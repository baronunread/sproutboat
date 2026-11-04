import { createContext, useCallback, useContext, useState } from "react";

/**
 * Keyboard-opened overlays do not animate: they answer a deliberate key press and
 * are opened constantly. Roots wrap `onOpenChange` with `useInstantOpen`, share the
 * result through context, and the popup sets `data-sb-instant` on itself.
 */
const InstantContext = createContext(false);
export const InstantProvider = InstantContext.Provider;
export const useInstant = (): boolean => useContext(InstantContext);

/** A key press, or a click with `detail === 0` (Enter or Space on a button). */
export function isKeyboardEvent(event: Event | undefined): boolean {
  if (!event) return false;
  if (event.type.startsWith("key")) return true;
  return event instanceof MouseEvent && event.type === "click" && event.detail === 0;
}

export function useInstantOpen<Details extends { event: Event }>(
  onOpenChange?: (open: boolean, details: Details) => void,
): [boolean, (open: boolean, details: Details) => void] {
  const [instant, setInstant] = useState(false);
  const handle = useCallback(
    (open: boolean, details: Details) => {
      if (open) setInstant(isKeyboardEvent(details.event));
      onOpenChange?.(open, details);
    },
    [onOpenChange],
  );
  return [instant, handle];
}

/** The attribute popups spread so CSS can switch the transition off. */
export const instantAttr = (instant: boolean): { "data-sb-instant"?: "" } => (instant ? { "data-sb-instant": "" } : {});
