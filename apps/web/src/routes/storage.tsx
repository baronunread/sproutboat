import { createFileRoute } from "@tanstack/react-router";
import { StorageView } from "../storage-view";

/**
 * #74/#76 — account-level storage resources in the UI. They are created and
 * deleted independently of any deploy, keyed by a stable `<kind>_<id>` handle
 * that a project binds by id, so data survives a redeploy and can be shared.
 */
export const Route = createFileRoute("/storage")({
  component: () => <StorageView />,
  head: () => ({ meta: [{ title: "Storage · Sproutboat" }] }),
});
