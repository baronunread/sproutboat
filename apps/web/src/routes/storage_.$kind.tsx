import { createFileRoute } from "@tanstack/react-router";
import { StorageView, type ResourceKind } from "../storage-view";

const KINDS = new Set(["kv", "d1", "r2", "queue"]);

/** One storage kind, the way Cloudflare gives KV, D1, R2 and Queues their own pages. */
export const Route = createFileRoute("/storage_/$kind")({
  component: StorageKind,
  head: ({ params }) => ({ meta: [{ title: `${params.kind.toUpperCase()} · Sproutboat` }] }),
});

function StorageKind() {
  const { kind } = Route.useParams();
  // SAFETY: the set holds exactly the ResourceKind members, so a hit narrows the
  // segment to that union; an unknown segment falls back to the unfiltered list.
  return KINDS.has(kind) ? <StorageView kind={kind as ResourceKind} /> : <StorageView />;
}
