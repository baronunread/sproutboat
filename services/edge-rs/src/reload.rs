//! Change detection for `routes.json`.
//!
//! The Bun edge reloads when `mtimeMs` is strictly greater than the one it knows. Filesystem
//! timestamps are coarse (a kernel tick, about 4 ms on Linux ext4/tmpfs, whole seconds on some
//! filesystems), so a rewrite shortly after the previous write carries an identical mtime, down
//! to the nanosecond, and Bun keeps the old routes until SIGHUP. This module closes that gap
//! the way git closes its "racily clean" index entries:
//!
//! 1. A cheap stat tuple (mtime, ctime, inode, size) is compared on every poll. A newer mtime
//!    reloads; the same mtime with a different inode, ctime or size reloads too (an atomic
//!    rename always changes the inode). An *older* mtime is still ignored until SIGHUP, as in Bun.
//! 2. A snapshot loaded within `RACY_WINDOW_MS` of its own mtime is "racy": a write in the same
//!    tick would be invisible to the stat tuple. While a snapshot is racy, every poll with an
//!    unchanged tuple also compares a content hash. The snapshot stops being racy once a poll
//!    sees identical content at least a window after its mtime, because any later write then
//!    carries a later mtime. A stalled poller cannot miss a write: racy is decided by when the
//!    snapshot was *loaded*, not when it is polled.

use std::collections::hash_map::DefaultHasher;
use std::hash::Hasher;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

/// Longer than any timestamp granularity we care about on local filesystems, shorter than the
/// time it takes a quiet file to stop being re-hashed.
pub const RACY_WINDOW_MS: i128 = 2_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Stamp {
    pub exists: bool,
    pub mtime_ns: i128,
    pub ctime_ns: i128,
    pub ino: u64,
    pub dev: u64,
    pub size: u64,
}

/// What the edge last loaded: the stat tuple it saw, the hash of the bytes it parsed, and
/// whether a same-tick rewrite could still hide behind that tuple.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Loaded {
    pub stamp: Stamp,
    pub hash: u64,
    pub racy: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Check {
    /// Nothing new.
    Same,
    /// Nothing new, and the snapshot is old enough that stat alone is trustworthy again.
    Settled,
    /// Read the file and swap.
    Reload,
}

pub fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    hasher.write(bytes);
    hasher.finish()
}

fn ns(secs: i64, nanos: i64) -> i128 {
    i128::from(secs) * 1_000_000_000 + i128::from(nanos)
}

pub async fn stamp_of(path: &Path) -> Result<Stamp, String> {
    match tokio::fs::metadata(path).await {
        Ok(meta) => Ok(Stamp {
            exists: true,
            mtime_ns: ns(meta.mtime(), meta.mtime_nsec()),
            ctime_ns: ns(meta.ctime(), meta.ctime_nsec()),
            ino: meta.ino(),
            dev: meta.dev(),
            size: meta.size(),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Stamp::default()),
        Err(e) => Err(e.to_string()),
    }
}

/// Is a snapshot loaded at `now_ms` from a file stamped `stamp` still exposed to a same-tick rewrite?
/// An mtime in the future (clock skew, `touch -d`) counts as racy too.
pub fn is_racy(stamp: &Stamp, now_ms: u64) -> bool {
    stamp.exists && i128::from(now_ms) * 1_000_000 - stamp.mtime_ns < RACY_WINDOW_MS * 1_000_000
}

pub fn loaded(stamp: Stamp, bytes: &[u8], now_ms: u64) -> Loaded {
    Loaded {
        stamp,
        hash: hash_bytes(bytes),
        racy: is_racy(&stamp, now_ms),
    }
}

/// Compare the file on disk with what was loaded. A missing file is `Same` (Bun ignores deletion
/// at runtime; SIGHUP clears the routes).
pub async fn check(path: &Path, known: &Loaded, now_ms: u64) -> Result<Check, String> {
    let current = stamp_of(path).await?;
    if !current.exists {
        return Ok(Check::Same);
    }
    let k = &known.stamp;
    if current.mtime_ns > k.mtime_ns {
        return Ok(Check::Reload);
    }
    if current.mtime_ns < k.mtime_ns {
        return Ok(Check::Same); // an older replacement waits for SIGHUP, like Bun
    }
    if !k.exists
        || current.ino != k.ino
        || current.dev != k.dev
        || current.size != k.size
        || current.ctime_ns != k.ctime_ns
    {
        return Ok(Check::Reload);
    }
    if !known.racy {
        return Ok(Check::Same);
    }
    let bytes = match tokio::fs::read(path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Check::Same),
        Err(e) => return Err(e.to_string()),
    };
    if hash_bytes(&bytes) != known.hash {
        return Ok(Check::Reload);
    }
    Ok(if is_racy(&current, now_ms) {
        Check::Same
    } else {
        Check::Settled
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::now_ms;
    use filetime::{set_file_mtime, FileTime};
    use std::fs;

    fn pin(path: &Path, to: FileTime) {
        set_file_mtime(path, to).unwrap();
    }

    async fn load(path: &Path) -> Loaded {
        let stamp = stamp_of(path).await.unwrap();
        loaded(stamp, &fs::read(path).unwrap(), now_ms())
    }

    // The defect: two writes in one timestamp tick. The mtime is identical to the nanosecond, so a
    // strictly-newer comparison (Bun's) never notices the second.
    #[tokio::test]
    async fn in_place_rewrite_with_identical_mtime_and_size_is_seen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("routes.json");
        let tick = FileTime::from_unix_time(now_ms() as i64 / 1000, 123_456_789);
        fs::write(&path, "[\"aaaa\"]").unwrap();
        pin(&path, tick);
        let known = load(&path).await;
        assert!(known.racy);
        assert_eq!(check(&path, &known, now_ms()).await, Ok(Check::Same));

        fs::write(&path, "[\"bbbb\"]").unwrap(); // same size, same inode
        pin(&path, tick);
        let now = stamp_of(&path).await.unwrap();
        assert_eq!(now.mtime_ns, known.stamp.mtime_ns);
        assert_eq!(now.size, known.stamp.size);
        assert_eq!(now.ino, known.stamp.ino);
        assert_eq!(check(&path, &known, now_ms()).await, Ok(Check::Reload));
    }

    #[tokio::test]
    async fn atomic_rename_with_identical_mtime_is_seen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("routes.json");
        let tmp = dir.path().join("routes.json.tmp");
        let tick = FileTime::from_unix_time(now_ms() as i64 / 1000, 0);
        fs::write(&path, "[1]").unwrap();
        pin(&path, tick);
        let known = load(&path).await;
        fs::write(&tmp, "[1]").unwrap(); // even the same bytes: a new file is a reload
        pin(&tmp, tick);
        fs::rename(&tmp, &path).unwrap();
        assert_eq!(check(&path, &known, now_ms()).await, Ok(Check::Reload));
    }

    #[tokio::test]
    async fn a_stalled_poller_still_sees_a_same_tick_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("routes.json");
        let tick = FileTime::from_unix_time(now_ms() as i64 / 1000, 0);
        fs::write(&path, "aaaa").unwrap();
        pin(&path, tick);
        let known = load(&path).await;
        fs::write(&path, "bbbb").unwrap();
        pin(&path, tick);
        // The poll happens a minute later: racy was decided at load time, so it still hashes.
        let late = now_ms() + 60_000;
        assert_eq!(check(&path, &known, late).await, Ok(Check::Reload));
    }

    #[tokio::test]
    async fn unchanged_file_settles_and_then_costs_only_a_stat() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("routes.json");
        fs::write(&path, "aaaa").unwrap();
        let known = load(&path).await;
        assert!(known.racy);
        assert_eq!(check(&path, &known, now_ms()).await, Ok(Check::Same));
        let later = now_ms() + 3_000;
        assert_eq!(check(&path, &known, later).await, Ok(Check::Settled));
        let settled = Loaded {
            racy: false,
            ..known
        };
        // Not racy: a content change with an unchanged tuple is not looked for.
        assert_eq!(check(&path, &settled, later).await, Ok(Check::Same));
    }

    #[tokio::test]
    async fn an_old_file_is_not_racy_and_newer_or_older_mtimes_behave_like_bun() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("routes.json");
        fs::write(&path, "aaaa").unwrap();
        pin(
            &path,
            FileTime::from_unix_time(now_ms() as i64 / 1000 - 3600, 0),
        );
        let known = load(&path).await;
        assert!(!known.racy);
        pin(
            &path,
            FileTime::from_unix_time(now_ms() as i64 / 1000 - 1800, 0),
        );
        assert_eq!(check(&path, &known, now_ms()).await, Ok(Check::Reload));
        pin(
            &path,
            FileTime::from_unix_time(now_ms() as i64 / 1000 - 7200, 0),
        );
        assert_eq!(check(&path, &known, now_ms()).await, Ok(Check::Same));
        fs::remove_file(&path).unwrap();
        assert_eq!(check(&path, &known, now_ms()).await, Ok(Check::Same));
    }

    #[tokio::test]
    async fn a_file_that_appears_after_boot_is_loaded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("routes.json");
        let known = Loaded::default();
        assert_eq!(check(&path, &known, now_ms()).await, Ok(Check::Same));
        fs::write(&path, "[]").unwrap();
        assert_eq!(check(&path, &known, now_ms()).await, Ok(Check::Reload));
    }
}
