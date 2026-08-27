import { basename, dirname, resolve } from "node:path";

export type WorkerRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
};

export type WorkerResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

const maxBodyBytes = 262_144;
const maxLogBytes = 65_536;

async function readBounded(stream: ReadableStream<Uint8Array>, maximum: number, child: ReturnType<typeof Bun.spawn>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximum) {
        child.kill();
        throw new RangeError(`worker output exceeds ${maximum} byte limit`);
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

function assertResponse(value: unknown): asserts value is { status: number; headers: Record<string, string | null>; body: string } {
  if (typeof value !== "object" || value === null) throw new TypeError("worker response must be an object");
  const response = value as Record<string, unknown>;
  if (!Number.isInteger(response.status) || (response.status as number) < 100 || (response.status as number) > 599) throw new TypeError("worker response has invalid status");
  if (typeof response.body !== "string") throw new TypeError("worker response body must be a string");
  if (typeof response.headers !== "object" || response.headers === null || Array.isArray(response.headers)
    || !Object.entries(response.headers).every(([key, item]) => /^[a-z0-9-]+$/i.test(key) && (typeof item === "string" || item === null))) {
    throw new TypeError("worker response headers must contain strings or nulls");
  }
}

export async function runWorker(workerPath: string, request: WorkerRequest): Promise<WorkerResponse> {
  if (new TextEncoder().encode(request.body).byteLength > maxBodyBytes) throw new RangeError("request body exceeds 256 KiB limit");
  const image = process.env.SPROUTBOAT_RUNTIME_IMAGE || "sproutboat/build:dev";
  const artifactDir = dirname(resolve(workerPath));
  const workerName = basename(workerPath);
  const child = Bun.spawn([
    "docker", "run", "--rm", "-i", "--network", "none", "--read-only",
    "--user", "65534:65534",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--memory", "64m", "--pids-limit", "16", "--platform", "linux/amd64",
    "--entrypoint", `/artifact/${workerName}`,
    "--mount", `type=bind,src=${artifactDir},dst=/artifact,readonly`,
    image,
  ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  if (!child.stdin) throw new Error("worker process has no standard input");
  child.stdin.write(JSON.stringify(request));
  child.stdin.end();
  const timeout = setTimeout(() => child.kill(), 5_000);
  let exitCode: number;
  let stdout: string;
  let stderr: string;
  try {
    [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBounded(child.stdout, maxBodyBytes, child),
      readBounded(child.stderr, maxLogBytes, child),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  if (exitCode !== 0) throw new Error(stderr.trim() || `worker exited ${exitCode}`);
  const response = JSON.parse(stdout.trim());
  assertResponse(response);
  return {
    status: response.status,
    headers: Object.fromEntries(Object.entries(response.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
    body: response.body,
  };
}
