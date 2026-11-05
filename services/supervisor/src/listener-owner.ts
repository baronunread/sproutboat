import { readFileSync, readdirSync, readlinkSync } from "node:fs";

/**
 * Who is behind a loopback port.
 *
 * The pool probes a port, spawns a sprout and then waits until something
 * accepts on it. A bare connect cannot tell the sprout from another process that
 * took the port first, so on Linux the supervisor also checks that every
 * listening socket on the port belongs to the process tree it started.
 */

export type ListenerOwner = "owned" | "foreign" | "none" | "unsupported";

/** Inodes of the LISTEN sockets bound to `port` (any local address, v4 and v6). Throws when /proc/net/tcp is unreadable. */
export function listeningInodes(port: number): Set<number> {
  const inodes = new Set<number>();
  let readable = false;
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (file === "/proc/net/tcp") throw error;
      continue;
    }
    readable = true;
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10 || fields[3] !== "0A") continue;
      const local = fields[1]!;
      if (Number.parseInt(local.slice(local.lastIndexOf(":") + 1), 16) !== port) continue;
      const inode = Number(fields[9]);
      if (inode > 0) inodes.add(inode);
    }
  }
  if (!readable) throw new Error("/proc/net/tcp is unreadable");
  return inodes;
}

/** `pid` and every process below it, found through /proc/<pid>/task/*\/children. */
export function descendants(pid: number): number[] {
  const seen = new Set<number>();
  const queue = [pid];
  while (queue.length) {
    const next = queue.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    let tasks: string[];
    try {
      tasks = readdirSync(`/proc/${next}/task`);
    } catch {
      continue;
    }
    for (const task of tasks) {
      let text = "";
      try {
        text = readFileSync(`/proc/${next}/task/${task}/children`, "utf8");
      } catch {
        continue;
      }
      for (const child of text.split(/\s+/)) {
        const id = Number(child);
        if (id > 0) queue.push(id);
      }
    }
  }
  return [...seen];
}

/** Inodes of the sockets `pid` holds open. */
export function socketInodes(pid: number): Set<number> {
  const inodes = new Set<number>();
  let names: string[];
  try {
    names = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return inodes;
  }
  for (const name of names) {
    try {
      const match = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${name}`));
      if (match) inodes.add(Number(match[1]));
    } catch {
      // closed while we looked
    }
  }
  return inodes;
}

/**
 * `owned`: at least one listener on `port`, and every one of them is a socket
 * held by `rootPid` or a descendant. `foreign`: some listener on the port is
 * not (a second socket sharing the port counts). `none`: nobody listens yet.
 * `unsupported`: no /proc/net/tcp to ask (not Linux).
 */
export function listenerOwner(port: number, rootPid: number): ListenerOwner {
  let listening: Set<number>;
  try {
    listening = listeningInodes(port);
  } catch {
    return "unsupported";
  }
  if (listening.size === 0) return "none";
  const mine = new Set<number>();
  for (const pid of descendants(rootPid)) for (const inode of socketInodes(pid)) mine.add(inode);
  for (const inode of listening) if (!mine.has(inode)) return "foreign";
  return "owned";
}
