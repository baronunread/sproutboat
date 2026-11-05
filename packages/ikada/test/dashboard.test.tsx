import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
  Banner,
  Breadcrumbs,
  CommandPalette,
  EmptyState,
  FallbackPill,
  Meter,
  MetricTile,
  PageHeader,
  PageTab,
  PageTabs,
  RuntimeChip,
  Sidebar,
  SidebarItem,
  SidebarNav,
  SidebarToggle,
  SidebarTrigger,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableError,
  TableHead,
  TableHeader,
  TableLoading,
  TableRow,
  TooltipProvider,
  TrafficSplitBar,
  UsageMeter,
  nextSort,
  parsePrefix,
  usageState,
} from "../src";
import type { PaletteGroup, SortDirection } from "../src";

afterEach(cleanup);

describe("Spinner", () => {
  test("is a labelled status, or hidden when decorative", () => {
    const { rerender } = render(<Spinner size="lg" label="Deploying" />);
    expect(screen.getByRole("status").textContent).toBe("Deploying");
    rerender(<Spinner decorative />);
    expect(screen.queryByRole("status")).toBeNull();
  });
  test("turns only under motion-safe and pulses under reduced motion", () => {
    const { container } = render(<Spinner />);
    const cls = container.querySelector("svg")?.getAttribute("class") ?? "";
    expect(cls).toContain("motion-safe:animate-spin");
    expect(cls).toContain("motion-reduce:animate-pulse");
  });
});

describe("Banner", () => {
  test("danger is an alert, other tones are polite status", () => {
    const { rerender } = render(<Banner tone="danger">Deploys paused</Banner>);
    expect(screen.getByRole("alert").textContent).toContain("Deploys paused");
    rerender(<Banner tone="info">Heads up</Banner>);
    expect(screen.getByRole("status")).toBeTruthy();
  });
  test("dismissible banner hides and calls onDismiss; action renders", async () => {
    let dismissed = 0;
    render(
      <Banner title="Quota" dismissible onDismiss={() => (dismissed += 1)} action={<button type="button">View</button>}>
        86% used
      </Banner>,
    );
    expect(screen.getByRole("button", { name: "View" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(dismissed).toBe(1);
    expect(screen.queryByText("Quota")).toBeNull();
  });
});

describe("Breadcrumbs", () => {
  const items = [{ label: "Org", href: "/o" }, { label: "Project", href: "/p" }, { label: "production" }];
  test("is a nav landmark with the last item as the current page", () => {
    render(<Breadcrumbs items={items} />);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Org", "Project"]);
    expect(within(nav).getByText("production").getAttribute("aria-current")).toBe("page");
  });
  test("a long trail collapses the middle into a menu you can open with the keyboard", async () => {
    const long = [
      { label: "Org", href: "/o" },
      { label: "Team", href: "/t" },
      { label: "Apps", href: "/a" },
      { label: "Project", href: "/p" },
      { label: "production" },
    ];
    render(<Breadcrumbs items={long} maxItems={3} />);
    expect(screen.queryByText("Team")).toBeNull();
    const more = screen.getByRole("button", { name: "2 more levels" });
    more.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("menuitem", { name: "Team" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Apps" })).toBeTruthy();
    expect(screen.getByText("production").getAttribute("aria-current")).toBe("page");
  });
});

describe("PageHeader", () => {
  test("renders one h1 with status, actions, breadcrumbs and a tabs slot", () => {
    render(
      <PageHeader
        title="field-notes"
        status={<span>Live</span>}
        actions={<button type="button">Deploy</button>}
        breadcrumbs={<Breadcrumbs items={[{ label: "Org", href: "/" }, { label: "Project" }]} />}
        tabs={
          <PageTabs>
            <PageTab href="#o" current>
              Overview
            </PageTab>
            <PageTab href="#l">Logs</PageTab>
          </PageTabs>
        }
      />,
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deploy" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Logs" }).getAttribute("aria-current")).toBeNull();
  });
});

function SidebarHarness({ mode }: { mode: "static" | "drawer" }) {
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider>
      <SidebarTrigger onClick={() => setOpen(true)} />
      <Sidebar mode={mode} collapsed={collapsed} open={open} onOpenChange={setOpen}>
        <SidebarToggle collapsed={collapsed} onCollapsedChange={setCollapsed} />
        <SidebarNav label="Account">
          <SidebarItem href="#p" current>
            Projects
          </SidebarItem>
          <SidebarItem href="#l">Logs</SidebarItem>
        </SidebarNav>
      </Sidebar>
    </TooltipProvider>
  );
}

describe("Sidebar", () => {
  test("marks the current item and keeps links in tab order", async () => {
    render(<SidebarHarness mode="static" />);
    const nav = screen.getByRole("navigation", { name: "Account" });
    expect(within(nav).getByRole("link", { name: "Projects" }).getAttribute("aria-current")).toBe("page");
    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Collapse sidebar" }));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Projects" }));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "Logs" }));
  });
  test("collapses to a rail: labels stay accessible, toggle reports aria-expanded", async () => {
    render(<SidebarHarness mode="static" />);
    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(toggle);
    const expand = screen.getByRole("button", { name: "Expand sidebar" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("complementary").hasAttribute("data-collapsed")).toBe(true);
    expect(screen.getByRole("link", { name: "Logs" })).toBeTruthy();
  });
  test("mobile drawer opens as a modal dialog, Escape closes it and focus returns", async () => {
    render(<SidebarHarness mode="drawer" />);
    expect(screen.queryByRole("navigation")).toBeNull();
    const trigger = screen.getByRole("button", { name: "Open navigation" });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Navigation" });
    expect(within(dialog).getByRole("link", { name: "Logs" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /sidebar/ })).toBeNull();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
  test("choosing a link closes the drawer", async () => {
    render(<SidebarHarness mode="drawer" />);
    await userEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("link", { name: "Logs" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

function SortableTable({ initial }: { initial?: SortDirection }) {
  const [sort, setSort] = useState<SortDirection | undefined>(initial);
  const rows = [3, 1, 2].sort((a, b) => (sort === "desc" ? b - a : sort === "asc" ? a - b : 0));
  return (
    <Table label="Versions">
      <TableHeader>
        <TableRow>
          <TableHead sortable sort={sort} onSort={() => setSort(nextSort(sort))}>
            Version
          </TableHead>
          <TableHead>Message</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((n) => (
          <TableRow key={n} selected={n === 2}>
            <TableCell>v{n}</TableCell>
            <TableCell>msg {n}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

describe("Table", () => {
  test("is a semantic table in a labelled, focusable scroll region", () => {
    render(<SortableTable />);
    const region = screen.getByRole("region", { name: "Versions" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.className).toContain("overflow-auto");
    expect(within(region).getByRole("table")).toBeTruthy();
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });
  test("sort header is a button: Enter cycles aria-sort none, ascending, descending, none", async () => {
    render(<SortableTable />);
    const header = screen.getByRole("columnheader", { name: "Version" });
    expect(header.getAttribute("aria-sort")).toBe("none");
    const button = within(header).getByRole("button");
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    expect(
      screen
        .getAllByRole("cell")
        .filter((c) => c.textContent?.startsWith("v"))
        .map((c) => c.textContent),
    ).toEqual(["v1", "v2", "v3"]);
    await userEvent.keyboard(" ");
    expect(header.getAttribute("aria-sort")).toBe("descending");
    expect(
      screen
        .getAllByRole("cell")
        .filter((c) => c.textContent?.startsWith("v"))
        .map((c) => c.textContent),
    ).toEqual(["v3", "v2", "v1"]);
    await userEvent.keyboard("{Enter}");
    expect(header.getAttribute("aria-sort")).toBe("none");
  });
  test("unsortable headers have no aria-sort and no button", () => {
    render(<SortableTable />);
    const header = screen.getByRole("columnheader", { name: "Message" });
    expect(header.getAttribute("aria-sort")).toBeNull();
    expect(within(header).queryByRole("button")).toBeNull();
  });
  test("selected rows are marked", () => {
    render(<SortableTable />);
    const selected = screen.getAllByRole("row").filter((r) => r.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toContain("v2");
  });
  test("sticky header sets the sticky hook", () => {
    render(
      <Table label="Sticky" stickyHeader maxHeight="10rem">
        <TableHeader>
          <TableRow>
            <TableHead>A</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );
    const region = screen.getByRole("region", { name: "Sticky" });
    expect(region.hasAttribute("data-sticky")).toBe(true);
    expect(region.style.maxHeight).toBe("10rem");
  });
  test("empty, loading and error bodies span every column", () => {
    render(
      <>
        <Table label="Empty">
          <TableBody>
            <TableEmpty colSpan={3}>Nothing here</TableEmpty>
          </TableBody>
        </Table>
        <Table label="Loading" aria-busy="true">
          <TableBody>
            <TableLoading columns={3} rows={2} />
          </TableBody>
        </Table>
        <Table label="Error">
          <TableBody>
            <TableError colSpan={3} action={<button type="button">Retry</button>}>
              Try later
            </TableError>
          </TableBody>
        </Table>
      </>,
    );
    expect(screen.getByText("Nothing here").closest("td")?.getAttribute("colspan")).toBe("3");
    expect(screen.getByRole("region", { name: "Loading" }).querySelectorAll("tr")).toHaveLength(2);
    expect(screen.getByRole("alert").textContent).toContain("Could not load this list");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
  test("nextSort cycles", () => {
    expect(nextSort(undefined)).toBe("asc");
    expect(nextSort("asc")).toBe("desc");
    expect(nextSort("desc")).toBeUndefined();
  });
});

describe("EmptyState", () => {
  test("icon, title, one line and one action", () => {
    render(
      <EmptyState
        icon={<svg data-testid="icon" />}
        title="No databases"
        description="Create one."
        action={<button type="button">Create</button>}
      />,
    );
    expect(screen.getByRole("heading", { name: "No databases", level: 3 })).toBeTruthy();
    expect(screen.getByText("Create one.")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});

describe("Meter and UsageMeter", () => {
  test("Meter has meter semantics and a label", () => {
    render(<Meter label="Build minutes" value={42} />);
    const meter = screen.getByRole("meter", { name: "Build minutes" });
    expect(meter.getAttribute("aria-valuenow")).toBe("42");
  });
  test("usageState: amber near and at the limit, red only when blocked", () => {
    expect(usageState(10, 100)).toBe("under");
    expect(usageState(80, 100)).toBe("near");
    expect(usageState(100, 100)).toBe("at");
    expect(usageState(100, 100, 0.8, true)).toBe("blocked");
    expect(usageState(5, null)).toBe("unlimited");
  });
  function fillTone(): string | null {
    return document.querySelector("[data-tone]")?.getAttribute("data-tone") ?? null;
  }
  test("under is neutral, near and at are amber and written out, blocked is red", () => {
    const { rerender } = render(<UsageMeter label="Requests" used={10} limit={100} />);
    expect(fillTone()).toBe("normal");
    rerender(<UsageMeter label="Requests" used={85} limit={100} />);
    expect(fillTone()).toBe("warning");
    expect(screen.getByText("Near limit")).toBeTruthy();
    rerender(<UsageMeter label="Requests" used={100} limit={100} />);
    expect(fillTone()).toBe("warning");
    expect(screen.getByText("At limit")).toBeTruthy();
    rerender(<UsageMeter label="Requests" used={100} limit={100} blocked />);
    expect(fillTone()).toBe("danger");
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByRole("meter").getAttribute("aria-valuetext")).toContain("blocked");
  });
  test("unlimited shows the number and no meter", () => {
    render(<UsageMeter label="Bandwidth" used={182} limit={null} unit="GB" />);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByText("182 GB, unlimited")).toBeTruthy();
  });
  test("over the limit never overflows the bar", () => {
    render(<UsageMeter label="Seats" used={9} limit={5} />);
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("5");
  });
});

describe("RuntimeChip and FallbackPill", () => {
  test("sproutd is neutral, supervisor is amber, unknown is neutral", () => {
    render(
      <>
        <RuntimeChip runtime="sproutd" />
        <RuntimeChip runtime="supervisor" />
        <RuntimeChip runtime="unknown" />
      </>,
    );
    expect(screen.getByText("sproutd").className).toContain("bg-neutral-soft");
    expect(screen.getByText("supervisor").className).toContain("bg-warn-soft");
    expect(screen.getByText("supervisor").className).not.toContain("danger");
    expect(screen.getByText("unknown").className).toContain("bg-neutral-soft");
  });
  test("FallbackPill is amber, never red, focusable, and shows the reason in a tooltip", async () => {
    render(
      <TooltipProvider delay={0}>
        <FallbackPill reason="abi_rejected" defaultOpen />
      </TooltipProvider>,
    );
    const pill = screen.getByRole("button", { name: "Fell back to supervisor" });
    expect(pill.className).toContain("bg-warn-soft");
    expect(pill.className).not.toContain("danger");
    expect(await screen.findByText("abi_rejected")).toBeTruthy();
  });
  test("a custom label and no reason means no tooltip", () => {
    render(<FallbackPill>Served by supervisor</FallbackPill>);
    expect(screen.getByRole("button", { name: "Served by supervisor" })).toBeTruthy();
  });
});

describe("TrafficSplitBar", () => {
  const two = [
    { id: "a", label: "v47", percent: 90 },
    { id: "b", label: "v48", percent: 10 },
  ];
  test("each version is a keyboard-focusable meter with readable value text", async () => {
    render(<TrafficSplitBar versions={two} />);
    expect(screen.getByRole("group", { name: "Traffic split" })).toBeTruthy();
    const meters = screen.getAllByRole("meter");
    expect(meters).toHaveLength(2);
    expect(meters[0]?.getAttribute("aria-valuetext")).toBe("v47, 90% of traffic");
    expect(meters[1]?.getAttribute("value")).toBe("10");
    await userEvent.tab();
    expect(document.activeElement).toBe(meters[0]);
    await userEvent.tab();
    expect(document.activeElement).toBe(meters[1]);
  });
  test("a single version fills the bar", () => {
    render(<TrafficSplitBar versions={[{ id: "a", label: "v47", percent: 100 }]} />);
    expect(screen.getAllByRole("meter")).toHaveLength(1);
  });
  test("three or more versions all appear, zero-percent ones only in the legend", () => {
    render(
      <TrafficSplitBar
        versions={[
          { id: "a", label: "v47", percent: 60 },
          { id: "b", label: "v48", percent: 30 },
          { id: "c", label: "v46", percent: 10 },
          { id: "d", label: "v45", percent: 0 },
        ]}
      />,
    );
    expect(screen.getAllByRole("meter")).toHaveLength(3);
    expect(document.body.textContent).toContain("v45");
  });
  test("zero traffic says so and has no meters", () => {
    render(<TrafficSplitBar versions={[{ id: "a", label: "v47", percent: 0 }]} />);
    expect(screen.queryAllByRole("meter")).toHaveLength(0);
    expect(document.body.textContent).toContain("No traffic yet");
  });
});

describe("MetricTile", () => {
  test("shows value, unit, delta direction in words, hint and the sparkline slot", () => {
    render(
      <MetricTile
        label="Requests"
        value="1.28"
        unit="M"
        delta={{ value: "12%", direction: "up" }}
        hint="14.8 req/s"
        sparkline={<div data-testid="spark" />}
      />,
    );
    const tile = screen.getByRole("group", { name: "Requests" });
    expect(tile.textContent).toContain("1.28");
    expect(tile.textContent).toContain("Up 12%");
    expect(screen.getByTestId("spark")).toBeTruthy();
  });
  test("down delta; bad news is red only when you say so", () => {
    render(<MetricTile label="CPU" value="3" delta={{ value: "1 ms", direction: "down", sentiment: "good" }} />);
    expect(screen.getByText(/Down/).parentElement?.className).toContain("text-brand-fg");
  });
  test("loading is busy and hides the value and the sparkline", () => {
    render(<MetricTile label="Requests" loading value="9" sparkline={<div data-testid="spark" />} />);
    const tile = screen.getByRole("group", { name: "Requests" });
    expect(tile.getAttribute("aria-busy")).toBe("true");
    expect(tile.textContent).not.toContain("9");
    expect(screen.queryByTestId("spark")).toBeNull();
  });
  test("no data shows a dash and the reason", () => {
    render(
      <MetricTile label="Fallback" noData emptyText="No fallback" value="5" delta={{ value: "1", direction: "up" }} />,
    );
    const tile = screen.getByRole("group", { name: "Fallback" });
    expect(tile.textContent).toContain("—");
    expect(tile.textContent).toContain("No fallback");
    expect(tile.textContent).not.toContain("Up");
  });
});

const groups: PaletteGroup[] = [
  { id: "projects", label: "Projects", items: [{ id: "fn", label: "field-notes", hint: "production" }] },
  {
    id: "storage",
    label: "Storage",
    items: [
      { id: "db", label: "notes-db", scope: "d1" },
      { id: "kv", label: "notes-cache", scope: "kv" },
    ],
  },
];
const prefixes = [
  { scope: "d1", label: "D1 databases" },
  { scope: "kv", label: "KV namespaces" },
];

function PaletteHarness({ onSelect = () => {} }: { onSelect?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open palette
      </button>
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        groups={groups}
        recents={[{ id: "r1", label: "digest-jobs" }]}
        prefixes={prefixes}
        onSelect={(item) => onSelect(item.id)}
      />
    </>
  );
}

async function openPalette() {
  await userEvent.click(screen.getByRole("button", { name: "Open palette" }));
  return await screen.findByRole("dialog", { name: "Command palette" });
}

describe("CommandPalette", () => {
  test("parsePrefix recognises known prefixes only", () => {
    expect(parsePrefix("d1: notes", prefixes)).toEqual({ prefix: prefixes[0], rest: "notes" });
    expect(parsePrefix("zz: notes", prefixes)).toEqual({ rest: "zz: notes" });
    expect(parsePrefix("plain", prefixes)).toEqual({ rest: "plain" });
  });
  test("opens as a dialog with a focused combobox, recents first, then groups, and a shortcut hint", async () => {
    render(<PaletteHarness />);
    const dialog = await openPalette();
    const input = within(dialog).getByRole("combobox");
    expect(document.activeElement).toBe(input);
    const groupsShown = within(dialog)
      .getAllByRole("group")
      .map((g) => g.getAttribute("aria-labelledby"));
    expect(groupsShown).toHaveLength(3);
    expect(within(dialog).getByText("Recent")).toBeTruthy();
    expect(within(dialog).getAllByRole("option")).toHaveLength(4);
    expect(dialog.textContent).toContain("Prefixes");
    expect(dialog.textContent).toContain("d1:");
  });
  test("opening does not animate: no transition classes on the popup or backdrop", async () => {
    render(<PaletteHarness />);
    const dialog = await openPalette();
    expect(dialog.className).not.toContain("transition");
    expect(dialog.className).not.toContain("starting-style");
  });
  test("arrow keys move aria-activedescendant, Enter picks and closes", async () => {
    const picked: string[] = [];
    render(<PaletteHarness onSelect={(id) => picked.push(id)} />);
    const dialog = await openPalette();
    const input = within(dialog).getByRole("combobox");
    const options = within(dialog).getAllByRole("option");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[2]?.id);
    expect(options[2]?.getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[3]?.id);
    await userEvent.keyboard("{Enter}");
    expect(picked).toEqual(["kv"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  test("typing filters; no matches shows a no-results message", async () => {
    render(<PaletteHarness />);
    const dialog = await openPalette();
    await userEvent.keyboard("field");
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["field-notesproduction"]);
    await userEvent.keyboard("zzz");
    expect(within(dialog).queryAllByRole("option")).toHaveLength(0);
    expect(within(dialog).getByRole("status").textContent).toContain("No results for “fieldzzz”");
  });
  test("a typed prefix scopes the search and shows a chip; Backspace on an empty term clears it", async () => {
    render(<PaletteHarness />);
    const dialog = await openPalette();
    await userEvent.keyboard("d1:");
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["notes-db"]);
    expect(within(dialog).getAllByText("d1:").length).toBeGreaterThan(0);
    await userEvent.keyboard("{Backspace}");
    expect(within(dialog).getAllByRole("option").length).toBeGreaterThan(1);
  });
  test("Escape closes and returns focus to the opener; focus stays inside while open", async () => {
    render(<PaletteHarness />);
    const opener = screen.getByRole("button", { name: "Open palette" });
    const dialog = await openPalette();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
  test("focus is trapped: Tab never leaves the palette", async () => {
    render(<PaletteHarness />);
    const dialog = await openPalette();
    for (let i = 0; i < 6; i += 1) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
