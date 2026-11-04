import { useEffect, useState } from "react";
import type { ReactNode } from "react";
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
import { ToastProvider, toast } from "../src/components/toast";
import { Tooltip, TooltipProvider } from "../src/components/tooltip";
import { CopyIcon } from "../src/lib/icons";

const params = new URLSearchParams(location.search);
/** ?open=menu|select|dialog|tooltip|popover|toast opens that state for screenshots. */
const openState = params.get("open");

const regions = [
  { value: "iad", label: "Washington, D.C." },
  { value: "fra", label: "Frankfurt" },
  { value: "sin", label: "Singapore" },
  { value: "syd", label: "Sydney", disabled: true },
];
const statuses: { status: Status; label: string }[] = [
  { status: "success", label: "Ready" },
  { status: "warning", label: "Fell back to supervisor" },
  { status: "danger", label: "Build failed" },
  { status: "info", label: "Building" },
  { status: "neutral", label: "Stopped" },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby={`h-${title}`}>
      <h2 id={`h-${title}`} className="scroll-mt-16 text-md font-semibold">
        {title}
      </h2>
      <div className="flex flex-col gap-4 rounded-lg border border-hairline bg-surface p-4 sm:p-5">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

const forcedFocus = "outline-solid outline-2 outline-offset-2 outline-focus";

function ButtonSection() {
  const [loading, setLoading] = useState(false);
  function fakeSave() {
    setLoading(true);
    setTimeout(() => setLoading(false), 1800);
  }

  return (
    <Section title="Button">
      <Row label="Variants">
        <Button variant="primary">Create project</Button>
        <Button variant="secondary">Cancel</Button>
        <Button variant="ghost">Skip</Button>
        <Button variant="danger">Delete project</Button>
      </Row>
      <Row label="Sizes">
        <Button size="sm">Small</Button>
        <Button size="md">Medium</Button>
        <Button size="lg">Large</Button>
      </Row>
      <Row label="Disabled">
        <Button variant="primary" disabled>
          Create project
        </Button>
        <Button disabled>Cancel</Button>
        <Button variant="ghost" disabled>
          Skip
        </Button>
        <Button variant="danger" disabled>
          Delete project
        </Button>
      </Row>
      <Row label="Loading (click to try)">
        <Button variant="primary" loading={loading} onClick={fakeSave}>
          Save changes
        </Button>
        <Button loading>Deploying</Button>
        <Button variant="danger" loading>
          Deleting
        </Button>
      </Row>
      <Row label="Focus-visible (forced) and hover with the pointer">
        <Button variant="primary" className={forcedFocus}>
          Primary
        </Button>
        <Button className={forcedFocus}>Secondary</Button>
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
      </Row>
      <Row label="Link">
        <Link href="#links">Read the docs</Link>
        <Link href="https://sproutboat.com" external>
          sproutboat.com
        </Link>
        <Link href="#links" aria-disabled="true">
          Disabled link
        </Link>
      </Row>
    </Section>
  );
}

function FormSection() {
  const [region, setRegion] = useState<string | null>("fra");
  return (
    <Section title="Form controls">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Project name" description="Lowercase letters, digits and dashes.">
          <Input placeholder="my-app" />
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
        <Field label="Region">
          <Select options={regions} value={region} onValueChange={setRegion} defaultOpen={openState === "select"} />
        </Field>
        <Field label="Runtime (disabled)">
          <Select options={regions} disabled defaultValue="iad" />
        </Field>
        <Field label="Region (invalid)" error="Pick a region to deploy to.">
          <Select options={regions} placeholder="Choose a region" />
        </Field>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="standalone">Standalone label</Label>
          <Input id="standalone" placeholder="Label + input without Field" />
        </div>
      </div>
      <Row label="Checkbox">
        <Checkbox label="Unchecked" />
        <Checkbox label="Checked" defaultChecked />
        <Checkbox label="Mixed" indeterminate />
        <Checkbox label="Disabled" disabled />
        <Checkbox label="Disabled, checked" disabled defaultChecked />
        <Checkbox label="Invalid" invalid />
        <Checkbox label="With description" description="Applies to all branches." />
      </Row>
      <Row label="Switch">
        <Switch label="Off" />
        <Switch label="On" defaultChecked />
        <Switch label="Disabled" disabled />
        <Switch label="Disabled, on" disabled defaultChecked />
      </Row>
    </Section>
  );
}

function StatusSection() {
  return (
    <Section title="Badge and StatusDot">
      <Row label="Badge tones">
        {statuses.map((s) => (
          <Badge key={s.status} tone={s.status} dot>
            {s.label}
          </Badge>
        ))}
      </Row>
      <Row label="Badge without dot">
        <Badge>v12</Badge>
        <Badge tone="success">Production</Badge>
        <Badge tone="warning">Supervisor</Badge>
      </Row>
      <Row label="StatusDot with label">
        {statuses.map((s) => (
          <StatusDot key={s.status} status={s.status} label={s.label} />
        ))}
        <StatusDot status="info" label="Deploying" pulse />
      </Row>
      <Row label="StatusDot, label hidden visually (still announced)">
        <StatusDot status="success" label="Ready" hideLabel />
        <StatusDot status="warning" label="Fell back to supervisor" hideLabel />
      </Row>
    </Section>
  );
}

function OverlaySection() {
  return (
    <Section title="Overlays">
      <Row label="Tooltip">
        <Tooltip content="Copies the deployment ID" defaultOpen={openState === "tooltip"}>
          <Button>Hover or focus me</Button>
        </Tooltip>
      </Row>
      <Row label="Popover">
        <Popover defaultOpen={openState === "popover"}>
          <PopoverTrigger render={<Button />}>Rollout settings</PopoverTrigger>
          <PopoverContent>
            <PopoverTitle>Rollout</PopoverTitle>
            <PopoverDescription>Send a share of traffic to the new version first.</PopoverDescription>
            <div className="mt-3 flex justify-end">
              <PopoverClose render={<Button size="sm" />}>Done</PopoverClose>
            </div>
          </PopoverContent>
        </Popover>
      </Row>
      <Row label="Dialog">
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
      <Row label="Dropdown menu">
        <DropdownMenu defaultOpen={openState === "menu"}>
          <DropdownMenuTrigger render={<Button />}>Actions</DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Deployment</DropdownMenuLabel>
              <DropdownMenuItem>Promote to production</DropdownMenuItem>
              <DropdownMenuItem>View logs</DropdownMenuItem>
              <DropdownMenuItem disabled>Roll back (unavailable)</DropdownMenuItem>
              <DropdownMenuCheckboxItem defaultChecked>Pin version</DropdownMenuCheckboxItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive>Delete deployment</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Row>
      <Row label="Toast">
        <Button
          onClick={() =>
            toast.add({
              title: "Deployment ready",
              description: "v12 is live on all regions.",
              type: "success",
            })
          }
        >
          Success
        </Button>
        <Button
          onClick={() =>
            toast.add({
              title: "Fell back to supervisor",
              description: "sproutd refused to load v12; it runs on the supervisor.",
              type: "warning",
              timeout: 0,
            })
          }
        >
          Warning
        </Button>
        <Button
          onClick={() =>
            toast.add({ title: "Build failed", description: "Fix the error and deploy again.", type: "danger" })
          }
        >
          Danger
        </Button>
        <Button onClick={() => toast.add({ title: "Copied to clipboard", type: "neutral" })}>Neutral</Button>
      </Row>
    </Section>
  );
}

function TabsSection() {
  return (
    <Section title="Tabs">
      <Tabs defaultValue="overview">
        <TabsList aria-label="Project sections">
          <TabsTab value="overview">Overview</TabsTab>
          <TabsTab value="deployments">Deployments</TabsTab>
          <TabsTab value="logs">Logs</TabsTab>
          <TabsTab value="settings" disabled>
            Settings (disabled)
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
      <Row label="Skeleton (aria-hidden, pulses only with motion allowed)">
        <div className="flex w-full max-w-sm flex-col gap-2" aria-busy="true">
          <Skeleton className="w-1/3" />
          <Skeleton />
          <Skeleton className="w-4/5" />
        </div>
        <Skeleton kind="circle" />
        <Skeleton kind="block" className="max-w-48" />
      </Row>
      <Row label="CopyId">
        <CopyId value="dpl_8f3a91c2d4e7" label="Copy deployment ID" />
        <CopyId value="9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d" display="9b1deb4d...cb6d" label="Copy project ID" />
        <div className="w-40 rounded-md border border-hairline p-2">
          <CopyId value="a-very-long-identifier-that-has-to-truncate-inside-a-narrow-cell" label="Copy ID" />
        </div>
      </Row>
    </Section>
  );
}

export function App() {
  useEffect(() => {
    if (!openState) return;
    const id = openState === "select" ? "h-Form controls" : "h-Overlays";
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, []);
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute("data-theme") ?? "dark");
  const [density, setDensity] = useState("comfortable");

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("sb-theme", next);
    } catch {
      // Private mode: the choice just will not persist.
    }
    setTheme(next);
  }

  return (
    <TooltipProvider>
      <ToastProvider>
        <div data-density={density} className="min-h-dvh">
          <header className="sticky top-0 z-(--sb-z-sticky) flex items-center gap-2 border-b border-hairline bg-canvas/90 px-4 py-2.5 backdrop-blur sm:px-6">
            <h1 className="min-w-0 flex-1 truncate text-md font-semibold">@sproutboat/ui</h1>
            <Button
              size="sm"
              onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")}
              aria-pressed={density === "compact"}
            >
              Density: {density}
            </Button>
            <Button
              size="sm"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            >
              {theme === "dark" ? "Light" : "Dark"}
            </Button>
          </header>

          <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-6 sm:px-6">
            <p className="max-w-prose text-fg-muted">
              Every P0 primitive in its states. Theme: {theme}. Density: {density}. Add{" "}
              <code className="font-mono text-sm">?open=menu</code>, select, dialog, tooltip, popover or toast to the
              URL to open that state.
            </p>

            <ButtonSection />

            <FormSection />

            <StatusSection />

            <OverlaySection />

            <TabsSection />

            <MiscSection />
          </main>
          {openState === "toast" ? <ToastOnLoad /> : null}
        </div>
      </ToastProvider>
    </TooltipProvider>
  );
}

function ToastOnLoad() {
  useState(() => {
    queueMicrotask(() => {
      toast.add({ title: "Deployment ready", description: "v12 is live on all regions.", type: "success", timeout: 0 });
      toast.add({
        title: "Fell back to supervisor",
        description: "sproutd refused to load v12.",
        type: "warning",
        timeout: 0,
      });
    });
  });
  return null;
}
