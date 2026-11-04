/** Shared builders for the case files. */
import type { Fixture, Hdrs, HttpObs, Json, ReqSpec } from "./lib";
import { bodyText } from "./lib";
import type { Case, Ctx } from "./runner";

/** A supervisor route: the stand-in sprout runs under the real pool. */
export async function supRoute(
  fx: Fixture,
  host = "app.test",
  name = "app",
  opts?: Parameters<Fixture["makeSprout"]>[1],
) {
  return { hostname: host, sproutPath: await fx.makeSprout(name, opts) };
}

/** A case on a supervisor route (the stand-in sprout runs under the real pool). */
export function supCase(
  id: string,
  group: string,
  make: () => Omit<Case, "id" | "group" | "setup"> & { setup?: Case["setup"] },
): Case[] {
  return [{ id, group, setup: async (fx: Fixture) => [await supRoute(fx)], ...make() }];
}

export const text = (obs: HttpObs) => bodyText(obs);
export const json = (obs: HttpObs): Json => {
  try {
    const parsed: Json = JSON.parse(bodyText(obs));
    return parsed;
  } catch {
    return `<not json: ${bodyText(obs).slice(0, 60)}>`;
  }
};
export const header = (obs: HttpObs, name: string) => obs.headers.find(([key]) => key === name)?.[1] ?? null;

/** Request `path` (GET) and return the observation. */
export const get = (ctx: Ctx, label: string, path: string, extra: ReqSpec = {}) => ctx.req(label, { path, ...extra });

export const bytes = (n: number, fill = 0x61) => new Uint8Array(n).fill(fill);
/** A deterministic, non-text byte pattern. */
export const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
export const hdrs = (...pairs: [string, string][]): Hdrs => pairs;
