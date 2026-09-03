import { createFileRoute } from "@tanstack/react-router";
import { PRODUCTS } from "../products";
import { CreateResource } from "../resource-product";

export const Route = createFileRoute("/r2_/new")({
  component: () => <CreateResource product={PRODUCTS.r2} />,
  head: () => ({ meta: [{ title: "Create bucket · Sproutboat" }] }),
});
