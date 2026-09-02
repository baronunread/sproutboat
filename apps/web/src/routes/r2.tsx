import { createFileRoute } from "@tanstack/react-router";
import { PRODUCTS } from "../products";
import { ResourceList } from "../resource-product";

export const Route = createFileRoute("/r2")({
  component: () => <ResourceList product={PRODUCTS.r2} />,
  head: () => ({ meta: [{ title: "R2 buckets · Sproutboat" }] }),
});
