import { createFileRoute } from "@tanstack/react-router";
import { PRODUCTS } from "../products";
import { ResourceList } from "../resource-product";

export const Route = createFileRoute("/kv")({
  component: () => <ResourceList product={PRODUCTS.kv} />,
  head: () => ({ meta: [{ title: "KV namespaces · Sproutboat" }] }),
});
