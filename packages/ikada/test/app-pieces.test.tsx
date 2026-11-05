import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useState } from "react";
import type { ComponentProps, ReactElement } from "react";
import {
  Avatar,
  Breadcrumbs,
  CodeBlock,
  DescriptionList,
  Field,
  Link,
  PageTab,
  PageTabs,
  Pagination,
  RadioGroup,
  SegmentedControl,
  SensitiveInput,
  Sidebar,
  SidebarItem,
  SidebarNav,
  TooltipProvider,
  pageRange,
} from "../src";

afterEach(cleanup);

async function expectClean(ui: ReactElement) {
  const { container } = render(ui);
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  const blocking = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 200)).join(", ")}`);
  expect(blocking).toEqual([]);
}

/** Stands in for a router link: renders its own anchor and records that it was used. */
function RouterLink({ to, children, ...props }: ComponentProps<"a"> & { to: string }) {
  return (
    <a data-router-link="" href={`/app${to}`} {...props}>
      {children}
    </a>
  );
}

describe("router link adapter", () => {
  test("Link renders the router's element with ikada styles and the external extras", () => {
    render(<Link render={<RouterLink to="/projects" />}>Sprouts</Link>);
    const link = screen.getByRole("link", { name: "Sprouts" });
    expect(link.getAttribute("data-router-link")).toBe("");
    expect(link.getAttribute("href")).toBe("/app/projects");
    expect(link.className).toContain("underline");
  });

  test("Link without render is a plain anchor", () => {
    render(
      <Link href="https://example.test" external>
        Docs
      </Link>,
    );
    const link = screen.getByRole("link", { name: /Docs/ });
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  test("SidebarItem keeps current state, label and drawer-less behaviour through render", () => {
    render(
      <TooltipProvider>
        <Sidebar mode="static">
          <SidebarNav label="Main">
            <SidebarItem render={<RouterLink to="/x" />} current>
              Sprouts
            </SidebarItem>
          </SidebarNav>
        </Sidebar>
      </TooltipProvider>,
    );
    const link = screen.getByRole("link", { name: "Sprouts" });
    expect(link.getAttribute("data-router-link")).toBe("");
    expect(link.getAttribute("aria-current")).toBe("page");
  });

  test("PageTab and a Breadcrumbs item accept render", () => {
    render(
      <>
        <Breadcrumbs
          items={[{ label: "Sprouts", id: "sprouts", render: <RouterLink to="/projects" /> }, { label: "blog" }]}
        />
        <PageTabs>
          <PageTab render={<RouterLink to="/metrics" />} current>
            Metrics
          </PageTab>
        </PageTabs>
      </>,
    );
    expect(screen.getByRole("link", { name: "Sprouts" }).getAttribute("data-router-link")).toBe("");
    const tab = screen.getByRole("link", { name: "Metrics" });
    expect(tab.getAttribute("data-router-link")).toBe("");
    expect(tab.getAttribute("aria-current")).toBe("page");
  });
});

describe("Avatar", () => {
  test("shows the initial when there is no image", () => {
    render(<Avatar name="andrea" />);
    expect(screen.getByText("A")).toBeTruthy();
  });
  test("a clean render", async () => {
    await expectClean(<Avatar name="andrea" size="lg" />);
  });
});

describe("SegmentedControl", () => {
  function Demo() {
    const [value, setValue] = useState("system");
    return (
      <SegmentedControl
        aria-label="Theme"
        value={value}
        onValueChange={setValue}
        options={[
          { value: "system", label: "System" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
      />
    );
  }
  test("selects on click and never ends up with nothing selected", async () => {
    render(<Demo />);
    const light = screen.getByRole("button", { name: "Light" });
    await userEvent.click(light);
    await waitFor(() => expect(light.getAttribute("aria-pressed")).toBe("true"));
    await userEvent.click(light);
    expect(light.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "System" }).getAttribute("aria-pressed")).toBe("false");
  });
  test("a clean render", async () => {
    await expectClean(<Demo />);
  });
});

describe("RadioGroup", () => {
  test("arrow keys move the choice", async () => {
    let chosen = "";
    render(
      <RadioGroup
        legend="Retention"
        defaultValue="7"
        onValueChange={(v) => (chosen = String(v))}
        options={[
          { value: "7", label: "7 days" },
          { value: "30", label: "30 days", description: "Recommended" },
        ]}
      />,
    );
    const first = screen.getByRole("radio", { name: "7 days" });
    first.focus();
    await userEvent.keyboard("{ArrowDown}");
    await waitFor(() => expect(chosen).toBe("30"));
  });
  test("a clean render", async () => {
    await expectClean(
      <RadioGroup
        legend="Retention"
        defaultValue="7"
        options={[
          { value: "7", label: "7 days" },
          { value: "30", label: "30 days", disabled: true },
        ]}
      />,
    );
  });
});

describe("SensitiveInput", () => {
  test("is masked until revealed, and the toggle announces its state", async () => {
    render(
      <TooltipProvider>
        <Field label="Token">
          <SensitiveInput defaultValue="sproutboat_secret" copyable />
        </Field>
      </TooltipProvider>,
    );
    const input = screen.getByLabelText("Token");
    expect(input.getAttribute("type")).toBe("password");
    await userEvent.click(screen.getByRole("button", { name: "Show value" }));
    expect(input.getAttribute("type")).toBe("text");
    expect(screen.getByRole("button", { name: "Hide value" }).getAttribute("aria-pressed")).toBe("true");
  });
  test("a clean render", async () => {
    await expectClean(
      <TooltipProvider>
        <Field label="Password">
          <SensitiveInput autoComplete="current-password" />
        </Field>
        <Field label="Token">
          <SensitiveInput readOnly defaultValue="abc" copyable />
        </Field>
      </TooltipProvider>,
    );
  });
});

describe("DescriptionList", () => {
  test("pairs every term with its details", async () => {
    await expectClean(
      <DescriptionList
        items={[
          { id: "username", term: "Username", details: "test-admin" },
          { id: "email", term: "Email", details: "admin@example.test", mono: true },
        ]}
      />,
    );
    expect(screen.getByText("Username").tagName).toBe("DT");
    expect(screen.getByText("test-admin").tagName).toBe("DD");
  });
});

describe("Pagination", () => {
  test("pageRange shows first, last, siblings and gaps", () => {
    expect(pageRange(1, 1)).toEqual([1]);
    expect(pageRange(1, 5)).toEqual([1, 2, "gap-end", 5]);
    expect(pageRange(6, 12)).toEqual([1, "gap-start", 5, 6, 7, "gap-end", 12]);
    expect(pageRange(2, 4)).toEqual([1, 2, 3, 4]);
  });
  test("buttons move the page, ends are disabled, the current page is marked", async () => {
    let page = 1;
    const { rerender } = render(<Pagination page={page} pageCount={5} onPageChange={(n) => (page = n)} />);
    expect(screen.getByRole("button", { name: "Previous page" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Page 1" }).getAttribute("aria-current")).toBe("page");
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(page).toBe(2);
    rerender(<Pagination page={5} pageCount={5} onPageChange={(n) => (page = n)} />);
    expect(screen.getByRole("button", { name: "Next page" }).hasAttribute("disabled")).toBe(true);
  });
  test("a clean render, full and compact", async () => {
    await expectClean(
      <>
        <Pagination page={6} pageCount={12} onPageChange={() => {}} />
        <Pagination compact page={2} pageCount={3} onPageChange={() => {}} />
      </>,
    );
  });
});

describe("CodeBlock", () => {
  test("shows the code verbatim and names the region", async () => {
    await expectClean(
      <TooltipProvider>
        <CodeBlock label="Deploy command" code="sproutboat deploy hello" />
      </TooltipProvider>,
    );
    expect(screen.getByRole("region", { name: "Deploy command" }).textContent).toBe("sproutboat deploy hello");
    expect(screen.getByRole("button", { name: "Copy deploy command" })).toBeTruthy();
  });
});
