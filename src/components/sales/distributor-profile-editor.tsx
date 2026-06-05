"use client";

import { ArrowDown, ArrowUp, CheckCircle2, Download, Loader2, Plus, RotateCcw, Save, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Phoenix target fields — EACH its own cell, exact order/labels of the exported workbook.
const FIELDS: { key: FieldKey; label: string; hint?: string }[] = [
  { key: "productCodeColumns", label: "Product Code" },
  { key: "productNameColumns", label: "Product Name" },
  { key: "qtyColumns", label: "Quantity" },
  { key: "branchCodeColumns", label: "Branch Code" },
  { key: "branchNameColumns", label: "Branch Name" },
  { key: "bonusColumns", label: "Bonus Qty" },
  { key: "valueColumns", label: "Value", hint: "only used in 'from sheet' mode" },
  { key: "discountColumns", label: "Discount %" },
  { key: "dateColumns", label: "Invoice Date" },
  { key: "customerCodeColumns", label: "Customer Code" },
  { key: "customerNameColumns", label: "Customer Name" },
  { key: "customerAddressColumns", label: "Customer Address" },
  { key: "areaIdColumns", label: "Area ID" },
  { key: "areaNameColumns", label: "Area Name" },
  { key: "brickIdColumns", label: "Brick ID" },
  { key: "brickNameColumns", label: "Brick Name" },
  { key: "regionColumns", label: "Region" },
];

type FieldKey =
  | "productCodeColumns" | "productNameColumns" | "qtyColumns" | "branchCodeColumns" | "branchNameColumns"
  | "bonusColumns" | "valueColumns" | "discountColumns" | "dateColumns" | "customerCodeColumns"
  | "customerNameColumns" | "customerAddressColumns" | "areaIdColumns" | "areaNameColumns"
  | "brickIdColumns" | "brickNameColumns" | "regionColumns";

type EditableProfile = {
  distributorCode: string;
  distributorName: string;
  valueSource: "recompute" | "sheet";
  regionOnly: boolean;
  isCustom: boolean;
  fields: Record<FieldKey, string[]>;
};

const chip = "inline-flex items-center gap-1 border border-[#D8E0EA] bg-white px-2 py-1 text-xs font-semibold text-[#0F172A]";

export function DistributorProfileEditor() {
  const [profiles, setProfiles] = useState<EditableProfile[]>([]);
  const [headers, setHeaders] = useState<Record<string, string[]>>({});
  const [selected, setSelected] = useState<string>("");
  const [draft, setDraft] = useState<EditableProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<"reset" | "import" | null>(null);
  const [message, setMessage] = useState<{ text: string; type: "error" | "success" } | null>(null);
  const [manual, setManual] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function load(keepSelection = true) {
    try {
      const res = await fetch("/api/sales/database-mapping/distributor-profiles", { cache: "no-store" });
      const json = await res.json();
      if (!json.success) { setMessage({ type: "error", text: json.error ?? "Failed to load mappings." }); return; }
      const list = json.data.profiles as EditableProfile[];
      setProfiles(list);
      setHeaders(json.data.headers as Record<string, string[]>);
      const next = keepSelection && selected ? selected : list[0]?.distributorCode ?? "";
      setSelected(next);
      const found = list.find((p) => p.distributorCode === next) ?? null;
      setDraft(found ? structuredClone(found) : null);
    } catch (e) {
      setMessage({ type: "error", text: e instanceof Error ? e.message : "Failed to load mappings." });
    } finally {
      setLoading(false);
    }
  }

  // Fetch-on-mount: load() only sets state after its await, so there is no synchronous cascade.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(false); }, []);

  function selectDistributor(code: string) {
    setSelected(code);
    const found = profiles.find((p) => p.distributorCode === code) ?? null;
    setDraft(found ? structuredClone(found) : null);
    setMessage(null);
  }

  const pool = useMemo(() => (selected ? headers[selected] ?? [] : []), [headers, selected]);

  function addToField(key: FieldKey, value: string) {
    const v = value.trim();
    if (!v || !draft) return;
    if (draft.fields[key].includes(v)) return;
    setDraft({ ...draft, fields: { ...draft.fields, [key]: [...draft.fields[key], v] } });
  }
  function removeFromField(key: FieldKey, idx: number) {
    if (!draft) return;
    const next = draft.fields[key].slice(); next.splice(idx, 1);
    setDraft({ ...draft, fields: { ...draft.fields, [key]: next } });
  }
  function move(key: FieldKey, idx: number, dir: -1 | 1) {
    if (!draft) return;
    const next = draft.fields[key].slice();
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    setDraft({ ...draft, fields: { ...draft.fields, [key]: next } });
  }

  async function save() {
    if (!draft) return;
    setSaving(true); setMessage(null);
    try {
      const res = await fetch("/api/sales/database-mapping/distributor-profiles", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ distributorCode: draft.distributorCode, fields: draft.fields, valueSource: draft.valueSource, regionOnly: draft.regionOnly }),
      });
      const json = await res.json();
      if (!json.success) { setMessage({ type: "error", text: json.error ?? "Save failed." }); return; }
      setMessage({ type: "success", text: `Saved ${draft.distributorName}. Re-upload that distributor's file on the Normalizer to apply the corrected mapping — already-imported months keep their old values until re-imported.` });
      await load(true);
    } catch (e) {
      setMessage({ type: "error", text: e instanceof Error ? e.message : "Save failed." });
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefault() {
    if (!draft) return;
    setBusy("reset"); setMessage(null);
    try {
      const res = await fetch(`/api/sales/database-mapping/distributor-profiles?distributor=${encodeURIComponent(draft.distributorCode)}`, { method: "DELETE" });
      const json = await res.json();
      if (!json.success) { setMessage({ type: "error", text: json.error ?? "Reset failed." }); return; }
      setMessage({ type: "success", text: `${draft.distributorName} reset to the built-in default.` });
      await load(true);
    } catch (e) {
      setMessage({ type: "error", text: e instanceof Error ? e.message : "Reset failed." });
    } finally {
      setBusy(null);
    }
  }

  async function importFile(file: File) {
    setBusy("import"); setMessage(null);
    try {
      const form = new FormData(); form.set("file", file);
      const res = await fetch("/api/sales/database-mapping/distributor-profiles/import", { method: "POST", body: form });
      const json = await res.json();
      if (!json.success) { setMessage({ type: "error", text: json.error ?? "Import failed." }); return; }
      setMessage({ type: "success", text: `Imported ${json.data.saved} mapping(s)${json.data.skipped ? `, skipped ${json.data.skipped}` : ""}.` });
      await load(true);
    } catch (e) {
      setMessage({ type: "error", text: e instanceof Error ? e.message : "Import failed." });
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  if (loading) {
    return <div className="flex items-center gap-2 p-6 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading distributor mappings…</div>;
  }

  return (
    <div className="space-y-5">
      <AdminTableShell
        action={(
          <div className="flex flex-wrap items-center gap-2">
            <Button className="gap-2" onClick={() => { window.location.href = "/api/sales/database-mapping/distributor-profiles/export"; }} variant="secondary">
              <Download className="h-4 w-4" /> Export XLSX
            </Button>
            <Button className="gap-2 bg-[#0B0B0B] text-white hover:bg-[#F97316]" disabled={busy === "import"} onClick={() => fileRef.current?.click()}>
              {busy === "import" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Import XLSX
            </Button>
            <input accept=".xlsx" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); }} ref={fileRef} type="file" />
          </div>
        )}
        description="Pick a distributor, then drag its real column headers onto each Phoenix field (or type one). Order = priority (first found wins). Region & Area are auto-derived from the Brick. Saved edits apply to the next upload."
        title="Distributor → Phoenix mapping (editable)"
      >
        <div className="space-y-5 p-4 md:p-5">
          {/* distributor picker */}
          <div className="flex flex-wrap gap-2">
            {profiles.map((p) => (
              <button
                className={cn("border px-3 py-1.5 text-xs font-bold", selected === p.distributorCode ? "border-[#0B0B0B] bg-[#0B0B0B] text-white" : "border-[#D8E0EA] bg-white text-[#0F172A] hover:border-[#F97316]")}
                key={p.distributorCode}
                onClick={() => selectDistributor(p.distributorCode)}
                type="button"
              >
                {p.distributorName} <span className="opacity-60">/ {p.distributorCode}</span>{p.isCustom ? <span className="ml-1 text-[#F97316]">●</span> : null}
              </button>
            ))}
          </div>

          {message ? (
            <AdminCallout tone={message.type === "success" ? "success" : "danger"}>
              {message.type === "success" ? <CheckCircle2 className="mt-0.5 h-4 w-4" /> : <X className="mt-0.5 h-4 w-4" />}
              <p>{message.text}</p>
            </AdminCallout>
          ) : null}

          {draft ? (
            <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
              {/* pool of real headers */}
              <div className="border border-[#E2E8F0] bg-[#F8FAFC] p-3">
                <p className="mb-2 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">{draft.distributorName} headers</p>
                {pool.length === 0 ? (
                  <p className="text-xs text-slate-400">No imported file seen yet for this distributor — type column names into the fields instead.</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {pool.map((h) => (
                      <span
                        className={cn(chip, "cursor-grab active:cursor-grabbing")}
                        draggable
                        key={h}
                        onDragStart={(e) => e.dataTransfer.setData("text/plain", h)}
                        title="Drag onto a Phoenix field"
                      >
                        {h}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-3 border-t border-[#E2E8F0] pt-3 text-[11px] text-slate-500">
                  <label className="flex items-center gap-2">
                    <input
                      checked={draft.valueSource === "sheet"}
                      onChange={(e) => setDraft({ ...draft, valueSource: e.target.checked ? "sheet" : "recompute" })}
                      type="checkbox"
                    />
                    Value taken from the sheet (else recomputed = Qty × factory price)
                  </label>
                </div>
              </div>

              {/* Phoenix fields */}
              <div className="grid gap-3 sm:grid-cols-2">
                {FIELDS.map((f) => (
                  <div
                    className="border border-[#E2E8F0] p-3"
                    key={f.key}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); addToField(f.key, e.dataTransfer.getData("text/plain")); }}
                  >
                    <p className="text-xs font-black text-[#0B0B0B]">{f.label}{f.hint ? <span className="ml-1 font-normal text-slate-400">— {f.hint}</span> : null}</p>
                    <div className="mt-2 flex min-h-[34px] flex-wrap gap-1.5">
                      {draft.fields[f.key].length === 0 ? (
                        <span className="text-xs italic text-slate-300">drag a header here</span>
                      ) : draft.fields[f.key].map((v, i) => (
                        <span className={chip} key={`${v}:${i}`}>
                          <span className="text-slate-400">{i + 1}.</span>{v}
                          <button className="text-slate-400 hover:text-[#F97316]" onClick={() => move(f.key, i, -1)} title="up" type="button"><ArrowUp className="h-3 w-3" /></button>
                          <button className="text-slate-400 hover:text-[#F97316]" onClick={() => move(f.key, i, 1)} title="down" type="button"><ArrowDown className="h-3 w-3" /></button>
                          <button className="text-slate-400 hover:text-red-500" onClick={() => removeFromField(f.key, i)} title="remove" type="button"><X className="h-3 w-3" /></button>
                        </span>
                      ))}
                    </div>
                    <div className="mt-2 flex items-center gap-1">
                      <input
                        className="h-7 flex-1 border border-[#D8E0EA] px-2 text-xs outline-none focus:border-[#F97316]"
                        onChange={(e) => setManual({ ...manual, [f.key]: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") { addToField(f.key, manual[f.key] ?? ""); setManual({ ...manual, [f.key]: "" }); } }}
                        placeholder="+ type a column"
                        value={manual[f.key] ?? ""}
                      />
                      <button className="border border-[#D8E0EA] p-1.5 hover:border-[#F97316]" onClick={() => { addToField(f.key, manual[f.key] ?? ""); setManual({ ...manual, [f.key]: "" }); }} type="button"><Plus className="h-3.5 w-3.5" /></button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {draft ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-[#E2E8F0] pt-4">
              <Button className="gap-2 bg-[#0B0B0B] text-white hover:bg-[#F97316]" disabled={saving} onClick={() => void save()}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save {draft.distributorName}
              </Button>
              <Button className="gap-2" disabled={busy === "reset" || !draft.isCustom} onClick={() => void resetToDefault()} variant="secondary">
                {busy === "reset" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Reset to default
              </Button>
              <span className="text-xs text-slate-400">● = custom mapping saved · changes affect the next upload only</span>
            </div>
          ) : null}
        </div>
      </AdminTableShell>
    </div>
  );
}
