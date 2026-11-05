import { basename, dirname } from "node:path";

/**
 * The name a deployment's sprout log (`logs/sprouts/<name>.log`) and broker
 * state (`brokers/<name>/`) are kept under: the last two directory segments of
 * the sprout path, `<ownerDir>-<digest>` for an artifact the control plane
 * placed at `artifacts/<ownerDir>/<digest>/sprout`. Control derives the same
 * name in apps/control/src/logs.ts (contract-tested), so two accounts holding
 * byte-identical artifacts never share a log or a state directory.
 */
export function runtimeName(sproutPath: string): string {
  const dir = dirname(sproutPath);
  return `${basename(dirname(dir))}-${basename(dir)}`;
}
