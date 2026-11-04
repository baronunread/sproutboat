/**
 * Status vocabulary shared by Badge, StatusDot, Toast and (later) RuntimeChip.
 * `warning` is amber and means "working, but not the usual way".
 * `danger` is red and means "failed, needs action".
 * Each status also has its own shape (see StatusGlyph), so color is never the only signal.
 */
export type Status = "success" | "warning" | "danger" | "info" | "neutral";

export const dotColor = {
  success: "bg-brand-dot",
  warning: "bg-warn-dot",
  danger: "bg-danger-dot",
  info: "bg-info-dot",
  neutral: "bg-neutral-dot",
} satisfies Record<Status, string>;

/** Soft fill with a matching text color. No border: the tone is the edge. */
export const softSurface = {
  success: "bg-brand-soft text-brand-fg",
  warning: "bg-warn-soft text-warn-fg",
  danger: "bg-danger-soft text-danger-fg",
  info: "bg-info-soft text-info-fg",
  neutral: "bg-neutral-soft text-neutral-fg",
} satisfies Record<Status, string>;
