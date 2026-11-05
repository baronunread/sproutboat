import type { ComponentProps } from "react";
import { cn } from "./cn";

type IconProps = ComponentProps<"svg">;

function Icon({ className, children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn("size-4 shrink-0", className)}
      {...props}
    >
      {children}
    </svg>
  );
}

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Icon>
);
export const MinusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 8h8" />
  </Icon>
);
export const ChevronDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m4 6 4 4 4-4" />
  </Icon>
);
export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
);
export const CopyIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" />
  </Icon>
);
export const ArrowUpRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 11 11 5M6 5h5v5" />
  </Icon>
);

/** The ↩ hook arrow: a straight shaft pointing left, the tail curling up at the right. */
export const UndoIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.5 10.5h7.25a3.25 3.25 0 0 0 0-6.5H8.5" />
    <path d="M5.5 7.5l-3 3 3 3" />
  </Icon>
);

/** The whole icon turns, and only under motion-safe; otherwise it is a static ring segment. */
export const SpinnerIcon = ({ className, ...props }: IconProps) => (
  <Icon className={cn("motion-safe:animate-spin", className)} {...props}>
    <circle cx="8" cy="8" r="6" opacity="0.25" />
    <path d="M14 8a6 6 0 0 0-6-6" />
  </Icon>
);

export const SearchIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </Icon>
);
export const ChevronRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m6 4 4 4-4 4" />
  </Icon>
);
export const MoreIcon = (props: IconProps) => (
  <Icon {...props} strokeWidth="2.4">
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" />
  </Icon>
);
export const MenuIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
  </Icon>
);
/** A panel with its left rail: the collapse toggle of the sidebar. */
export const SidebarIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <path d="M6 2.5v11" />
  </Icon>
);
export const ArrowUpIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 13V3M4 7l4-4 4 4" />
  </Icon>
);
export const ArrowDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 3v10M4 9l4 4 4-4" />
  </Icon>
);
/** Both chevrons: a column that can be sorted. */
export const SortIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m5 6.5 3-3 3 3M5 9.5l3 3 3-3" />
  </Icon>
);
export const InfoIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.5V11M8 5.25h.01" />
  </Icon>
);
export const AlertIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 2.5 14 13H2L8 2.5Z" />
    <path d="M8 6.5v3M8 11.5h.01" />
  </Icon>
);
export const HomeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.5 7.5 8 3l5.5 4.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V7.5Z" />
    <path d="M6.5 13.5V9.5h3v4" />
  </Icon>
);
export const FolderIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />
  </Icon>
);
export const RocketIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 2c2.5 1.2 3.5 3.6 3.5 6L10 11H6L4.5 8c0-2.4 1-4.8 3.5-6Z" />
    <circle cx="8" cy="6.5" r="1" />
    <path d="M6 11.5 5 14M10 11.5l1 2.5" />
  </Icon>
);
export const LogsIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="2" width="10" height="12" rx="1.5" />
    <path d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
  </Icon>
);
export const DatabaseIcon = (props: IconProps) => (
  <Icon {...props}>
    <ellipse cx="8" cy="4" rx="5" ry="1.8" />
    <path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8" />
  </Icon>
);
export const GlobeIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2c2 1.7 2.8 3.7 2.8 6S10 12.3 8 14c-2-1.7-2.8-3.7-2.8-6S6 3.7 8 2Z" />
  </Icon>
);
export const KeyIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="5.5" cy="10.5" r="2.5" />
    <path d="m7.3 8.7 5.2-5.2M10.5 5.5l1.5 1.5" />
  </Icon>
);
export const CardIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
    <path d="M2 6.5h12" />
  </Icon>
);
export const SettingsIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.8 3.8l1 1M11.2 11.2l1 1M12.2 3.8l-1 1M4.8 11.2l-1 1" />
  </Icon>
);
export const ActivityIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M1.5 8h3l2-5 3 10 2-5h3" />
  </Icon>
);
export const InboxIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.5 9.5 4 3.5h8l1.5 6v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-3Z" />
    <path d="M2.5 9.5h3.2l.8 1.5h3l.8-1.5h3.2" />
  </Icon>
);
