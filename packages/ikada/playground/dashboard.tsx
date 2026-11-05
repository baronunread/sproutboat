import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Sparkline } from "../src/charts/sparkline";
import { Banner } from "../src/components/banner";
import { Breadcrumbs } from "../src/components/breadcrumbs";
import { Button } from "../src/components/button";
import { CommandPalette, shortcutLabel, useCommandPaletteShortcut } from "../src/components/command-palette";
import type { PaletteGroup, PaletteItem } from "../src/components/command-palette";
import { EmptyState } from "../src/components/empty-state";
import { FallbackPill } from "../src/components/fallback-pill";
import { Kbd } from "../src/components/kbd";
import { Meter, UsageMeter } from "../src/components/meter";
import { MetricTile } from "../src/components/metric-tile";
import { PageHeader, PageTab, PageTabs } from "../src/components/page-header";
import { RuntimeChip } from "../src/components/runtime-chip";
import {
  Sidebar,
  SidebarFooter,
  SidebarHeader,
  SidebarItem,
  SidebarNav,
  SidebarToggle,
  SidebarTrigger,
} from "../src/components/sidebar";
import { Spinner } from "../src/components/spinner";
import { StatusDot } from "../src/components/status-dot";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableError,
  TableHead,
  TableHeader,
  TableLoading,
  TableRow,
  nextSort,
} from "../src/components/table";
import type { SortDirection } from "../src/components/table";
import { TrafficSplitBar } from "../src/components/traffic-split-bar";
import { Checkbox } from "../src/components/checkbox";
import {
  ActivityIcon,
  CardIcon,
  DatabaseIcon,
  FolderIcon,
  GlobeIcon,
  HomeIcon,
  InboxIcon,
  KeyIcon,
  LogsIcon,
  RocketIcon,
  SearchIcon,
  SettingsIcon,
} from "../src/lib/icons";
import { PortalContainer } from "../src/lib/portal";
import { errors, p99, requests } from "./data";

import { openState, Row, Section } from "./parts";

const values = (points: { value: number }[]): number[] => points.map((p) => p.value);
const reqSpark = values(requests);
const errSpark = values(errors);
const p99Spark = values(p99);

const navItems = [
  { label: "Overview", icon: <HomeIcon /> },
  { label: "Projects", icon: <FolderIcon /> },
  { label: "Deployments", icon: <RocketIcon /> },
  { label: "Logs", icon: <LogsIcon /> },
  { label: "Storage", icon: <DatabaseIcon /> },
  { label: "Domains", icon: <GlobeIcon /> },
  { label: "Secrets", icon: <KeyIcon /> },
  { label: "Activity", icon: <ActivityIcon /> },
  { label: "Usage and billing", icon: <CardIcon /> },
  { label: "Settings", icon: <SettingsIcon /> },
];

/** A frame that keeps floating layers (drawer, palette) inside it, and reports whether it is narrow. */
function Frame({ children, className }: { children: (narrow: boolean) => ReactNode; className?: string }) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? 999) < 720));
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return (
    <div
      ref={setNode}
      className={`relative isolate flex min-w-0 overflow-hidden rounded-xl bg-canvas shadow-card ${className ?? ""}`}
    >
      <PortalContainer value={node}>{children(narrow)}</PortalContainer>
    </div>
  );
}

function AppSidebar({
  collapsed,
  open,
  onOpenChange,
  mode,
  current = "Projects",
}: {
  collapsed: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "static" | "drawer";
  current?: string;
}) {
  return (
    <Sidebar mode={mode} collapsed={collapsed} open={open} onOpenChange={onOpenChange}>
      <SidebarHeader>
        <span
          aria-hidden="true"
          className="grid size-7 shrink-0 place-items-center rounded-md bg-fg text-xs font-bold text-canvas"
        >
          S
        </span>
        {collapsed ? null : <span className="min-w-0 flex-1 truncate text-md font-semibold">Fernhill Labs</span>}
      </SidebarHeader>
      <SidebarNav label="Account">
        {navItems.map((item) => (
          <SidebarItem
            key={item.label}
            href={`#${item.label.toLowerCase()}`}
            icon={item.icon}
            current={item.label === current}
            onClick={(e) => e.preventDefault()}
          >
            {item.label}
          </SidebarItem>
        ))}
      </SidebarNav>
      <SidebarFooter>
        <SidebarNav label="Help">
          <SidebarItem href="#docs" icon={<InboxIcon />} onClick={(e) => e.preventDefault()}>
            Docs
          </SidebarItem>
        </SidebarNav>
      </SidebarFooter>
    </Sidebar>
  );
}

function SidebarDemo() {
  const [collapsed, setCollapsed] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-start gap-5">
      <Row label="Expanded column, current item raised">
        <Frame className="h-[38rem] w-60 max-w-full">
          {() => <AppSidebar collapsed={false} open={false} onOpenChange={() => {}} mode="static" />}
        </Frame>
      </Row>
      <Row label="Collapsible rail: labels become tooltips; use the toggle">
        <Frame className="h-[38rem] w-[22rem] max-w-full">
          {() => (
            <>
              <AppSidebar collapsed={collapsed} open={false} onOpenChange={() => {}} mode="static" />
              <div className="p-3">
                <SidebarToggle collapsed={collapsed} onCollapsedChange={setCollapsed} />
              </div>
            </>
          )}
        </Frame>
      </Row>
      <Row label="Mobile drawer: modal, focus trapped, Escape or scrim closes, focus returns to the button">
        <Frame className="h-[38rem] w-[22rem] max-w-full">
          {() => (
            <>
              <div className="flex h-12 w-full items-center gap-2 px-2 shadow-[inset_0_-1px_0_var(--sb-hairline)]">
                <SidebarTrigger onClick={() => setDrawerOpen(true)} />
                <span className="font-semibold">field-notes</span>
              </div>
              <AppSidebar collapsed={false} open={drawerOpen} onOpenChange={setDrawerOpen} mode="drawer" />
            </>
          )}
        </Frame>
      </Row>
    </div>
  );
}

const crumbs = [
  { label: "Fernhill Labs", href: "#org" },
  { label: "field-notes", href: "#project" },
  { label: "production" },
];
const longCrumbs = [
  { label: "Fernhill Labs", href: "#org" },
  { label: "Platform", href: "#team" },
  { label: "Apps", href: "#apps" },
  { label: "field-notes", href: "#project" },
  { label: "production", href: "#env" },
  { label: "v47" },
];

function LayoutSection() {
  return (
    <Section
      title="Layout and navigation"
      hint="Sidebar, PageHeader, Breadcrumbs, Spinner and Banner: the frame every dashboard page sits in."
    >
      <SidebarDemo />
      <Row label="PageHeader: breadcrumbs, title, status, actions and a tabs slot">
        <div className="w-full rounded-xl bg-canvas p-4">
          <PageHeader
            breadcrumbs={<Breadcrumbs items={crumbs} />}
            title="field-notes"
            status={<RuntimeChip runtime="sproutd" />}
            description="notes.fernhill.dev · fernhill/field-notes · main"
            actions={
              <>
                <Button>View logs</Button>
                <Button variant="primary">Deployments</Button>
              </>
            }
            tabs={
              <PageTabs>
                {["Overview", "Deployments", "Logs", "Metrics", "Bindings", "Domains", "Settings"].map((t) => (
                  <PageTab key={t} href={`#${t}`} current={t === "Overview"} onClick={(e) => e.preventDefault()}>
                    {t}
                  </PageTab>
                ))}
              </PageTabs>
            }
          />
        </div>
        <div className="w-full rounded-xl bg-canvas p-4">
          <PageHeader title="Usage and billing" />
        </div>
      </Row>
      <Row label="Breadcrumbs: Org, Project, Environment; six levels collapse the middle into a menu">
        <Breadcrumbs items={crumbs} className="w-full" />
        <Breadcrumbs items={longCrumbs.map((c) => ({ ...c, text: c.label }))} maxItems={4} className="w-full" />
        <div className="w-44 rounded-lg bg-well p-2">
          <Breadcrumbs items={crumbs} />
        </div>
      </Row>
      <Row label="Spinner: sm, md, lg, with a label and decorative inside a button; reduced motion pulses instead of turning">
        <Spinner size="sm" />
        <Spinner size="md" />
        <Spinner size="lg" />
        <Button disabled>
          <Spinner decorative />
          Deploying
        </Button>
      </Row>
      <Row label="Banner: tones, an action, dismissible">
        <div className="flex w-full flex-col gap-2.5">
          <Banner tone="info" title="Maintenance window">
            Builds are queued from 02:00 to 02:20 UTC on Sunday.
          </Banner>
          <Banner tone="success" title="Custom domain verified" dismissible>
            notes.fernhill.dev now serves production.
          </Banner>
          <Banner
            tone="warning"
            title="Using 86% of the monthly request quota"
            action={<Button size="sm">View usage</Button>}
          >
            Requests are not limited yet.
          </Banner>
          <Banner
            tone="danger"
            title="Deploys are paused"
            action={<Button size="sm">Update billing</Button>}
            dismissible
          >
            The last invoice failed, so new deployments are blocked until it is paid.
          </Banner>
          <Banner tone="neutral">Read-only while you are viewing a past version.</Banner>
        </div>
      </Row>
    </Section>
  );
}

interface Deployment {
  id: string;
  version: number;
  sha: string;
  message: string;
  status: "success" | "info" | "neutral" | "danger";
  statusLabel: string;
  runtime: "sproutd" | "supervisor";
  author: string;
  fellBack?: boolean;
  live?: boolean;
  age: number;
  ageLabel: string;
}

const deployments: Deployment[] = [
  {
    id: "d48",
    version: 48,
    sha: "e5c71d4",
    message: "Stream note export via R2",
    status: "info",
    statusLabel: "Canary 10%",
    runtime: "sproutd",
    author: "maya",
    age: 14,
    ageLabel: "14m",
  },
  {
    id: "d47",
    version: 47,
    sha: "a3f9c21",
    message: "Search v2 ranking weights",
    status: "success",
    statusLabel: "Live 90%",
    live: true,
    runtime: "sproutd",
    author: "joel",
    age: 120,
    ageLabel: "2h",
  },
  {
    id: "d46",
    version: 46,
    sha: "7b02e9f",
    message: "Enable queue consumer for digests",
    status: "neutral",
    statusLabel: "Superseded",
    runtime: "supervisor",
    author: "maya",
    fellBack: true,
    age: 420,
    ageLabel: "7h",
  },
  {
    id: "d45",
    version: 45,
    sha: "c48d1a6",
    message: "Hotfix: export timeout",
    status: "danger",
    statusLabel: "Rolled back",
    runtime: "sproutd",
    author: "priya",
    age: 1440,
    ageLabel: "1d",
  },
  {
    id: "d44",
    version: 44,
    sha: "19ae6d3",
    message: "Pin markdown renderer",
    status: "neutral",
    statusLabel: "Superseded",
    runtime: "sproutd",
    author: "joel",
    age: 2880,
    ageLabel: "2d",
  },
];

const FALLBACK_REASON =
  "abi_rejected: the build uses an API the sproutd runtime rejected, so the supervisor serves it.";

function DeploymentsTable({
  rows,
  sort,
  onSort,
  selection,
  onSelect,
  stickyHeader,
  maxHeight,
  label,
}: {
  rows: Deployment[];
  sort?: { key: "version" | "age"; dir: SortDirection };
  onSort?: (key: "version" | "age") => void;
  selection?: Set<string>;
  onSelect?: (id: string, on: boolean) => void;
  stickyHeader?: boolean;
  maxHeight?: string;
  label: string;
}) {
  return (
    <Table label={label} stickyHeader={stickyHeader} maxHeight={maxHeight}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {selection ? (
            <TableHead className="w-10 pe-0">
              <span className="sr-only">Select</span>
            </TableHead>
          ) : null}
          <TableHead
            sortable={!!onSort}
            sort={sort?.key === "version" ? sort.dir : undefined}
            onSort={() => onSort?.("version")}
          >
            Version
          </TableHead>
          <TableHead hideBelow="sm">Message</TableHead>
          <TableHead>Status</TableHead>
          <TableHead hideBelow="lg">Runtime</TableHead>
          <TableHead hideBelow="3xl">Author</TableHead>
          <TableHead
            hideBelow="md"
            sortable={!!onSort}
            sort={sort?.key === "age" ? sort.dir : undefined}
            onSort={() => onSort?.("age")}
          >
            Age
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((d) => (
          <TableRow key={d.id} selected={selection?.has(d.id)}>
            {selection ? (
              <TableCell className="w-10 pe-0">
                <Checkbox
                  aria-label={`Select v${d.version}`}
                  checked={selection.has(d.id)}
                  onCheckedChange={(on) => onSelect?.(d.id, on)}
                />
              </TableCell>
            ) : null}
            <TableCell className="whitespace-nowrap">
              <span className="font-semibold">v{d.version}</span>{" "}
              <span className="font-mono text-sm text-fg-muted">{d.sha}</span>
              {/* Below sm the Message column is dropped; its text moves under the version. */}
              <span className="hidden max-w-36 whitespace-normal py-1 text-sm text-fg-muted @max-sm:block">
                {d.message}
              </span>
            </TableCell>
            <TableCell hideBelow="sm">{d.message}</TableCell>
            <TableCell className="whitespace-nowrap">
              {/* Critical status lives in a column that never hides, so the fallback survives at 390px. */}
              <div className="flex flex-col items-start gap-1 py-1.5">
                <StatusDot status={d.status} live={d.live} label={d.statusLabel} />
                {d.fellBack ? <FallbackPill compact reason={FALLBACK_REASON} /> : null}
              </div>
            </TableCell>
            <TableCell hideBelow="lg">
              <RuntimeChip runtime={d.runtime} />
            </TableCell>
            <TableCell hideBelow="3xl" className="whitespace-nowrap text-fg-muted">
              {d.author}
            </TableCell>
            <TableCell hideBelow="md" className="whitespace-nowrap tabular-nums text-fg-muted">
              {d.ageLabel}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function sortRows(rows: Deployment[], sort?: { key: "version" | "age"; dir: SortDirection }): Deployment[] {
  if (!sort) return rows;
  const sign = sort.dir === "asc" ? 1 : -1;
  return rows.toSorted((a, b) => sign * (a[sort.key] - b[sort.key]));
}

function TableSection() {
  const [sort, setSort] = useState<{ key: "version" | "age"; dir: SortDirection } | undefined>(
    openState === "table-sorted" ? { key: "version", dir: "asc" } : undefined,
  );
  const [selection, setSelection] = useState(() => new Set(["d47"]));
  const sorted = useMemo(() => sortRows(deployments, sort), [sort]);
  function onSort(key: "version" | "age") {
    const dir = nextSort(sort?.key === key ? sort.dir : undefined);
    setSort(dir ? { key, dir } : undefined);
  }
  return (
    <Section title="Table" hint="Semantic table in its own scroll container: wide ones scroll inside, never the page.">
      <Row label="Sortable (click or press Enter on Version and Age), row hover, selection with checkboxes">
        <div className="w-full">
          <DeploymentsTable
            label="Deployments, sortable"
            rows={sorted}
            sort={sort}
            onSort={onSort}
            selection={selection}
            onSelect={(id, on) =>
              setSelection((prev) => {
                const next = new Set(prev);
                if (on) next.add(id);
                else next.delete(id);
                return next;
              })
            }
          />
        </div>
      </Row>
      <Row label="Responsive columns: Runtime hides below 32rem, Age below 28rem, Author below 48rem, measured on the table's own width">
        <div className="flex w-full flex-wrap items-start gap-4">
          <div className="w-[22rem] max-w-full">
            <DeploymentsTable label="Deployments, narrow container" rows={deployments.slice(0, 3)} />
          </div>
          <div className="w-[40rem] max-w-full">
            <DeploymentsTable label="Deployments, medium container" rows={deployments.slice(0, 3)} />
          </div>
        </div>
      </Row>
      <Row label="Sticky header in a 16rem scroll area">
        <div className="w-full">
          <DeploymentsTable
            label="Deployments, sticky header"
            rows={[...deployments, ...deployments.map((d) => ({ ...d, id: `${d.id}b`, version: d.version - 5 }))]}
            stickyHeader
            maxHeight="16rem"
          />
        </div>
      </Row>
      <Row label="Empty, loading and error bodies keep the header and the column count">
        <div className="grid w-full items-start gap-4 lg:grid-cols-3">
          <Table label="Domains, empty" className="min-w-0">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Hostname</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableEmpty colSpan={2}>
                <EmptyState
                  icon={<GlobeIcon />}
                  title="No domains yet"
                  description="Add a hostname to serve this project from your own domain."
                  action={<Button size="sm">Add domain</Button>}
                />
              </TableEmpty>
            </TableBody>
          </Table>
          <Table label="Domains, loading" aria-busy="true" className="min-w-0">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Hostname</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableLoading columns={2} rows={3} />
            </TableBody>
          </Table>
          <Table label="Domains, error" className="min-w-0">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Hostname</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableError colSpan={2} title="Could not load domains" action={<Button size="sm">Try again</Button>}>
                The control plane did not answer. Your sites are not affected.
              </TableError>
            </TableBody>
          </Table>
        </div>
      </Row>
      <Row label="EmptyState: icon, title, one line, one action">
        <div className="w-full rounded-xl bg-well">
          <EmptyState
            icon={<DatabaseIcon />}
            title="No databases"
            description="Create a D1 database to give your apps SQL storage."
            action={<Button variant="primary">Create database</Button>}
          />
        </div>
        <div className="w-full rounded-xl bg-well">
          <EmptyState title="Nothing in the last hour" description="Logs appear here as requests arrive." />
        </div>
      </Row>
    </Section>
  );
}

function MeterSection() {
  return (
    <Section
      title="Meter and UsageMeter"
      hint="Amber from 80% and at the limit. Red only when the platform is actually blocking work. The state is always written out."
    >
      <Row label="Meter: plain bar, default value text and a custom one">
        <div className="grid w-full gap-5 sm:grid-cols-2">
          <Meter label="Build minutes" value={42} />
          <Meter label="Cache hit rate" value={88} valueLabel="88% hits" />
        </div>
      </Row>
      <Row label="UsageMeter: under, near limit, at limit (still amber), blocked (red), unlimited">
        <div className="grid w-full gap-5 sm:grid-cols-2">
          <UsageMeter label="Requests" used={420_000} limit={1_000_000} />
          <UsageMeter label="D1 storage" used={4.4} limit={5} unit="GB" />
          <UsageMeter label="Build minutes" used={500} limit={500} unit="min" />
          <UsageMeter label="Seats" used={5} limit={5} blocked />
          <UsageMeter label="Bandwidth" used={182} limit={null} unit="GB" />
        </div>
      </Row>
    </Section>
  );
}

function SproutboatSection() {
  return (
    <Section
      title="Runtime, traffic and metrics"
      hint="The Sproutboat pieces. sproutd is neutral, the supervisor fallback is amber and never red."
    >
      <Row label="RuntimeChip: sproutd, supervisor, unknown">
        <RuntimeChip runtime="sproutd" />
        <RuntimeChip runtime="supervisor" />
        <RuntimeChip runtime="unknown" />
      </Row>
      <Row label="FallbackPill: hover or focus it for the reason (a tooltip); without a reason; as a link">
        <FallbackPill reason={FALLBACK_REASON} defaultOpen={openState === "fallback"} />
        <FallbackPill />
        <FallbackPill href="#details" reason="abi_rejected" />
      </Row>
      <Row label="TrafficSplitBar: one version, two, three or more, zero traffic. Tab through the segments.">
        <div className="grid w-full gap-6 lg:grid-cols-2">
          <TrafficSplitBar label="Traffic, one version" versions={[{ id: "v47", label: "v47", percent: 100 }]} />
          <TrafficSplitBar
            label="Traffic, two versions"
            versions={[
              { id: "v47", label: "v47", percent: 90, note: "live" },
              { id: "v48", label: "v48", percent: 10, note: "canary" },
            ]}
          />
          <TrafficSplitBar
            label="Traffic, four versions"
            versions={[
              { id: "v47", label: "v47", percent: 60 },
              { id: "v48", label: "v48", percent: 25 },
              { id: "v46", label: "v46", percent: 14.5 },
              { id: "v45", label: "v45", percent: 0.5 },
            ]}
          />
          <TrafficSplitBar
            label="Traffic, none"
            versions={[
              { id: "v47", label: "v47", percent: 0 },
              { id: "v48", label: "v48", percent: 0 },
            ]}
          />
        </div>
      </Row>
      <Row label="MetricTile: value and unit with a delta up and down, loading, no data">
        <div className="grid w-full gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <MetricTile
            label="Requests"
            amount={1_280_000}
            delta={{ value: "12%", direction: "up" }}
            hint="14.8 req/s average"
            sparkline={<Sparkline data={reqSpark} ariaLabel="Requests, last 24 hours" />}
          />
          <MetricTile
            label="Errors (5xx)"
            value="0.21"
            unit="%"
            delta={{ value: "0.08 pt", direction: "up", sentiment: "bad" }}
            hint="2,685 requests"
            sparkline={<Sparkline data={errSpark} color="errors" ariaLabel="Errors, last 24 hours" />}
          />
          <MetricTile
            label="CPU time"
            value="3.4"
            unit="ms p50"
            delta={{ value: "0.4 ms", direction: "down", sentiment: "good" }}
            hint="p99 58 ms"
            sparkline={<Sparkline data={p99Spark} color="series" ariaLabel="CPU time, last 24 hours" />}
          />
          <MetricTile label="Cold starts" loading />
          <MetricTile label="Served by supervisor" noData emptyText="No fallback in this range" />
        </div>
      </Row>
    </Section>
  );
}

const paletteGroups: PaletteGroup[] = [
  {
    id: "projects",
    label: "Projects",
    items: [
      { id: "fn", label: "field-notes", hint: "sproutd · production", icon: <FolderIcon /> },
      { id: "dj", label: "digest-jobs", hint: "sproutd · production", icon: <FolderIcon /> },
    ],
  },
  {
    id: "storage",
    label: "Storage",
    items: [
      { id: "notes-db", label: "notes-db", hint: "d1 · 1.4 GB", icon: <DatabaseIcon />, scope: "d1" },
      { id: "sessions-db", label: "sessions", hint: "d1 · 220 MB", icon: <DatabaseIcon />, scope: "d1" },
      { id: "cache", label: "notes-cache", hint: "kv · 41 MB", icon: <DatabaseIcon />, scope: "kv" },
      { id: "exports", label: "notes-exports", hint: "r2 · 8.2 GB", icon: <DatabaseIcon />, scope: "r2" },
    ],
  },
  {
    id: "pages",
    label: "Pages",
    items: navItems.slice(0, 6).map((n) => ({ id: `page-${n.label}`, label: n.label, icon: n.icon })),
  },
];
const recents: PaletteItem[] = [
  { id: "r-fn", label: "field-notes", hint: "sproutd · production", icon: <FolderIcon /> },
  { id: "r-v46", label: "v46 Enable queue consumer for digests", hint: "abi_rejected", icon: <RocketIcon /> },
];
const prefixes = [
  { scope: "d1", label: "D1 databases" },
  { scope: "kv", label: "KV namespaces" },
  { scope: "r2", label: "R2 buckets" },
  { scope: "p", label: "Projects" },
];

function PaletteDemo() {
  const [open, setOpen] = useState(openState === "palette");
  const [picked, setPicked] = useState<string>();
  useCommandPaletteShortcut(() => setOpen((v) => !v));
  return (
    <Frame className="h-[34rem] w-full">
      {() => (
        <div className="flex w-full flex-col items-start gap-3 p-4">
          <Button onClick={() => setOpen(true)} aria-keyshortcuts="Control+K Meta+K">
            <SearchIcon />
            Find anything
            <Kbd>{shortcutLabel()}</Kbd>
          </Button>
          <p className="text-sm text-fg-muted">
            Opened by key or click, it never animates. Try <Kbd>d1:</Kbd> then a name, or something that matches
            nothing.
          </p>
          {picked ? <p className="text-sm">Picked: {picked}</p> : null}
          <CommandPalette
            open={open}
            onOpenChange={setOpen}
            groups={paletteGroups}
            recents={recents}
            prefixes={prefixes}
            onSelect={(item) => setPicked(item.label)}
          />
        </div>
      )}
    </Frame>
  );
}

function PaletteSection() {
  return (
    <Section
      title="CommandPalette"
      hint="Cmd or Ctrl K. Groups, recents, typed prefixes, no results, a shortcut hint, and focus trapped inside."
    >
      <PaletteDemo />
    </Section>
  );
}

/** One realistic project page, built only from the components above. */
export function DashboardPreview() {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(openState === "drawer");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sort, setSort] = useState<{ key: "version" | "age"; dir: SortDirection }>({ key: "age", dir: "asc" });
  const rows = useMemo(() => sortRows(deployments, sort), [sort]);
  useCommandPaletteShortcut(() => setPaletteOpen((v) => !v));
  useEffect(() => {
    if (openState === "dashboard-palette") setPaletteOpen(true);
  }, []);

  return (
    <Frame className="w-full">
      {(narrow) => (
        <>
          {narrow ? null : (
            <div className="shrink-0 self-stretch">
              <AppSidebar collapsed={collapsed} open={false} onOpenChange={() => {}} mode="static" />
            </div>
          )}
          {narrow ? (
            <AppSidebar collapsed={false} open={drawerOpen} onOpenChange={setDrawerOpen} mode="drawer" />
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-12 items-center gap-2 px-3 shadow-[inset_0_-1px_0_var(--sb-hairline)]">
              {narrow ? (
                <SidebarTrigger onClick={() => setDrawerOpen(true)} />
              ) : (
                <SidebarToggle collapsed={collapsed} onCollapsedChange={setCollapsed} />
              )}
              <Button
                size="sm"
                className="ms-auto min-w-0 sm:w-56 sm:justify-between"
                onClick={() => setPaletteOpen(true)}
              >
                <span className="inline-flex items-center gap-2 text-fg-muted">
                  <SearchIcon />
                  Find anything
                </span>
                <Kbd className="max-sm:hidden">{shortcutLabel()}</Kbd>
              </Button>
            </div>
            <div className="flex min-w-0 flex-col gap-6 p-4 sm:p-6">
              <PageHeader
                breadcrumbs={<Breadcrumbs items={crumbs} />}
                title="field-notes"
                status={<StatusDot status="success" live label="Live" />}
                description="notes.fernhill.dev · fernhill/field-notes · main"
                actions={
                  <>
                    <Button>View logs</Button>
                    <Button variant="primary">Deploy</Button>
                  </>
                }
                tabs={
                  <PageTabs>
                    {["Overview", "Deployments", "Logs", "Metrics", "Bindings", "Domains", "Settings"].map((t) => (
                      <PageTab key={t} href={`#${t}`} current={t === "Overview"} onClick={(e) => e.preventDefault()}>
                        {t}
                      </PageTab>
                    ))}
                  </PageTabs>
                }
              />
              <Banner
                tone="warning"
                title="v46 is served by the supervisor"
                action={<Button size="sm">See why</Button>}
                dismissible
              >
                It fell back after the ABI check rejected the build. Traffic is unaffected.
              </Banner>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <MetricTile
                  label="Requests"
                  amount={1_280_000}
                  delta={{ value: "12%", direction: "up" }}
                  hint="14.8 req/s average"
                  sparkline={<Sparkline data={reqSpark} ariaLabel="Requests, last 24 hours" />}
                />
                <MetricTile
                  label="Errors (5xx)"
                  value="0.21"
                  unit="%"
                  delta={{ value: "0.08 pt", direction: "up", sentiment: "bad" }}
                  hint="2,685 requests"
                  sparkline={<Sparkline data={errSpark} color="errors" ariaLabel="Errors, last 24 hours" />}
                />
                <MetricTile
                  label="CPU time"
                  value="3.4"
                  unit="ms p50"
                  delta={{ value: "0.4 ms", direction: "down", sentiment: "good" }}
                  hint="p99 58 ms"
                  className="sm:max-xl:col-span-2"
                  sparkline={<Sparkline data={p99Spark} color="series" ariaLabel="CPU time, last 24 hours" />}
                />
              </div>
              <section
                aria-labelledby="split-title"
                className="flex flex-col gap-3 rounded-xl bg-surface p-4 shadow-card"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 id="split-title" className="text-md font-semibold">
                    Live deployment
                  </h2>
                  <span className="text-sm text-fg-muted">Production · 14.8 req/s total</span>
                </div>
                <TrafficSplitBar
                  label="Production traffic split"
                  versions={[
                    { id: "v47", label: "v47", percent: 90, note: "live" },
                    { id: "v48", label: "v48", percent: 10, note: "canary" },
                  ]}
                />
                <UsageMeter label="Requests this month" used={860_000} limit={1_000_000} />
              </section>
              <section aria-labelledby="deploys-title" className="flex flex-col gap-3">
                <h2 id="deploys-title" className="text-md font-semibold">
                  Recent deployments
                </h2>
                <DeploymentsTable
                  label="Deployments list"
                  rows={rows}
                  sort={sort}
                  onSort={(key) => setSort((s) => ({ key, dir: s.key === key && s.dir === "asc" ? "desc" : "asc" }))}
                />
              </section>
              <section aria-labelledby="cron-title" className="flex flex-col gap-3">
                <h2 id="cron-title" className="text-md font-semibold">
                  Cron and triggers
                </h2>
                <div className="rounded-xl bg-surface shadow-card">
                  <EmptyState
                    icon={<ActivityIcon />}
                    title="No cron triggers"
                    description="Run this app on a schedule, such as every night at 02:00."
                    action={<Button>Add trigger</Button>}
                  />
                </div>
              </section>
            </div>
          </div>
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            groups={paletteGroups}
            recents={recents}
            prefixes={prefixes}
            onSelect={() => {}}
          />
        </>
      )}
    </Frame>
  );
}

export function DashboardSections() {
  return (
    <>
      <LayoutSection />
      <TableSection />
      <MeterSection />
      <SproutboatSection />
      <PaletteSection />
      <Section
        title="Dashboard preview"
        hint="One project page composed from the components above: Sidebar, PageHeader with breadcrumbs and tabs, MetricTiles, TrafficSplitBar, a deployments Table, an EmptyState and the palette. Narrow frames switch the sidebar to its drawer."
      >
        <DashboardPreview />
      </Section>
    </>
  );
}
