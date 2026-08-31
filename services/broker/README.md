# services/broker

The per-deployment bindings broker (KV / secrets / D1 / R2 / queues / analytics /
Durable Object storage, plus the cron + queue trigger delivery loop).

`broker.ts` is **vendored verbatim** from `sproutboat-cli/src/broker.ts`, which is
the canonical copy — its `broker.test.ts` is the test of record (run there). The
supervisor (`services/supervisor/src/run.ts`) spawns one broker per deployment
that ships a `bindings.json`, passing `SB_BROKER_PORT` / `SB_BROKER_TOKEN` to the
worker and `--worker-url` back to the broker.
