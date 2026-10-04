import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const root = process.env.PORFFOR_ROOT || process.cwd();
const work = await mkdtemp(join(tmpdir(), "porffor-encoder-check-"));
const inputs = ["", "ASCII", "caffè", "東京", "🚤", "x🚤y", "\ud800", "\udc00", "\ud800x", "\ud800\ud800\udc00"];
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
  const source = join(work, "encoder.js");
  const binary = join(work, "encoder");
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  await writeFile(
    source,
    `export default { port: ${port}, fetch() {
    const inputs = ${JSON.stringify(inputs)};
    const encoded = [];
    const into = [];
    for (const input of inputs) {
      encoded.push(Array.from(new TextEncoder().encode(input)));
      const rows = [];
      for (let size = 0; size <= 10; size++) {
        const destination = new Uint8Array(size);
        const result = new TextEncoder().encodeInto(input, destination);
        rows.push({ read: result.read, written: result.written, bytes: Array.from(destination) });
      }
      into.push(rows);
    }
    const overridden = new TextEncoder();
    overridden.encodeInto = function() { throw new Error('encodeInto should not be called'); };
    const override = Array.from(overridden.encode('x'));
    return new Response(JSON.stringify({ encoded, into, override, empty: Array.from(new TextEncoder().encode()), number: Array.from(new TextEncoder().encode(42)) }));
  } };`,
  );
  const compile = Bun.spawn(
    [process.execPath, resolve(root, "runtime/index.js"), "native", source, "-o", binary, "-s"],
    { cwd: work, stdout: "pipe", stderr: "pipe" },
  );
  const [status, stdout, stderr] = await Promise.all([
    compile.exited,
    new Response(compile.stdout).text(),
    new Response(compile.stderr).text(),
  ]);
  if (status !== 0) throw new Error(stderr || stdout);
  child = Bun.spawn([binary], { stdout: "ignore", stderr: "pipe" });
  let response: Response | undefined;
  for (let i = 0; i < 100; i++) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      break;
    } catch {
      if (child.exitCode !== null) break;
      await Bun.sleep(30);
    }
  }
  if (!response) throw new Error("Native handler did not respond");
  if (!response.ok) throw new Error(`Native handler answered ${response.status}`);
  const actual = await response.json();
  const expected = {
    encoded: inputs.map((input) => Array.from(new TextEncoder().encode(input))),
    into: inputs.map((input) =>
      Array.from({ length: 11 }, (_, size) => {
        const destination = new Uint8Array(size);
        const result = new TextEncoder().encodeInto(input, destination);
        return { read: result.read, written: result.written, bytes: Array.from(destination) };
      }),
    ),
    override: Array.from(new TextEncoder().encode("x")),
    empty: [],
    number: Array.from(new TextEncoder().encode(42)),
  };
  const rows = [
    ...expected.encoded.map((value, i) => ({
      name: `encode-${i}`,
      correct: isDeepStrictEqual(actual.encoded[i], value),
    })),
    ...expected.into.flatMap((values, i) =>
      values.map((value, size) => ({
        name: `encodeInto-${i}-${size}`,
        correct: isDeepStrictEqual(actual.into[i][size], value),
      })),
    ),
    { name: "encode-ignores-overridden-encodeInto", correct: isDeepStrictEqual(actual.override, expected.override) },
    { name: "encode-default", correct: isDeepStrictEqual(actual.empty, expected.empty) },
    { name: "encode-number", correct: isDeepStrictEqual(actual.number, expected.number) },
  ];
  const result = {
    backend: "native HTTP",
    oracle: `Bun ${Bun.version}`,
    correct: rows.filter((row) => row.correct).length,
    total: rows.length,
    rows,
  };
  console.log(JSON.stringify(result, null, 2));
  if (result.correct !== result.total) process.exitCode = 1;
} finally {
  if (child) {
    child.kill();
    await child.exited;
  }
  await rm(work, { recursive: true, force: true });
}
