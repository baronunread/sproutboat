import { useId, useState } from "react";
import type { CSSProperties } from "react";
import { chartColors } from "../src/charts/theme";
import { Sparkline } from "../src/charts/sparkline";
import { TimeseriesChart } from "../src/charts/timeseries-chart";
import { Badge } from "../src/components/badge";
import { Button } from "../src/components/button";
import { Checkbox } from "../src/components/checkbox";
import { CopyId } from "../src/components/copy-id";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "../src/components/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../src/components/dropdown-menu";
import { Field } from "../src/components/field";
import { IconButton } from "../src/components/icon-button";
import { Input } from "../src/components/input";
import { Label } from "../src/components/label";
import { Link } from "../src/components/link";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "../src/components/popover";
import { Select } from "../src/components/select";
import { Skeleton } from "../src/components/skeleton";
import type { Status } from "../src/components/status";
import { StatusDot } from "../src/components/status-dot";
import { Switch } from "../src/components/switch";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../src/components/tabs";
import { toast } from "../src/components/toast";
import { Tooltip } from "../src/components/tooltip";
import { ToastLab } from "./toast-lab";
import { AppPiecesSection } from "./app-pieces";
import { DashboardSections } from "./dashboard";
import { openState, Row, Section } from "./parts";
export { openState };
import { CheckIcon, CopyIcon } from "../src/lib/icons";
import { clock, DEPLOY_HOUR, errors, p50, p99, requests } from "./data";

const regions = [
  { value: "iad", label: "Washington, D.C." },
  { value: "fra", label: "Frankfurt" },
  { value: "sin", label: "Singapore" },
  { value: "syd", label: "Sydney", disabled: true },
];
const statuses: { status: Status; label: string; live?: boolean }[] = [
  { status: "success", label: "Ready" },
  { status: "success", label: "Live", live: true },
  { status: "warning", label: "Domain not verified" },
  { status: "danger", label: "Build failed" },
  { status: "info", label: "Building" },
  { status: "neutral", label: "Stopped" },
];

const forcedFocus = "outline-solid outline-2 outline-offset-2 outline-focus";

const layers = [
  ["canvas", "bg-canvas"],
  ["surface", "bg-surface"],
  ["well", "bg-well"],
  ["hover", "bg-hover"],
  ["raised", "bg-raised shadow-float"],
] as const;
const status = ["brand", "warn", "danger", "info", "neutral"] as const;
const chart = ["requests", "errors", "deploy", "2xx", "3xx", "4xx", "5xx", "other", "series"] as const;
const variants = ["primary", "secondary", "ghost", "danger"] as const;
const names = { primary: "Create project", secondary: "Cancel", ghost: "Skip", danger: "Delete project" };
const deploy = { time: DEPLOY_HOUR, label: "v48" };
const format = { formatTime: clock };
const perMinute = (v: number): string => `${v.toLocaleString()} req/min`;
const errPerMinute = (v: number): string => `${v} err/min`;
const millis = (v: number): string => `${v} ms`;
const plain = (v: number): string => v.toLocaleString();
const halfHourClock = (i: number): string => clock(i / 2);
const sparks = [
  ["Requests", requests, "requests", perMinute],
  ["Errors", errors, "errors", errPerMinute],
  ["p99", p99, "series", millis],
  ["2xx", requests, "2xx", plain],
] as const;

function Tokens() {
  return (
    <Section
      title="Surfaces, radii and chart colors"
      hint="Layers separate by tone and shadow, not borders. Radii are concentric: outer = inner + padding."
    >
      <Row label="Layers: canvas, surface, well, hover, raised (overlay)">
        {layers.map(([name, cls]) => (
          <div
            key={name}
            className={`flex h-16 w-28 items-end rounded-xl p-2 text-xs font-medium ${cls} ring-1 ring-hairline`}
          >
            {name}
          </div>
        ))}
      </Row>
      <Row label="Concentric radii: card 12 holds a well 10 (pad 4) holds a row 6; control 8 in a popover 12 (pad 4)">
        <div className="rounded-xl bg-canvas p-1 shadow-card">
          <div className="rounded-lg bg-well p-1">
            <div className="rounded-sm bg-raised px-3 py-2 text-sm shadow-pill">12 / 10 / 6</div>
          </div>
        </div>
        <div className="rounded-xl bg-raised p-1 shadow-float">
          <div className="rounded-md bg-hover px-3 py-2 text-sm">12 / 8</div>
        </div>
      </Row>
      <Row label="Status colors">
        {status.map((s) => (
          <span key={s} className="inline-flex items-center gap-2 text-sm">
            <span
              className={`size-4 rounded-xs ${{ brand: "bg-brand-dot", warn: "bg-warn-dot", danger: "bg-danger-dot", info: "bg-info-dot", neutral: "bg-neutral-dot" }[s]}`}
            />
            {s}
          </span>
        ))}
      </Row>
      <Row label="Chart colors">
        {chart.map((c) => (
          <span key={c} className="inline-flex items-center gap-2 text-sm">
            <span className="size-4 rounded-xs" style={{ background: chartColors[c] }} />
            {c}
          </span>
        ))}
      </Row>
    </Section>
  );
}

function ButtonSection() {
  const [loading, setLoading] = useState(false);
  function fakeSave() {
    setLoading(true);
    setTimeout(() => setLoading(false), 1800);
  }

  return (
    <Section title="Button" hint="Hover and press with the pointer: press scales to 0.97 over 160ms.">
      <Row label="Variants">
        {variants.map((v) => (
          <Button key={v} variant={v}>
            {names[v]}
          </Button>
        ))}
      </Row>
      <Row label="Sizes">
        <Button variant="primary" size="sm">
          Small
        </Button>
        <Button variant="primary" size="md">
          Medium
        </Button>
        <Button variant="primary" size="lg">
          Large
        </Button>
        <Button size="sm">Small</Button>
        <Button size="lg">Large</Button>
      </Row>
      <Row label="Disabled">
        {variants.map((v) => (
          <Button key={v} variant={v} disabled>
            {names[v]}
          </Button>
        ))}
      </Row>
      <Row label="Loading (click the first to try)">
        <Button variant="primary" loading={loading} onClick={fakeSave}>
          Save changes
        </Button>
        <Button loading>Deploying</Button>
        <Button variant="danger" loading>
          Deleting
        </Button>
        <Button variant="ghost" loading>
          Syncing
        </Button>
      </Row>
      <Row label="Focus-visible (forced)">
        {variants.map((v) => (
          <Button key={v} variant={v} className={forcedFocus}>
            {names[v]}
          </Button>
        ))}
      </Row>
      <Row label="With an icon (icon side has 2px less padding)">
        <Button variant="primary">
          <CheckIcon />
          Promote
        </Button>
        <Button>
          Copy
          <CopyIcon />
        </Button>
      </Row>
      <Row label="Icon buttons (label required, shown as tooltip)">
        <IconButton label="Copy deployment ID">
          <CopyIcon />
        </IconButton>
        <IconButton label="Copy ID" variant="secondary">
          <CopyIcon />
        </IconButton>
        <IconButton label="Copy ID" size="sm">
          <CopyIcon />
        </IconButton>
        <IconButton label="Copy ID" disabled>
          <CopyIcon />
        </IconButton>
        <IconButton label="Copy ID" className={forcedFocus}>
          <CopyIcon />
        </IconButton>
      </Row>
      <Row label="Link: default, external, disabled, focus (forced)">
        <Link href="#links">Read the docs</Link>
        <Link href="https://sproutboat.com" external>
          sproutboat.com
        </Link>
        <Link href="#links" aria-disabled="true">
          Disabled link
        </Link>
        <Link href="#links" className={forcedFocus}>
          Focused link
        </Link>
      </Row>
    </Section>
  );
}

function FormSection() {
  const labelId = useId();
  const [region, setRegion] = useState<string | null>("fra");
  return (
    <Section title="Form controls">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Project name" description="Lowercase letters, digits and dashes.">
          <Input placeholder="my-app" />
        </Field>
        <Field label="Project name (focus, forced)">
          <Input defaultValue="my-app" className={forcedFocus} />
        </Field>
        <Field label="Domain" error="That domain is already used by another project." required>
          <Input defaultValue="docs.example.com" />
        </Field>
        <Field label="Deployment ID (disabled)">
          <Input mono disabled defaultValue="dpl_8f3a91c2" />
        </Field>
        <Field label="Read-only key">
          <Input mono readOnly defaultValue="sb_live_2f9a" />
        </Field>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={labelId}>Standalone label</Label>
          <Input id={labelId} placeholder="Label + input without Field" />
        </div>
        <Field label="Region">
          <Select options={regions} value={region} onValueChange={setRegion} defaultOpen={openState === "select"} />
        </Field>
        <Field label="Region (empty)">
          <Select options={regions} placeholder="Choose a region" />
        </Field>
        <Field label="Region (disabled)">
          <Select options={regions} disabled defaultValue="iad" />
        </Field>
        <Field label="Region (invalid)" error="Pick a region to deploy to.">
          <Select options={regions} placeholder="Choose a region" />
        </Field>
      </div>
      <Row label="Checkbox: unchecked, checked, mixed, disabled, invalid, description, focus (forced)">
        <Checkbox label="Unchecked" />
        <Checkbox label="Checked" defaultChecked />
        <Checkbox label="Mixed" indeterminate />
        <Checkbox label="Disabled" disabled />
        <Checkbox label="Disabled, checked" disabled defaultChecked />
        <Checkbox label="Invalid" invalid />
        <Checkbox label="With description" description="Applies to all branches." />
        <Checkbox aria-label="Focused" defaultChecked className={forcedFocus} />
      </Row>
      <Row label="Switch: off, on, disabled, disabled on, focus (forced)">
        <Switch label="Off" />
        <Switch label="On" defaultChecked />
        <Switch label="Disabled" disabled />
        <Switch label="Disabled, on" disabled defaultChecked />
        <Switch aria-label="Focused" className={forcedFocus} />
      </Row>
    </Section>
  );
}

function StatusSection() {
  return (
    <Section
      title="Badge and StatusDot"
      hint="Amber is degraded but working, never red. Every status has its own shape as well as its color."
    >
      <Row label="Badge with shape">
        {statuses.map((s) => (
          <Badge key={s.label} tone={s.status} live={s.live} dot>
            {s.label}
          </Badge>
        ))}
      </Row>
      <Row label="Badge without shape">
        <Badge>v12</Badge>
        <Badge tone="success">Production</Badge>
        <Badge tone="warning">Supervisor</Badge>
        <Badge tone="danger">Failed</Badge>
        <Badge tone="info">Preview</Badge>
      </Row>
      <Row label="StatusDot with label">
        {statuses.map((s) => (
          <StatusDot key={s.label} status={s.status} live={s.live} label={s.label} />
        ))}
        <StatusDot status="info" label="Deploying" pulse />
        <StatusDot status="success" live label="Live" pulse />
      </Row>
      <Row label="StatusDot, label hidden visually (still announced)">
        <StatusDot status="success" label="Ready" hideLabel />
        <StatusDot status="warning" label="Domain not verified" hideLabel />
        <StatusDot status="danger" label="Build failed" hideLabel />
      </Row>
    </Section>
  );
}

function OverlaySection() {
  return (
    <Section
      title="Overlays"
      hint="Menus, selects and popovers: 180ms in, 120ms out, from the trigger. Open one with Enter and it appears with no animation."
    >
      <Row label="Tooltip (hover or focus; neighbours open instantly after the first)">
        <Tooltip content="Copies the deployment ID" defaultOpen={openState === "tooltip"}>
          <Button>Hover or focus me</Button>
        </Tooltip>
        <Tooltip content="Roll back to v47">
          <Button variant="secondary">Roll back</Button>
        </Tooltip>
        <Tooltip content="Open the runtime logs">
          <Button variant="ghost">Logs</Button>
        </Tooltip>
      </Row>
      <Row label="Popover">
        <Popover defaultOpen={openState === "popover"}>
          <PopoverTrigger render={<Button />}>Rollout settings</PopoverTrigger>
          <PopoverContent>
            <PopoverTitle>Rollout</PopoverTitle>
            <PopoverDescription>Send a share of traffic to the new version first.</PopoverDescription>
            <div className="mt-3 flex justify-end">
              <PopoverClose render={<Button size="sm" variant="primary" />}>Done</PopoverClose>
            </div>
          </PopoverContent>
        </Popover>
      </Row>
      <Row label="Dialog (centered, 220ms in, 150ms out)">
        <Dialog defaultOpen={openState === "dialog"}>
          <DialogTrigger render={<Button variant="danger" />}>Delete project</DialogTrigger>
          <DialogContent>
            <DialogTitle>Delete my-app?</DialogTitle>
            <DialogDescription>This removes all deployments and bindings. It cannot be undone.</DialogDescription>
            <DialogFooter>
              <DialogClose render={<Button />}>Cancel</DialogClose>
              <DialogClose render={<Button variant="danger" />}>Delete project</DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Row>
      <Row label="Dropdown menu: with a checkbox item, every item shares one fixed gutter">
        <DropdownMenu defaultOpen={openState === "menu"}>
          <DropdownMenuTrigger render={<Button />}>Actions</DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Deployment</DropdownMenuLabel>
              <DropdownMenuItem>Promote to production</DropdownMenuItem>
              <DropdownMenuItem>View logs</DropdownMenuItem>
              <DropdownMenuItem disabled>Roll back (unavailable)</DropdownMenuItem>
              <DropdownMenuCheckboxItem defaultChecked>Pin version</DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem>Notify the team</DropdownMenuCheckboxItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive>Delete deployment</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="secondary" />}>Radio items</DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Theme</DropdownMenuLabel>
              <DropdownMenuRadioGroup defaultValue="system">
                <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="secondary" />}>Plain menu</DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem>Rename</DropdownMenuItem>
            <DropdownMenuItem>Duplicate</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive>Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Row>
      <ToastLab />
    </Section>
  );
}

function TabsSection() {
  return (
    <Section title="Tabs" hint="One pill slides to the active tab over 250ms, ease-in-out. Use the arrow keys.">
      <Tabs defaultValue="overview">
        <TabsList aria-label="Project sections">
          <TabsTab value="overview">Overview</TabsTab>
          <TabsTab value="deployments">Deployments</TabsTab>
          <TabsTab value="logs">Logs</TabsTab>
          <TabsTab value="settings" disabled>
            Settings
          </TabsTab>
        </TabsList>
        <TabsPanel value="overview">Traffic, errors and the active version.</TabsPanel>
        <TabsPanel value="deployments">Every version, newest first.</TabsPanel>
        <TabsPanel value="logs">Live request logs.</TabsPanel>
      </Tabs>
    </Section>
  );
}

function MiscSection() {
  return (
    <Section title="Skeleton and CopyId">
      <Row label="Skeleton (aria-hidden, a soft fade)">
        <div className="flex w-full max-w-sm flex-col gap-2" aria-busy="true">
          <Skeleton className="w-1/3" />
          <Skeleton />
          <Skeleton className="w-4/5" />
        </div>
        <Skeleton kind="circle" />
        <Skeleton kind="block" className="max-w-48" />
      </Row>
      <Row label="CopyId (click: the icons swap with scale, blur and fade)">
        <CopyId value="dpl_8f3a91c2d4e7" label="Copy deployment ID" />
        <CopyId value="9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d" display="9b1deb4d...cb6d" label="Copy project ID" />
        <div className="w-40 rounded-lg bg-well p-2">
          <CopyId value="a-very-long-identifier-that-has-to-truncate-inside-a-narrow-cell" label="Copy ID" />
        </div>
      </Row>
    </Section>
  );
}

function ChartsSection() {
  return (
    <Section
      title="Charts"
      hint="@sproutboat/ikada/charts: TimeseriesChart and Sparkline on TanStack Charts, painted by the chart tokens. Hover or use the arrow keys for the tooltip."
    >
      <Row label="TimeseriesChart: requests (area) with a deploy marker">
        <TimeseriesChart
          ariaLabel="Requests per minute"
          series={[{ id: "req", label: "Requests", data: requests, area: true }]}
          deploy={deploy}
          {...format}
          formatValue={perMinute}
        />
      </Row>
      <div className="grid gap-5 lg:grid-cols-2">
        <Row label="Errors with a deploy marker">
          <TimeseriesChart
            ariaLabel="Errors per minute"
            height={150}
            series={[{ id: "err", label: "Errors", data: errors, color: "errors", dashed: true }]}
            deploy={deploy}
            yTicks={2}
            {...format}
            formatValue={errPerMinute}
          />
        </Row>
        <Row label="Latency: p50 and p99">
          <TimeseriesChart
            ariaLabel="Latency"
            height={150}
            series={[
              { id: "p99", label: "p99", data: p99, color: "series", dashed: true },
              { id: "p50", label: "p50", data: p50, color: "requests" },
            ]}
            deploy={deploy}
            {...format}
            formatValue={millis}
          />
        </Row>
      </div>
      <Row label="Sparkline">
        <div className="grid w-full gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {sparks.map(([label, data, color, fmt]) => (
            <div key={label} className="flex flex-col gap-1 rounded-lg bg-well p-3">
              <span className="text-xs font-semibold text-fg-muted">{label}</span>
              <Sparkline
                ariaLabel={`${label}, last 24 hours`}
                data={data.map((p) => p.value)}
                color={color}
                formatValue={fmt}
                formatPoint={halfHourClock}
              />
            </div>
          ))}
        </div>
      </Row>
    </Section>
  );
}

function EasingTrack({ name, curve, run }: { name: string; curve: string; run: boolean }) {
  const style: CSSProperties & Record<`--${string}`, string> = { "--ease-curve": curve };
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-xs text-fg-muted">
        {name} {curve}
      </span>
      <div className="ease-track @container h-6 rounded-md bg-well p-1" data-run={run} style={style}>
        <span data-dot className="block size-4 rounded-full bg-brand" />
      </div>
    </div>
  );
}

function MotionSection() {
  const [run, setRun] = useState(false);

  return (
    <Section
      title="Motion"
      hint="Use the speed and reduced-motion controls in the header; they apply to the whole page."
    >
      <Row label="Curves: ease-out for everything entering or pressed; in-out only for a sliding indicator">
        <div className="flex w-full max-w-xl flex-col gap-3">
          <EasingTrack name="ease-out" curve="cubic-bezier(0.23, 1, 0.32, 1)" run={run} />
          <EasingTrack name="ease-in-out" curve="cubic-bezier(0.77, 0, 0.175, 1)" run={run} />
          <div>
            <Button size="sm" onClick={() => setRun(!run)}>
              {run ? "Reset" : "Play"}
            </Button>
          </div>
        </div>
      </Row>
      <Row label="Press (hold the pointer down): scale 0.97, 160ms ease-out">
        <Button variant="primary">Press and hold</Button>
        <Button>Press and hold</Button>
        <Button variant="ghost">Press and hold</Button>
      </Row>
      <Row label="Pointer opens animate from the trigger; Tab to a trigger and press Enter, and it opens with no animation">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button />}>Menu</DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem>One</DropdownMenuItem>
            <DropdownMenuItem>Two</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Select options={regions} aria-label="Region" placeholder="Select" className="w-44" />
        <Popover>
          <PopoverTrigger render={<Button />}>Popover</PopoverTrigger>
          <PopoverContent>
            <PopoverTitle>Scales from the trigger</PopoverTitle>
            <PopoverDescription>180ms in, 120ms out, from 0.96.</PopoverDescription>
          </PopoverContent>
        </Popover>
        <Dialog>
          <DialogTrigger render={<Button />}>Dialog</DialogTrigger>
          <DialogContent>
            <DialogTitle>Scales from its center</DialogTitle>
            <DialogDescription>
              220ms in, 150ms out, from 0.96. Opened with the keyboard, it does not animate.
            </DialogDescription>
            <DialogFooter>
              <DialogClose render={<Button />}>Close</DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Row>
      <Row label="Tooltip warm skip-delay: the first waits 450ms, the next ones open at once for 300ms">
        {["Deploy", "Logs", "Domains", "Settings"].map((n) => (
          <Tooltip key={n} content={`${n} shortcut`}>
            <Button variant="secondary" size="sm">
              {n}
            </Button>
          </Tooltip>
        ))}
      </Row>
      <Row label="Toasts rise 300ms ease-out and leave in 200ms; reduced motion fades in place. Try the buttons under Overlays.">
        <Button onClick={() => toast.add({ title: "Deployment ready", description: "v12 is live.", tone: "success" })}>
          Push a toast
        </Button>
      </Row>
    </Section>
  );
}

/** Every component in every state. Rendered once per theme panel. */
export function Gallery() {
  return (
    <div className="flex flex-col gap-8">
      <Tokens />
      <ButtonSection />
      <FormSection />
      <StatusSection />
      <OverlaySection />
      <TabsSection />
      <MiscSection />
      <AppPiecesSection />
      <ChartsSection />
      <MotionSection />
      <DashboardSections />
    </div>
  );
}
