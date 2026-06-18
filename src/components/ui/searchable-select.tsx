"use client";

import * as React from "react";
import { Search } from "lucide-react";

import { cn } from "@/lib/utils";

type SearchableSelectProps = Omit<React.ComponentPropsWithoutRef<"select">, "children" | "onChange"> & {
  children?: React.ReactNode;
  maxResults?: number;
  noResultsText?: string;
  onChange?: React.ChangeEventHandler<HTMLSelectElement>;
  onValueChange?: (value: string) => void;
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
  if (React.isValidElement(node)) return toDisplayText(node.props?.children);
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
    const elementType = typeof node.type === "string" ? node.type : "";
    const props = node.props ?? {};
    if (elementType === "option") {
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

    if (elementType === "optgroup") {
      const childNodes = React.Children.toArray(props.children);
      for (const child of childNodes) {
        visit(child);
      }
      return;
    }

    if (elementType === "React.Fragment" || elementType === React.Fragment) {
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
  const [internalValue, setInternalValue] = React.useState<string>(uncontrolledDefaultValue);
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    if (!isControlled && defaultValue === undefined && internalValue === "" && uncontrolledDefaultValue) {
      setInternalValue(uncontrolledDefaultValue);
    }
  }, [isControlled, defaultValue, internalValue, uncontrolledDefaultValue]);

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
      if (!wrapperRef.current || wrapperRef.current.contains(target)) return;
      setOpen(false);
      setQuery("");
    }

    document.addEventListener("mousedown", onDocumentMouseDown);
    return () => document.removeEventListener("mousedown", onDocumentMouseDown);
  }, []);

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

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
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

    onKeyDown?.(event as unknown as React.KeyboardEvent<HTMLInputElement>);
  };

  const baseInputClassName = "h-9 w-full rounded-[6px] border border-[#E2E8F0] bg-white px-3 text-sm font-medium text-[#0F172A] outline-none transition disabled:opacity-50";

  return (
    <div className="relative" ref={wrapperRef}>
      <input
        {...(rest as React.ComponentPropsWithoutRef<"input">)}
        ref={inputRef}
        aria-autocomplete="list"
        aria-controls={`${id ?? "searchable-select"}-options`}
        aria-expanded={open}
        autoComplete="off"
        className={cn(baseInputClassName, className)}
        disabled={disabled}
        id={id}
        name={name}
        placeholder={placeholder ?? (disabled ? undefined : (selectedLabel || "").toString())}
        value={open ? query : selectedLabel || ""}
        onBlur={(event) => {
          closeDropdown();
          onBlur?.(event as unknown as React.FocusEvent<HTMLInputElement>);
        }}
        onChange={(event) => {
          if (!open) openDropdown();
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={(event) => {
          openDropdown();
          onFocus?.(event as unknown as React.FocusEvent<HTMLInputElement>);
        }}
        onClick={() => openDropdown()}
        onKeyDown={handleInputKeyDown}
        type="text"
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[#94A3B8]">
        <Search className="h-4 w-4" />
      </span>

      {open ? (
        <div
          ref={dropdownRef}
          className="z-[1000] max-h-64 overflow-auto rounded-lg border border-[#E2E8F0] bg-white shadow-lg"
          id={`${id ?? "searchable-select"}-options`}
          style={{ width: "100%" }}
        >
        {filteredOptions.length === 0 ? (
            <div className="p-2 text-xs text-[#64748B]">{noResultsText}</div>
          ) : (
            filteredOptions.map((option, index) => {
              const isActive = currentValue === option.value;
              if (option.disabled) {
                return (
                  <div
                    key={`${option.value}-${index}`}
                    className={cn(
                      "w-full border-b border-[#F1F5F9] px-3 py-2 text-left text-sm text-[#94A3B8]",
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
                  className={cn(
                    "w-full border-b border-[#F1F5F9] px-3 py-2 text-left text-sm transition last:border-b-0",
                    isActive && "bg-[#FFF7ED] text-[#F97316]",
                    "hover:bg-[#F8FAFC]",
                  )}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    if (option.disabled) return;
                    selectOption(option.value);
                  }}
                >
                  {option.label}
                </button>
              );
            })
          )}
        </div>
      ) : null}

      <input type="hidden" name={name} required={required} value={currentValue} />
    </div>
  );
}
