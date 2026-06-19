"use client";

import * as React from "react";
import { Check, RotateCcw } from "lucide-react";

import { MappingCombobox } from "@/components/ui/mapping-combobox";
import type { BrickLookupStrategy, DistributorTemplate } from "@/lib/sales-operations/types";
import { cn } from "@/lib/utils";

// The sheet-style mapping editor: mirrors the unified Headers Mapping sheet. Per distributor, each
// unified field is a MULTI-COLUMN combobox; the brick-lookup strategy (column L) is a selector; the
// editor shows the REAL saved values (DB-first via /api/sales-operations/profiles) — designing out the
// old editor's one-column collapse and code-defaults-vs-DB mismatch.

type EditableTemplate = { template: DistributorTemplate; isCustom: boolean };

type FieldKey =
  | "customerCodeHeaders"
  | "customerNameHeaders"
  | "customerAddressHeaders"
  | "brickNameHeaders"
  | "productNameHeaders"
  | "productCodeHeaders"
  | "qtyHeaders"
  | "dateHeaders"
  | "bonusHeaders";

const FIELDS: { key: FieldKey; label: string; hint?: string }[] = [
  { key: "customerCodeHeaders", label: "Customer Code (A)", hint: "brick key when lookup = customer code" },
  { key: "customerNameHeaders", label: "Customer Name (B)" },
  { key: "customerAddressHeaders", label: "Customer Address (C)" },
  { key: "brickNameHeaders", label: "Brick / Area Name (E)", hint: "brick key when lookup = brick name" },
  { key: "productNameHeaders", label: "Product Name (H)", hint: "primary — product is resolved by NAME first" },
  { key: "productCodeHeaders", label: "Product Code (G)", hint: "fallback only" },
  { key: "qtyHeaders", label: "Qty / Value (I)" },
  { key: "dateHeaders", label: "Date (F)", hint: "omit for date-less channels (period from picker)" },
  { key: "bonusHeaders", label: "Bonus / Free-unit flag", hint: "flagged rows are excluded" },
];

const LOOKUP_LABELS: Record<BrickLookupStrategy, string> = {
  "customer-code": "Customer Code → brick",
  "brick-name": "Brick / Area Name → brick",
  "office-allocation": "Office (contribution % allocation)",
};

const OFFICE_HIDDEN = new Set<FieldKey>(["customerCodeHeaders", "customerNameHeaders", "customerAddressHeaders", "brickNameHeaders", "productCodeHeaders", "dateHeaders", "bonusHeaders"]);

function fieldValues(template: DistributorTemplate, key: FieldKey): string[] {
  return (template[key] as string[] | undefined) ?? [];
}

export function SalesOpsMappingEditor() {
  const [rows, setRows] = React.useState<EditableTemplate[]>([]);
  const [selected, setSelected] = React.useState<string>("");
  const [version, setVersion] = React.useState(0); // bumps to remount the form with fresh data
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    // No synchronous setState here: `loading` already starts true for the first load, and refresh
    // loads come from event handlers — so the mount effect's body performs no synchronous setState.
    try {
      const res = await fetch("/api/sales-operations/profiles", { credentials: "same-origin" });
      const body = (await res.json()) as { success: boolean; data?: EditableTemplate[]; error?: string };
      if (!res.ok || !body.success || !body.data) throw new Error(body.error ?? "Failed to load mappings.");
      const data = body.data;
      setRows(data);
      setSelected((prev) => prev || data[0]?.template.code || "");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load mappings.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    // Canonical fetch-on-mount; setState happens only after the await (codebase-wide convention).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const onDone = React.useCallback((message: string) => {
    setNotice(message);
    setError(null);
    setVersion((v) => v + 1);
    void load();
  }, [load]);

  const suggestionsByField = React.useMemo(() => {
    const map = {} as Record<FieldKey, string[]>;
    for (const f of FIELDS) {
      const set = new Set<string>();
      for (const r of rows) for (const v of fieldValues(r.template, f.key)) set.add(v);
      map[f.key] = [...set].sort();
    }
    return map;
  }, [rows]);

  const selectedRow = rows.find((r) => r.template.code === selected) ?? null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
      <aside className="border border-[#D8E0EA] bg-white">
        <div className="bg-[#020617] px-3 py-2 text-[11px] font-black uppercase tracking-[0.12em] text-white">Distributors</div>
        <ul className="max-h-[70vh] overflow-auto">
          {rows.map((r) => (
            <li key={r.template.code}>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center justify-between border-b border-[#F1F5F9] px-3 py-2 text-left text-sm",
                  selected === r.template.code ? "bg-[#FFF7ED] text-[#F97316]" : "text-[#0F172A] hover:bg-[#F8FAFC]",
                )}
                onClick={() => {
                  setSelected(r.template.code);
                  setNotice(null);
                }}
              >
                <span>
                  <span className="font-semibold">{r.template.code}</span> · {r.template.name}
                </span>
                {r.isCustom ? <span className="bg-[#F97316] px-1.5 py-0.5 text-[10px] font-bold text-white">EDITED</span> : null}
              </button>
            </li>
          ))}
          {loading && rows.length === 0 ? <li className="px-3 py-2 text-xs text-[#64748B]">Loading…</li> : null}
        </ul>
      </aside>

      <section className="border border-[#D8E0EA] bg-white">
        {error ? <div className="border-b border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-xs text-[#B91C1C]">{error}</div> : null}
        {notice ? <div className="border-b border-[#BBF7D0] bg-[#F0FDF4] px-3 py-2 text-xs text-[#15803D]">{notice}</div> : null}
        {selectedRow ? (
          <DistributorMappingForm
            key={`${selected}:${version}`}
            template={selectedRow.template}
            suggestions={suggestionsByField}
            onDone={onDone}
            onError={(msg) => setError(msg)}
          />
        ) : (
          <div className="p-6 text-sm text-[#64748B]">Select a distributor to edit its mapping.</div>
        )}
      </section>
    </div>
  );
}

function DistributorMappingForm({
  template,
  suggestions,
  onDone,
  onError,
}: {
  template: DistributorTemplate;
  suggestions: Record<FieldKey, string[]>;
  onDone: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = React.useState<DistributorTemplate>(() => structuredClone(template));
  const [saving, setSaving] = React.useState(false);

  const isOffice = draft.brickLookup === "office-allocation";

  const updateField = (key: FieldKey, values: string[]) => setDraft((prev) => ({ ...prev, [key]: values }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/sales-operations/profiles", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          distributorCode: draft.code,
          brickLookup: draft.brickLookup,
          customerCodeHeaders: draft.customerCodeHeaders ?? [],
          customerNameHeaders: draft.customerNameHeaders ?? [],
          customerAddressHeaders: draft.customerAddressHeaders ?? [],
          brickNameHeaders: draft.brickNameHeaders ?? [],
          productNameHeaders: draft.productNameHeaders ?? [],
          productCodeHeaders: draft.productCodeHeaders ?? [],
          qtyHeaders: draft.qtyHeaders ?? [],
          dateHeaders: draft.dateHeaders ?? [],
          bonusHeaders: draft.bonusHeaders ?? [],
          regionOnly: Boolean(draft.regionOnly),
          dateFormat: draft.dateFormat ?? "day-first",
        }),
      });
      const body = (await res.json()) as { success: boolean; error?: string };
      if (!res.ok || !body.success) throw new Error(body.error ?? "Failed to save.");
      onDone("Mapping saved — it takes effect on the next upload of this distributor.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/sales-operations/profiles?distributor=${encodeURIComponent(draft.code)}`, { method: "DELETE", credentials: "same-origin" });
      const body = (await res.json()) as { success: boolean; error?: string };
      if (!res.ok || !body.success) throw new Error(body.error ?? "Failed to reset.");
      onDone("Reset to the built-in default mapping.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to reset.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between bg-[#020617] px-3 py-2">
        <span className="text-[11px] font-black uppercase tracking-[0.12em] text-white">{draft.code} · {draft.name}</span>
        <div className="flex items-center gap-2">
          <button type="button" disabled={saving} onClick={reset} className="inline-flex items-center gap-1 bg-white px-2 py-1 text-[11px] font-semibold text-[#0F172A] disabled:opacity-50">
            <RotateCcw className="h-3 w-3" /> Reset
          </button>
          <button type="button" disabled={saving} onClick={save} className="inline-flex items-center gap-1 bg-[#F97316] px-3 py-1 text-[11px] font-bold text-white disabled:opacity-50">
            <Check className="h-3 w-3" /> {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="space-y-3 p-3">
        <div className="flex flex-wrap items-end gap-4 border border-[#E2E8F0] p-3">
          <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
            Brick lookup (column L)
            <select className="h-9 border border-[#E2E8F0] bg-white px-2 text-sm text-[#0F172A]" value={draft.brickLookup} onChange={(e) => setDraft({ ...draft, brickLookup: e.target.value as BrickLookupStrategy })}>
              {(Object.keys(LOOKUP_LABELS) as BrickLookupStrategy[]).map((s) => (
                <option key={s} value={s}>{LOOKUP_LABELS[s]}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-[#475569]">
            Date format
            <select className="h-9 border border-[#E2E8F0] bg-white px-2 text-sm text-[#0F172A]" value={draft.dateFormat ?? "day-first"} onChange={(e) => setDraft({ ...draft, dateFormat: e.target.value as "day-first" | "month-first" })}>
              <option value="day-first">Day-first (DD-MM)</option>
              <option value="month-first">Month-first (MM-DD)</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs font-semibold text-[#475569]">
            <input type="checkbox" checked={Boolean(draft.regionOnly)} onChange={(e) => setDraft({ ...draft, regionOnly: e.target.checked })} />
            Region/area only (no brick)
          </label>
        </div>

        {isOffice ? (
          <p className="border border-[#FED7AA] bg-[#FFF7ED] px-3 py-2 text-xs text-[#9A3412]">
            Office is a pivot allocated by contribution %. Map only the product name and units columns; geography is computed from the other channels&rsquo; sales.
          </p>
        ) : null}

        <div className="divide-y divide-[#F1F5F9] border border-[#E2E8F0]">
          {FIELDS.filter((f) => !(isOffice && OFFICE_HIDDEN.has(f.key))).map((f) => (
            <div key={f.key} className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-[200px_1fr]">
              <div className="text-sm">
                <div className="font-semibold text-[#0F172A]">{f.label}</div>
                {f.hint ? <div className="text-[11px] text-[#64748B]">{f.hint}</div> : null}
              </div>
              <MappingCombobox
                ariaLabel={f.label}
                values={fieldValues(draft, f.key)}
                suggestions={suggestions[f.key]}
                onChange={(values) => updateField(f.key, values)}
                placeholder="Add the distributor's raw column…"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
