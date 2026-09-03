import { createFileRoute } from "@tanstack/react-router";
import { PRODUCTS } from "../products";
import { ResourceList } from "../resource-product";

export const Route = createFileRoute("/d1")({
  component: () => <ResourceList product={PRODUCTS.d1} />,
  head: () => ({ meta: [{ title: "D1 databases · Sproutboat" }] }),
});
