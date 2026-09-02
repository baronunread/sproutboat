import { createFileRoute } from "@tanstack/react-router";
import { PRODUCTS } from "../products";
import { ResourceList } from "../resource-product";

export const Route = createFileRoute("/queues")({
  component: () => <ResourceList product={PRODUCTS.queues} />,
  head: () => ({ meta: [{ title: "Queues · Sproutboat" }] }),
});
