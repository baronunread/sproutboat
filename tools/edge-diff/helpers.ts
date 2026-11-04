/** Shared builders for the case files. */
import { join } from "node:path";
import type { Fixture, Hdrs, HttpObs, Json, ReqSpec } from "./lib";
import { bodyText } from "./lib";
import type { Case, Ctx } from "./runner";

export type Kind = "sup" | "sproutd";

/** A supervisor route: the stand-in sprout runs under the real pool. */
export async function supRoute(
  fx: Fixture,
  host = "app.test",
  name = "app",
  opts?: Parameters<Fixture["makeSprout"]>[1],
) {
  return { hostname: host, sproutPath: await fx.makeSprout(name, opts) };
}

/** A sproutd route: forwards to a fake backend (`sproutPath` is still required by the loader). */
export async function backendRoute(fx: Fixture, host = "app.test", name = "app") {
  const app = fx.apps.get(name) ?? (await fx.startApp(name));
  return {
    hostname: host,
    sproutPath: join(fx.dir, "artifacts", name, "sprout"),
    backend: { kind: "sproutd", url: app.url },
  };
}

export const kindRoute = (fx: Fixture, kind: Kind, host = "app.test", name = "app") =>
  kind === "sup" ? supRoute(fx, host, name) : backendRoute(fx, host, name);

/** One case per route kind (supervisor sprout, sproutd backend). */
export function both(
  id: string,
  group: string,
  make: (kind: Kind) => Omit<Case, "id" | "group" | "setup"> & { setup?: Case["setup"] },
): Case[] {
  return (["sup", "sproutd"] as const).map((kind) => {
    const body = make(kind);
    return { id: `${id}.${kind}`, group, setup: async (fx: Fixture) => [await kindRoute(fx, kind)], ...body };
  });
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
