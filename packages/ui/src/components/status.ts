/**
 * Status vocabulary shared by Badge, StatusDot, Toast and (later) RuntimeChip.
 * `warning` is amber and means "working, but not the usual way".
 * `danger` is red and means "failed, needs action".
 */
export type Status = "success" | "warning" | "danger" | "info" | "neutral";

export const dotColor = {
  success: "bg-brand-dot",
  warning: "bg-warn-dot",
  danger: "bg-danger-dot",
  info: "bg-info-dot",
  neutral: "bg-neutral-dot",
} satisfies Record<Status, string>;

export const softSurface = {
  success: "border-brand-edge bg-brand-soft text-brand-fg",
  warning: "border-warn-edge bg-warn-soft text-warn-fg",
  danger: "border-danger-edge bg-danger-soft text-danger-fg",
  info: "border-info-edge bg-info-soft text-info-fg",
  neutral: "border-hairline-strong bg-raised text-fg",
} satisfies Record<Status, string>;
