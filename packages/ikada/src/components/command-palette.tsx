import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { cn, focusRing } from "../lib/cn";
import { SearchIcon } from "../lib/icons";
import { usePortalContainer } from "../lib/portal";
import { Kbd } from "./kbd";
import { Spinner } from "./spinner";

export interface PaletteItem {
  id: string;
  label: string;
  /** Muted text at the end of the row: "sproutd · production". */
  hint?: string;
  icon?: ReactNode;
  /** Extra search terms. */
  keywords?: string;
  /** Typed-prefix scope this item answers to ("d1" for `d1:`). Unscoped items show in every search. */
  scope?: string;
}

export interface PaletteGroup {
  id: string;
  label: string;
  items: readonly PaletteItem[];
}

export interface PalettePrefix {
  /** Without the colon: "d1". Typed as `d1:`. */
  scope: string;
  /** What it searches, for the chip and the footer hint: "D1 databases". */
  label: string;
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: readonly PaletteGroup[];
  /** Shown first while the query is empty. */
  recents?: readonly PaletteItem[];
  prefixes?: readonly PalettePrefix[];
  onSelect: (item: PaletteItem) => void;
  loading?: boolean;
  placeholder?: string;
  /** Name for screen readers. */
  label?: string;
}

interface Row {
  item: PaletteItem;
  group: string;
}

const norm = (s: string): string => s.toLowerCase();

const contains = (haystack: string, needle: string): boolean => haystack.includes(needle);

function matches(item: PaletteItem, query: string): boolean {
  if (!query) return true;
  const hay = norm(`${item.label} ${item.hint ?? ""} ${item.keywords ?? ""}`);
  return query.split(/\s+/).every((word) => contains(hay, word));
}

/** Splits `d1: notes` into scope `d1` and rest `notes`, when `d1` is a known prefix. */
export function parsePrefix(
  query: string,
  prefixes: readonly PalettePrefix[],
): { prefix?: PalettePrefix; rest: string } {
  const m = /^([a-z0-9]+):\s*(.*)$/i.exec(query);
  const prefix = m ? prefixes.find((p) => p.scope === norm(m[1] ?? "")) : undefined;
  return prefix ? { prefix, rest: m?.[2] ?? "" } : { rest: query };
}

/**
 * Global search and jump (Cmd or Ctrl K). It is opened with a key, so it never animates
 * in or out. Combobox pattern: focus stays in the input, arrows move `aria-activedescendant`,
 * Enter runs the row, Escape closes, and focus is trapped inside while open.
 */
export function CommandPalette({
  open,
  onOpenChange,
  groups,
  recents = [],
  prefixes = [],
  onSelect,
  loading = false,
  placeholder = "Search projects, versions, storage…",
  label = "Command palette",
}: CommandPaletteProps) {
  const container = usePortalContainer();
  // Whoever had focus when the palette opened gets it back on close. The initial-focus
  // callback runs before focus moves, so that is the moment to remember them.
  const opener = useRef<HTMLElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange} modal>
      <BaseDialog.Portal container={container}>
        <BaseDialog.Backdrop className={cn(container ? "absolute" : "fixed", "inset-0 z-(--sb-z-overlay) bg-scrim")} />
        <BaseDialog.Viewport
          className={cn(
            container ? "absolute" : "fixed",
            "inset-0 z-(--sb-z-modal) grid place-items-start justify-items-center overflow-y-auto p-3 pt-[min(12vh,6rem)] sm:p-4 sm:pt-[min(14vh,7rem)]",
          )}
        >
          <BaseDialog.Popup
            aria-label={label}
            initialFocus={() => {
              const active = document.activeElement;
              opener.current = active instanceof HTMLElement ? active : null;
              return input.current;
            }}
            finalFocus={() => opener.current}
            className="flex max-h-[min(34rem,calc(100%-1rem))] w-full max-w-xl flex-col overflow-hidden rounded-xl bg-raised text-fg shadow-dialog outline-hidden"
          >
            <PaletteBody
              inputRef={input}
              groups={groups}
              recents={recents}
              prefixes={prefixes}
              onSelect={(item) => {
                onSelect(item);
                onOpenChange(false);
              }}
              loading={loading}
              placeholder={placeholder}
              label={label}
            />
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

function PaletteBody({
  inputRef,
  groups,
  recents,
  prefixes,
  onSelect,
  loading,
  placeholder,
  label,
}: Required<
  Pick<CommandPaletteProps, "groups" | "recents" | "prefixes" | "onSelect" | "loading" | "placeholder" | "label">
> & { inputRef: RefObject<HTMLInputElement | null> }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const { prefix, rest } = parsePrefix(query, prefixes);
  const term = norm(rest.trim());

  const sections = useMemo(() => {
    const out: { id: string; label: string; items: PaletteItem[] }[] = [];
    const inScope = (item: PaletteItem) => (prefix ? item.scope === prefix.scope : true);
    if (!query && recents.length) out.push({ id: "recent", label: "Recent", items: [...recents] });
    for (const g of groups) {
      const items = g.items.filter((i) => inScope(i) && matches(i, term));
      if (items.length) out.push({ id: g.id, label: g.label, items });
    }
    return out;
  }, [groups, recents, prefix, query, term]);

  const rows: Row[] = sections.flatMap((s) => s.items.map((item) => ({ item, group: s.id })));
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1));
  const optionId = (index: number): string => `${listId}-opt-${index}`;
  const activeId = `${listId}-opt-${activeIndex}`;

  useEffect(() => {
    document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!rows.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + rows.length) % rows.length);
    } else if (event.key === "Home" || event.key === "End") {
      if (event.ctrlKey || event.metaKey || !rows.length) return;
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : rows.length - 1);
    } else if (event.key === "Enter") {
      const row = rows[activeIndex];
      if (row && !event.nativeEvent.isComposing) {
        event.preventDefault();
        onSelect(row.item);
      }
    }
  }

  let index = -1;
  return (
    <>
      <BaseDialog.Title className="sr-only">{label}</BaseDialog.Title>
      <div className="flex items-center gap-3 px-4 shadow-[inset_0_-1px_0_var(--sb-hairline)]">
        <SearchIcon className="text-fg-muted" />
        {prefix ? (
          <span className="inline-flex h-6 shrink-0 items-center rounded-sm bg-neutral-soft px-2 font-mono text-xs font-medium text-neutral-fg">
            {prefix.scope}:
          </span>
        ) : null}
        <input
          ref={inputRef}
          role="combobox"
          aria-label={label}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={rows.length ? activeId : undefined}
          value={prefix ? rest : query}
          placeholder={prefix ? `Search ${prefix.label.toLowerCase()}` : placeholder}
          onChange={(e) => {
            setQuery(prefix ? `${prefix.scope}:${e.target.value}` : e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && prefix && !rest) setQuery("");
            onKeyDown(e);
          }}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="h-12 min-w-0 flex-1 bg-transparent text-md font-normal text-fg outline-hidden placeholder:text-fg-muted"
        />
        {loading ? <Spinner size="sm" label="Searching" /> : <Kbd aria-hidden="true">Esc</Kbd>}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-2">
        <div id={listId} role="listbox" aria-label="Results" className="flex flex-col gap-1">
          {sections.map((section) => (
            <div key={section.id} role="group" aria-labelledby={`${listId}-${section.id}`} className="flex flex-col">
              <div id={`${listId}-${section.id}`} className="px-2.5 pt-2 pb-1 text-xs font-semibold text-fg-muted">
                {section.label}
              </div>
              {section.items.map((item) => {
                index += 1;
                const i = index;
                const isActive = i === activeIndex;
                return (
                  // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- keys are handled by the combobox input
                  <div
                    key={`${section.id}:${item.id}`}
                    id={optionId(i)}
                    role="option"
                    aria-selected={isActive}
                    data-active={isActive || undefined}
                    onMouseMove={() => i !== activeIndex && setActive(i)}
                    onClick={() => onSelect(item)}
                    className={cn(
                      "flex min-h-10 cursor-default items-center gap-3 rounded-md px-2.5 py-1.5 text-base",
                      "data-active:bg-hover data-active:shadow-[inset_2px_0_0_var(--sb-fg)]",
                      "pointer-coarse:min-h-11",
                    )}
                  >
                    {item.icon ? <span className="text-fg-muted [&>svg]:size-4">{item.icon}</span> : null}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.hint ? (
                      <span className="hidden shrink-0 font-mono text-xs text-fg-muted sm:inline">{item.hint}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {rows.length === 0 && !loading ? (
          <div role="status" className="px-4 py-10 text-center">
            <p className="font-semibold">No results{term ? ` for “${rest.trim()}”` : ""}</p>
            <p className="mt-1 text-fg-muted">
              {prefix
                ? `Nothing in ${prefix.label.toLowerCase()} matches.`
                : "Check the spelling, or try a prefix such as d1:."}
            </p>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2.5 text-xs text-fg-muted shadow-[inset_0_1px_0_var(--sb-hairline)]">
        <span className="inline-flex items-center gap-1.5">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>↵</Kbd> open
        </span>
        {prefixes.length ? (
          <span className="inline-flex flex-wrap items-center gap-1.5">
            Prefixes
            {prefixes.map((p) => (
              <Kbd key={p.scope} title={p.label}>
                {p.scope}:
              </Kbd>
            ))}
          </span>
        ) : null}
        <BaseDialog.Close className={cn("ms-auto rounded-xs px-1 hover:text-fg", focusRing)}>Close</BaseDialog.Close>
      </div>
    </>
  );
}

/** Opens on Cmd+K (macOS) or Ctrl+K elsewhere. Call it once, near the app root. */
export function useCommandPaletteShortcut(onToggle: () => void): void {
  const toggle = useEffectEvent(onToggle);
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault();
        toggle();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

/** "⌘K" on Apple platforms, "Ctrl K" elsewhere. */
export function shortcutLabel(): string {
  const apple = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? "");
  return apple ? "⌘K" : "Ctrl K";
}
