import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InlineConfirm, ToastProvider, deployToast, toast } from "../src";
import type { ToastEvent } from "../src";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const items = () => document.querySelectorAll("[data-sb-toast]");
const open = (id: string) => toast.has(id);
const add: typeof toast.add = (o) => {
  let id = "";
  act(() => {
    id = toast.add(o);
  });
  return id;
};

beforeEach(() => {
  render(<ToastProvider />);
});
afterEach(() => {
  act(() => toast.close());
  cleanup();
});

describe("Toast basics", () => {
  test("shows a toast with title, description and a dismiss control", async () => {
    add({ title: "Deployment ready", description: "v12 is live", tone: "success", duration: 0 });
    expect(await screen.findByText("Deployment ready")).toBeTruthy();
    expect(screen.getByText("v12 is live")).toBeTruthy();
    expect(screen.getByLabelText("Dismiss notification")).toBeTruthy();
  });

  test("the region is labelled and names its shortcut", async () => {
    add({ title: "Hello", duration: 0 });
    await screen.findByText("Hello");
    const region = screen.getByRole("region", { name: /Notifications/ });
    expect(region.getAttribute("aria-keyshortcuts")).toBe("Alt+T F6");
  });

  test("errors use priority high (assertive), others stay polite", async () => {
    add({ title: "Build failed", tone: "danger", duration: 0 });
    add({ title: "Saved", tone: "success", duration: 0 });
    await screen.findByText("Saved");
    const roots = [...items()];
    expect(roots.some((r) => r.getAttribute("role") === "alertdialog")).toBe(true);
    expect(roots.some((r) => r.getAttribute("role") === "dialog")).toBe(true);
    expect(screen.getByRole("region", { name: /Notifications/ }).getAttribute("aria-live")).toBe("polite");
  });
});

describe("update in place", () => {
  test("toast.update morphs one toast: same count, new text, progress line follows", async () => {
    const id = add({ title: "Queued", description: "field-notes v48", tone: "neutral", progress: 0.08, duration: 0 });
    await screen.findByText("Queued");
    expect(document.querySelector("[data-progress]")).toBeTruthy();
    act(() => toast.update(id, { title: "Building", tone: "info", busy: true, progress: 0.4 }));
    await waitFor(() => expect(screen.getAllByText("Building").length).toBeGreaterThan(0));
    expect(items().length).toBe(1);
    // Outgoing layer is aria-hidden and inert while it fades; the live one is not.
    await waitFor(() => expect(document.querySelectorAll("[data-layer=out]").length).toBe(0), { timeout: 1500 });
    expect(screen.queryByText("Queued")).toBeNull();
  });

  test("the progress line goes away when progress is cleared (Live)", async () => {
    const id = add({ title: "Building", progress: 0.5, duration: 0 });
    await screen.findByText("Building");
    expect(document.querySelector("[data-progress]")).toBeTruthy();
    act(() => toast.update(id, { title: "Live", tone: "success", progress: null }));
    await waitFor(() => expect(document.querySelector("[data-progress]")).toBeNull());
  });

  test("deployToast runs Queued, Building, Canary, Live as one toast and ends the progress line", async () => {
    const d = deployToast({ name: "field-notes v48" });
    act(() => d.queued());
    await screen.findByText("Queued");
    const id = d.id ?? "";
    act(() => d.building());
    act(() => d.canary());
    act(() => d.live());
    await waitFor(() => expect(screen.getAllByText("Live").length).toBeGreaterThan(0));
    expect(d.id).toBe(id);
    expect(items().length).toBe(1);
    expect(document.querySelector("[data-progress]")).toBeNull();
  });

  test("fallback is amber with a log action; failed is red with Retry", async () => {
    let retried = 0;
    const d = deployToast({ name: "field-notes v48", onViewLog: () => undefined, onRetry: () => (retried += 1) });
    act(() => d.fallback("no standalone build"));
    await screen.findByText("Live on supervisor");
    expect(document.querySelector("[data-tone=warning]")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View build log" })).toBeTruthy();
    act(() => d.failed("TS2304"));
    await waitFor(() => expect(document.querySelector("[data-tone=danger]")).toBeTruthy());
    const retry = await screen.findAllByRole("button", { name: "Retry", hidden: true });
    const last = retry[retry.length - 1];
    if (!last) throw new Error("no Retry button");
    await userEvent.click(last);
    expect(retried).toBe(1);
  });
});

describe("merging", () => {
  test("identical toasts merge into one with a ×N counter", async () => {
    const a = add({ title: "Rate limited", tone: "warning", duration: 0 });
    const b = add({ title: "Rate limited", tone: "warning", duration: 0 });
    const c = add({ title: "Rate limited", tone: "warning", duration: 0 });
    expect(b).toBe(a);
    expect(c).toBe(a);
    await screen.findByText("×3");
    expect(items().length).toBe(1);
  });

  test("different content does not merge, and merge:false opts out", async () => {
    const a = add({ title: "One", duration: 0 });
    const b = add({ title: "Two", duration: 0 });
    const c = add({ title: "One", duration: 0, merge: false });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  test("a merge restarts the timer", async () => {
    const id = add({ title: "Again", duration: 300 });
    await sleep(200);
    add({ title: "Again", duration: 300 });
    await sleep(200);
    expect(open(id)).toBe(true);
    await sleep(250);
    expect(open(id)).toBe(false);
  });

  test("a merge reports itself to history with the new count", () => {
    const seen: ToastEvent[] = [];
    const off = toast.subscribe((e) => seen.push(e));
    add({ title: "Spam", duration: 0 });
    add({ title: "Spam", duration: 0 });
    off();
    expect(seen.map((e) => e.type)).toEqual(["add", "merge"]);
    expect(seen[1]?.toast.count).toBe(2);
  });
});

describe("Undo", () => {
  test("Undo is a plain text action that swaps the toast in place to a confirmation, with no countdown", async () => {
    let undone = 0;
    toast.undo({ title: "Rolled back to v47", onUndo: () => (undone += 1), confirmTitle: "Undone. v48 is live again" });
    const button = await screen.findByRole("button", { name: "Undo" });
    expect(button.className).toContain("underline");
    expect(document.querySelector("[role=progressbar], [data-progress], [data-countdown]")).toBeNull();
    await userEvent.click(button);
    expect(undone).toBe(1);
    await waitFor(() => expect(screen.getAllByText("Undone. v48 is live again").length).toBeGreaterThan(0));
    expect(items().length).toBe(1);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo" })).toBeNull(), { timeout: 1500 });
  });
});

describe("timers", () => {
  test("a toast leaves after its duration", async () => {
    const id = add({ title: "Quick", duration: 120 });
    expect(open(id)).toBe(true);
    await sleep(250);
    expect(open(id)).toBe(false);
  });

  test("duration 0 stays until dismissed", async () => {
    const id = add({ title: "Sticky", duration: 0 });
    await sleep(200);
    expect(open(id)).toBe(true);
  });

  test("timers pause while the tab is hidden and resume after", async () => {
    const id = add({ title: "Paused by tab", duration: 200 });
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await sleep(350);
    expect(open(id)).toBe(true);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await sleep(350);
    expect(open(id)).toBe(false);
  });

  test("timers pause while the deck is expanded by hover", async () => {
    const id = add({ title: "Paused by hover", duration: 200 });
    const region = await screen.findByRole("region", { name: /Notifications/ });
    fireEvent.mouseEnter(region);
    await sleep(350);
    expect(open(id)).toBe(true);
    expect(region.hasAttribute("data-expanded")).toBe(true);
    fireEvent.mouseLeave(region);
    await sleep(350);
    expect(open(id)).toBe(false);
  });
});

describe("keyboard", () => {
  test("Alt+T moves focus to the newest toast", async () => {
    add({ title: "Older", duration: 0 });
    add({ title: "Newest", duration: 0 });
    await screen.findByText("Newest");
    fireEvent.keyDown(document.body, { key: "t", code: "KeyT", altKey: true });
    await waitFor(() => {
      const active = document.activeElement;
      expect(active?.hasAttribute("data-sb-toast")).toBe(true);
      expect(active?.textContent).toContain("Newest");
    });
  });

  test("Escape dismisses the focused toast", async () => {
    const id = add({ title: "Dismiss me", duration: 0 });
    await screen.findByText("Dismiss me");
    const root = document.querySelector("[data-sb-toast]");
    if (!(root instanceof HTMLElement)) throw new Error("no toast");
    root.focus();
    fireEvent.keyDown(root, { key: "Escape" });
    await waitFor(() => expect(open(id)).toBe(false));
  });
});

describe("history hook", () => {
  test("onToast and subscribe see add, update and close with the snapshot", async () => {
    const seen: string[] = [];
    const off = toast.subscribe((e) => seen.push(`${e.type}:${e.toast.title}`));
    const id = add({ title: "A", duration: 0, silent: true });
    act(() => toast.update(id, { title: "B" }));
    act(() => toast.close(id));
    off();
    expect(seen).toEqual(["add:A", "update:B", "close:B"]);
  });
});

describe("InlineConfirm", () => {
  test("shows the word next to the control, announces it, then goes away", async () => {
    render(
      <InlineConfirm message="Copied" duration={150}>
        {({ confirm }) => <button onClick={confirm}>Copy</button>}
      </InlineConfirm>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    const statuses = screen.getAllByRole("status");
    expect(statuses.some((s) => s.textContent === "Copied")).toBe(true);
    await waitFor(() => expect(screen.getAllByRole("status").every((s) => s.textContent === "")).toBe(true));
  });
});
