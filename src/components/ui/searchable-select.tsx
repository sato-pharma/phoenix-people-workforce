"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Check, Search } from "lucide-react";

import { phxSelectClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

const emptySubscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

function useMounted() {
  return React.useSyncExternalStore(emptySubscribe, getClientSnapshot, getServerSnapshot);
}

type SearchableSelectProps = Omit<React.ComponentPropsWithoutRef<"select">, "children" | "onChange"> & {
  children?: React.ReactNode;
  maxResults?: number;
  noResultsText?: string;
  placeholder?: string;
  onChange?: React.ChangeEventHandler<HTMLSelectElement>;
  onValueChange?: (value: string) => void;
  onBlur?: React.FocusEventHandler<HTMLInputElement | HTMLSelectElement>;
  onFocus?: React.FocusEventHandler<HTMLInputElement | HTMLSelectElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement | HTMLSelectElement>;
  /**
   * Show the chosen value as WRAPPING text while the field is closed, so a narrow field (a table
   * column) reads the whole value on as many lines as it needs instead of clipping it on one.
   * Opt-in: a one-line input is still the right look in filter bars and forms.
   */
  wrapValue?: boolean;
  /**
   * Opt-in free typing. When set, whatever is typed that is not already a row gets one extra row at
   * the top of the list — click it (or press Enter when nothing else matches) and the select emits
   * `freeTextValue(typed)` as its value. A return of "" means the typed text is not acceptable and no
   * row is offered. The caller must also list an <option> for the value it holds, so the closed field
   * can show it. Every select that does not pass this behaves exactly as before.
   */
  freeTextValue?: (typed: string) => string;
  /** The words on that row; defaults to Use "typed". */
  freeTextLabel?: (typed: string) => string;
};

// The caller's fixed height (`h-10`, `h-[42px]`) becomes the wrapping field's MINIMUM height, so a
// one-line value keeps exactly the height it had and only a longer value grows the field.
function minHeightFromClassName(className: string): string | undefined {
  let minHeight: string | undefined;
  for (const token of className.split(/\s+/)) {
    const scale = token.match(/^h-(\d+(?:\.\d+)?)$/);
    if (scale) minHeight = `${Number(scale[1]) * 0.25}rem`;
    const arbitrary = token.match(/^h-\[([^\]]+)\]$/);
    if (arbitrary) minHeight = arbitrary[1];
  }
  return minHeight;
}

type ParsedOption = {
  value: string;
  label: string;
  lowerLabel: string;
  lowerValue: string;
  selected: boolean;
  disabled: boolean;
  // Optional visual tone, read from an <option data-tone="…"> attribute. "planned" paints the row
  // green — used by the weekly Plan-week picker to mark weeks a plan already exists for. The raw
  // <option> is never rendered to the DOM (only parsed), so this attribute never leaks as markup.
  tone: string | undefined;
  node: React.ReactElement;
};

function toDisplayText(node: React.ReactNode): string {
  if (node == null) return "";
  if (Array.isArray(node)) return node.map(toDisplayText).join(" ").trim();
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (typeof node === "boolean") return "";
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return toDisplayText(props.children);
  }
  return "";
}

function parseOptions(children: React.ReactNode): ParsedOption[] {
  const options: ParsedOption[] = [];

  const visit = (node: React.ReactNode) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
      return;
    }

    if (!React.isValidElement(node)) return;
    const props = (node.props ?? {}) as {
      value?: unknown;
      children?: React.ReactNode;
      selected?: unknown;
      disabled?: unknown;
      "data-tone"?: unknown;
    };
    if (node.type === "option") {
      const rawValue = props.value ?? props.children ?? "";
      const value = String(rawValue);
      const label = toDisplayText(props.children);
      const rawTone = props["data-tone"];
      options.push({
        value,
        label: label || value,
        lowerLabel: (label || value).toLowerCase(),
        lowerValue: value.toLowerCase(),
        selected: Boolean(props.selected),
        disabled: Boolean(props.disabled),
        tone: typeof rawTone === "string" && rawTone ? rawTone : undefined,
        node,
      });
      return;
    }

    if (node.type === "optgroup") {
      const childNodes = React.Children.toArray(props.children);
      for (const child of childNodes) {
        visit(child);
      }
      return;
    }

    if (node.type === React.Fragment) {
      visit(props.children);
      return;
    }
  };

  React.Children.forEach(children, visit);
  return options;
}

export function SearchableSelect({
  children,
  className,
  disabled = false,
  required = false,
  name,
  id,
  value,
  defaultValue,
  onChange,
  onBlur,
  onFocus,
  onKeyDown,
  onValueChange,
  maxResults = 100,
  noResultsText = "No results",
  placeholder,
  wrapValue = false,
  freeTextValue,
  freeTextLabel,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: SearchableSelectProps) {
  const valueId = React.useId();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const isControlled = value !== undefined;
  const options = React.useMemo(() => parseOptions(children), [children]);
  const uncontrolledDefaultValue = React.useMemo(() => {
    if (defaultValue !== undefined) return String(defaultValue);
    if (options.length === 0) return "";
    const explicitSelected = options.find((option) => option.selected);
    if (explicitSelected) return explicitSelected.value;
    const firstEnabled = options.find((option) => !option.disabled);
    if (firstEnabled) return firstEnabled.value;
    return options[0].value;
  }, [defaultValue, options]);
  const mounted = useMounted();
  const [internalValue, setInternalValue] = React.useState<string>(() => uncontrolledDefaultValue);
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [menuRect, setMenuRect] = React.useState<{
    top: number;
    left: number;
    width: number;
    maxWidth: number;
  } | null>(null);

  const currentValue = React.useMemo(() => {
    if (isControlled) return String(value ?? "");
    return internalValue;
  }, [isControlled, internalValue, value]);

  const normalizedQuery = query.trim().toLowerCase();

  const filteredOptions = React.useMemo(() => {
    if (!normalizedQuery) return options.slice(0, maxResults);
    const filtered = options.filter((option) => {
      return option.lowerValue.includes(normalizedQuery) || option.lowerLabel.includes(normalizedQuery);
    });
    return filtered.slice(0, maxResults);
  }, [options, normalizedQuery, maxResults]);

  // The extra "use what I typed" row: only when free typing is on, something readable was typed and no
  // row already reads exactly that (typing a listed name picks the listed one, never a duplicate).
  const freeTextRow = React.useMemo(() => {
    if (!freeTextValue) return null;
    const typed = query.replace(/\s+/g, " ").trim();
    if (!typed) return null;
    const lowerTyped = typed.toLowerCase();
    if (options.some((option) => option.lowerLabel === lowerTyped)) return null;
    const emitted = freeTextValue(typed);
    if (!emitted) return null;
    return { value: emitted, label: freeTextLabel ? freeTextLabel(typed) : `Use "${typed}"` };
  }, [freeTextLabel, freeTextValue, options, query]);

  const selectedLabel = React.useMemo(() => {
    const match = options.find((option) => option.value === currentValue);
    if (match) return match.label;
    if (currentValue && options.some((option) => option.value === "")) return "";
    return currentValue;
  }, [currentValue, options]);

  React.useEffect(() => {
    function onDocumentMouseDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (wrapperRef.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
      setQuery("");
    }

    document.addEventListener("mousedown", onDocumentMouseDown);
    return () => document.removeEventListener("mousedown", onDocumentMouseDown);
  }, []);

  const updateMenuPosition = React.useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const rect = wrapper.getBoundingClientRect();
    // The panel is allowed to grow past the trigger it hangs from, because an option label is
    // never clipped and never wrapped — a name has to be readable in full. A narrow field would
    // otherwise force one of the two. Growth stops at the viewport's right edge so a field sitting
    // near it cannot push the panel off-screen; a label longer than that scrolls inside the panel,
    // which is the only remaining way to show all of it.
    const roomToTheRight = window.innerWidth - rect.left - 8;
    setMenuRect({
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
      maxWidth: Math.max(rect.width, roomToTheRight),
    });
  }, []);

  // The panel is position:fixed and portalled to <body>, so it follows its field on every scroll. It
  // must also CLOSE once the field is no longer on screen. Before this it kept tracking a field that
  // had scrolled up under the portal's sticky header and drew itself over that header, hanging from
  // nothing (owner's video of the Weekly / Monthly Plan page, 2026-09-13). "On screen" is a hit-test
  // at the field's centre: it answers null past the viewport and the header when one covers the
  // field, while a field a phone keyboard scrolls INTO view stays open. A scroll inside the panel's
  // own option list is ignored.
  const triggerIsOnScreen = React.useCallback(() => {
    const input = inputRef.current;
    const wrapper = wrapperRef.current;
    if (!input || !wrapper) return false;
    const rect = input.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(hit && wrapper.contains(hit));
  }, []);

  React.useLayoutEffect(() => {
    if (!open) return;
    updateMenuPosition();
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && dropdownRef.current?.contains(event.target)) return;
      if (!triggerIsOnScreen()) {
        setOpen(false);
        setQuery("");
        return;
      }
      updateMenuPosition();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", updateMenuPosition);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", updateMenuPosition);
    };
  }, [open, triggerIsOnScreen, updateMenuPosition]);

  const emitChange = (nextValue: string) => {
    if (!isControlled) setInternalValue(nextValue);
    const syntheticEvent = {
      target: {
        name,
        value: nextValue,
        required,
        disabled,
      },
      currentTarget: {
        name,
        value: nextValue,
        required,
        disabled,
      },
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as React.ChangeEvent<HTMLSelectElement>;

    onValueChange?.(nextValue);
    if (onChange) onChange(syntheticEvent);
  };

  const openDropdown = () => {
    if (disabled) return;
    setOpen(true);
    setQuery("");
  };

  const closeDropdown = () => {
    setOpen(false);
    setQuery("");
  };

  const selectOption = (nextValue: string) => {
    emitChange(nextValue);
    closeDropdown();
    inputRef.current?.focus();
  };

  const handleInputKeyDown: React.KeyboardEventHandler<HTMLInputElement> = (event) => {
    if (event.key === "Escape") {
      closeDropdown();
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!open) {
        openDropdown();
      }
      return;
    }

    if (event.key === "Enter" && open) {
      event.preventDefault();
      const firstSelectable = filteredOptions.find((option) => !option.disabled);
      if (firstSelectable) {
        selectOption(firstSelectable.value);
      } else if (freeTextRow) {
        selectOption(freeTextRow.value);
      }
      return;
    }

    if (event.key === "Tab" && open) {
      closeDropdown();
      return;
    }

    if (event.key === "Enter" && !open && selectedLabel) {
      openDropdown();
      return;
    }

    onKeyDown?.(event);
  };

  // `pr-9`, NOT `px-3`, AND THE MAGNIFIER BELOW IS THE REASON. The icon is absolutely positioned
  // at `right-2.5` and is 16px wide, so it covers the input from 10px to 26px in from the right
  // edge. With 12px of right padding the value ran straight underneath it — measured at 375px on
  // the hiring pack, where "AI-0018 · SamahAshraf · Medical Representative" rendered as
  // "AI-0018 · SamahAshraf · Medical Re" with the rest disappearing behind the glass. Nothing was
  // truncated in the DOM and no overflow reading showed anything wrong: the text was simply painted
  // under an opaque sibling. 36px clears the icon with 10px to spare.
  //
  // A caller passing its own `px-*` still wins here, because `cn` is tailwind-merge and `px`
  // conflicts with `pr`. That is the correct precedence — a caller asking for specific horizontal
  // padding gets it — and it only means that screen keeps the old behaviour, never that it breaks.
  //
  // The skin itself is the SHARED select token (`@/components/ui/form-tokens`) plus this
  // component's own `pr-9`. Before the 2026-10-06 sweep this line was a sixth look of its
  // own — h-9, `border-phx-line`, and a `rounded-[6px]` the employee portal does not reset
  // — which made every one of this component's call sites a square-edge breach outside the
  // admin shell.
  const baseInputClassName = cn(phxSelectClassName, "pr-9");

  // wrapValue: an <input> can only ever paint one line, so a value wider than its field was clipped
  // — measured on the Weekly Plan table, 2026-09-14, where "Marketing Double Visit" read as
  // "Marketing Doubl" and a partner's name and title showed 136 of 361px. While the field is closed
  // the input paints only the box (empty value, no placeholder) and a sibling in the same grid cell
  // paints the value with `whitespace-normal break-words`; the cell grows to fit it and the input
  // stretches with it, so the box, its border and its focus ring stay the input's own. While open
  // the sibling turns `invisible` but keeps its height, so typing a search never makes the row jump.
  //
  // The sibling is a disabled-able <button> for one reason: the caller's `disabled:` text colour and
  // opacity then apply to the painted value exactly as they did to the input's own text. It is
  // `pointer-events-none`, so every click reaches the input (and the hit-test in triggerIsOnScreen
  // still lands inside the wrapper), `tabIndex={-1}` and `aria-hidden`; the input names it through
  // aria-describedby so a screen reader still hears the chosen value. `pr-9` is re-applied after the
  // caller's classes on both, because the magnifier sits over the text whatever `px-*` was passed.
  const wrapClosed = wrapValue && !open;
  const fieldClassName = cn(baseInputClassName, className);
  const valueMinHeight = wrapValue ? minHeightFromClassName(fieldClassName) : undefined;
  const describedBy = [ariaDescribedBy, wrapValue ? valueId : undefined].filter(Boolean).join(" ") || undefined;

  return (
    <div className={wrapValue ? "relative grid grid-cols-[minmax(0,1fr)]" : "relative"} ref={wrapperRef}>
      <input
        {...(rest as React.InputHTMLAttributes<HTMLInputElement>)}
        ref={inputRef}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={`${id ?? "searchable-select"}-options`}
        aria-describedby={describedBy}
        aria-expanded={open}
        aria-label={ariaLabel ?? placeholder ?? name ?? "Select an option"}
        autoComplete="off"
        className={
          wrapValue
            ? cn(fieldClassName, "col-start-1 row-start-1 h-auto self-stretch pr-9", wrapClosed && "caret-transparent")
            : fieldClassName
        }
        disabled={disabled}
        id={id}
        name={name}
        placeholder={wrapClosed ? undefined : placeholder ?? (disabled ? undefined : (selectedLabel || "").toString())}
        value={open ? query : wrapValue ? "" : selectedLabel || ""}
        onBlur={(event) => {
          closeDropdown();
          onBlur?.(event);
        }}
        onChange={(event) => {
          if (!open) openDropdown();
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={(event) => {
          openDropdown();
          onFocus?.(event);
        }}
        onClick={() => openDropdown()}
        onKeyDown={handleInputKeyDown}
        type="text"
      />
      {wrapValue ? (
        <button
          aria-hidden="true"
          className={cn(
            fieldClassName,
            "pointer-events-none relative col-start-1 row-start-1 h-auto whitespace-normal break-words border-transparent bg-transparent py-2 pr-9 text-left shadow-none hover:bg-transparent disabled:bg-transparent",
            open && "invisible",
          )}
          disabled={disabled}
          id={valueId}
          style={valueMinHeight ? { minHeight: valueMinHeight } : undefined}
          tabIndex={-1}
          type="button"
        >
          {selectedLabel || placeholder || "\u00a0"}
        </button>
      ) : null}
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-phx-ink-faint">
        <Search className="h-4 w-4" />
      </span>

      {mounted && open && menuRect
        ? createPortal(
            <div
              ref={dropdownRef}
              role="listbox"
              aria-label={placeholder ?? "Options"}
              // Portaled out of whatever menu holds this select, so a menu's outside-click dismiss
              // (useDismissOnOutsideInteraction) would read a press on an option as "outside" and
              // close the menu. The marker tells it this list belongs to the menu.
              data-floating-layer=""
              className="fixed z-[1000] max-h-64 w-max overflow-x-hidden overflow-y-auto border border-slate-200 bg-white shadow-[0_16px_36px_rgba(15,23,42,0.14)]"
              id={`${id ?? "searchable-select"}-options`}
              style={{
                top: menuRect.top,
                left: menuRect.left,
                minWidth: menuRect.width,
                maxWidth: menuRect.maxWidth,
              }}
            >
              {freeTextRow ? (
                <button
                  role="option"
                  aria-selected={false}
                  className="flex w-full items-center gap-2 border-b border-slate-100 bg-orange-50/60 px-3 py-2 text-left text-sm font-semibold text-orange-700 transition hover:bg-orange-50"
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    selectOption(freeTextRow.value);
                  }}
                >
                  <span className="min-w-0 whitespace-normal break-words">{freeTextRow.label}</span>
                </button>
              ) : null}
              {filteredOptions.length === 0 ? (
                freeTextRow ? null : (
                  <div className="p-2 text-xs text-phx-ink-soft" role="option" aria-disabled="true" aria-selected={false}>{noResultsText}</div>
                )
              ) : (
                filteredOptions.map((option, index) => {
                  const isActive = currentValue === option.value;
                  if (option.disabled) {
                    return (
                      <div
                        key={`${option.value}-${index}`}
                        role="option"
                        aria-disabled="true"
                        aria-selected={false}
                        className={cn(
                          "w-full whitespace-normal break-words border-b border-slate-100 px-3 py-2 text-left text-sm text-slate-400",
                          "last:border-b-0"
                        )}
                      >
                        {option.label}
                      </div>
                    );
                  }
                  return (
                    <button
                      key={`${option.value}-${index}`}
                      role="option"
                      aria-selected={isActive}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 text-left text-sm transition last:border-b-0",
                        isActive
                          ? "bg-orange-50 font-semibold text-orange-700"
                          : option.tone === "planned"
                            ? "bg-emerald-50/40 font-semibold text-emerald-700 hover:bg-emerald-50"
                            : "text-slate-700 hover:bg-orange-50 hover:text-orange-700",
                      )}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        if (option.disabled) return;
                        selectOption(option.value);
                      }}
                    >
                      {/*
                        Not `truncate`, and no longer `whitespace-nowrap` either. Both were tried, in that
                        order, and each moved the same damage one step further out.

                        `truncate` is overflow-hidden + text-overflow: ellipsis, and it is what turned
                        "Ahmed Abdallah / District Sales Manager" into "Ahmed Abdallah / District Sales Mana..."
                        in every dropdown in the app, so a person picking a manager could not tell two long
                        names apart. It stays banned — tests/searchable-select-no-ellipsis.test.ts.

                        `whitespace-nowrap` replaced it and clipped nothing, but the panel is capped at the
                        viewport (maxWidth below), so a row wider than the cap made the panel scroll SIDEWAYS.
                        Measured on the Employee Master vacancy picker, 2026-09-09: 708px of row inside a 491px
                        panel, with the district and the manager sitting past the right edge.

                        AGENTS.md §4 settles which rule wins: the no-horizontal-scroll golden rule supersedes
                        the old "never let text wrap" companion, and WRAPPING is the permitted answer. So the
                        row wraps. `break-words` because an area name can be one long unbroken token, and
                        `min-w-0` because without it this flex child refuses to shrink below its content and
                        the scroll comes straight back.
                      */}
                      <span className="flex min-w-0 items-center gap-1.5">
                        {option.tone === "planned" ? (
                          <span aria-hidden className="h-2 w-2 shrink-0 bg-emerald-500" />
                        ) : null}
                        <span className="min-w-0 whitespace-normal break-words">{option.label}</span>
                      </span>
                      {isActive ? <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-orange-600" /> : null}
                    </button>
                  );
                })
              )}
            </div>,
            document.body,
          )
        : null}

      <input type="hidden" name={name} required={required} value={currentValue} />
    </div>
  );
}
