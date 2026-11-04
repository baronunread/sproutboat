import type { Case } from "./runner";
import { assetCases } from "./cases-assets";
import { cacheCases } from "./cases-cache";
import { coreCases } from "./cases-core";
import { intentionalCases } from "./cases-intentional";
import { reloadCases } from "./cases-reload";
import { wsCases } from "./cases-ws";

export const cases: Case[] = [
  ...coreCases,
  ...cacheCases,
  ...assetCases,
  ...wsCases,
  ...reloadCases,
  ...intentionalCases,
];

const seen = new Set<string>();
for (const c of cases) {
  if (seen.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
  seen.add(c.id);
}
