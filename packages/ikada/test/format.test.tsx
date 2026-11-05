import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import {
  LocaleProvider,
  MetricTile,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TrafficSplitBar,
  UsageMeter,
  formatBytes,
  formatCompact,
  formatNumber,
} from "../src";
import type { Status } from "../src";
import { StatusGlyph } from "../src/components/status-glyph";

afterEach(cleanup);

describe("format helpers", () => {
  test("formatNumber groups with en by default", () => {
    expect(formatNumber(860_000)).toBe("860,000");
    expect(formatNumber(1234.5678)).toBe("1,234.568");
    expect(formatNumber(860_000, { locale: "de" })).toBe("860.000");
  });

  test("formatCompact uses compact units", () => {
    expect(formatCompact(860_000)).toBe("860K");
    expect(formatCompact(1_000_000)).toBe("1M");
    expect(formatCompact(1_280_000)).toBe("1.28M");
    expect(formatCompact(4.4)).toBe("4.4");
    expect(formatCompact(500)).toBe("500");
    expect(formatCompact(1_280_000, { locale: "de" })).toBe("1,28\u00a0Mio.");
  });

  test("formatBytes uses decimal units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(12)).toBe("12 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(4_400_000_000)).toBe("4.4 GB");
    expect(formatBytes(2_000_000)).toBe("2 MB");
    expect(formatBytes(1536, { locale: "de" })).toBe("1,5 KB");
  });
});

describe("number formatting in components", () => {
  test("UsageMeter reads 860K of 1M, never dotted thousands", () => {
    render(<UsageMeter label="Requests" used={860_000} limit={1_000_000} />);
    expect(screen.getByText(/860K of 1M/)).toBeTruthy();
    expect(document.body.textContent).not.toContain("860.000");
  });

  test("UsageMeter follows the LocaleProvider and an explicit locale prop", () => {
    render(
      <LocaleProvider value="de">
        <UsageMeter label="Provider" used={1_280_000} limit={2_000_000} />
        <UsageMeter label="Explicit" used={1_280_000} limit={2_000_000} locale="en" />
      </LocaleProvider>,
    );
    expect(screen.getByText(/1,28\sMio\. of 2\sMio\./)).toBeTruthy();
    expect(screen.getByText(/1\.28M of 2M/)).toBeTruthy();
  });

  test("UsageMeter keeps a custom formatValue", () => {
    render(<UsageMeter label="Requests" used={5} limit={10} formatValue={(n) => `<${n}>`} />);
    expect(screen.getByText(/<5> of <10>/)).toBeTruthy();
  });

  test("MetricTile formats an amount compactly and leaves a value string alone", () => {
    render(
      <>
        <MetricTile label="Requests" amount={1_280_000} />
        <MetricTile label="Errors" value="0.21" unit="%" />
      </>,
    );
    expect(screen.getByText("1.28M")).toBeTruthy();
    expect(screen.getByText("0.21")).toBeTruthy();
  });

  test("MetricTile honours locale", () => {
    render(<MetricTile label="Requests" amount={1_280_000} locale="de" />);
    expect(screen.getByText(/^1,28\sMio\.$/)).toBeTruthy();
  });

  test("TrafficSplitBar formats percentages in the locale", () => {
    render(
      <TrafficSplitBar
        locale="de"
        versions={[
          { id: "a", label: "v1", percent: 87.5 },
          { id: "b", label: "v2", percent: 12.5 },
        ]}
      />,
    );
    expect(screen.getByText("87,5%")).toBeTruthy();
    cleanup();
    render(<TrafficSplitBar versions={[{ id: "a", label: "v1", percent: 87.5 }]} />);
    expect(screen.getByText("87.5%")).toBeTruthy();
  });
});

describe("Table hideBelow", () => {
  test("adds container-query hide classes to head and cells, and a container on the scroller", () => {
    render(
      <Table label="Deploys">
        <TableHeader>
          <TableRow>
            <TableHead>Version</TableHead>
            <TableHead hideBelow="3xl">Author</TableHead>
            <TableHead hideBelow="md">Age</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>v1</TableCell>
            <TableCell hideBelow="3xl">maya</TableCell>
            <TableCell hideBelow="md">2h</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByRole("region", { name: "Deploys" }).className).toContain("@container");
    expect(screen.getByRole("columnheader", { name: "Author" }).className).toContain("@max-3xl:hidden");
    expect(screen.getByText("2h").className).toContain("@max-md:hidden");
    expect(screen.getByRole("columnheader", { name: "Version" }).className).not.toContain("hidden");
  });
});

describe("StatusGlyph outlines", () => {
  const statuses: Status[] = ["success", "warning", "danger", "info", "neutral"];

  test("every status has its own distinct shape", () => {
    const outlines = statuses.map((status) => {
      const { container } = render(<StatusGlyph status={status} />);
      const el = container.querySelector("[data-glyph]");
      expect(el?.getAttribute("aria-hidden")).toBe("true");
      return (el?.className ?? "")
        .split(" ")
        .filter(
          (c) =>
            c.startsWith("[clip-path") || c.startsWith("rounded") || c.startsWith("border") || c.startsWith("bg-["),
        )
        .join(" ");
    });
    expect(new Set(outlines).size).toBe(statuses.length);
  });

  test("in progress is a closed ring with a wedge, not an open arc, and spins only when motion is safe", () => {
    const { container } = render(<StatusGlyph status="info" pulse />);
    const cls = container.querySelector("[data-glyph]")?.className ?? "";
    expect(cls).toContain("conic-gradient");
    expect(cls).toContain("border-2");
    expect(cls).not.toContain("border-r-transparent");
    expect(cls).toContain("motion-safe:animate-spin");
  });
});
