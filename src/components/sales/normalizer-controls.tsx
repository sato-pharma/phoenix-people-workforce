"use client";

import { Check, ClipboardPaste, Copy } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "@/lib/utils";

// The three controls the mapping tables are built from, shared by the MONTHLY (Source Normalizer)
// and WEEKLY workspaces. They live here rather than inside one workspace so the two surfaces cannot
// drift apart: the owner's rule is that a new page in a module matches its siblings exactly, and the
// surest way to honour that is for both to render the same component, not a copy of it.

/** One-click copy of a raw value (so it can be pasted into the Phoenix search). */
export function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  if (!text) return null;
  return (
    <button
      className="ml-1 inline-flex shrink-0 items-center text-slate-400 transition hover:text-orange-600"
      onClick={async (e) => { e.stopPropagation(); try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1000); } catch { /* clipboard blocked */ } }}
      title="Copy"
      type="button"
    >{done ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}</button>
  );
}

// Type-to-search combobox — filter hundreds of bricks/products by typing instead of scrolling.
// Includes a paste button: paste a copied raw value to instantly filter the list.
export function ComboBox({ disabled, onChange, options, placeholder, value }: { disabled?: boolean; onChange: (v: string) => void; options: { label: string; value: string }[]; placeholder: string; value: string }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = options.find((o) => o.value === value);
  const q = query.trim().toLowerCase();
  const filtered = open ? (q ? options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)) : options).slice(0, 60) : [];
  return (
    <div className="relative min-w-[240px]">
      <input
        className="h-9 w-full border border-slate-300 bg-white px-2 pr-8 text-sm outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 disabled:bg-slate-50 disabled:text-slate-400"
        disabled={disabled}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => { setOpen(true); setQuery(""); }}
        placeholder={placeholder}
        ref={inputRef}
        value={open ? query : selected?.label ?? ""}
      />
      <button
        className="absolute right-1.5 top-2 text-slate-400 transition hover:text-orange-600 disabled:opacity-40"
        disabled={disabled}
        onClick={async () => { try { const t = await navigator.clipboard.readText(); if (t) { setQuery(t); setOpen(true); inputRef.current?.focus(); } } catch { /* clipboard blocked */ } }}
        onMouseDown={(e) => e.preventDefault()}
        title="Paste to search"
        type="button"
      ><ClipboardPaste className="h-3.5 w-3.5" /></button>
      {open && !disabled ? (
        <div className="absolute left-0 right-0 z-50 mt-1 max-h-64 overflow-auto border border-slate-300 bg-white shadow-[0_12px_28px_rgba(15,23,42,0.12)]">
          {filtered.map((o) => (
            <button
              className={cn("block w-full px-2 py-1.5 text-left text-sm hover:bg-orange-50", o.value === value && "bg-orange-50 font-semibold text-orange-700")}
              key={o.value}
              onMouseDown={(e) => { e.preventDefault(); onChange(o.value); setOpen(false); setQuery(""); }}
              type="button"
            >{o.label}</button>
          ))}
          {filtered.length === 0 ? <div className="px-2 py-2 text-xs text-slate-400">Type to search… no match.</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function ConfidenceBadge({ pct: p }: { pct: number }) {
  const tone = p >= 80
    ? { box: "border-emerald-200 bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" }
    : p >= 50
    ? { box: "border-amber-200 bg-amber-50 text-amber-700", dot: "bg-amber-500" }
    : { box: "border-rose-200 bg-rose-50 text-rose-600", dot: "bg-rose-500" };
  return <span className={cn("inline-flex items-center gap-1 border px-1.5 py-0.5 text-xs font-semibold tabular-nums", tone.box)}><span aria-hidden="true" className={cn("h-1.5 w-1.5", tone.dot)} />{p}%</span>;
}
