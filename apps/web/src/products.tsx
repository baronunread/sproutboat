import type { Product } from "./resource-product";

/**
 * #77 - the four storage products, each with its own page and API collection.
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
    exampleName: "sessions",
    nameHint: "Name it after the data it will hold, such as sessions, flags, or cache.",
    nextStep: "Add the generated namespace id to a KV binding in sproutboat.jsonc.",
    idPrefix: "kv",
    bindingExample: '"bindings": {\n  "kv": {\n    "SESSIONS": { "id": "kv_…" }\n  }\n}',
    icon: "kv",
  },
  d1: {
    segment: "d1",
    title: "D1 databases",
    noun: "database",
    description: "SQL databases your sprouts query through a D1 binding.",
    exampleName: "app-data",
    nameHint: "Use a stable name for the dataset, such as app-data or customer-records.",
    nextStep: "Add the generated database id to a D1 binding, then run your migrations.",
    idPrefix: "d1",
    bindingExample: '"bindings": {\n  "d1": {\n    "DB": { "id": "d1_…" }\n  }\n}',
    icon: "d1",
  },
  r2: {
    segment: "r2",
    title: "R2 buckets",
    noun: "bucket",
    description: "Object storage for files and blobs, bound by id and shared across projects.",
    exampleName: "uploads",
    nameHint: "Name it after the objects it will contain, such as uploads, media, or exports.",
    nextStep: "Add the generated bucket id to an R2 binding before uploading objects.",
    idPrefix: "r2",
    bindingExample: '"bindings": {\n  "r2": {\n    "MEDIA": { "id": "r2_…" }\n  }\n}',
    icon: "r2",
  },
  queues: {
    segment: "queues",
    title: "Queues",
    noun: "queue",
    description: "Message queues a sprout can produce to and consume from, with retries and a dead-letter path.",
    exampleName: "background-jobs",
    nameHint: "Name it after the work it carries, such as background-jobs or email-delivery.",
    nextStep: "Add the generated queue id to a producer or consumer binding in your project.",
    idPrefix: "queue",
    bindingExample: '"bindings": {\n  "queues": {\n    "JOBS": { "id": "queue_…" }\n  }\n}',
    icon: "queues",
  },
} as const satisfies Record<string, Product>;
