"use client";

// A searchable picker whose options are grouped TWICE — an outer heading and an inner one.
//
// WHY THIS EXISTS AS A PRIMITIVE. It was written once, for the recruitment screening queue's manager
// picker, against a measured problem: the native `<select>` it replaced rendered 30 people and 16 of
// them could not be told apart from their own label, because the discriminator the company actually
// uses — the LINE — was not in the text. Grouping by job title and then by line fixed that.
//
// The owner's instruction on 2026-08-31, the moment he saw it working: *"I tell you a thing. You
// should implement it everywhere if needed and if applicable. I don't have to tell you everything one
// by one."* The position picker two rows above the manager picker had exactly the same shape and
// exactly the same problem — 35 open vacancies across 34 areas, two job titles, several lines, in one
// flat native dropdown. So the picker stopped being a component and became this.
//
// WHY NOT `SearchableSelect`. The shared primitive is the right shape for one-line text options and
// a dozen screens depend on it, but it is single-select and it flattens `<optgroup>`, keeping only
// the option TEXT — the two things a grouped picker exists to show. Rather than change it under
// those screens, this borrows its design identity verbatim: the same portal-to-body panel, the same
// never-truncate rule, the same orange active row, the same border and shadow.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search, X } from "lucide-react";

import { cn } from "@/lib/utils";

/** One row in the list. */
export type ComboItem = {
  /** Stable identity. What `value` holds and what `onChange` reports. */
  id: string;
  /** The bold line — a person's name, a position's area. Never truncated. */
  name: string;
  /** The muted line under it. The two headings are NOT repeated here; that is the point of grouping. */
  secondary?: string | null;
  /** Outer heading. Groups appear in FIRST-SEEN order, so the caller's own sort is what orders them. */
  group?: string | null;
  /** Inner heading. Sorted alphabetically inside a group, with the un-named bucket last. */
  subgroup?: string | null;
  /** Extra words typing should match — a region, a line, an HR_ID. Never displayed. */
  search?: string;
};

/**
 * No subgroup at all. Sorts last within its group and is never given a heading row.
 *
 * The empty string, because a real subgroup can never BE one: every name is trimmed and an empty
 * name falls through to this sentinel. It was a literal NUL byte until 2026-08-31, which worked and
 * was invisible — `git grep` reported the whole file as binary and refused to search it.
 */
const NO_SUBGROUP = "";

/**
 * True once this is running in a browser, for the portal — the server has no `document`.
 *
 * The same three lines `searchable-select.tsx` uses, copied rather than shared: this file has no
 * other reason to import from that one, and a `useEffect(() => setMounted(true), [])` — the obvious
 * spelling — is a lint ERROR in this repo (`react-hooks/set-state-in-effect`), so the shape matters
 * more than the four lines it costs.
 */
const emptySubscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

function useMounted() {
  return useSyncExternalStore(emptySubscribe, getClientSnapshot, getServerSnapshot);
}

type Row =
  | { kind: "group"; key: string; label: string; count: number }
  | { kind: "subgroup"; key: string; label: string; count: number }
  | { kind: "item"; key: string; item: ComboItem };

function haystackOf(item: ComboItem): string {
  return [item.name, item.secondary, item.group, item.subgroup, item.search]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * Headings interleaved with the items under them.
 *
 * Group order is FIRST-SEEN, never alphabetical, because a caller that has sorted its list down an
 * org chart must not have that re-sorted into "District" above "National" for no reason a person can
 * read. Item order inside a subgroup is likewise the caller's own.
 *
 * A group with exactly one subgroup still gets both headings — dropping the inner one when there is
 * only one of it would make the list's shape depend on its contents, so the same screen would read
 * differently on a Tuesday.
 */
function buildRows(items: ComboItem[]): Row[] {
  const groups = new Map<string, Map<string, ComboItem[]>>();
  for (const item of items) {
    const group = (item.group ?? "").trim();
    const subgroup = (item.subgroup ?? "").trim() || NO_SUBGROUP;
    let subgroups = groups.get(group);
    if (!subgroups) {
      subgroups = new Map();
      groups.set(group, subgroups);
    }
    const bucket = subgroups.get(subgroup);
    if (bucket) bucket.push(item);
    else subgroups.set(subgroup, [item]);
  }

  const rows: Row[] = [];
  for (const [group, subgroups] of groups) {
    const total = [...subgroups.values()].reduce((sum, bucket) => sum + bucket.length, 0);
    // An unlabelled group is a real case — the free-text and "no position" rows at the foot of a
    // picker belong to nothing. They get their items and no heading rather than a blank bar.
    if (group) rows.push({ count: total, key: `group-${group}`, kind: "group", label: group });

    const ordered = [...subgroups.keys()].sort((left, right) =>
      left === NO_SUBGROUP ? 1 : right === NO_SUBGROUP ? -1 : left.localeCompare(right),
    );
    for (const subgroup of ordered) {
      const bucket = subgroups.get(subgroup) ?? [];
      if (subgroup !== NO_SUBGROUP) {
        rows.push({ count: bucket.length, key: `sub-${group}-${subgroup}`, kind: "subgroup", label: subgroup });
      }
      for (const item of bucket) rows.push({ item, key: item.id, kind: "item" });
    }
  }
  return rows;
}

/** "Ahmed, Sara and Mona" — never an ellipsis, never a count standing in for the names. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function GroupedComboBox({
  ariaLabel,
  disabled = false,
  emptyLabel = "Nothing matches",
  hint,
  inputRef,
  items,
  leadingIcon,
  multiple = false,
  onChange,
  panelId,
  placeholder,
  selectedSuffix,
  summaryNoun,
  value,
}: {
  ariaLabel: string;
  disabled?: boolean;
  /** Said when a search matches nothing. "Nobody matches" reads wrong for positions. */
  emptyLabel?: string;
  /** The right-hand note in the panel header — what the three parts of a row mean. */
  hint?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  items: ComboItem[];
  /** Shown in the closed field when nothing is chosen, or one thing is. */
  leadingIcon?: React.ReactNode;
  /** One at a time, or several. Single-select closes on choosing; multi deliberately does not. */
  multiple?: boolean;
  onChange: (ids: string[]) => void;
  /** Unique per picker on the page — two portals sharing an id is two panels claiming one listbox. */
  panelId: string;
  placeholder: string;
  /** Extra text beside the closed field when exactly one thing is chosen — a seat, a line. */
  selectedSuffix?: (item: ComboItem) => string | null;
  /** "managers", "positions" — the plural in "32 managers". */
  summaryNoun: string;
  value: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The HIGHLIGHT is stored as the item's id, never as a row index. The list is rebuilt on every
  // keystroke, so an index means a different row after each one — and keeping the id lets the
  // highlight follow the item a person is looking at as the list narrows around it.
  const [activeId, setActiveId] = useState<string | null>(null);
  const mounted = useMounted();
  const [panel, setPanel] = useState<{ top: number; left: number; width: number; maxWidth: number; above: boolean } | null>(
    null,
  );

  const localRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const setInput = useCallback(
    (node: HTMLInputElement | null) => {
      localRef.current = node;
      if (inputRef) inputRef.current = node;
    },
    [inputRef],
  );

  const chosen = useMemo(() => new Set(value), [value]);
  /** The picked items in the LIST's order, so the summary never reshuffles as one is added. */
  const selected = useMemo(() => items.filter((item) => chosen.has(item.id)), [chosen, items]);

  /**
   * Rebuilt on every keystroke rather than filtered in place, because a heading whose whole group
   * has been typed away must disappear with it — an empty heading reads as a loading state.
   */
  const rows = useMemo<Row[]>(() => {
    const needle = query.trim().toLowerCase();
    return buildRows(needle ? items.filter((item) => haystackOf(item).includes(needle)) : items);
  }, [items, query]);

  /** Indices arrow keys may land on — headings are skipped, never highlighted. */
  const selectableIndexes = useMemo(
    () => rows.map((row, index) => (row.kind === "item" ? index : -1)).filter((index) => index >= 0),
    [rows],
  );

  /**
   * Where the highlight actually IS — derived, not stored, so typing can never leave it pointing at
   * a row that no longer exists. The held item keeps the highlight while it survives the filter; the
   * moment it is typed away the first remaining row takes it, so after narrowing to one row Enter
   * takes THAT row rather than whatever was highlighted three keystrokes ago.
   */
  const activeIndex = useMemo(() => {
    const held = activeId ? rows.findIndex((row) => row.kind === "item" && row.item.id === activeId) : -1;
    return held >= 0 ? held : selectableIndexes[0] ?? -1;
  }, [activeId, rows, selectableIndexes]);

  /** Move the highlight to a row by index. A heading clears it rather than holding a stale id. */
  const highlight = (index: number) => {
    const row = rows[index];
    setActiveId(row?.kind === "item" ? row.item.id : null);
  };

  /**
   * Where the panel goes.
   *
   * ABOVE the field when there is not room below, and that is not a nicety: the picker this was
   * written for lives in a bar pinned to the BOTTOM of a panel, so "below" is almost always
   * off-screen. A dropdown that opens into the void is a dropdown that appears broken.
   *
   * Fixed-positioned into a portal on `document.body` for the same reason the shared
   * `SearchableSelect` is: the container is `overflow-auto`, which would otherwise clip the panel to
   * a couple of rows.
   */
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - 12;
    const above = rect.top - 12;
    const openAbove = below < Math.min(340, 220) && above > below;
    setPanel({
      above: openAbove,
      left: rect.left,
      // The panel may grow past the field it hangs from, because a name is never clipped and never
      // wrapped — the owner's standing rule — and a 240px field would force one of the two.
      maxWidth: Math.max(rect.width, window.innerWidth - rect.left - 12),
      top: openAbove ? Math.max(12, rect.top - 8) : rect.bottom + 6,
      width: rect.width,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  // Close on a click that is neither the field nor the panel. `mousedown` rather than `click` so the
  // panel is gone before the click lands on whatever is underneath it.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
      setQuery("");
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  /**
   * Take or drop one row.
   *
   * Multi-select does NOT close, and keeps the query. Typing "giza" and taking two of the three it
   * found is the motivating case for multi-select existing at all; clearing the search after the
   * first pick would make the second one a fresh hunt. Single-select closes, because there is
   * nothing left to do.
   */
  const toggle = useCallback(
    (id: string) => {
      if (!multiple) {
        onChange(chosen.has(id) ? [] : [id]);
        setOpen(false);
        setQuery("");
        localRef.current?.focus();
        return;
      }
      onChange(chosen.has(id) ? value.filter((held) => held !== id) : [...value, id]);
      localRef.current?.focus();
    },
    [chosen, multiple, onChange, value],
  );

  const move = (direction: 1 | -1) => {
    if (selectableIndexes.length === 0) return;
    const position = selectableIndexes.indexOf(activeIndex);
    const next = position < 0 ? 0 : (position + direction + selectableIndexes.length) % selectableIndexes.length;
    const index = selectableIndexes[next];
    highlight(index);
    panelRef.current?.querySelector(`[data-row="${index}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (event) => {
    // Every branch stops propagation. The screen this was written for listens for bare letters as
    // hotkeys (S shortlists a candidate, R rejects), so an un-stopped keystroke would type "Sara"
    // and shortlist somebody on the S. Escape and Enter are stopped for the same reason.
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!open) {
        setOpen(true);
        return;
      }
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (!open) {
        setOpen(true);
        return;
      }
      const row = rows[activeIndex];
      if (row?.kind === "item") toggle(row.item.id);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setQuery("");
      return;
    }
    // Backspace on an empty search drops what was added last — the same gesture every chip field in
    // every mail client has, and the fastest undo for taking the wrong one of three similar rows.
    if (multiple && event.key === "Backspace" && !query && value.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      onChange(value.slice(0, -1));
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      setQuery("");
      return;
    }
    event.stopPropagation();
  };

  const only = selected.length === 1 ? selected[0] : null;
  const onlySuffix = only && selectedSuffix ? selectedSuffix(only) : null;
  const showPickedNames = !open && selected.length > 0;
  const matchCount = rows.reduce((sum, row) => sum + (row.kind === "item" ? 1 : 0), 0);

  return (
    <div className="relative min-w-0 flex-1" ref={triggerRef}>
      {/* The whole 32px control opens the list, not just the input inside it.
          The input is 21px tall and `flex-1`, so the chevron, the count pill, the suffix and the
          strip of padding above and below the text were all dead: the field LOOKED 32px and was
          live for 21 of them, and the chevron — the one part of a closed dropdown a person actually
          aims at — did nothing at all. Measured at 375px, where 21px is under the floor a pointer
          target is meant to clear.

          `onMouseDown` rather than `onClick`, and preventDefault before focusing, because by click
          time the browser has already moved focus and begun a selection; this hands focus to the
          input with the caret intact. The input's own handler still runs for presses that land on
          it, so nothing here doubles up. */}
      <div
        className={cn(
          "flex min-h-8 w-full items-center gap-1.5 overflow-hidden border bg-white px-2 transition",
          open ? "border-orange-400 ring-2 ring-orange-100" : "border-slate-300 hover:border-slate-400",
          disabled ? "opacity-50" : "cursor-text",
        )}
        onMouseDown={(event) => {
          if (disabled || event.target === localRef.current) return;
          event.preventDefault();
          localRef.current?.focus();
          setOpen(true);
        }}
      >
        {/* The count, as a pill, the moment there is more than one. This is the whole visual signal
            that the field is holding a LIST — without it a second pick looks like it replaced the
            first, which is how a multi-select quietly loses somebody's CV. */}
        {selected.length > 1 ? (
          <span className="shrink-0 bg-orange-100 px-1.5 text-phx-2xs font-black tabular-nums text-orange-700">
            {selected.length}
          </span>
        ) : (
          leadingIcon
        )}
        {/* The picked names while the field is closed, as text that WRAPS. An input is one line, so at
            375px "Hager Abdelmaged and Mohamed Eleiwa" was cut off mid-name with no way to read the
            rest; the field grows a line instead (min-h-8, not h-8). The input stays mounted, see-
            through and still holding the names for a screen reader, so a press anywhere opens it. */}
        {showPickedNames ? (
          <span aria-hidden className="min-w-0 flex-1 whitespace-normal break-words py-1.5 text-xs leading-snug text-slate-900">
            {joinNames(selected.map((item) => item.name))}
          </span>
        ) : null}
        <input
          aria-autocomplete="list"
          aria-controls={panelId}
          aria-expanded={open}
          aria-label={ariaLabel}
          autoComplete="off"
          className={cn(
            "min-w-0 flex-1 bg-transparent text-xs text-slate-900 outline-none placeholder:text-slate-400",
            showPickedNames && "pointer-events-none absolute h-px w-px opacity-0",
          )}
          disabled={disabled}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          onMouseDown={() => setOpen(true)}
          placeholder={
            selected.length === 0
              ? placeholder
              : selected.length === 1
                ? selected[0].name
                : `${selected.length} ${summaryNoun}`
          }
          ref={setInput}
          role="combobox"
          type="text"
          value={open ? query : selected.length > 0 ? joinNames(selected.map((item) => item.name)) : ""}
        />
        {/* The extra fact beside the name while the field is closed and holds exactly one thing.
            Picking the right Giza District Manager and then being shown only "Sameh El Hoseiny" puts
            the ambiguity the grouping just removed straight back. Hidden while typing, where the
            query owns the field, and dropped on a narrow field rather than allowed to squeeze the
            name. */}
        {!open && onlySuffix ? (
          <span className="hidden shrink-0 whitespace-nowrap text-phx-2xs font-semibold text-slate-400 sm:inline">
            {onlySuffix}
          </span>
        ) : null}
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-slate-400 transition", open && "rotate-180")} />
      </div>

      {mounted && open && panel
        ? // The panel is portaled to <body>, OUTSIDE `.admin-shell` and `.employee-portal-shell`, so
          // the shells' square-corner sweep never reaches it. Square edges are therefore stated here,
          // by leaving every `rounded-*` off — pinned by tests/business-cards.test.ts.
          createPortal(
            <div
              aria-multiselectable={multiple || undefined}
              className="fixed z-[1000] overflow-hidden border border-slate-200 bg-white shadow-[0_20px_48px_rgba(15,23,42,0.18)]"
              id={panelId}
              ref={panelRef}
              role="listbox"
              style={{
                left: panel.left,
                maxWidth: panel.maxWidth,
                minWidth: Math.max(panel.width, 300),
                ...(panel.above
                  ? { bottom: window.innerHeight - panel.top, maxHeight: panel.top - 12 }
                  : { top: panel.top, maxHeight: window.innerHeight - panel.top - 12 }),
              }}
            >
              <div className="flex items-center gap-1.5 border-b border-slate-100 bg-slate-50/80 px-3 py-1.5">
                <Search className="h-3 w-3 shrink-0 text-slate-400" />
                <span className="whitespace-nowrap text-phx-2xs font-semibold uppercase tracking-wide text-slate-500">
                  {query.trim() ? `${matchCount} of ${items.length}` : `${items.length} ${summaryNoun}`}
                </span>
                {hint ? <span className="ml-auto whitespace-nowrap text-phx-2xs text-slate-400">{hint}</span> : null}
              </div>

              {/* ── Chosen, in full, and removable ───────────────────────────────────────────────
                  A multi-select whose only record of what you picked is a scattering of ticks
                  further down a scrolling list is one you have to audit before you dare press Send.
                  This strip is that audit, and it is the one place every chosen row is shown
                  complete — the closed field has an eight-pixel budget and cannot be. */}
              {multiple && selected.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1 border-b border-orange-100 bg-orange-50/60 px-2.5 py-1.5">
                  {selected.map((item) => (
                    <button
                      className="group inline-flex max-w-full items-center gap-1 whitespace-nowrap border border-orange-200 bg-white py-0.5 pl-2 pr-1 text-phx-2xs font-semibold text-orange-800 transition hover:border-orange-400 hover:bg-orange-100"
                      key={item.id}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        toggle(item.id);
                      }}
                      title={`Remove ${item.name}`}
                      type="button"
                    >
                      {item.name}
                      {item.secondary ? <span className="font-normal text-orange-500/80">{item.secondary}</span> : null}
                      <X className="h-3 w-3 shrink-0 text-orange-400 transition group-hover:text-orange-700" />
                    </button>
                  ))}
                  {selected.length > 1 ? (
                    <button
                      className="ml-auto shrink-0 whitespace-nowrap px-2 py-0.5 text-phx-2xs font-semibold text-slate-500 transition hover:bg-white hover:text-slate-800"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        onChange([]);
                        localRef.current?.focus();
                      }}
                      type="button"
                    >
                      Clear all
                    </button>
                  ) : null}
                </div>
              ) : null}

              <div className="max-h-[300px] overflow-auto overscroll-contain">
                {rows.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs text-slate-500">
                    {emptyLabel} “{query.trim()}”.
                  </p>
                ) : (
                  rows.map((row, index) => {
                    // ── The outer group, in the caller's own order ─────────────────────────────
                    if (row.kind === "group") {
                      return (
                        <div
                          className="sticky top-0 z-20 flex items-center gap-2 border-y border-slate-100 bg-slate-100/95 px-3 py-1 backdrop-blur-sm"
                          key={row.key}
                        >
                          <span className="whitespace-nowrap text-phx-2xs font-black uppercase tracking-wide text-slate-600">
                            {row.label}
                          </span>
                          <span className="bg-white px-1.5 text-phx-2xs font-black tabular-nums text-slate-500 ring-1 ring-slate-200">
                            {row.count}
                          </span>
                        </div>
                      );
                    }
                    // ── The inner group. Indented, lighter, never sticky, so it reads as belonging
                    //    to the heading above rather than competing with it.
                    if (row.kind === "subgroup") {
                      return (
                        <div className="flex items-center gap-1.5 px-3 pb-0.5 pt-1.5" key={row.key}>
                          <span className="h-2 w-0.5 shrink-0 bg-orange-300" />
                          <span className="whitespace-nowrap text-phx-2xs font-bold uppercase tracking-wide text-orange-600/90">
                            {row.label}
                          </span>
                          <span className="text-phx-2xs tabular-nums text-slate-400">{row.count}</span>
                          <span className="ml-1 h-px flex-1 bg-slate-100" />
                        </div>
                      );
                    }
                    const picked = chosen.has(row.item.id);
                    return (
                      <button
                        aria-selected={picked}
                        className={cn(
                          "flex w-full items-center gap-2 py-1.5 pl-4 pr-3 text-left transition",
                          index === activeIndex ? "bg-orange-50" : "hover:bg-orange-50/60",
                        )}
                        data-row={index}
                        key={row.key}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          toggle(row.item.id);
                        }}
                        onMouseEnter={() => setActiveId(row.item.id)}
                        role="option"
                        type="button"
                      >
                        {/* A real box on a multi-select, not just a tick on the chosen ones. An empty
                            checkbox is the only thing on screen that says "you may take more than one
                            of these" BEFORE the first click rather than after it. Single-select keeps
                            the bare tick, because there is no such thing to say. */}
                        {multiple ? (
                          <span
                            className={cn(
                              "flex h-3.5 w-3.5 shrink-0 items-center justify-center border transition",
                              picked ? "border-orange-600 bg-orange-600" : "border-slate-300 bg-white",
                            )}
                          >
                            {picked ? <Check aria-hidden="true" className="h-2.5 w-2.5 text-white" /> : null}
                          </span>
                        ) : null}
                        <span className="min-w-0 flex-1">
                          {/* `whitespace-nowrap`, never `truncate`. Clipping is what turned
                              "Ahmed Abdallah · District Sales Manager" into "…Sales Mana…" across
                              this app; the panel above grows instead. */}
                          <span
                            className={cn(
                              "block whitespace-nowrap text-xs font-semibold",
                              picked ? "text-orange-700" : "text-slate-800",
                            )}
                          >
                            {row.item.name}
                          </span>
                          {row.item.secondary ? (
                            <span className="block whitespace-nowrap text-phx-2xs text-slate-500">
                              {row.item.secondary}
                            </span>
                          ) : null}
                        </span>
                        {!multiple && picked ? (
                          <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-orange-600" />
                        ) : null}
                      </button>
                    );
                  })
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
