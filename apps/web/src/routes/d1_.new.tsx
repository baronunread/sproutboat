import { createFileRoute } from "@tanstack/react-router";
import { PRODUCTS } from "../products";
import { CreateResource } from "../resource-product";

export const Route = createFileRoute("/d1_/new")({
  component: () => <CreateResource product={PRODUCTS.d1} />,
  head: () => ({ meta: [{ title: "Create database · Sproutboat" }] }),
});
