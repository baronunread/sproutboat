import { Toast } from "@base-ui/react/toast";
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { cn, focusRing } from "../lib/cn";
import { Crossfade } from "../lib/crossfade";
import { CloseIcon } from "../lib/icons";
import { releaseSpring } from "../lib/spring";
import { buttonStyles } from "./button";
import { dotColor } from "./status";
import { StatusGlyph } from "./status-glyph";
import { toast } from "./toast-api";
import type { ToastData, ToastEvent, ToastTone } from "./toast-api";

export { deployToast, toast } from "./toast-api";
export type {
  DeployToast,
  DeployToastOptions,
  ToastAction,
  ToastActionContext,
  ToastEvent,
  ToastListener,
  ToastOptions,
  ToastPatch,
  ToastRecord,
  ToastTone,
  UndoOptions,
} from "./toast-api";

export function useToast() {
  return Toast.useToastManager<ToastData>();
}

type BaseToast = Toast.Root.ToastObject<ToastData>;

/** A flick is a fast, short horizontal release: 0.4px per ms, at least 16px. A slow drag needs 40px (Base UI). */
const FLICK_SPEED = 0.4;
const FLICK_MIN = 16;

const rootBase = [
  "absolute inset-x-0 bottom-0 origin-top touch-pan-y select-none rounded-xl",
  "[--peek:10px] [--gap:8px]",
  "[--x:var(--toast-swipe-movement-x)]",
  "[transform:translate3d(calc(var(--x)+var(--ex)),calc(var(--y)+var(--ey)),0)_scale(var(--s))]",
  "[opacity:calc(var(--o-deck)*var(--o-life))]",
  // Deck height and position move together, ease-out, transform and opacity apart from the height of a morph.
  "[transition:transform_var(--sb-duration-toast-in)_var(--ease-out),opacity_var(--sb-duration-toast-in)_var(--ease-out),height_var(--sb-duration-toast-in)_var(--ease-out)]",
  // Reduced motion: the deck stays where it is and only fades.
  "motion-reduce:[transition:opacity_var(--sb-duration-toast-in)_linear,height_var(--sb-duration-toast-in)_linear]",
  "data-released:[transition:transform_500ms_var(--sb-ease-spring),opacity_var(--sb-duration-toast-in)_var(--ease-out),height_var(--sb-duration-toast-in)_var(--ease-out)]",
  "data-swiping:cursor-grabbing",
  focusRing,
  // Invisible bridge across the gap so the pointer can cross from one fanned-out toast to the next.
  "after:absolute after:inset-x-0 after:top-full after:h-[calc(var(--gap)+1px)] after:content-['']",
].join(" ");

function rootState(state: Toast.Root.State, flick: string | undefined): string {
  const leaving = state.transitionStatus === "ending";
  const entering = state.transitionStatus === "starting";
  const swiped = leaving && (state.swipeDirection !== undefined || flick !== undefined);
  return cn(
    state.expanded
      ? "h-(--toast-height) [--s:1] [--y:calc(var(--toast-swipe-movement-y)-var(--toast-offset-y)-var(--toast-index)*var(--gap))] [--o-deck:1]"
      : [
          "h-[var(--toast-frontmost-height,var(--toast-height))]",
          "[--s:max(0,calc(1-var(--toast-index)*0.05))]",
          "[--y:calc(var(--toast-swipe-movement-y)-var(--toast-index)*var(--peek))]",
          // The front three show; the rest are fully faded (3 minus index, clamped to 0..1).
          "[--o-deck:clamp(0,calc(3-var(--toast-index)),1)]",
        ],
    // Entering and leaving: slide from below by a full height, or fly sideways after a swipe or flick.
    entering || (leaving && !swiped) ? "[--ey:calc(100%*var(--sb-move))]" : "[--ey:0px]",
    swiped ? "[--ex:120%]" : "[--ex:0px]",
    swiped && (state.swipeDirection === "left" || flick === "left") && "[--ex:-120%]",
    entering || leaving || state.limited ? "[--o-life:0]" : "[--o-life:1]",
    state.swiping && "transition-none!",
  );
}

function Glyph({ tone, busy }: { tone: ToastTone; busy: boolean }) {
  return (
    <Crossfade
      kind="slot"
      layerKey={`${tone}:${busy}`}
      value={{ tone, busy }}
      settleMs={300}
      render={(v) =>
        v.tone === "info" && !v.busy ? (
          // Info at rest is a full ring; the open ring is the one that spins while work is in progress.
          <span
            aria-hidden="true"
            data-glyph="info"
            className="inline-block size-2.5 rounded-full border-2 border-info-dot"
          />
        ) : (
          <StatusGlyph status={v.tone} pulse={v.busy} />
        )
      }
    />
  );
}

interface Face {
  title: string;
  description?: string;
  count: number;
  actions: ToastData["actions"];
}

function CountBadge({ count }: { count: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const el = ref.current;
    if (!el || !("animate" in el)) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.animate([{ scale: 1 }, { scale: 1.25 }, { scale: 1 }], {
      duration: 240,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
    });
  }, [count]);
  if (count < 2) return null;
  return (
    <span
      ref={ref}
      className="inline-flex min-h-[18px] shrink-0 items-center rounded-full bg-well px-1.5 text-xs font-semibold tabular-nums text-fg shadow-button"
    >
      <span aria-hidden="true">×{count}</span>
      <span className="sr-only">, {count} times</span>
    </span>
  );
}

function ToastActions({ face, id, live }: { face: Face; id: string; live: boolean }) {
  if (face.actions.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {face.actions.map((action) => {
        const ghost = (action.variant ?? "ghost") === "ghost";
        return (
          <button
            key={action.label}
            type="button"
            tabIndex={live ? undefined : -1}
            onClick={() =>
              action.onClick({
                id,
                update: (patch) => toast.update(id, patch),
                close: () => toast.close(id),
              })
            }
            className={cn(
              buttonStyles({ variant: ghost ? "ghost" : "danger", size: "sm" }),
              "after:absolute after:-inset-x-0.5 after:-inset-y-1.5 after:content-['']",
              ghost && "-ms-2 px-2 text-fg underline decoration-fg-muted decoration-1 underline-offset-3 hover:text-fg",
            )}
          >
            {action.label}
          </button>
        );
      })}
    </div>
  );
}

function Face({ face, id, live }: { face: Face; id: string; live: boolean }) {
  return (
    <div className="py-px">
      <div className="flex min-h-6 items-center gap-1.5 text-base font-semibold">
        {live ? (
          <Toast.Title className="min-w-0 text-balance wrap-anywhere" />
        ) : (
          <div className="min-w-0 text-balance wrap-anywhere">{face.title}</div>
        )}
        <CountBadge count={face.count} />
      </div>
      {face.description ? (
        live ? (
          <Toast.Description className="mt-px text-sm text-fg-muted wrap-anywhere" />
        ) : (
          <div className="mt-px text-sm text-fg-muted wrap-anywhere">{face.description}</div>
        )
      ) : null}
      <ToastActions face={face} id={id} live={live} />
    </div>
  );
}

/** Only while progress is a number. The bar keeps its last value while it fades, so it never shrinks on the way out. */
function ProgressLine({ progress, tone }: { progress: number | undefined; tone: ToastTone }) {
  const shown = progress !== undefined;
  const [last, setLast] = useState(progress ?? 0);
  if (progress !== undefined && progress !== last) setLast(progress);
  return (
    <span
      aria-hidden="true"
      data-progress={shown ? "" : undefined}
      className="pointer-events-none absolute inset-x-0 bottom-0 h-[3px]"
    >
      <span
        className={cn(
          "absolute inset-0 bg-hairline transition-opacity duration-300 ease-out",
          shown ? "opacity-80" : "opacity-0",
        )}
      />
      <span
        className={cn(
          "absolute inset-0 origin-left transition-[scale,opacity] duration-600 ease-out",
          dotColor[tone],
          shown ? "opacity-100" : "opacity-0",
        )}
        style={{ scale: `${last} 1` }}
      />
    </span>
  );
}

function ToastItem({ item }: { item: BaseToast }) {
  const data: ToastData = item.data ?? { title: "", tone: "info", busy: false, actions: [], count: 1 };
  const [flick, setFlick] = useState<"left" | "right" | undefined>(undefined);
  const [released, setReleased] = useState(false);
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(releaseTimer.current), []);

  /** Base UI dismisses a slow drag past 40px; this adds the flick, and a spring on the way back. */
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button, a, input, textarea")))
      return;
    clearTimeout(releaseTimer.current);
    setReleased(false);
    const doc = event.currentTarget.ownerDocument;
    const startX = event.clientX;
    const samples = [{ x: event.clientX, t: event.timeStamp }];
    const move = (e: PointerEvent) => {
      samples.push({ x: e.clientX, t: e.timeStamp });
      while (samples.length > 2 && e.timeStamp - (samples[0]?.t ?? 0) > 100) samples.shift();
    };
    const stop = () => {
      doc.removeEventListener("pointermove", move);
      doc.removeEventListener("pointerup", up);
      doc.removeEventListener("pointercancel", stop);
    };
    const up = (e: PointerEvent) => {
      stop();
      const dx = e.clientX - startX;
      const a = samples[0];
      const b = samples[samples.length - 1];
      const speed = a && b && b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0;
      if (Math.abs(speed) >= FLICK_SPEED && Math.abs(dx) >= FLICK_MIN && Math.sign(speed) === Math.sign(dx)) {
        setFlick(dx > 0 ? "right" : "left");
        toast.close(item.id);
      } else if (Math.abs(dx) > 1) {
        setReleased(true);
        releaseTimer.current = setTimeout(() => setReleased(false), 600);
      }
    };
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", up);
    doc.addEventListener("pointercancel", stop);
  }

  const face: Face = {
    title: data.title,
    description: data.description,
    count: data.count,
    actions: data.actions,
  };
  const faceKey = [data.tone, face.title, face.description ?? "", data.actions.map((a) => a.label).join("/")].join(
    "\u0001",
  );

  return (
    <Toast.Root
      toast={item}
      swipeDirection={["left", "right"]}
      data-sb-toast=""
      data-tone={data.tone}
      data-flick={flick}
      data-released={released ? "" : undefined}
      onPointerDown={onPointerDown}
      className={(state) => cn(rootBase, rootState(state, flick))}
      style={{ zIndex: `calc(100 - var(--toast-index))` }}
    >
      <Toast.Content
        className={(state) =>
          cn(
            "relative size-full overflow-hidden rounded-xl bg-raised text-fg shadow-float",
            state.behind && !state.expanded ? "[--c-op:0]" : "[--c-op:1]",
          )
        }
      >
        <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_1.5rem] gap-2.5 py-3 ps-3 pe-2.5 opacity-(--c-op) transition-opacity duration-(--sb-duration-toast-in) ease-out">
          <Glyph tone={data.tone} busy={data.busy} />
          <Crossfade layerKey={faceKey} value={face} render={(f, live) => <Face face={f} id={item.id} live={live} />} />
          <Toast.Close
            aria-label="Dismiss notification"
            className={cn(
              "relative inline-grid size-6 shrink-0 place-items-center self-start rounded-md text-fg-muted transition-[background-color,color,scale] duration-(--sb-duration-hover) ease-hover hover:bg-hover hover:text-fg active:scale-(--sb-scale-press)",
              "after:absolute after:-inset-2 after:content-[''] pointer-coarse:after:-inset-3",
              focusRing,
            )}
          >
            <CloseIcon className="size-3.5" />
          </Toast.Close>
        </div>
        <ProgressLine progress={data.progress} tone={data.tone} />
      </Toast.Content>
    </Toast.Root>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager<ToastData>();
  return toasts.map((item) => <ToastItem key={item.id} item={item} />);
}

export interface ToastProviderProps {
  children?: ReactNode;
  /** The history hook: called for every add, merge, update and close. For an Activity feed or a bell. */
  onToast?: (event: ToastEvent) => void;
  /** Toasts kept on screen at once; older ones are dropped. Default 5. */
  limit?: number;
  /** Accessible name of the region. */
  label?: string;
}

/**
 * Mount once near the app root. The viewport is a labelled region at the bottom end; Alt+T (or F6) moves
 * focus to the newest toast, Escape dismisses the focused one. Hover or focus fans the deck out, and timers
 * stop while it is out or the tab is hidden.
 */
export function ToastProvider({ children, onToast, limit = 5, label = "Notifications (Alt+T)" }: ToastProviderProps) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const onToastRef = useRef(onToast);
  useEffect(() => {
    onToastRef.current = onToast;
  });

  useEffect(() => toast.subscribe((event) => onToastRef.current?.(event)), []);

  useEffect(() => {
    viewport?.style.setProperty("--sb-ease-spring", releaseSpring);
    const hidden = () => toast.setPaused("hidden", document.hidden);
    hidden();
    document.addEventListener("visibilitychange", hidden);
    // Alt+T: Base UI already moves focus into the region on F6, so reuse that, then land on the newest toast.
    const onKey = (event: KeyboardEvent) => {
      if (!(event.altKey && event.code === "KeyT")) return;
      const front = viewport?.querySelector<HTMLElement>("[data-sb-toast]:not([data-ending-style])");
      if (!front) return;
      event.preventDefault();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "F6", bubbles: true, cancelable: true }));
      front.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("keydown", onKey);
    };
  }, [viewport]);

  // The viewport carries data-expanded while hovered or focused; mirror it into the timers.
  useEffect(() => {
    const el = viewport;
    if (!el) return undefined;
    const sync = () => toast.setPaused("expanded", el.hasAttribute("data-expanded"));
    const observer = new MutationObserver(sync);
    observer.observe(el, { attributes: true, attributeFilter: ["data-expanded"] });
    sync();
    return () => observer.disconnect();
  }, [viewport]);

  return (
    <Toast.Provider toastManager={toast.manager} timeout={0} limit={limit}>
      {children}
      <Toast.Portal>
        <Toast.Viewport
          ref={setViewport}
          aria-label={label}
          aria-keyshortcuts="Alt+T F6"
          className="fixed inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-(--sb-z-toast) h-0 w-auto outline-hidden sm:start-auto sm:end-4 sm:bottom-[max(1rem,env(safe-area-inset-bottom))] sm:w-90"
        >
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
