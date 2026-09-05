import type { Product } from "./resource-product";

/**
 * #77 — the four storage products, each with its own page and API collection.
 *
 * `bindingExample` is written multi-line on purpose. The rail renders it in a
 * <pre> so the indentation stands and nothing wraps mid-token in an 18rem
 * column; the list's empty state renders the same string in a <code>, where
 * HTML collapses the newlines back into the one-liner that suits a wide panel.
 */
export const PRODUCTS = {
  kv: {
    segment: "kv",
    title: "KV namespaces",
    noun: "namespace",
    description: "Low-latency key-value storage, read from any sprout with a KV binding.",
    bindingExample: '"bindings": {\n  "kv": {\n    "SESSIONS": { "id": "kv_…" }\n  }\n}',
    icon: "kv",
  },
  d1: {
    segment: "d1",
    title: "D1 databases",
    noun: "database",
    description: "SQL databases your sprouts query through a D1 binding.",
    bindingExample: '"bindings": {\n  "d1": {\n    "DB": { "id": "d1_…" }\n  }\n}',
    icon: "d1",
  },
  r2: {
    segment: "r2",
    title: "R2 buckets",
    noun: "bucket",
    description: "Object storage for files and blobs, bound by id and shared across projects.",
    bindingExample: '"bindings": {\n  "r2": {\n    "MEDIA": { "id": "r2_…" }\n  }\n}',
    icon: "r2",
  },
  queues: {
    segment: "queues",
    title: "Queues",
    noun: "queue",
    description: "Message queues a sprout can produce to and consume from, with retries and a dead-letter path.",
    bindingExample: '"bindings": {\n  "queues": {\n    "JOBS": { "id": "queue_…" }\n  }\n}',
    icon: "queues",
  },
} as const satisfies Record<string, Product>;
