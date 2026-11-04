//! #141: answer control's "start this candidate" requests (see
//! apps/control/src/activation.ts). `start` gets the request path, parses it as
//! a route snapshot and resolves once the candidate listens; any error is the
//! failure control reports to the deployer.

use std::future::Future;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

static BUSY: AtomicBool = AtomicBool::new(false);

struct Busy;
impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::Release);
    }
}

fn write_reply(reply: &Path, result: &Result<(), String>) -> std::io::Result<()> {
    use std::io::Write;
    let json = match result {
        Ok(()) => serde_json::json!({ "ok": true }),
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    };
    let tmp = PathBuf::from(format!("{}.tmp", reply.display()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o640)
        .open(&tmp)?;
    file.write_all(json.to_string().as_bytes())?;
    drop(file);
    std::fs::rename(&tmp, reply)
}

/// One request at a time, so a candidate that never listens holds the queue for the
/// supervisor's readiness timeout. Fine at single-box deploy rates.
pub async fn serve_activations<F, Fut>(dir: &str, start: F) -> std::io::Result<()>
where
    F: Fn(PathBuf) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    if BUSY.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let _busy = Busy;
    let Ok(read) = std::fs::read_dir(dir) else {
        return Ok(());
    };
    let mut names: Vec<String> = read
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .collect();
    names.sort();
    for name in names {
        let Some(stem) = name.strip_suffix(".request.json") else {
            continue;
        };
        let request = Path::new(dir).join(&name);
        let request = std::path::absolute(&request).unwrap_or(request);
        let reply = request.with_file_name(format!("{stem}.reply.json"));
        if reply.exists() {
            continue;
        }
        let result = start(request.clone()).await;
        write_reply(&reply, &result)?;
        // Control timed out and removed its request while we worked; nobody reads this.
        if !request.exists() {
            let _ = std::fs::remove_file(&reply);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    // `BUSY` is process-wide, so the cases run in one test.
    #[tokio::test]
    async fn answers_each_request_once_and_drops_replies_nobody_waits_for() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().to_str().unwrap().to_string();
        std::fs::write(dir.path().join("good.request.json"), "[]").unwrap();
        std::fs::write(dir.path().join("bad.request.json"), "[]").unwrap();
        let started = Arc::new(Mutex::new(Vec::new()));
        let seen = started.clone();
        serve_activations(&d, move |request| {
            let seen = seen.clone();
            async move {
                seen.lock().unwrap().push(request.clone());
                if request.to_str().unwrap().ends_with("bad.request.json") {
                    return Err("sprout exited before it began listening".to_string());
                }
                Ok(())
            }
        })
        .await
        .unwrap();
        let reply = |id: &str| -> serde_json::Value {
            serde_json::from_str(
                &std::fs::read_to_string(dir.path().join(format!("{id}.reply.json"))).unwrap(),
            )
            .unwrap()
        };
        assert_eq!(reply("good"), serde_json::json!({ "ok": true }));
        assert_eq!(
            reply("bad"),
            serde_json::json!({ "ok": false, "error": "sprout exited before it began listening" })
        );
        // Already answered: the next poll leaves them alone.
        serve_activations(&d, |_| async { Err("must not run twice".to_string()) })
            .await
            .unwrap();
        assert_eq!(started.lock().unwrap().len(), 2);

        // Control gave up while the candidate was starting.
        std::fs::write(dir.path().join("late.request.json"), "[]").unwrap();
        serve_activations(&d, |request| async move {
            std::fs::remove_file(request).unwrap();
            Ok(())
        })
        .await
        .unwrap();
        assert!(!dir.path().join("late.reply.json").exists());
        let mode = std::fs::metadata(dir.path().join("good.reply.json")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(mode.permissions().mode() & 0o777 & !0o022, 0o640 & !0o022);
    }
}
