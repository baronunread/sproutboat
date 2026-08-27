import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseConfig } from "../../../packages/config/src/config";
import { validateHttpSyncSource } from "../../../packages/config/src/source";
import { buildArtifact } from "../../../packages/artifact/src/build";
import { activeApiUrl, savedToken, saveToken } from "./credentials";

const defaultApiUrl = "https://dashboard.porffer.dev";

const starterConfig = (name: string) => `{
  "$schema": "https://porffer.dev/schema.json",
  "name": "${name}",
  "main": "src/index.js",
  "compatibility_date": "2026-08-26"
}
`;
const starterHandler = `export default {
  fetch() {
    return new Response("hello from Porffer");
  }
};
`;

function fail(message: string): never {
  console.error(`porffer: ${message}`);
  process.exit(1);
}

async function readProject(directory = process.cwd()) {
  const projectDirectory = resolve(directory);
  const configPath = resolve(projectDirectory, "porffer.jsonc");
  let configSource: string;
  try {
    configSource = await readFile(configPath, "utf8");
  } catch {
    fail(`no porffer.jsonc found in ${projectDirectory}`);
  }
  const parsed = parseConfig(configSource);
  if (!parsed.ok) fail(parsed.errors.join("\n"));
  const sourcePath = resolve(projectDirectory, parsed.value.main);
  let source: string;
  try {
    source = await readFile(sourcePath, "utf8");
  } catch {
    fail(`entry point not found: ${parsed.value.main}`);
  }
  const supported = validateHttpSyncSource(source);
  if (!supported.ok) fail(supported.errors.join("\n"));
  return { directory: projectDirectory, config: parsed.value, sourcePath, source };
}

async function init(name = "hello") {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(name)) fail("project name must be a 3–32 character lowercase slug");
  const directory = resolve(process.cwd(), name);
  const configPath = resolve(directory, "porffer.jsonc");
  if (await Bun.file(configPath).exists()) fail(`${basename(directory)} already contains porffer.jsonc`);
  await mkdir(resolve(directory, "src"), { recursive: true });
  await writeFile(configPath, starterConfig(name), { flag: "wx" });
  await writeFile(resolve(directory, "src/index.js"), starterHandler, { flag: "wx" });
  console.log(`Created ${basename(directory)}/porffer.jsonc`);
  console.log(`Created ${basename(directory)}/src/index.js`);
}

async function check(directory?: string) {
  const project = await readProject(directory);
  console.log(`check passed: ${project.config.name} (${project.config.main}, http-sync-v0)`);
}

async function build(directory?: string) {
  const project = await readProject(directory);
  console.log("Bundling with Rolldown...");
  console.log("Compiling with Porffor in the pinned Linux image...");
  const artifact = await buildArtifact({ projectDir: project.directory, config: project.config, sourcePath: project.sourcePath });
  console.log(`Built ${project.config.name}`);
  console.log(artifact.artifactDir);
  return { project, artifact };
}

async function deploy(args: string[]) {
  const artifactIndex = args.indexOf("--artifact");
  const dryRun = args.includes("--dry-run");
  let projectName: string;
  let artifactDir: string;
  if (artifactIndex >= 0) {
    artifactDir = args[artifactIndex + 1] ? resolve(args[artifactIndex + 1]) : fail("--artifact requires a directory");
    const manifest = await Bun.file(resolve(artifactDir, "manifest.json")).json() as { project?: string };
    if (!manifest.project || typeof manifest.project !== "string") fail("artifact manifest has no project name");
    projectName = manifest.project;
  } else {
    const built = await build(args[0]);
    projectName = built.project.config.name;
    artifactDir = built.artifact.artifactDir;
  }
  const manifest = Bun.file(resolve(artifactDir, "manifest.json"));
  const worker = Bun.file(resolve(artifactDir, "worker"));
  if (!(await manifest.exists()) || !(await worker.exists())) fail("artifact must contain manifest.json and worker");
  if (dryRun) {
    console.log(`Dry run: ${projectName}, ${worker.size} byte worker; no upload made.`);
    return;
  }
  const { apiUrl, token } = await apiCredentials();
  const form = new FormData();
  form.set("manifest", new File([await manifest.arrayBuffer()], "manifest.json", { type: "application/json" }));
  form.set("worker", new File([await worker.arrayBuffer()], "worker", { type: "application/octet-stream" }));
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/projects/${projectName}/deployments`, {
    method: "POST",
    headers: { "x-api-key": token },
    body: form,
  });
  const body = await response.text();
  if (!response.ok) fail(`deployment rejected (${response.status}): ${body}`);
  const deployed = JSON.parse(body) as { url: string };
  console.log(`Deployed ${projectName}`);
  console.log(deployed.url);
}

function loginApiUrl(args: string[]): string {
  if (!args.length) return (process.env.PORFFER_API_URL || defaultApiUrl).replace(/\/$/, "");
  if (args.length === 2 && args[0] === "--api-url") return args[1].replace(/\/$/, "");
  fail("usage: porffer login [--api-url <url>]");
}

async function login(args: string[]) {
  const apiUrl = loginApiUrl(args);
  const response = await fetch(`${apiUrl}/v1/cli/authorizations`, { method: "POST" });
  const body = await response.text();
  if (!response.ok) fail(`could not start login (${response.status}): ${body}`);
  const authorization = JSON.parse(body) as { deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresAt: string };
  const verificationUrl = new URL(authorization.verificationUri, `${apiUrl}/`).toString();
  const openCommand = process.platform === "darwin" ? ["open", verificationUrl] : process.platform === "win32" ? ["cmd", "/c", "start", "", verificationUrl] : ["xdg-open", verificationUrl];
  try { Bun.spawn(openCommand, { stdout: "ignore", stderr: "ignore" }); }
  catch { console.log(`Open ${verificationUrl}`); }
  console.log("Opening the browser to approve this CLI login.");
  console.log(`Confirm code: ${authorization.userCode}`);
  while (new Date(authorization.expiresAt).getTime() > Date.now()) {
    await Bun.sleep(Math.max(authorization.interval, 1) * 1000);
    const exchange = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/cli/authorizations/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: authorization.deviceCode }),
    });
    if (exchange.status === 428) continue;
    const result = await exchange.text();
    if (!exchange.ok) fail(`login failed (${exchange.status}): ${result}`);
    const token = (JSON.parse(result) as { token?: unknown }).token;
    if (typeof token !== "string") fail("login response did not include a CLI token");
    await saveToken(apiUrl, token);
    console.log("Login approved. Credentials were saved locally for this API endpoint.");
    return;
  }
  fail("login expired before approval");
}

async function dev(args: string[]) {
  const portIndex = args.indexOf("--port");
  const portValue = portIndex >= 0 ? args[portIndex + 1] : undefined;
  if (portIndex >= 0 && (!portValue || !/^\d+$/.test(portValue))) fail("--port requires a numeric value");
  const directory = args.find((arg, index) => index !== portIndex && index !== portIndex + 1 && !arg.startsWith("--"));
  const built = await build(directory);
  const port = Number(portValue || 8788);
  if (port < 1 || port > 65_535) fail("--port must be between 1 and 65535");
  const hostname = `${built.project.config.name}.localhost`;
  const snapshotPath = resolve(built.project.directory, ".porffer/dev-routes.json");
  await writeFile(snapshotPath, `${JSON.stringify([{ hostname, workerPath: resolve(built.artifact.artifactDir, "worker") }], null, 2)}\n`);
  const edgePath = resolve(import.meta.dir, "../../../services/edge/src/main.ts");
  console.log(`Development server: http://${hostname}:${port}`);
  const child = Bun.spawn([process.execPath, edgePath], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      PORT: String(port),
      PORFFER_ROUTE_SNAPSHOT: snapshotPath,
      PORFFER_RUNTIME_IMAGE: process.env.PORFFER_RUNTIME_IMAGE || process.env.PORFFER_BUILD_IMAGE_REF || "porffer/build:dev",
    },
  });
  process.on("SIGINT", () => child.kill());
  process.exitCode = await child.exited;
}

async function apiCredentials() {
  const apiUrl = (process.env.PORFFER_API_URL || await activeApiUrl() || defaultApiUrl).replace(/\/$/, "");
  const token = process.env.PORFFER_TOKEN || await savedToken(apiUrl);
  if (!token) fail("not logged in; run porffer login or set PORFFER_TOKEN for this command");
  return { apiUrl, token };
}

async function versions(args: string[]) {
  if (args[0] !== "list") fail("usage: porffer versions list [project-directory]");
  const project = await readProject(args[1]);
  const { apiUrl, token } = await apiCredentials();
  const response = await fetch(`${apiUrl}/v1/projects/${project.config.name}/deployments`, { headers: { "x-api-key": token } });
  if (!response.ok) fail(`could not list versions (${response.status}): ${await response.text()}`);
  const deployments = await response.json() as Array<{ id: string; artifact: string; deployedAt: string; active: boolean }>;
  for (const deployment of deployments) console.log(`${deployment.active ? "*" : " "} ${deployment.id} ${deployment.artifact.slice(0, 12)} ${deployment.deployedAt}`);
}

async function rollback(args: string[]) {
  const id = args[0];
  if (!id) fail("usage: porffer rollback <version-id> [project-directory]");
  const project = await readProject(args[1]);
  const { apiUrl, token } = await apiCredentials();
  const response = await fetch(`${apiUrl}/v1/projects/${project.config.name}/deployments/${id}/activate`, { method: "POST", headers: { "x-api-key": token } });
  if (!response.ok) fail(`rollback rejected (${response.status}): ${await response.text()}`);
  const deployment = await response.json() as { url: string };
  console.log(`Rolled back ${project.config.name}`);
  console.log(deployment.url);
}

async function tail(args: string[]) {
  const project = await readProject(args[0]);
  const { apiUrl, token } = await apiCredentials();
  const response = await fetch(`${apiUrl}/v1/projects/${project.config.name}/logs/stream`, { headers: { "x-api-key": token } });
  if (!response.ok) fail(`could not read logs (${response.status}): ${await response.text()}`);
  process.stdout.write(await response.text());
}

async function deleteProject(args: string[]) {
  if (args[0] !== "--yes") fail("refusing to delete without --yes");
  const project = await readProject(args[1]);
  const { apiUrl, token } = await apiCredentials();
  const response = await fetch(`${apiUrl}/v1/projects/${project.config.name}`, { method: "DELETE", headers: { "x-api-key": token } });
  if (!response.ok) fail(`delete rejected (${response.status}): ${await response.text()}`);
  console.log(`Deleted ${project.config.name}`);
}

function usage(): never {
  console.error("usage: porffer <init [name]|check|build|dev [directory] [--port <port>]|login [--api-url <url>]|deploy [--dry-run|--artifact <path>]|tail|versions list|rollback <version-id>|delete --yes>");
  process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case "init": await init(args[0]); break;
  case "check": await check(args[0]); break;
  case "build": await build(args[0]); break;
  case "dev": await dev(args); break;
  case "login": await login(args); break;
  case "deploy": await deploy(args); break;
  case "versions": await versions(args); break;
  case "rollback": await rollback(args); break;
  case "tail": await tail(args); break;
  case "delete": await deleteProject(args); break;
  default: usage();
}
