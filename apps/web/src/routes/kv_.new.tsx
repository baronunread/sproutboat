import { createFileRoute } from "@tanstack/react-router";
import { PRODUCTS } from "../products";
import { CreateResource } from "../resource-product";

export const Route = createFileRoute("/kv_/new")({
  component: () => <CreateResource product={PRODUCTS.kv} />,
  head: () => ({ meta: [{ title: "Create namespace · Sproutboat" }] }),
});
