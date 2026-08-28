"use client";

import { useEffect, useState } from "react";
import { History, Loader2, RefreshCw } from "lucide-react";

// Collapsible "who changed what, when" panel for the distributor column editors. Reads the dedicated
// source_of_sales_mapping_audit trail via /api/sales/mapping-audit (best-effort; empty state if absent).

type AuditEntry = {
  id: string;
  entityType: string;
  distributorCode: string | null;
  entityKey: string;
  action: string;
  actor: string;
  createdAt: string;
};

const ACTION_LABEL: Record<string, string> = { add: "created", edit: "saved", delete: "reset to built-in" };

function when(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function MappingAuditHistory({ entityType, distributorCode }: { entityType: string; distributorCode?: string | null }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ entityType });
      if (distributorCode) params.set("distributorCode", distributorCode);
      const res = await fetch(`/api/sales/mapping-audit?${params.toString()}`);
      const payload = (await res.json()) as { success?: boolean; entries?: AuditEntry[] };
      setEntries(payload.success ? payload.entries ?? [] : []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    // Defer so the first setState isn't called synchronously inside the effect body; also cancels a
    // pending load when the selected distributor changes while the panel is open.
    const id = setTimeout(() => void load(), 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, distributorCode, entityType]);

  return (
    <div className="rounded-[6px] border border-phx-line">
      <button
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-black uppercase tracking-wide text-phx-ink-2"
        onClick={() => setOpen((o) => !o)}
        type="button"
      >
        <span className="inline-flex items-center gap-1.5"><History className="h-4 w-4" /> Recent changes</span>
        <span className="flex items-center gap-2 text-phx-ink-faint">
          {open && !loading ? <RefreshCw className="h-3.5 w-3.5" onClick={(e) => { e.stopPropagation(); void load(); }} /> : null}
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          <span aria-hidden>{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {open ? (
        <div className="border-t border-phx-line">
          {loading ? (
            <p className="px-3 py-3 text-xs text-phx-ink-faint">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="px-3 py-3 text-xs text-phx-ink-faint">No changes recorded yet.</p>
          ) : (
            <ul className="divide-y divide-phx-paper-2">
              {entries.map((e) => (
                <li className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs" key={e.id}>
                  <span className="font-semibold text-phx-ink">
                    {e.distributorCode ?? e.entityKey} · <span className="font-bold text-phx-ink-2">{ACTION_LABEL[e.action] ?? e.action}</span>
                  </span>
                  <span className="text-phx-ink-faint">{e.actor} · {when(e.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
