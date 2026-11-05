import {
  ActivityIcon,
  Badge,
  Banner,
  Button,
  ChevronDownIcon,
  DatabaseIcon,
  DescriptionList,
  EmptyState,
  Field,
  FolderIcon,
  GlobeIcon,
  KeyIcon,
  Link,
  RocketIcon,
  SegmentedControl,
  Select,
  ShieldIcon,
  Skeleton,
  Switch,
  Tooltip,
  UserIcon,
  cn,
} from "@sproutboat/ikada";
import type { Status } from "@sproutboat/ikada";
import { Link as RouterLink } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { relativeTime, useAccount, useJson } from "./dashboard-data";
import type { Overview } from "./dashboard-data";

/**
 * The Activity feed: what changed on this box, newest first, grouped by day. It is fed by
 * `GET /api/activity` only: nothing from the browser's own toast history is mixed in, so what
 * you read here is the server's record and survives a reload.
 */

export type ActivityEvent = {
  /** The absolute time, formatted once when the event is loaded rather than on every render. */
  stamp: string;
  id: number;
  ts: string;
  project: string | null;
  type: string;
  actor: string | null;
  summary: string;
  data: Record<string, string | number | boolean | null>;
  ownerId?: string;
};
type ActivityPage = { events: Array<Omit<ActivityEvent, "stamp">>; nextBefore: number | null };
const stamped = (events: ActivityPage["events"]): ActivityEvent[] =>
  events.map((event) => ({ ...event, stamp: STAMP.format(new Date(event.ts)) }));
type ActivityTypes = { types: string[]; groups: string[] };

const PAGE_SIZE = 25;

/** The vocabulary's groups by their dotted prefix (`deploy.*` is `deploy`), with the words the UI uses. */
const GROUP_LABELS = new Map([
  ["deploy", "Deploys"],
  ["project", "Projects"],
  ["secret", "Secrets"],
  ["domain", "Domains"],
  ["token", "Tokens"],
  ["member", "Members"],
  ["backup", "Backups"],
  ["webhook", "Webhooks"],
]);

export const groupName = (token: string) => token.split(".")[0] ?? token;
export const groupLabel = (token: string) => GROUP_LABELS.get(groupName(token)) ?? groupName(token);

/** One icon per group; the icon is decoration, the summary and type carry the meaning. */
const GROUP_ICONS = new Map<string, ReactNode>([
  ["deploy", <RocketIcon />],
  ["project", <FolderIcon />],
  ["secret", <KeyIcon />],
  ["domain", <GlobeIcon />],
  ["token", <ShieldIcon />],
  ["member", <UserIcon />],
  ["backup", <DatabaseIcon />],
  ["webhook", <ActivityIcon />],
]);
const groupIcon = (type: string) => GROUP_ICONS.get(groupName(type)) ?? <ActivityIcon />;

/** Failed is red; rolled back and disabled are amber; succeeded, verified and created are green; the rest are neutral. */
export function eventTone(type: string): Status {
  const verb = type.split(".").slice(1).join(".");
  if (verb === "failed") return "danger";
  if (verb === "rolled_back" || verb === "disabled") return "warning";
  if (verb === "succeeded" || verb === "verified" || verb === "created") return "success";
  return "neutral";
}

const iconTone = {
  success: "bg-brand-soft text-brand-fg",
  warning: "bg-warn-soft text-warn-fg",
  danger: "bg-danger-soft text-danger-fg",
  info: "bg-info-soft text-info-fg",
  neutral: "bg-neutral-soft text-neutral-fg",
} satisfies Record<Status, string>;

export function useActivityTypes() {
  return useJson<ActivityTypes>("/api/activity/types");
}

const RANGES = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "all", label: "All" },
] as const;
type Range = (typeof RANGES)[number]["value"];

function sinceFor(range: Range): string | undefined {
  const now = new Date();
  if (range === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  if (range === "7d") return new Date(now.getTime() - 7 * 86_400_000).toISOString();
  if (range === "30d") return new Date(now.getTime() - 30 * 86_400_000).toISOString();
  return undefined;
}

const ALL = "all";
const DAY = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const STAMP = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

function dayKey(ts: string) {
  const date = new Date(ts);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(ts: string) {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (dayKey(ts) === dayKey(today.toISOString())) return "Today";
  if (dayKey(ts) === dayKey(yesterday.toISOString())) return "Yesterday";
  return DAY.format(date);
}

function groupByDay(events: readonly ActivityEvent[]) {
  const days: Array<{ key: string; label: string; events: ActivityEvent[] }> = [];
  for (const event of events) {
    const key = dayKey(event.ts);
    const last = days[days.length - 1];
    if (last?.key === key) last.events.push(event);
    else days.push({ key, label: dayLabel(event.ts), events: [event] });
  }
  return days;
}

/**
 * `project` pins the feed to one project (the per-project tab) and hides the project filter.
 * Admins get an "All accounts" switch that adds `all=1` and shows which account each event is from.
 */
export function ActivityFeed({ project }: { project?: string }) {
  const { account } = useAccount();
  const isAdmin = Boolean(account?.isAdmin);
  const { data: types } = useActivityTypes();
  const { data: overview } = useJson<Overview>(project ? null : "/api/overview");

  const [group, setGroup] = useState(ALL);
  const [projectFilter, setProjectFilter] = useState(ALL);
  const [range, setRange] = useState<Range>("30d");
  const [allAccounts, setAllAccounts] = useState(false);

  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const [nonce, setNonce] = useState(0);

  const wantAll = isAdmin && allAccounts;
  const selectedProject = project ?? (projectFilter === ALL ? undefined : projectFilter);

  const query = (before?: number) => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (selectedProject) params.set("project", selectedProject);
    if (group !== ALL) params.set("type", group);
    const since = sinceFor(range);
    if (since) params.set("since", since);
    if (before !== undefined) params.set("before", String(before));
    if (wantAll) params.set("all", "1");
    return `/api/activity?${params.toString()}`;
  };

  // The first page is refetched whenever a filter changes. `ignore` drops a response that a
  // newer filter has already replaced.
  useEffect(() => {
    let ignore = false;
    setState("loading");
    setOlderFailed(false);
    void fetch(query(), { credentials: "include" })
      .then(async (response) => {
        if (ignore) return;
        if (!response.ok) {
          setState("error");
          return;
        }
        // SAFETY: a 2xx from /api/activity is the ActivityPage contract.
        const body = (await response.json()) as ActivityPage;
        if (ignore) return;
        setEvents(stamped(body.events));
        setNextBefore(body.nextBefore);
        setState("ready");
      })
      .catch(() => {
        if (!ignore) setState("error");
      });
    return () => {
      ignore = true;
    };
    // `query` is rebuilt from exactly these values each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProject, group, range, wantAll, nonce]);

  async function loadOlder() {
    if (nextBefore === null) return;
    setLoadingOlder(true);
    setOlderFailed(false);
    try {
      const response = await fetch(query(nextBefore), { credentials: "include" });
      if (!response.ok) {
        setOlderFailed(true);
        return;
      }
      // SAFETY: as above, a 2xx body is the ActivityPage contract.
      const body = (await response.json()) as ActivityPage;
      setEvents((current) => [...current, ...stamped(body.events)]);
      setNextBefore(body.nextBefore);
    } catch {
      setOlderFailed(true);
    } finally {
      setLoadingOlder(false);
    }
  }

  const groupOptions = useMemo(
    () => [
      { value: ALL, label: "All types" },
      ...(types?.groups ?? []).map((token) => ({ value: token, label: groupLabel(token) })),
    ],
    [types],
  );
  const projectOptions = useMemo(
    () => [
      { value: ALL, label: "All projects" },
      ...(overview?.projects ?? []).map((item) => ({ value: item.name, label: item.name })),
    ],
    [overview],
  );

  const days = useMemo(() => groupByDay(events), [events]);
  const filtered = group !== ALL || range !== "all" || selectedProject !== undefined;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-4">
        <Field label="Type" className="w-full sm:w-48">
          <Select
            aria-label="Type"
            options={groupOptions}
            value={group}
            onValueChange={(next) => setGroup(next ?? ALL)}
          />
        </Field>
        {project ? null : (
          <Field label="Project" className="w-full sm:w-48">
            <Select
              aria-label="Project"
              options={projectOptions}
              value={projectFilter}
              onValueChange={(next) => setProjectFilter(next ?? ALL)}
            />
          </Field>
        )}
        <div className="flex w-full flex-col gap-1.5 sm:w-auto">
          <span className="text-sm font-semibold">Time range</span>
          <SegmentedControl
            aria-label="Time range"
            options={RANGES}
            value={range}
            onValueChange={setRange}
            className="h-(--sb-control-h) items-center sm:w-auto"
          />
        </div>
        {isAdmin ? (
          <div className="flex h-(--sb-control-h) items-center sm:ms-auto">
            <Switch label="All accounts" checked={allAccounts} onCheckedChange={setAllAccounts} />
          </div>
        ) : null}
      </div>

      {state === "error" ? (
        <Banner
          tone="danger"
          action={
            <Button size="sm" onClick={() => setNonce((value) => value + 1)}>
              Retry
            </Button>
          }
        >
          Could not load activity. Refresh and try again.
        </Banner>
      ) : state === "loading" && events.length === 0 ? (
        <FeedSkeleton />
      ) : events.length === 0 ? (
        <div className="rounded-xl bg-surface p-4 shadow-card">
          <EmptyState
            icon={<ActivityIcon />}
            title={filtered ? "No activity matches these filters" : "No activity yet"}
            description={
              filtered
                ? "Widen the time range or clear the type filter."
                : "Deploys, secrets, domains and tokens show up here as they change."
            }
          />
        </div>
      ) : (
        <div className="flex flex-col gap-6" aria-busy={state === "loading" || undefined}>
          {days.map((day) => (
            <section key={day.key} aria-label={day.label} className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold text-fg-muted">{day.label}</h2>
              <ul className="flex flex-col overflow-hidden rounded-xl bg-surface shadow-card">
                {day.events.map((event) => (
                  <EventRow key={event.id} event={event} showAccount={wantAll} showProject={!project} />
                ))}
              </ul>
            </section>
          ))}
          {olderFailed ? (
            <p role="alert" className="text-sm text-danger-fg">
              Could not load older activity. Try again.
            </p>
          ) : null}
          {nextBefore !== null ? (
            <div className="flex justify-center">
              <Button loading={loadingOlder} onClick={() => void loadOlder()}>
                Load older
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function FeedSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-3 rounded-xl bg-surface p-5 shadow-card">
      <span className="sr-only">Loading activity…</span>
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex items-center gap-3">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ))}
    </div>
  );
}

function EventRow({
  event,
  showAccount,
  showProject,
}: {
  event: ActivityEvent;
  showAccount: boolean;
  showProject: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { stamp } = event;
  const tone = eventTone(event.type);
  const detailsId = `event-${event.id}-details`;
  const entries = Object.entries(event.data);

  return (
    <li className="px-4 py-3 shadow-[inset_0_-1px_0_var(--sb-hairline)] last:shadow-none">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "mt-0.5 inline-grid size-8 shrink-0 place-items-center rounded-full [&>svg]:size-4",
            iconTone[tone],
          )}
        >
          {groupIcon(event.type)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="min-w-0 break-words text-base font-medium">{event.summary}</p>
            <Badge tone={tone} className="font-mono">
              {event.type}
            </Badge>
          </div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-fg-muted">
            {event.actor ? <span>{event.actor}</span> : <span>system</span>}
            {showProject && event.project ? (
              <>
                <span aria-hidden="true">·</span>
                <Link render={<RouterLink to="/projects/$name" params={{ name: event.project }} />}>
                  {event.project}
                </Link>
              </>
            ) : null}
            {showAccount && event.ownerId ? (
              <>
                <span aria-hidden="true">·</span>
                <span title={event.ownerId}>
                  Account <code>{event.ownerId.length > 12 ? `${event.ownerId.slice(0, 8)}…` : event.ownerId}</code>
                </span>
              </>
            ) : null}
            <span aria-hidden="true">·</span>
            <Tooltip content={stamp}>
              <time dateTime={event.ts} className="whitespace-nowrap">
                {relativeTime(event.ts)}
              </time>
            </Tooltip>
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          aria-controls={detailsId}
          aria-label={`${open ? "Hide" : "Show"} details for ${event.summary}`}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="max-sm:sr-only">Details</span>
          <ChevronDownIcon className={cn("transition-transform duration-200", open && "rotate-180")} />
        </Button>
      </div>
      {open ? (
        <div id={detailsId} className="mt-3 ps-11">
          <DescriptionList
            items={[
              { id: "type", term: "Type", details: event.type, mono: true },
              { id: "time", term: "Time", details: stamp },
              ...entries.map(([key, value]) => ({
                id: `data-${key}`,
                term: key,
                details: value === null ? "-" : String(value),
                mono: true,
              })),
            ]}
          />
        </div>
      ) : null}
    </li>
  );
}
