import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseConfig, type SproutboatConfig } from "../../../packages/config/src/config";
import { validateHttpSyncSource } from "../../../packages/config/src/source";
import { buildArtifact } from "../../../packages/artifact/src/build";
import { validateManifest, type ArtifactManifest } from "../../../packages/artifact/src/manifest";
import { printDeployReport } from "./report";
import { activeApiUrl, savedToken, saveToken } from "./credentials";

const defaultApiUrl = "https://dashboard.sproutboat.com";

async function responseText(response: Response, failure: string): Promise<string> {
  if (response.ok) return response.text();
  fail(`${failure} (${response.status}): ${await response.text()}`);
}

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

function isString(value: JsonValue | undefined): value is string {
  return value !== undefined && value === String(value);
}

function isSafeInteger(value: JsonValue | undefined): value is number {
  return Number.isSafeInteger(value);
}

function parseJsonValue(source: string): JsonValue {
  const value = JSON.parse(source);
  if (value === null || value === true || value === false || value === String(value) || Number.isFinite(value) || value instanceof Object) return value;
  throw new Error("response was not valid JSON");
}

function jsonObject(value: JsonValue): JsonObject | undefined {
  return value instanceof Object && !Array.isArray(value) ? value : undefined;
}

type DeploymentSummary = { artifact: string; hostname: string; active: boolean };
type VersionSummary = { id: string; artifact: string; deployedAt: string; active: boolean };
type CliAuthorization = { deviceCode: string; userCode: string; verificationUri: string; interval: number; expiresAt: string };

function parseDeploymentList(source: string): DeploymentSummary[] | undefined {
  const value = parseJsonValue(source);
  if (!Array.isArray(value)) return undefined;
  const deployments: DeploymentSummary[] = [];
  for (const item of value) {
    const record = jsonObject(item);
    if (!record || !isString(record.artifact) || !isString(record.hostname) || (record.active !== true && record.active !== false)) return undefined;
    deployments.push({ artifact: record.artifact, hostname: record.hostname, active: record.active });
  }
  return deployments;
}

function parseVersionList(source: string): VersionSummary[] | undefined {
  const value = parseJsonValue(source);
  if (!Array.isArray(value)) return undefined;
  const deployments: VersionSummary[] = [];
  for (const item of value) {
    const record = jsonObject(item);
    if (!record || !isString(record.id) || !isString(record.artifact) || !isString(record.deployedAt) || (record.active !== true && record.active !== false)) return undefined;
    deployments.push({ id: record.id, artifact: record.artifact, deployedAt: record.deployedAt, active: record.active });
  }
  return deployments;
}

function parseUrlResponse(source: string): { url: string } | undefined {
  const record = jsonObject(parseJsonValue(source));
  return record && isString(record.url) ? { url: record.url } : undefined;
}

function parseAuthorization(source: string): CliAuthorization | undefined {
  const record = jsonObject(parseJsonValue(source));
  if (!record || !isString(record.deviceCode) || !isString(record.userCode) || !isString(record.verificationUri) || !isSafeInteger(record.interval) || !isString(record.expiresAt)) return undefined;
  return { deviceCode: record.deviceCode, userCode: record.userCode, verificationUri: record.verificationUri, interval: record.interval, expiresAt: record.expiresAt };
}

function parseToken(source: string): string | undefined {
  const record = jsonObject(parseJsonValue(source));
  return record && isString(record.token) ? record.token : undefined;
}

const starterConfig = (name: string) => `{
  "$schema": "https://sproutboat.com/schema.json",
  "name": "${name}",
  "main": "src/index.js",
  "compatibility_date": "2026-08-26"
}
`;
const starterHandler = `export default {
  fetch() {
    return new Response("hello from Sproutboat");
  }
};
`;

function fail(message: string): never {
  console.error(`sproutboat: ${message}`);
  process.exit(1);
}

async function readProject(directory = process.cwd()) {
  const projectDirectory = resolve(directory);
  const configPath = resolve(projectDirectory, "sproutboat.jsonc");
  let configSource: string;
  try {
    configSource = await readFile(configPath, "utf8");
  } catch {
    fail(`no sproutboat.jsonc found in ${projectDirectory}`);
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
  const configPath = resolve(directory, "sproutboat.jsonc");
  if (await Bun.file(configPath).exists()) fail(`${basename(directory)} already contains sproutboat.jsonc`);
  await mkdir(resolve(directory, "src"), { recursive: true });
  await writeFile(configPath, starterConfig(name), { flag: "wx" });
  await writeFile(resolve(directory, "src/index.js"), starterHandler, { flag: "wx" });
  console.log(`Created ${basename(directory)}/sproutboat.jsonc`);
  console.log(`Created ${basename(directory)}/src/index.js`);
}

async function check(directory?: string) {
  const project = await readProject(directory);
  console.log(`check passed: ${project.config.name} (${project.config.main}, native-fetch)`);
}

async function build(directory?: string) {
  const project = await readProject(directory);
  console.log("Compiling the native-fetch server with Porffor in the pinned build image...");
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
  let config: SproutboatConfig | undefined;
  if (artifactIndex >= 0) {
    artifactDir = args[artifactIndex + 1] ? resolve(args[artifactIndex + 1]) : fail("--artifact requires a directory");
    projectName = "";
  } else {
    const built = await build(args[0]);
    projectName = built.project.config.name;
    artifactDir = built.artifact.artifactDir;
    config = built.project.config;
  }
  const manifest = Bun.file(resolve(artifactDir, "manifest.json"));
  const worker = Bun.file(resolve(artifactDir, "worker"));
  if (!(await manifest.exists()) || !(await worker.exists())) fail("artifact must contain manifest.json and worker");
  const manifestValidation = validateManifest(await manifest.json());
  if (!manifestValidation.ok) fail(`invalid artifact manifest: ${manifestValidation.errors.join(", ")}`);
  const artifactManifest: ArtifactManifest = manifestValidation.value;
  if (artifactIndex >= 0) projectName = artifactManifest.project;

  printDeployReport(
    config ?? { name: projectName, main: "", compatibility_date: "(prebuilt artifact)" },
    artifactManifest,
    new Uint8Array(await worker.arrayBuffer()),
    manifest.size,
  );
  if (dryRun) {
    console.log("\n--dry-run: not uploading.");
    return;
  }
  const { apiUrl, token } = await apiCredentials();
  const digest = artifactManifest.binaryHash.replace(/^sha256:/, "");
  if (digest) {
    const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api/projects/${projectName}/deployments`, { headers: { "x-api-key": token } });
    const deployments = parseDeploymentList(await responseText(response, "could not check existing deployments"));
    if (!deployments) fail("could not parse deployment list response");
    const active = deployments.find((deployment) => deployment.active && deployment.artifact === digest);
    if (active) {
      console.log(`Nothing to deploy — artifact ${digest.slice(0, 12)} is already active`);
      console.log(`https://${active.hostname}`);
      return;
    }
  }
  const form = new FormData();
  form.set("manifest", new File([await manifest.arrayBuffer()], "manifest.json", { type: "application/json" }));
  form.set("worker", new File([await worker.arrayBuffer()], "worker", { type: "application/octet-stream" }));
  const response = await fetch(`${apiUrl.replace(/\/$/, "")}/api/projects/${projectName}/deployments`, {
    method: "POST",
    headers: { "x-api-key": token },
    body: form,
  });
  const body = await responseText(response, "deployment rejected");
  const deployed = parseUrlResponse(body);
  if (!deployed) fail("deployment response did not include a URL");
  console.log(`\nDeployed ${projectName}`);
  console.log(`  ${deployed.url}`);
}

function parseLoginArgs(args: string[]) {
  let apiUrl = process.env.SPROUTBOAT_API_URL || defaultApiUrl;
  let token: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (args[index] === "--api-url" && value) apiUrl = value;
    else if (args[index] === "--token" && value) token = value;
    else fail("usage: sproutboat login [--api-url <url>] [--token <token>]");
  }
  return { apiUrl: apiUrl.replace(/\/$/, ""), token };
}

async function login(args: string[]) {
  const { apiUrl, token: directToken } = parseLoginArgs(args);
  // Self-hosted / non-interactive: skip the browser flow and store the token
  // the admin already holds (e.g. SPROUTBOAT_BOOTSTRAP_TOKEN).
  if (directToken) {
    await saveToken(apiUrl, directToken);
    console.log(`Saved credentials for ${apiUrl}.`);
    return;
  }
  const response = await fetch(`${apiUrl}/api/cli/authorizations`, { method: "POST" });
  const body = await responseText(response, "could not start login");
  const authorization = parseAuthorization(body);
  if (!authorization) fail("login response did not include a valid authorization request");
  const verificationUrl = new URL(authorization.verificationUri, `${apiUrl}/`).toString();
  const openCommand = process.platform === "darwin" ? ["open", verificationUrl] : process.platform === "win32" ? ["cmd", "/c", "start", "", verificationUrl] : ["xdg-open", verificationUrl];
  try { Bun.spawn(openCommand, { stdout: "ignore", stderr: "ignore" }); }
  catch { console.log(`Open ${verificationUrl}`); }
  console.log("Opening the browser to approve this CLI login.");
  console.log(`Confirm code: ${authorization.userCode}`);
  while (new Date(authorization.expiresAt).getTime() > Date.now()) {
    await Bun.sleep(Math.max(authorization.interval, 1) * 1000);
    const exchange = await fetch(`${apiUrl.replace(/\/$/, "")}/api/cli/authorizations/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: authorization.deviceCode }),
    });
    if (exchange.status === 428) continue;
    const result = await exchange.text();
    if (!exchange.ok) fail(`login failed (${exchange.status}): ${result}`);
    const token = parseToken(result);
    if (!token) fail("login response did not include a CLI token");
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
  const snapshotPath = resolve(built.project.directory, ".sproutboat/dev-routes.json");
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
      SPROUTBOAT_ROUTE_SNAPSHOT: snapshotPath,
    },
  });
  process.on("SIGINT", () => child.kill());
  process.exitCode = await child.exited;
}

async function apiCredentials() {
  const apiUrl = (process.env.SPROUTBOAT_API_URL || await activeApiUrl() || defaultApiUrl).replace(/\/$/, "");
  const token = process.env.SPROUTBOAT_TOKEN || await savedToken(apiUrl);
  if (!token) fail("not logged in; run sproutboat login or set SPROUTBOAT_TOKEN for this command");
  return { apiUrl, token };
}

async function versions(args: string[]) {
  if (args[0] !== "list") fail("usage: sproutboat versions list [project-directory]");
  const [project, { apiUrl, token }] = await Promise.all([readProject(args[1]), apiCredentials()]);
  const response = await fetch(`${apiUrl}/api/projects/${project.config.name}/deployments`, { headers: { "x-api-key": token } });
  const deployments = parseVersionList(await responseText(response, "could not list versions"));
  if (!deployments) fail("could not parse versions response");
  for (const deployment of deployments) console.log(`${deployment.active ? "*" : " "} ${deployment.id} ${deployment.artifact.slice(0, 12)} ${deployment.deployedAt}`);
}

async function rollback(args: string[]) {
  const id = args[0];
  if (!id) fail("usage: sproutboat rollback <version-id> [project-directory]");
  const [project, { apiUrl, token }] = await Promise.all([readProject(args[1]), apiCredentials()]);
  const response = await fetch(`${apiUrl}/api/projects/${project.config.name}/deployments/${id}/activate`, { method: "POST", headers: { "x-api-key": token } });
  const deployment = parseUrlResponse(await responseText(response, "rollback rejected"));
  if (!deployment) fail("rollback response did not include a URL");
  console.log(`Rolled back ${project.config.name}`);
  console.log(deployment.url);
}

async function tail(args: string[]) {
  const [project, { apiUrl, token }] = await Promise.all([readProject(args[0]), apiCredentials()]);
  const response = await fetch(`${apiUrl}/api/projects/${project.config.name}/logs/recent`, { headers: { "x-api-key": token } });
  process.stdout.write(await responseText(response, "could not read logs"));
}

async function deleteProject(args: string[]) {
  if (args[0] !== "--yes") fail("refusing to delete without --yes");
  const [project, { apiUrl, token }] = await Promise.all([readProject(args[1]), apiCredentials()]);
  const response = await fetch(`${apiUrl}/api/projects/${project.config.name}`, { method: "DELETE", headers: { "x-api-key": token } });
  await responseText(response, "delete rejected");
  console.log(`Deleted ${project.config.name}`);
}

function usage(): never {
  console.error("usage: sproutboat <init [name]|check|build|dev [directory] [--port <port>]|login [--api-url <url>] [--token <token>]|deploy [--dry-run|--artifact <path>]|tail|versions list|rollback <version-id>|delete --yes>");
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
