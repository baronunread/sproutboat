import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { ReactElement } from "react";
import {
  Banner,
  Breadcrumbs,
  Button,
  CommandPalette,
  EmptyState,
  Meter,
  MetricTile,
  PageHeader,
  PageTab,
  PageTabs,
  Sidebar,
  SidebarItem,
  SidebarNav,
  Spinner,
  StatusDot,
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
  UsageMeter,
} from "../src";
import { DashboardPreview } from "../playground/dashboard";

afterEach(cleanup);

/**
 * axe-core over rendered components. Color contrast needs real layout and paint, which a
 * DOM emulator does not have, so it is checked at the token level instead (tokens.test.ts
 * runs WCAG ratios for every foreground and surface pair in both themes).
 */
async function violations(container: Element = document.body) {
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return results.violations;
}

const blocking = (list: Awaited<ReturnType<typeof violations>>) =>
  list
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.html.slice(0, 220)).join(", ")}`);

async function expectClean(ui: ReactElement) {
  const { container } = render(ui);
  const found = await violations(container);
  expect(blocking(found)).toEqual([]);
  // Moderate and minor findings are not allowed to creep in either.
  expect(found.map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 90)).join(" | ")}`)).toEqual([]);
}

describe("axe: no violations", () => {
  test("Spinner, Banner, Breadcrumbs, PageHeader", async () => {
    await expectClean(
      <TooltipProvider>
        <Spinner />
        <Banner tone="danger" title="Deploys are paused" dismissible action={<Button>Update billing</Button>}>
          Invoice failed.
        </Banner>
        <Banner tone="info">Heads up</Banner>
        <PageHeader
          breadcrumbs={
            <Breadcrumbs
              items={[
                { label: "Org", href: "/o" },
                { label: "Team", href: "/t" },
                { label: "Apps", href: "/a" },
                { label: "Project", href: "/p" },
                { label: "production" },
              ]}
              maxItems={3}
            />
          }
          title="field-notes"
          status={<StatusDot status="success" label="Live" />}
          actions={<Button>Deploy</Button>}
          tabs={
            <PageTabs>
              <PageTab href="#o" current>
                Overview
              </PageTab>
              <PageTab href="#l">Logs</PageTab>
            </PageTabs>
          }
        />
      </TooltipProvider>,
    );
  });

  test("Sidebar (column and rail)", async () => {
    await expectClean(
      <TooltipProvider>
        <Sidebar mode="static" aria-label="Column">
          <SidebarNav label="Account">
            <SidebarItem href="#p" current>
              Projects
            </SidebarItem>
            <SidebarItem href="#l">Logs</SidebarItem>
          </SidebarNav>
        </Sidebar>
        <Sidebar mode="static" collapsed aria-label="Rail">
          <SidebarNav label="Rail">
            <SidebarItem href="#p" current>
              Projects
            </SidebarItem>
          </SidebarNav>
        </Sidebar>
      </TooltipProvider>,
    );
  });

  test("Table: sortable, selected, empty, loading, error", async () => {
    await expectClean(
      <>
        <Table label="Versions">
          <TableHeader>
            <TableRow>
              <TableHead sortable sort="asc" onSort={() => {}}>
                Version
              </TableHead>
              <TableHead sortable>Age</TableHead>
              <TableHead>Message</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow selected>
              <TableCell>v1</TableCell>
              <TableCell>2h</TableCell>
              <TableCell>First</TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <Table label="Empty">
          <TableBody>
            <TableEmpty colSpan={3}>
              <EmptyState title="No domains" description="Add one." action={<Button>Add</Button>} />
            </TableEmpty>
          </TableBody>
        </Table>
        <Table label="Loading" aria-busy="true">
          <TableBody>
            <TableLoading columns={3} />
          </TableBody>
        </Table>
        <Table label="Error">
          <TableBody>
            <TableError colSpan={3} action={<Button>Retry</Button>}>
              Try later
            </TableError>
          </TableBody>
        </Table>
      </>,
    );
  });

  test("Meter, UsageMeter, MetricTile", async () => {
    await expectClean(
      <TooltipProvider>
        <Meter label="Build minutes" value={40} />
        <UsageMeter label="Requests" used={10} limit={100} />
        <UsageMeter label="Storage" used={90} limit={100} unit="GB" />
        <UsageMeter label="Builds" used={100} limit={100} />
        <UsageMeter label="Seats" used={5} limit={5} blocked />
        <UsageMeter label="Bandwidth" used={5} limit={null} />
        <MetricTile label="Requests" value="1.2" unit="M" delta={{ value: "3%", direction: "up" }} />
        <MetricTile label="Loading" loading />
        <MetricTile label="Empty" noData />
      </TooltipProvider>,
    );
  });

  test("CommandPalette open: results, no results, prefix", async () => {
    render(
      <CommandPalette
        open
        onOpenChange={() => {}}
        groups={[{ id: "g", label: "Projects", items: [{ id: "a", label: "field-notes", scope: "d1" }] }]}
        recents={[{ id: "r", label: "digest-jobs" }]}
        prefixes={[{ scope: "d1", label: "D1 databases" }]}
        onSelect={() => {}}
      />,
    );
    await screen.findByRole("dialog");
    expect(blocking(await violations())).toEqual([]);
    expect((await violations()).map((v) => v.id)).toEqual([]);
    await userEvent.keyboard("zzz");
    expect(await screen.findByRole("status")).toBeTruthy();
    expect((await violations()).map((v) => v.id)).toEqual([]);
  });

  test("Dashboard preview (the playground page composition)", async () => {
    await expectClean(
      <TooltipProvider>
        <main>
          <DashboardPreview />
        </main>
      </TooltipProvider>,
    );
  });
});

describe("axe: the whole playground", () => {
  test("every section of the gallery has no serious or critical violations", async () => {
    const { Gallery } = await import("../playground/gallery");
    const { ToastProvider } = await import("../src");
    const { container } = render(
      <TooltipProvider>
        <ToastProvider>
          <main>
            <Gallery />
          </main>
        </ToastProvider>
      </TooltipProvider>,
    );
    const found = await violations(container);
    expect(blocking(found)).toEqual([]);
    // The gallery repeats landmarks on purpose (several sidebars and breadcrumbs side by side), so only
    // that one best-practice finding is tolerated here; the single-page compositions above allow none.
    expect(found.map((v) => v.id).filter((id) => id !== "landmark-unique")).toEqual([]);
  });
});
