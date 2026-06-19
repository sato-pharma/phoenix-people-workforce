"use client";

import * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

// A fresh, reusable MULTI-VALUE chip input for header mappings. Replaces the old SoS MappingCombobox
// that was exported from a module file and coupled to 3 consumers — this lives in ui/ with no
// cross-module coupling. Each value is a raw header string (first-present-wins fallback list); the
// admin adds/removes columns freely, so multi-column-per-field is first-class.

type MappingComboboxProps = {
  values: string[];
  onChange: (values: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
};

function dedupePush(values: string[], next: string): string[] {
  const trimmed = next.trim();
  if (!trimmed) return values;
  if (values.some((v) => v.trim().toLowerCase() === trimmed.toLowerCase())) return values;
  return [...values, trimmed];
}

export function MappingCombobox({ values, onChange, suggestions = [], placeholder, disabled = false, ariaLabel }: MappingComboboxProps) {
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const wrapperRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function onDocMouseDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (!wrapperRef.current || (target && wrapperRef.current.contains(target))) return;
      setOpen(false);
      setQuery("");
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  const normalized = query.trim().toLowerCase();
  const filtered = React.useMemo(() => {
    const selected = new Set(values.map((v) => v.trim().toLowerCase()));
    return suggestions
      .filter((s) => !selected.has(s.trim().toLowerCase()))
      .filter((s) => (normalized ? s.toLowerCase().includes(normalized) : true))
      .slice(0, 50);
  }, [suggestions, values, normalized]);

  const add = (value: string) => {
    onChange(dedupePush(values, value));
    setQuery("");
  };

  const remove = (value: string) => onChange(values.filter((v) => v !== value));

  return (
    <div className="relative" ref={wrapperRef}>
      <div
        className={cn(
          "flex min-h-9 w-full flex-wrap items-center gap-1 border border-[#E2E8F0] bg-white px-2 py-1.5 text-sm",
          disabled && "opacity-50",
        )}
      >
        {values.map((value) => (
          <span key={value} className="inline-flex items-center gap-1 bg-[#0F172A] px-2 py-0.5 text-[11px] font-semibold text-white">
            {value}
            {!disabled ? (
              <button type="button" aria-label={`Remove ${value}`} className="text-white/70 hover:text-white" onClick={() => remove(value)}>
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </span>
        ))}
        {!disabled ? (
          <input
            aria-label={ariaLabel}
            className="min-w-[6rem] flex-1 border-0 bg-transparent px-1 text-sm text-[#0F172A] outline-none"
            placeholder={values.length === 0 ? (placeholder ?? "Add a column…") : ""}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && query.trim()) {
                event.preventDefault();
                add(query);
              } else if (event.key === "Backspace" && !query && values.length > 0) {
                remove(values[values.length - 1]);
              } else if (event.key === "Escape") {
                setOpen(false);
                setQuery("");
              }
            }}
          />
        ) : null}
      </div>

      {open && !disabled && (filtered.length > 0 || query.trim()) ? (
        <div className="absolute z-[1000] mt-1 max-h-56 w-full overflow-auto border border-[#E2E8F0] bg-white shadow-lg">
          {query.trim() ? (
            <button
              type="button"
              className="block w-full border-b border-[#F1F5F9] px-3 py-2 text-left text-sm text-[#0F172A] hover:bg-[#FFF7ED] hover:text-[#F97316]"
              onMouseDown={(event) => {
                event.preventDefault();
                add(query);
              }}
            >
              Add &ldquo;{query.trim()}&rdquo;
            </button>
          ) : null}
          {filtered.map((s) => (
            <button
              key={s}
              type="button"
              className="block w-full border-b border-[#F1F5F9] px-3 py-2 text-left text-sm last:border-b-0 hover:bg-[#F8FAFC]"
              onMouseDown={(event) => {
                event.preventDefault();
                add(s);
              }}
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
