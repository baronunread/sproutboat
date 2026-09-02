import { createFileRoute } from "@tanstack/react-router";
import { PRODUCTS } from "../products";
import { CreateResource } from "../resource-product";

export const Route = createFileRoute("/queues_/new")({
  component: () => <CreateResource product={PRODUCTS.queues} />,
  head: () => ({ meta: [{ title: "Create queue · Sproutboat" }] }),
});
