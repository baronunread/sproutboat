import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "./cn";

interface Layer<T> {
  key: string;
  value: T;
}

export interface CrossfadeProps<T> {
  /** Changes when the content is a different thing (new text, new glyph). Same key re-renders in place. */
  layerKey: string;
  value: T;
  /** `live` is true for the layer that stays; the outgoing one is rendered once more from its snapshot. */
  render: (value: T, live: boolean) => ReactNode;
  /** "text" animates the height between layers; "slot" stacks centered layers in a fixed box (icons). */
  kind?: "text" | "slot";
  className?: string;
  /** Milliseconds until the outgoing layer is removed. Match the CSS duration. */
  settleMs?: number;
}

const layerMotion = [
  "transition-[opacity,filter,translate,scale] duration-(--sb-duration-toast-in) ease-out",
  // The incoming layer starts blurred and a few pixels low. --sb-move is 0 under reduced motion: only the fade stays.
  "starting:opacity-0 starting:blur-[3px] starting:translate-y-[calc(3px*var(--sb-move))]",
].join(" ");

const leaving = "pointer-events-none opacity-0 blur-[3px] -translate-y-[calc(3px*var(--sb-move))]";

/**
 * Crossfades between versions of its content: the old layer blurs out while the new one blurs in
 * (the blur hides that two different things overlap), and for text the box animates to the new height.
 * Opacity, translate, scale and blur only; the height transition is the one exception and is a
 * layout property on a box that clips, so nothing around it moves.
 */
export function Crossfade<T>({ layerKey, value, render, kind = "text", className, settleMs = 340 }: CrossfadeProps<T>) {
  const [layers, setLayers] = useState<Layer<T>[]>([{ key: layerKey, value }]);
  const boxRef = useRef<HTMLDivElement>(null);
  const live = layers[layers.length - 1];
  if (live && live.key !== layerKey) setLayers([live, { key: layerKey, value }]);

  const morphing = layers.length > 1;

  useEffect(() => {
    if (!morphing) return undefined;
    const timer = setTimeout(() => setLayers((l) => l.slice(-1)), settleMs);
    return () => clearTimeout(timer);
  }, [morphing, layers, settleMs]);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || kind !== "text") return undefined;
    if (!morphing) {
      box.style.height = "";
      return undefined;
    }
    // The outgoing layer is still in flow, so the box measures its height; pin it, then move to the new one.
    const from = box.offsetHeight;
    box.style.height = `${from}px`;
    const incoming = box.querySelector<HTMLElement>("[data-layer=live]");
    const to = incoming?.offsetHeight ?? from;
    const frame = requestAnimationFrame(() => {
      box.style.height = `${to}px`;
    });
    // Focus on a control in the outgoing layer would be lost; hand it to the toast itself.
    const active = box.ownerDocument.activeElement;
    if (active && box.querySelector("[data-layer=out]")?.contains(active)) {
      box.closest<HTMLElement>("[tabindex]")?.focus({ preventScroll: true });
    }
    return () => cancelAnimationFrame(frame);
  }, [layers, morphing, kind]);

  return (
    <div
      ref={boxRef}
      data-crossfade={kind}
      data-morphing={morphing ? "" : undefined}
      className={cn(
        "relative min-w-0",
        kind === "text" &&
          "transition-[height] duration-(--sb-duration-toast-in) ease-out data-morphing:overflow-hidden",
        kind === "slot" && "grid size-6 place-items-center",
        className,
      )}
    >
      {layers.map((layer, i) => {
        const isLive = i === layers.length - 1;
        return (
          <div
            key={layer.key}
            data-layer={isLive ? "live" : "out"}
            aria-hidden={isLive ? undefined : true}
            inert={isLive ? undefined : true}
            className={cn(
              layerMotion,
              kind === "text" && "min-w-0",
              kind === "slot" && "col-start-1 row-start-1 grid place-items-center",
              // While both layers exist the newcomer overlays the old one; afterwards it takes over the flow.
              kind === "text" && isLive && morphing && "absolute inset-x-0 top-0",
              kind === "slot" && !isLive && "absolute inset-0",
              kind === "slot" && "starting:scale-(--sb-scale-icon)",
              kind === "slot" && !isLive && "scale-(--sb-scale-icon)",
              !isLive && leaving,
            )}
          >
            {render(isLive ? value : layer.value, isLive)}
          </div>
        );
      })}
    </div>
  );
}
