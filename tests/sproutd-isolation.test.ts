import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Design 05, phase 1, exit criterion: `sbctl update` does not touch sproutd. sproutd is private and updates on
// its own track, so nothing the installer, the updater or sbctl does may name it. If one of these files ever
// mentions sproutd, that is a decision to make on purpose (and to change this test with), not by accident.
const root = resolve(import.meta.dir, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("install.sh, the updater, sbctl and the shipped units never mention sproutd", () => {
  for (const file of [
    "install.sh",
    "infra/sbctl",
    "infra/sb-update",
    "infra/systemd/sproutboat-control.service",
    "infra/systemd/sproutboat-edge.service",
    "infra/systemd/sproutboat-egress.service",
    "infra/systemd/sproutboat-backup.service",
    "infra/systemd/sproutboat-backup.timer",
  ])
    expect([file, /sproutd/i.test(read(file))]).toEqual([file, false]);
});

test("the restart that an update performs names only the platform units", () => {
  const restart = read("install.sh")
    .split("\n")
    .find((line) => /^\s*systemctl restart /.test(line));
  expect(restart?.trim()).toBe("systemctl restart sproutboat-control sproutboat-egress sproutboat-edge");
  expect(read("infra/sbctl")).toContain("SERVICES=(sproutboat-control sproutboat-egress sproutboat-edge caddy)");
});
