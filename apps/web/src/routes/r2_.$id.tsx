import {
  Breadcrumbs,
  DescriptionList,
  EmptyState,
  Field,
  Input,
  Link,
  PageHeader,
  Pagination,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableLoading,
  TableRow,
  UsageMeter,
  formatBytes,
} from "@sproutboat/ikada";
import { createFileRoute, Link as RouterLink } from "@tanstack/react-router";
import { useState } from "react";
import { relativeTime, useJson } from "../dashboard-data";
import { LoadError } from "../page-state";

export const Route = createFileRoute("/r2_/$id")({
  component: R2ObjectBrowser,
  head: () => ({ meta: [{ title: "Bucket objects · Sproutboat" }] }),
});

type R2Object = {
  key: string;
  size: number;
  etag: string;
  uploaded: string;
  httpMetadata?: { contentType?: string };
};
type ObjectsPage = { objects: R2Object[]; cursor: string | null };
type R2Usage = {
  usedBytes: number;
  reservedBytes: number;
  quotaBytes: number;
  availableBytes: number;
  ticketsIssued: number;
  rejectedQuota: number;
  rejectedDisk: number;
  rejectedSize: number;
};

/** Rows per table page. The API pages by cursor, so more rows are fetched as the reader walks forward. */
const PAGE_SIZE = 25;

/**
 * #183: read-only: list objects, download one. No upload, delete or rename here.
 * The list endpoint is cursor-based, so the pagination below counts the pages loaded so far and
 * adds one more while a cursor remains; stepping onto that page fetches it.
 */
function R2ObjectBrowser() {
  const { id } = Route.useParams();
  const [prefix, setPrefix] = useState("");
  const [more, setMore] = useState<R2Object[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [fetchedMore, setFetchedMore] = useState(false);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const listUrl = `/api/r2/${encodeURIComponent(id)}/objects${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ""}`;
  const { data, state, refresh } = useJson<ObjectsPage>(listUrl);
  const { data: usage } = useJson<R2Usage>("/api/r2/usage");

  const objects = data ? [...data.objects, ...more] : [];
  const effectiveCursor = fetchedMore ? cursor : (data?.cursor ?? null);
  const loadedPages = Math.max(1, Math.ceil(objects.length / PAGE_SIZE));
  const pageCount = loadedPages + (effectiveCursor ? 1 : 0);
  const visible = objects.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const resetPaging = () => {
    setMore([]);
    setCursor(null);
    setFetchedMore(false);
    setPage(1);
    setMoreFailed(false);
  };

  const goTo = async (next: number) => {
    if (next <= loadedPages) {
      setPage(next);
      return;
    }
    if (!effectiveCursor) return;
    setLoadingMore(true);
    setMoreFailed(false);
    try {
      const response = await fetch(
        `/api/r2/${encodeURIComponent(id)}/objects?limit=100&cursor=${encodeURIComponent(effectiveCursor)}${
          prefix ? `&prefix=${encodeURIComponent(prefix)}` : ""
        }`,
        { credentials: "include" },
      );
      if (!response.ok) {
        setMoreFailed(true);
        return;
      }
      // SAFETY: response.ok above is listR2Objects' own contract for this shape.
      const body = (await response.json()) as ObjectsPage;
      setMore((prior) => [...prior, ...body.objects]);
      setCursor(body.cursor);
      setFetchedMore(true);
      setPage(next);
    } catch {
      setMoreFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        breadcrumbs={
          <Breadcrumbs
            items={[
              { id: "r2", label: "R2 buckets", render: <RouterLink to="/r2" /> },
              { id: "bucket", label: <code className="font-mono text-sm">{id}</code>, text: id },
            ]}
          />
        }
        title="Objects"
        description={
          <>
            Read-only: browse and download what is stored in <code>{id}</code>.
          </>
        }
      />

      {usage ? (
        <section
          aria-label="Bucket storage"
          className="grid gap-6 rounded-xl bg-surface p-5 shadow-card md:grid-cols-2"
        >
          <UsageMeter
            label="Account storage"
            used={usage.usedBytes}
            limit={usage.quotaBytes}
            formatValue={(n) => formatBytes(n)}
          />
          <DescriptionList
            items={[
              { id: "reserved", term: "Reserved by uploads", details: formatBytes(usage.reservedBytes) },
              { id: "tickets", term: "Transfer tickets", details: String(usage.ticketsIssued) },
              {
                id: "rejected",
                term: "Rejected transfers",
                details: String(usage.rejectedQuota + usage.rejectedDisk + usage.rejectedSize),
              },
            ]}
          />
        </section>
      ) : null}

      {state === "error" ? (
        <LoadError what="objects" onRetry={() => void refresh()} />
      ) : state === "ready" && objects.length === 0 && !prefix ? (
        <div className="rounded-xl bg-surface p-4 shadow-card">
          <EmptyState title="No objects yet" description="Objects land here once a deployment writes to this bucket." />
        </div>
      ) : (
        <>
          <div className="w-full max-w-md">
            <Field label="Filter by key prefix" className="[&>label]:sr-only">
              <Input
                type="search"
                placeholder="Filter by key prefix…"
                value={prefix}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setPrefix(event.target.value);
                  resetPaging();
                }}
              />
            </Field>
          </div>
          <Table label={`Objects in ${id}`} aria-busy={state === "loading" || undefined}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Key</TableHead>
                <TableHead className="text-end">Size</TableHead>
                <TableHead hideBelow="md">Content type</TableHead>
                <TableHead hideBelow="lg">Uploaded</TableHead>
                <TableHead className="text-end">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state === "loading" ? (
                <TableLoading columns={5} />
              ) : visible.length === 0 ? (
                <TableEmpty colSpan={5}>
                  <span className="text-fg-muted">Nothing matches “{prefix}”.</span>
                </TableEmpty>
              ) : (
                visible.map((object) => (
                  <TableRow key={object.key}>
                    <TableCell className="min-w-48">
                      <code className="break-all" title={object.key}>
                        {object.key}
                      </code>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-end tabular-nums">
                      {formatBytes(object.size)}
                    </TableCell>
                    <TableCell hideBelow="md" className="text-fg-muted">
                      {object.httpMetadata?.contentType || "-"}
                    </TableCell>
                    <TableCell hideBelow="lg" className="whitespace-nowrap text-fg-muted tabular-nums">
                      {relativeTime(object.uploaded)}
                    </TableCell>
                    <TableCell className="text-end">
                      <Link
                        href={`/api/r2/${encodeURIComponent(id)}/objects/${encodeURIComponent(object.key)}`}
                        aria-label={`Download ${object.key}`}
                      >
                        Download
                      </Link>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {moreFailed ? (
            <p role="alert" className="text-sm text-danger-fg">
              Could not load more objects. Try the next page again.
            </p>
          ) : null}
          {pageCount > 1 ? (
            <div className="flex justify-center" aria-busy={loadingMore || undefined}>
              <Pagination
                className="max-sm:hidden"
                page={page}
                pageCount={pageCount}
                onPageChange={(next) => void goTo(next)}
              />
              <Pagination
                className="sm:hidden"
                compact
                page={page}
                pageCount={pageCount}
                onPageChange={(next) => void goTo(next)}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
