import { Toast } from "@base-ui/react/toast";
import type { Status } from "./status";

/** Tone is the status vocabulary: it picks the glyph, the progress colour and the live-region priority. */
export type ToastTone = Status;

export interface ToastActionContext {
  id: string;
  /** Morph this toast in place, e.g. from "Rolled back" to "Undone". */
  update: (patch: ToastPatch) => void;
  close: () => void;
}

export interface ToastAction {
  label: string;
  onClick: (ctx: ToastActionContext) => void;
  /** `ghost` is plain underlined text (Undo, View build log); `danger` is a red button (Retry). Default ghost. */
  variant?: "ghost" | "danger";
}

export interface ToastOptions {
  /** Reuse an id to update that toast instead of adding a new one. */
  id?: string;
  title: string;
  description?: string;
  /** Default `info`. `danger` is announced assertively, everything else politely. */
  tone?: ToastTone;
  /** The glyph spins while work is in progress. */
  busy?: boolean;
  /** 0 to 1. The progress line shows only while this is a number. */
  progress?: number | null;
  actions?: ToastAction[];
  /** Milliseconds before it leaves; 0 keeps it until dismissed. Default by tone: 5s, warning 7s, danger 9s. */
  duration?: number;
  /** Identical toasts merge into one with a ×N counter. Default true; ignored when `id` is set. */
  merge?: boolean;
  /** What counts as identical. Default is tone, title and description. */
  key?: string;
  /** Marks a step the activity feed should skip (Queued, Building). Subscribers decide. */
  silent?: boolean;
  /** Free-form data for history subscribers: project, kind, runtime. */
  meta?: ToastMeta;
}

/** Free-form facts for history subscribers: project, kind, runtime. */
export type ToastMeta = Record<string, string | number | boolean | undefined>;

export type ToastPatch = Partial<Omit<ToastOptions, "id" | "merge" | "key">>;

/** What history subscribers receive: a plain snapshot, safe to keep. */
export interface ToastRecord {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  count: number;
  busy: boolean;
  progress?: number;
  silent: boolean;
  meta?: ToastMeta;
}

export interface ToastEvent {
  /** `add` a new toast, `merge` another identical one arrived (count went up), `update` it morphed, `close` it left. */
  type: "add" | "merge" | "update" | "close";
  at: number;
  toast: ToastRecord;
}

export type ToastListener = (event: ToastEvent) => void;

/** Stored on the Base UI toast; the renderer reads it. */
export interface ToastData {
  title: string;
  description?: string;
  tone: ToastTone;
  busy: boolean;
  progress?: number;
  actions: ToastAction[];
  count: number;
}

interface Entry extends ToastRecord {
  key: string;
  merge: boolean;
  actions: ToastAction[];
  duration: number;
  remaining: number;
  startedAt: number | null;
  handle: ReturnType<typeof setTimeout> | undefined;
}

const defaultDuration = {
  info: 5000,
  success: 5000,
  neutral: 5000,
  warning: 7000,
  danger: 9000,
} satisfies Record<ToastTone, number>;

const manager = Toast.createToastManager<ToastData>();
const entries = new Map<string, Entry>();
/** Oldest first; the last id is the toast in front. */
const order: string[] = [];
const listeners = new Set<ToastListener>();
const paused = { expanded: false, hidden: false };

const keyOf = (tone: ToastTone, title: string, description?: string) => `${tone}|${title}|${description ?? ""}`;

function record(e: Entry): ToastRecord {
  return {
    id: e.id,
    tone: e.tone,
    title: e.title,
    description: e.description,
    count: e.count,
    busy: e.busy,
    progress: e.progress,
    silent: e.silent,
    meta: e.meta,
  };
}

function emit(type: ToastEvent["type"], e: Entry): void {
  const event: ToastEvent = { type, at: Date.now(), toast: record(e) };
  for (const listener of listeners) listener(event);
}

const dataOf = (e: Entry): ToastData => ({
  title: e.title,
  description: e.description,
  tone: e.tone,
  busy: e.busy,
  progress: e.progress,
  actions: e.actions,
  count: e.count,
});

function baseOptions(e: Entry) {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    type: e.tone,
    priority: e.tone === "danger" ? ("high" as const) : ("low" as const),
    // Timers belong to this module: Base UI's own would not pause for a hidden tab.
    timeout: 0,
    data: dataOf(e),
    onClose: () => forget(e),
  };
}

/* ---------- timers: paused while the deck is expanded or the tab is hidden ---------- */

const isPaused = () => paused.expanded || paused.hidden;

function resume(e: Entry): void {
  if (e.remaining <= 0 || e.startedAt !== null || isPaused()) return;
  e.startedAt = Date.now();
  e.handle = setTimeout(() => manager.close(e.id), e.remaining);
}

function pause(e: Entry): void {
  if (e.startedAt === null) return;
  clearTimeout(e.handle);
  e.remaining = Math.max(1, e.remaining - (Date.now() - e.startedAt));
  e.startedAt = null;
}

function arm(e: Entry, ms: number): void {
  clearTimeout(e.handle);
  e.handle = undefined;
  e.startedAt = null;
  e.duration = ms;
  e.remaining = ms;
  resume(e);
}

/** Called by the provider: `expanded` follows hover and focus, `hidden` follows the page visibility. */
function setPaused(reason: "expanded" | "hidden", value: boolean): void {
  if (paused[reason] === value) return;
  paused[reason] = value;
  for (const e of entries.values()) (isPaused() ? pause : resume)(e);
}

function forget(e: Entry): void {
  clearTimeout(e.handle);
  if (entries.get(e.id) !== e) return;
  entries.delete(e.id);
  const i = order.indexOf(e.id);
  if (i > -1) order.splice(i, 1);
  emit("close", e);
}

/* ---------- public API ---------- */

function add(o: ToastOptions): string {
  const tone = o.tone ?? "info";
  if (o.id !== undefined && entries.has(o.id)) {
    update(o.id, o);
    return o.id;
  }
  const key = o.key ?? keyOf(tone, o.title, o.description);
  const merge = o.merge !== false && o.id === undefined;
  if (merge) {
    const twin = [...entries.values()].find((e) => e.merge && e.key === key);
    if (twin) return mergeInto(twin, o.duration);
  }
  const e: Entry = {
    id: o.id ?? `sb-toast-${Math.random().toString(36).slice(2, 10)}`,
    key,
    merge,
    tone,
    title: o.title,
    description: o.description,
    busy: o.busy ?? false,
    progress: o.progress ?? undefined,
    actions: o.actions ?? [],
    count: 1,
    silent: o.silent ?? false,
    meta: o.meta,
    duration: 0,
    remaining: 0,
    startedAt: null,
    handle: undefined,
  };
  entries.set(e.id, e);
  order.push(e.id);
  manager.add(baseOptions(e));
  arm(e, o.duration ?? defaultDuration[tone]);
  emit("add", e);
  return e.id;
}

function mergeInto(e: Entry, duration?: number): string {
  e.count += 1;
  if (order[order.length - 1] === e.id) {
    manager.update(e.id, { data: dataOf(e) });
  } else {
    // Behind others: bring it to the front by replacing it (Base UI swaps a closing toast of the same id).
    manager.close(e.id);
    entries.set(e.id, e);
    order.push(e.id);
    manager.add(baseOptions(e));
  }
  arm(e, duration ?? e.duration);
  emit("merge", e);
  return e.id;
}

function update(id: string, patch: ToastPatch): void {
  const e = entries.get(id);
  if (!e) return;
  if (patch.tone !== undefined) e.tone = patch.tone;
  if (patch.title !== undefined) e.title = patch.title;
  if ("description" in patch) e.description = patch.description;
  if (patch.busy !== undefined) e.busy = patch.busy;
  if ("progress" in patch) e.progress = patch.progress ?? undefined;
  if (patch.actions !== undefined) e.actions = patch.actions;
  if (patch.silent !== undefined) e.silent = patch.silent;
  if (patch.meta !== undefined) e.meta = patch.meta;
  if (e.merge) e.key = keyOf(e.tone, e.title, e.description);
  const { id: _id, onClose: _onClose, ...next } = baseOptions(e);
  manager.update(id, next);
  // New information restarts the clock (a sticky toast stays sticky).
  arm(e, patch.duration ?? e.duration);
  emit("update", e);
}

function close(id?: string): void {
  manager.close(id);
}

export interface UndoOptions extends Omit<ToastOptions, "actions" | "tone" | "merge"> {
  onUndo: () => void;
  /** Default "Undo". */
  label?: string;
  /** What the toast becomes after Undo. Default "Undone". */
  confirmTitle?: string;
  confirmDescription?: string;
}

/** A success toast with a plain text Undo. Clicking it runs `onUndo` and swaps the toast in place to a confirmation. */
function undo({ onUndo, label = "Undo", confirmTitle = "Undone", confirmDescription, ...rest }: UndoOptions): string {
  return add({
    duration: 8000,
    ...rest,
    tone: "success",
    merge: false,
    actions: [
      {
        label,
        variant: "ghost",
        onClick: (ctx) => {
          onUndo();
          ctx.update({
            title: confirmTitle,
            description: confirmDescription,
            tone: "success",
            actions: [],
            duration: 3500,
            meta: { ...rest.meta, undone: true },
          });
        },
      },
    ],
  });
}

function subscribe(listener: ToastListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Call from anywhere, inside or outside React. Mount `ToastProvider` once.
 * `add` returns the id; `update(id, patch)` morphs that toast in place.
 */
export const toast = {
  add,
  update,
  close,
  undo,
  subscribe,
  /** Whether a toast with this id is still on screen. */
  has: (id: string): boolean => entries.has(id),
  /** @internal The Base UI manager the provider renders. */
  manager,
  /** @internal Provider hooks for the timers. */
  setPaused,
};

/* ---------- deploy recipe ---------- */

export interface DeployToastOptions {
  /** Shown as the description, e.g. "field-notes v48". */
  name: string;
  meta?: ToastMeta;
  /** Adds a "View build log" action to the fallback state. */
  onViewLog?: () => void;
  /** Adds a red Retry action to the failed state. */
  onRetry?: () => void;
}

export interface DeployToast {
  /** The toast's id once the first step has run. */
  readonly id: string | undefined;
  queued: () => void;
  building: (progress?: number) => void;
  canary: (progress?: number) => void;
  /** Move the progress line without changing the step. */
  progress: (value: number) => void;
  live: () => void;
  /** Live, but on the supervisor. Amber: working, only differently. */
  fallback: (reason?: string) => void;
  /** Red, with a Retry action when `onRetry` is given. */
  failed: (reason?: string) => void;
}

/**
 * Queued, Building, Canary, Live as one toast that morphs in place. The progress line shows only while
 * the deploy is in flight; Live, fallback and failed end it. Only those three end states are not `silent`.
 */
export function deployToast(options: DeployToastOptions): DeployToast {
  const { name, onViewLog, onRetry } = options;
  let id: string | undefined;
  const meta = (kind: string, extra?: ToastMeta) => ({ ...options.meta, kind, name, ...extra });

  function show(patch: ToastPatch & { title: string }): void {
    const next: ToastOptions = { description: name, duration: 0, ...patch };
    if (id !== undefined && toast.has(id)) toast.update(id, next);
    else id = toast.add({ ...next, merge: false });
  }

  const flight: ToastPatch = { silent: true, busy: false, actions: [] };
  return {
    get id() {
      return id;
    },
    queued: () => show({ ...flight, title: "Queued", tone: "neutral", progress: 0.08, meta: meta("deploy") }),
    building: (progress = 0.16) =>
      show({ ...flight, title: "Building", tone: "info", busy: true, progress, meta: meta("deploy") }),
    canary: (progress = 0.82) =>
      show({ ...flight, title: "Canary 10%", tone: "info", busy: true, progress, meta: meta("deploy") }),
    progress: (value) => {
      if (id !== undefined && toast.has(id)) toast.update(id, { progress: value });
    },
    live: () =>
      show({
        title: "Live",
        tone: "success",
        busy: false,
        progress: null,
        actions: [],
        silent: false,
        duration: 6000,
        meta: meta("deploy", { runtime: "sproutd" }),
      }),
    fallback: (reason = "slower cold start") =>
      show({
        title: "Live on supervisor",
        description: `${name} · ${reason}`,
        tone: "warning",
        busy: false,
        progress: null,
        silent: false,
        duration: 12000,
        actions: onViewLog ? [{ label: "View build log", variant: "ghost", onClick: () => onViewLog() }] : [],
        meta: meta("fallback", { runtime: "supervisor", reason }),
      }),
    failed: (reason = "see the build log") =>
      show({
        title: "Build failed",
        description: `${name} · ${reason}`,
        tone: "danger",
        busy: false,
        progress: null,
        silent: false,
        duration: 12000,
        actions: onRetry ? [{ label: "Retry", variant: "danger", onClick: () => onRetry() }] : [],
        meta: meta("failure", { reason }),
      }),
  };
}
