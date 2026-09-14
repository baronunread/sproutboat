import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Box } from "lucide-react";
import { ActionsTh, DataTable, EmptyState, Panel, StatusMessage, TextField, FILTER_SEARCH } from "../components";
import { relativeTime, useJson } from "../dashboard-data";

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

const UNITS = ["B", "KB", "MB", "GB"] as const;
/** No formatting library for one call site — 1024-based, one decimal past KB. */
function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`;
}

/**
 * #183 — read-only: list objects, download one. No upload/delete/rename here,
 * same as #136's KV/D1 explorer milestone leaves those out for its own kinds.
 */
function R2ObjectBrowser() {
  const { id } = Route.useParams();
  const [prefix, setPrefix] = useState("");
  const [pages, setPages] = useState<R2Object[][]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const listUrl = `/api/r2/${encodeURIComponent(id)}/objects${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ""}`;
  const { data, state } = useJson<ObjectsPage>(listUrl);

  const objects = data ? [...pages.flat(), ...(pages.length === 0 ? data.objects : [])] : [];
  // pages accumulates only what "Load more" fetched; the first page comes
  // straight from useJson and is re-fetched whenever the prefix changes, so
  // reset pages/cursor for a new filter rather than mixing pages across it.
  const effectiveCursor = pages.length === 0 ? (data?.cursor ?? null) : cursor;

  const loadMore = async () => {
    if (!effectiveCursor) return;
    setLoadingMore(true);
    try {
      const response = await fetch(
        `/api/r2/${encodeURIComponent(id)}/objects?limit=100&cursor=${encodeURIComponent(effectiveCursor)}${
          prefix ? `&prefix=${encodeURIComponent(prefix)}` : ""
        }`,
        { credentials: "include" },
      );
      if (!response.ok) return;
      // SAFETY: response.ok above is listR2Objects' own contract for this shape.
      const page = (await response.json()) as ObjectsPage;
      setPages((prior) => [...prior, page.objects]);
      setCursor(page.cursor);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="mx-auto max-w-[64rem]">
      <Link
        className="mb-7 inline-flex min-h-10 items-center gap-2 rounded-lg px-2 text-[0.82rem] font-medium text-muted-foreground no-underline transition-colors hover:bg-accent hover:text-foreground"
        to="/r2"
      >
        <ArrowLeft className="size-4" aria-hidden="true" strokeWidth={1.5} />
        Back to R2 buckets
      </Link>

      <header className="mb-8 flex items-start gap-4">
        <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-brand/12 ring-1 ring-brand/25 [&_svg]:size-6">
          <Box className="size-6 text-brand" aria-hidden="true" strokeWidth={1.5} />
        </div>
        <div>
          <h1 className="m-0 text-[2rem] leading-tight font-bold tracking-[-0.04em] max-[480px]:text-[1.7rem]">
            Objects
          </h1>
          <p className="mt-2 max-w-[42rem] text-[0.9rem] leading-relaxed text-muted-foreground">
            Read-only: browse and download what's stored in <code>{id}</code>.
          </p>
        </div>
      </header>

      <Panel variant="bare">
        <div className="flex flex-wrap items-end gap-2.5 px-5 py-[1.1rem]">
          <TextField
            label="Filter by key prefix"
            hideLabel
            type="search"
            fieldClassName={FILTER_SEARCH}
            placeholder="Filter by key prefix…"
            value={prefix}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setPrefix(event.target.value);
              setPages([]);
              setCursor(null);
            }}
          />
        </div>

        {state === "loading" ? (
          <p className="min-h-56 px-5 pt-12 text-muted-foreground group-[.is-padded]/panel:px-0" aria-live="polite">
            Loading objects…
          </p>
        ) : state === "error" ? (
          <StatusMessage tone="error">Could not load objects. Refresh and try again.</StatusMessage>
        ) : objects.length === 0 ? (
          <EmptyState title={prefix ? `Nothing matches "${prefix}"` : "No objects yet"}>
            <p>Objects land here once a deployment writes to this bucket.</p>
          </EmptyState>
        ) : (
          <>
            <DataTable
              caption={`Objects in ${id}`}
              head={
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Size</th>
                  <th scope="col">Content type</th>
                  <th scope="col">Uploaded</th>
                  <ActionsTh />
                </tr>
              }
            >
              {objects.map((object) => (
                <tr key={object.key}>
                  <td>
                    <code title={object.key}>{object.key}</code>
                  </td>
                  <td>{formatBytes(object.size)}</td>
                  <td>{object.httpMetadata?.contentType || "-"}</td>
                  <td>{relativeTime(object.uploaded)}</td>
                  <td className="text-end">
                    <a
                      className="text-[0.8rem] text-sky underline-offset-2 hover:underline"
                      href={`/api/r2/${encodeURIComponent(id)}/objects/${encodeURIComponent(object.key)}`}
                    >
                      Download
                    </a>
                  </td>
                </tr>
              ))}
            </DataTable>
            {effectiveCursor && (
              <button
                type="button"
                className="mt-3 text-[0.82rem] font-medium text-muted-foreground hover:text-foreground disabled:opacity-60"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
