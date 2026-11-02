// One command to sproutd's admin socket, printed as received: bun admin.ts SOCKET "list"
// Used by the e2e as the sproutd user (the socket is 0600), to look at what the daemon itself reports.
import net from "node:net";

const [socketPath, ...words] = process.argv.slice(2);
if (!socketPath || words.length === 0) {
  console.error('usage: bun admin.ts SOCKET "command ..."');
  process.exit(2);
}
const socket = net.connect(socketPath);
let out = "";
const done = setTimeout(() => {
  console.error("timed out");
  process.exit(1);
}, 30_000);
socket.on("connect", () => socket.write(`${words.join(" ")}\n`));
socket.on("data", (chunk) => {
  out += chunk.toString();
  const last = out.trimEnd().split("\n").pop() ?? "";
  if (/^(ok|error)\b/.test(last)) {
    clearTimeout(done);
    process.stdout.write(out);
    socket.destroy();
  }
});
socket.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
