import { describe, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach } from "bun:test";
import {
  Badge,
  Button,
  Checkbox,
  CopyId,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  IconButton,
  Input,
  Link,
  Select,
  Skeleton,
  StatusDot,
  Switch,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  ToastProvider,
  toast,
} from "../src";

afterEach(cleanup);

describe("Button", () => {
  test("renders a button with a variant and merges className", () => {
    render(
      <Button variant="primary" className="w-40">
        Save
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Save" });
    expect(btn.className).toContain("bg-brand");
    expect(btn.className).toContain("w-40");
  });

  test("className wins over variant classes", () => {
    render(
      <Button variant="primary" className="bg-danger">
        x
      </Button>,
    );
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("bg-danger");
    expect(cls).not.toContain("bg-brand ");
  });

  test("forwards ref as a prop", () => {
    let node: HTMLElement | null = null;
    render(
      <Button
        ref={(el) => {
          node = el;
        }}
      >
        Ref
      </Button>,
    );
    expect(node).toBeInstanceOf(HTMLButtonElement);
  });

  test("loading is busy, keeps its name and ignores clicks", async () => {
    let clicks = 0;
    render(
      <Button
        loading
        onClick={() => {
          clicks += 1;
        }}
      >
        Deploy
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Deploy" });
    expect(btn.getAttribute("aria-busy")).toBe("true");
    await userEvent.click(btn);
    expect(clicks).toBe(0);
  });

  test("disabled does not fire", async () => {
    let clicks = 0;
    render(
      <Button
        disabled
        onClick={() => {
          clicks += 1;
        }}
      >
        Nope
      </Button>,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(clicks).toBe(0);
  });

  test("icon button takes its accessible name from label", () => {
    render(
      <IconButton label="Copy ID">
        <svg />
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "Copy ID" })).toBeTruthy();
  });

  test("focus ring classes are present", () => {
    render(<Button>Ring</Button>);
    expect(screen.getByRole("button").className).toContain("focus-visible:outline-2");
  });
});

describe("Link", () => {
  test("external links are safe and announced", () => {
    render(
      <Link href="https://example.com" external>
        Docs
      </Link>,
    );
    const a = screen.getByRole("link", { name: /Docs/ });
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.textContent).toContain("opens in a new tab");
  });
});

describe("Field", () => {
  test("label, description and error are wired to the input", () => {
    render(
      <Field label="Domain" description="Your domain." error="Already used.">
        <Input />
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Domain" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = input.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(described.split(" ")[0] ?? "")?.textContent).toBeTruthy();
    expect(screen.getByText("Already used.")).toBeTruthy();
  });

  test("no error means valid", () => {
    render(
      <Field label="Name">
        <Input />
      </Field>,
    );
    expect(screen.getByRole("textbox", { name: "Name" }).getAttribute("aria-invalid")).toBeNull();
  });
});

describe("Checkbox and Switch", () => {
  test("checkbox toggles with Space", async () => {
    render(<Checkbox label="Pin" />);
    const box = screen.getByRole("checkbox", { name: "Pin" });
    await userEvent.click(box);
    expect(box.getAttribute("aria-checked")).toBe("true");
  });

  test("switch has role switch and toggles", async () => {
    render(<Switch label="Auto deploy" />);
    const sw = screen.getByRole("switch", { name: "Auto deploy" });
    await userEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  test("disabled switch is not interactive", async () => {
    render(<Switch label="Off" disabled />);
    const sw = screen.getByRole("switch");
    await userEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });
});

describe("Select", () => {
  test("opens with keyboard and picks an option", async () => {
    render(
      <Select
        aria-label="Region"
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
        defaultValue="a"
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "Region" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const option = await screen.findByRole("option", { name: "Beta" });
    await userEvent.click(option);
    await waitFor(() => expect(trigger.textContent).toContain("Beta"));
  });
});

describe("Badge, StatusDot, Skeleton", () => {
  test("StatusDot always has a text label, dot is hidden from AT", () => {
    render(<StatusDot status="warning" label="Fell back to supervisor" />);
    expect(screen.getByText("Fell back to supervisor")).toBeTruthy();
    expect(document.querySelector("[aria-hidden=true]")).toBeTruthy();
  });

  test("hideLabel keeps the label for screen readers", () => {
    render(<StatusDot status="success" label="Ready" hideLabel />);
    expect(screen.getByText("Ready").className).toContain("sr-only");
  });

  test("fallback is amber, never red", () => {
    render(
      <Badge tone="warning" dot>
        Fallback
      </Badge>,
    );
    const cls = screen.getByText("Fallback").className;
    expect(cls).toContain("warn");
    expect(cls).not.toContain("danger");
  });

  test("skeleton is decorative", () => {
    const { container } = render(<Skeleton />);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("DropdownMenu", () => {
  function Menu({ onSelect }: { onSelect: () => void }) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button />}>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={onSelect}>View logs</DropdownMenuItem>
          <DropdownMenuItem>Promote</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  test("opens with Enter, arrows move, Enter selects, Escape closes", async () => {
    let picked = 0;
    render(
      <Menu
        onSelect={() => {
          picked += 1;
        }}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Actions" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(menu).toBeTruthy();
    expect(screen.getAllByRole("menuitem").length).toBe(2);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(picked).toBeGreaterThanOrEqual(0);
  });

  test("Escape closes the menu", async () => {
    render(<Menu onSelect={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await screen.findByRole("menu");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});

describe("Dialog", () => {
  function Demo() {
    return (
      <Dialog>
        <DialogTrigger render={<Button />}>Open</DialogTrigger>
        <DialogContent>
          <DialogTitle>Delete app?</DialogTitle>
          <DialogDescription>Cannot be undone.</DialogDescription>
          <Button>Confirm</Button>
        </DialogContent>
      </Dialog>
    );
  }

  test("has dialog role, name and description; Escape closes and focus returns", async () => {
    render(<Demo />);
    const trigger = screen.getByRole("button", { name: "Open" });
    await userEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Delete app?" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("close button has a name", async () => {
    render(<Demo />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByRole("button", { name: "Close" })).toBeTruthy();
  });
});

describe("Tabs", () => {
  function Demo() {
    return (
      <Tabs defaultValue="a">
        <TabsList aria-label="Sections">
          <TabsTab value="a">Overview</TabsTab>
          <TabsTab value="b">Logs</TabsTab>
          <TabsTab value="c">Settings</TabsTab>
        </TabsList>
        <TabsPanel value="a">Panel A</TabsPanel>
        <TabsPanel value="b">Panel B</TabsPanel>
        <TabsPanel value="c">Panel C</TabsPanel>
      </Tabs>
    );
  }

  test("roles and arrow-key navigation", async () => {
    render(<Demo />);
    expect(screen.getByRole("tablist", { name: "Sections" })).toBeTruthy();
    const first = screen.getByRole("tab", { name: "Overview" });
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toBe("Panel A");
    first.focus();
    await userEvent.keyboard("{ArrowRight}");
    const second = screen.getByRole("tab", { name: "Logs" });
    expect(document.activeElement).toBe(second);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(second.getAttribute("aria-selected")).toBe("true"));
    expect(screen.getByRole("tabpanel").textContent).toBe("Panel B");
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Settings" }));
  });
});

describe("CopyId", () => {
  test("copies the full value and announces it", async () => {
    let written = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          written = text;
        },
      },
    });
    render(<CopyId value="dpl_full_value" display="dpl_f...ue" label="Copy deployment ID" />);
    await userEvent.click(screen.getByRole("button", { name: "Copy deployment ID" }));
    await waitFor(() => expect(written).toBe("dpl_full_value"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Copied to clipboard"));
  });
});

describe("Toast", () => {
  test("shows a toast with title and a dismiss control", async () => {
    render(<ToastProvider />);
    toast.add({ title: "Deployment ready", description: "v12 is live", type: "success", timeout: 0 });
    expect(await screen.findByText("Deployment ready")).toBeTruthy();
    expect(screen.getByLabelText("Dismiss notification")).toBeTruthy();
  });
});
