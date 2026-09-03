import type { Product } from "./resource-product";

/** #77 — the four storage products, each with its own page and API collection. */
export const PRODUCTS = {
  kv: {
    segment: "kv",
    title: "KV namespaces",
    noun: "namespace",
    description: "Low-latency key-value storage, read from any sprout with a KV binding.",
    bindingExample: '"bindings": { "kv": { "SESSIONS": { "id": "kv_…" } } }',
    icon: "kv",
  },
  d1: {
    segment: "d1",
    title: "D1 databases",
    noun: "database",
    description: "SQL databases your sprouts query through a D1 binding.",
    bindingExample: '"bindings": { "d1": { "DB": { "id": "d1_…" } } }',
    icon: "d1",
  },
  r2: {
    segment: "r2",
    title: "R2 buckets",
    noun: "bucket",
    description: "Object storage for files and blobs, bound by id and shared across projects.",
    bindingExample: '"bindings": { "r2": { "MEDIA": { "id": "r2_…" } } }',
    icon: "r2",
  },
  queues: {
    segment: "queues",
    title: "Queues",
    noun: "queue",
    description: "Message queues a sprout can produce to. Consumers are not implemented yet (#82).",
    bindingExample: '"bindings": { "queues": { "JOBS": { "id": "queue_…" } } }',
    icon: "queues",
  },
} as const satisfies Record<string, Product>;
