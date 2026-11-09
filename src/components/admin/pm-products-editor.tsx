"use client";

import { useMemo, useState } from "react";
import { phxFieldClassName } from "@/components/ui/form-tokens";

export type PmRowData = {
  hrId: string;
  name: string;
  jobTitle: string | null;
  line: string | null;
  codes: string[];
};
export type PmProductOptionData = { code: string; name: string; line: string | null };

export function PmProductsEditor({
  pms,
  options,
  canEdit,
}: {
  pms: PmRowData[];
  options: PmProductOptionData[];
  canEdit: boolean;
}) {
  const optionByCode = useMemo(() => new Map(options.map((o) => [o.code, o])), [options]);
  return (
    <div className="space-y-3">
      {!canEdit ? (
        <p className="text-xs text-slate-500">Read-only — only a Super Admin can change product assignments.</p>
      ) : null}
      {pms.length === 0 ? (
        <div className="rounded-[16px] border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No Product / Group Product Managers found.
        </div>
      ) : (
        pms.map((pm) => <PmRow key={pm.hrId} pm={pm} options={options} optionByCode={optionByCode} canEdit={canEdit} />)
      )}
    </div>
  );
}

function PmRow({
  pm,
  options,
  optionByCode,
  canEdit,
}: {
  pm: PmRowData;
  options: PmProductOptionData[];
  optionByCode: Map<string, PmProductOptionData>;
  canEdit: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(pm.codes));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<null | "ok" | "err">(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const byLine = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, PmProductOptionData[]>();
    for (const o of options) {
      if (q && !`${o.code} ${o.name}`.toLowerCase().includes(q)) continue;
      const key = o.line || "Other";
      map.set(key, [...(map.get(key) ?? []), o]);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [options, query]);

  const toggle = (code: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  async function save() {
    setSaving(true);
    setSaved(null);
    try {
      const res = await fetch("/api/admin/pm-products", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hrId: pm.hrId, productCodes: [...selected] }),
      });
      setSaved(res.ok ? "ok" : "err");
    } catch {
      setSaved("err");
    }
    setSaving(false);
  }

  return (
    <div className="rounded-[16px] border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-bold text-slate-900">{pm.name}</div>
          <div className="truncate text-xs text-slate-400">
            {pm.jobTitle || "Product Manager"}
            {pm.line ? ` · ${pm.line}` : ""} · {pm.hrId.toUpperCase()}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs font-semibold text-slate-500">{selected.size} product{selected.size === 1 ? "" : "s"}</span>
          {canEdit ? (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
            >
              {open ? "Close" : "Edit"}
            </button>
          ) : null}
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {[...selected].map((code) => {
            const o = optionByCode.get(code);
            return (
              <span key={code} className="rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">
                {o?.name || code}
              </span>
            );
          })}
        </div>
      ) : (
        <div className="mt-2 text-xs text-slate-400">No products assigned — this manager&apos;s 360 sales fall back to their team roll-up.</div>
      )}

      {canEdit && open ? (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products…"
            className={`${phxFieldClassName} mb-2`}
          />
          <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
            {byLine.map(([line, opts]) => (
              <div key={line}>
                <div className="mb-1 text-phx-sm font-black uppercase tracking-wide text-slate-400">{line}</div>
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                  {opts.map((o) => (
                    <label key={o.code} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm text-slate-600 hover:bg-slate-50">
                      <input type="checkbox" checked={selected.has(o.code)} onChange={() => toggle(o.code)} className="h-4 w-4 rounded border-slate-300" />
                      <span className="truncate">
                        {o.name} <span className="text-slate-400">({o.code})</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {saved === "ok" ? <span className="text-xs font-semibold text-emerald-600">Saved ✓</span> : null}
            {saved === "err" ? <span className="text-xs font-semibold text-rose-600">Save failed — is the pm_product_assignments table migrated?</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
