import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SproutboatConfig } from "../../config/src/config";
import { ARTIFACT_SCHEMA_VERSION, CAPABILITY_PROFILE, RUNTIME, type ArtifactManifest } from "./manifest";
import { porfforVersion } from "../../../tools/porffor";

const root = resolve(import.meta.dir, "../../..");

export type BuildInput = {
  projectDir: string;
  config: SproutboatConfig;
  sourcePath: string;
};

export type BuildOutput = {
  artifactDir: string;
  manifest: ArtifactManifest;
};

function digest(value: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function run(command: string[], label: string): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${label} failed: ${(stderr || stdout).trim() || `exit ${code}`}`);
  return stdout;
}

async function readVersion(packageDir: string): Promise<string> {
  try {
    const version: unknown = JSON.parse(await readFile(resolve(root, "node_modules", packageDir, "package.json"), "utf8"))?.version;
    return Object(version) !== version && version === String(version) && version ? version : "unknown";
  } catch { return "unknown"; }
}

async function buildImage(): Promise<{ immutable: string; reference: string }> {
  const reference = process.env.SPROUTBOAT_BUILD_IMAGE_REF || "sproutboat/build:dev";
  const configured = process.env.SPROUTBOAT_BUILD_IMAGE;
  if (configured) {
    if (!/@sha256:[a-f0-9]{64}$/.test(configured)) throw new Error("SPROUTBOAT_BUILD_IMAGE must name an immutable build-image digest");
    return { immutable: configured, reference };
  }
  const imageId = (await run(["docker", "image", "inspect", "--format", "{{.Id}}", reference], "local build image inspection")).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error(`Docker did not return an immutable digest for ${reference}`);
  return { immutable: `${reference.replace(/@sha256:[a-f0-9]{64}$/, "")}@${imageId}`, reference };
}

/**
 * Cross-compiles a handler into a linux-x86_64 native-fetch server binary inside
 * the pinned build image, then verifies the binary starts and serves HTTP.
 */
export async function buildArtifact(input: BuildInput): Promise<BuildOutput> {
  const [image, source] = await Promise.all([buildImage(), readFile(input.sourcePath)]);
  const sourceHash = digest(source);
  const artifactId = sourceHash.slice("sha256:".length, 24);
  const artifactDir = resolve(input.projectDir, ".sproutboat/dist", artifactId);
  const workerPath = resolve(artifactDir, "worker");
  await mkdir(artifactDir, { recursive: true });

  await run([
    "docker", "run", "--rm", "--platform", "linux/amd64",
    "--env", `SPROUTBOAT_VARS_JSON=${JSON.stringify(input.config.vars ?? {})}`,
    "--mount", `type=bind,src=${input.projectDir},dst=/input,readonly`,
    "--mount", `type=bind,src=${artifactDir},dst=/output`,
    image.reference,
    "run", "tools/compile.ts", `/input/${input.config.main}`, "/output/worker",
  ], "native-fetch compilation");
  await chmod(workerPath, 0o555);

  await run([
    "docker", "run", "--rm", "--platform", "linux/amd64",
    "--entrypoint", "sh",
    "--mount", `type=bind,src=${artifactDir},dst=/output,readonly`,
    image.reference,
    "-c", "PORT=8099 /output/worker & for i in $(seq 40); do curl -sf -o /dev/null http://127.0.0.1:8099/ && exit 0; sleep 0.25; done; echo 'worker did not serve HTTP' >&2; exit 1",
  ], "artifact smoke test");

  const worker = await readFile(workerPath);
  const manifest: ArtifactManifest = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    project: input.config.name,
    target: "linux-x86_64",
    runtime: RUNTIME,
    capabilityProfile: CAPABILITY_PROFILE,
    porfforVersion: porfforVersion(),
    esbuildVersion: await readVersion("esbuild"),
    buildImage: image.immutable,
    sourceHash,
    binaryHash: digest(worker),
    binarySize: (await stat(workerPath)).size,
    builtAt: new Date().toISOString(),
  };
  await writeFile(resolve(artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { artifactDir, manifest };
}
