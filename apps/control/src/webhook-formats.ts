/**
 * Webhook bodies. `json` is the platform's own envelope; `discord` is the embed
 * shape Discord accepts on a channel webhook URL. The signature header is added
 * by the sender for both, over the exact bytes produced here.
 */
import type { EventData } from "./events";

export type WebhookFormat = "json" | "discord";

export type WebhookPayload = {
  id: number;
  type: string;
  ts: string;
  account: string;
  project: string | null;
  actor: string | null;
  summary: string;
  data: EventData;
};

const GREEN = 0x2ecc71;
const RED = 0xe74c3c;
const AMBER = 0xf59e0b;
const GREY = 0x95a5a6;

export function discordColor(type: string): number {
  if (type.endsWith(".failed")) return RED;
  if (type.endsWith(".rolled_back") || type.endsWith(".disabled")) return AMBER;
  if (type.endsWith(".succeeded") || type.endsWith(".verified") || type.endsWith(".created")) return GREEN;
  return GREY;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

export function discordBody(payload: WebhookPayload) {
  const fields = Object.entries(payload.data)
    .slice(0, 25)
    .map(([name, value]) => ({ name: clip(name, 256), value: clip(String(value) || "-", 1024), inline: true }));
  const by = payload.actor ? ` by ${payload.actor}` : "";
  return {
    embeds: [
      {
        title: clip(payload.summary, 256),
        description: clip(`${payload.type}${by}`, 4096),
        color: discordColor(payload.type),
        timestamp: payload.ts,
        fields,
        footer: { text: `Sproutboat · ${payload.project ?? payload.account}` },
      },
    ],
  };
}

export function webhookBody(format: WebhookFormat, payload: WebhookPayload): string {
  return JSON.stringify(format === "discord" ? discordBody(payload) : payload);
}
