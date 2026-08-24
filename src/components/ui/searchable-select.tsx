"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Check, Search } from "lucide-react";

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
};

type ParsedOption = {
  value: string;
  label: string;
  lowerLabel: string;
  lowerValue: string;
  selected: boolean;
  disabled: boolean;
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
    };
    if (node.type === "option") {
      const rawValue = props.value ?? props.children ?? "";
      const value = String(rawValue);
      const label = toDisplayText(props.children);
      options.push({
        value,
        label: label || value,
        lowerLabel: (label || value).toLowerCase(),
        lowerValue: value.toLowerCase(),
        selected: Boolean(props.selected),
        disabled: Boolean(props.disabled),
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
  "aria-label": ariaLabel,
  ...rest
}: SearchableSelectProps) {
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

  React.useLayoutEffect(() => {
    if (!open) return;
    updateMenuPosition();
    window.addEventListener("scroll", updateMenuPosition, true);
    window.addEventListener("resize", updateMenuPosition);
    return () => {
      window.removeEventListener("scroll", updateMenuPosition, true);
      window.removeEventListener("resize", updateMenuPosition);
    };
  }, [open, updateMenuPosition]);

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

  const baseInputClassName = "h-9 w-full rounded-[6px] border border-[#E2E8F0] bg-white px-3 text-sm font-medium text-[#0F172A] outline-none transition disabled:opacity-50";

  return (
    <div className="relative" ref={wrapperRef}>
      <input
        {...(rest as React.InputHTMLAttributes<HTMLInputElement>)}
        ref={inputRef}
        role="combobox"
        aria-autocomplete="list"
        aria-controls={`${id ?? "searchable-select"}-options`}
        aria-expanded={open}
        aria-label={ariaLabel ?? placeholder ?? name ?? "Select an option"}
        autoComplete="off"
        className={cn(baseInputClassName, className)}
        disabled={disabled}
        id={id}
        name={name}
        placeholder={placeholder ?? (disabled ? undefined : (selectedLabel || "").toString())}
        value={open ? query : selectedLabel || ""}
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
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[#94A3B8]">
        <Search className="h-4 w-4" />
      </span>

      {mounted && open && menuRect
        ? createPortal(
            <div
              ref={dropdownRef}
              role="listbox"
              aria-label={placeholder ?? "Options"}
              className="fixed z-[1000] max-h-64 w-max overflow-auto rounded-lg border border-slate-200 bg-white shadow-[0_16px_36px_rgba(15,23,42,0.14)]"
              id={`${id ?? "searchable-select"}-options`}
              style={{
                top: menuRect.top,
                left: menuRect.left,
                minWidth: menuRect.width,
                maxWidth: menuRect.maxWidth,
              }}
            >
              {filteredOptions.length === 0 ? (
                <div className="p-2 text-xs text-[#64748B]" role="option" aria-disabled="true" aria-selected={false}>{noResultsText}</div>
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
                          "w-full whitespace-nowrap border-b border-slate-100 px-3 py-2 text-left text-sm text-slate-400",
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
                        isActive ? "bg-orange-50 font-semibold text-orange-700" : "text-slate-700 hover:bg-orange-50 hover:text-orange-700",
                      )}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        if (option.disabled) return;
                        selectOption(option.value);
                      }}
                    >
                      {/*
                        Not `truncate`. That class is overflow-hidden + text-overflow: ellipsis,
                        and it is what turned "Ahmed Abdallah · District Sales Manager" into
                        "Ahmed Abdallah · District Sales Mana…" in every dropdown in the app —
                        a person picking a manager could not tell two long names apart. `nowrap`
                        alone keeps the one-line rule without ever clipping; the panel above is
                        what grows to fit it.
                      */}
                      <span className="whitespace-nowrap">{option.label}</span>
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
