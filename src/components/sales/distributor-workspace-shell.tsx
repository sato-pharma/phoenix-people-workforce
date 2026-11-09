"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Search, Store } from "lucide-react";

import { Card } from "@/components/ui/card";
import type { SalesDistributorEntry } from "@/lib/sales/distributor-registry";
import { cn } from "@/lib/utils";
import { phxFieldClassName } from "@/components/ui/form-tokens";

// ── D1: shared distributor-first shell ─────────────────────────────────────────────────────────
// Reusable left-rail distributor navigator (searchable) + a content area for the selected
// distributor. Used by both new pages (Mapping Database, Sales Upload) so the distributor-first
// pattern lives in one place. `children` is a render function receiving the selected distributor.

type Props = {
  distributors: SalesDistributorEntry[];
  children: (selected: SalesDistributorEntry) => ReactNode;
  /** Only list weekly-applicable distributors (e.g. a weekly-only surface). */
  weeklyOnly?: boolean;
  /** Optional initial selected code. */
  initialCode?: string;
};

export function DistributorWorkspaceShell({ distributors, children, weeklyOnly = false, initialCode }: Props) {
  const list = useMemo(
    () => distributors.filter((d) => (weeklyOnly ? d.weeklySupported : true)),
    [distributors, weeklyOnly],
  );
  const [query, setQuery] = useState("");
  const [selectedCode, setSelectedCode] = useState<string>(() => initialCode ?? list[0]?.code ?? "");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((d) => d.code.toLowerCase().includes(q) || d.name.toLowerCase().includes(q));
  }, [list, query]);

  const selected = list.find((d) => d.code === selectedCode) ?? filtered[0] ?? list[0] ?? null;

  return (
    <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
      <Card className="h-fit overflow-hidden rounded-[6px] border border-phx-line bg-white p-0 shadow-sm">
        <div className="border-b border-phx-line p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-phx-ink-faint" />
            <input
              className={cn(phxFieldClassName, "pl-8")}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search distributor"
              value={query}
            />
          </div>
        </div>
        <div className="max-h-[70vh] overflow-auto p-2">
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-xs text-phx-ink-soft">No distributors match.</p>
          ) : (
            filtered.map((d) => {
              const active = selected?.code === d.code;
              return (
                <button
                  key={d.code}
                  className={cn(
                    "mb-1 flex w-full items-center justify-between gap-2 rounded-[6px] px-3 py-2 text-left text-sm transition",
                    active ? "bg-[#0B0B0B] text-white" : "text-phx-ink hover:bg-phx-accent-soft",
                  )}
                  onClick={() => setSelectedCode(d.code)}
                  type="button"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-bold">{d.name}</span>
                    <span className={cn("block font-mono text-phx-xs", active ? "text-slate-300" : "text-phx-ink-faint")}>{d.code}</span>
                  </span>
                  {d.weeklySupported ? (
                    <span className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-phx-xs font-black uppercase tracking-[0.1em]",
                      active ? "bg-white/15 text-white" : "bg-[#FFEAD5] text-phx-accent-press",
                    )}>Weekly</span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </Card>

      <div className="min-w-0">
        {selected ? (
          children(selected)
        ) : (
          <Card className="flex items-center gap-3 rounded-[6px] border border-phx-line bg-white p-6 text-sm text-phx-ink-soft">
            <Store className="h-5 w-5 text-phx-ink-faint" />
            No distributors available.
          </Card>
        )}
      </div>
    </div>
  );
}
