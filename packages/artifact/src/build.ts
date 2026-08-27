import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SproutboatConfig } from "../../config/src/config";
import { ARTIFACT_SCHEMA_VERSION, ABI_VERSION, CAPABILITY_PROFILE, type ArtifactManifest } from "./manifest";

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

async function run(command: string[], label: string, input?: string): Promise<string> {
  const child = Bun.spawn(command, { stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (input !== undefined) {
    if (!child.stdin) throw new Error(`${label} could not open standard input`);
    child.stdin.write(input);
    child.stdin.end();
  }
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`${label} failed: ${(stderr || stdout).trim() || `exit ${code}`}`);
  return stdout;
}

async function localBuildImage(): Promise<{ immutable: string; reference: string }> {
  const reference = process.env.SPROUTBOAT_BUILD_IMAGE_REF || "sproutboat/build:dev";
  const configured = process.env.SPROUTBOAT_BUILD_IMAGE;
  if (configured) {
    if (!/@sha256:[a-f0-9]{64}$/.test(configured)) throw new Error("SPROUTBOAT_BUILD_IMAGE must name an immutable Linux build-image digest");
    return { immutable: configured, reference };
  }
  const imageId = (await run(["docker", "image", "inspect", "--format", "{{.Id}}", reference], "local build image inspection")).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error(`Docker did not return an immutable digest for ${reference}`);
  return { immutable: `${reference.replace(/@sha256:[a-f0-9]{64}$/, "")}@${imageId}`, reference };
}

export async function buildArtifact(input: BuildInput): Promise<BuildOutput> {
  const image = await localBuildImage();
  const source = await readFile(input.sourcePath);
  const sourceHash = digest(source);
  const artifactId = sourceHash.slice("sha256:".length, 24);
  const artifactDir = resolve(input.projectDir, ".sproutboat/dist", artifactId);
  const bundlePath = resolve(artifactDir, "bundle.js");
  const workerPath = resolve(artifactDir, "worker");
  await mkdir(artifactDir, { recursive: true });

  await run([
    process.execPath,
    resolve(root, "node_modules/rolldown/bin/cli.mjs"),
    input.sourcePath,
    "--file", bundlePath,
    "--format", "es",
  ], "Rolldown bundle");

  // The current http-sync-v0 contract is intentionally import-free, so the
  // compiler consumes the source after Rolldown has performed the same syntax
  // validation. The bundle is never part of the uploaded artifact.
  await run([
    "docker", "run", "--rm", "--network", "none", "--platform", "linux/amd64",
    "--mount", `type=bind,src=${input.projectDir},dst=/input,readonly`,
    "--mount", `type=bind,src=${artifactDir},dst=/output`,
    image.reference,
    "/workspace/tools/compile.ts",
    `/input/${input.config.main}`,
    "/output/worker",
  ], "Porffor Linux compilation");
  await chmod(workerPath, 0o555);

  const smokeOutput = await run([
    "docker", "run", "--rm", "-i", "--network", "none", "--platform", "linux/amd64",
    "--entrypoint", "/output/worker",
    "--mount", `type=bind,src=${artifactDir},dst=/output,readonly`,
    image.reference,
  ], "artifact smoke test", JSON.stringify({ method: "GET", url: "http://localhost/health", headers: {}, body: "" }));
  try {
    const response = JSON.parse(smokeOutput) as { status?: unknown; body?: unknown };
    if (!Number.isInteger(response.status) || typeof response.body !== "string") throw new TypeError("invalid response shape");
  } catch (error) {
    throw new Error(`artifact smoke test emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const [worker, rolldownPackage, porfforPackage] = await Promise.all([
    readFile(workerPath),
    Bun.file(resolve(root, "node_modules/rolldown/package.json")).json() as Promise<{ version: string }>,
    Bun.file(resolve(root, "node_modules/porffor/package.json")).json() as Promise<{ version: string }>,
  ]);
  const manifest: ArtifactManifest = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    project: input.config.name,
    target: "linux-x86_64",
    abi: ABI_VERSION,
    capabilityProfile: CAPABILITY_PROFILE,
    porfforVersion: process.env.PORFFOR_VERSION || porfforPackage.version,
    rolldownVersion: rolldownPackage.version,
    buildImage: image.immutable,
    sourceHash,
    binaryHash: digest(worker),
    binarySize: (await stat(workerPath)).size,
    builtAt: new Date().toISOString(),
  };
  await writeFile(resolve(artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await unlink(bundlePath);
  return { artifactDir, manifest };
}
