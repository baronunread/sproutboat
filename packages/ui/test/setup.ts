import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A DOM for component tests. Run through `bun run --cwd packages/ui test`, which
// is its own process, so these globals never reach the apps/services suites.
if (!globalThis.document) GlobalRegistrator.register({ url: "http://localhost/" });
