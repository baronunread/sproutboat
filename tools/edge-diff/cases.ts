import type { Case } from "./runner";
import { assetCases } from "./cases-assets";
import { cacheCases } from "./cases-cache";
import { coreCases } from "./cases-core";
import { intentionalCases } from "./cases-intentional";
import { bindingCases } from "./cases-bindings";
import { reloadCases } from "./cases-reload";
import { wsCases } from "./cases-ws";

export const cases: Case[] = [
  ...coreCases,
  ...cacheCases,
  ...assetCases,
  ...wsCases,
  ...bindingCases,
  ...reloadCases,
  ...intentionalCases,
];

const seen = new Set<string>();
for (const c of cases) {
  if (seen.has(c.id)) throw new Error(`duplicate case id ${c.id}`);
  seen.add(c.id);
}
