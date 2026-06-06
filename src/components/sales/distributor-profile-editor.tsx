"use client";

import { CheckCircle2, Download, Loader2, Plus, RotateCcw, Save, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AdminCallout, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Phoenix target fields — EACH holds ONE column, in the exact order/labels of the exported workbook.
const FIELDS: { key: FieldKey; label: string }[] = [
  { key: "productCodeColumns", label: "Product Code" },
  { key: "productNameColumns", label: "Product Name" },
  { key: "qtyColumns", label: "Quantity" },
  { key: "branchCodeColumns", label: "Branch Code" },
  { key: "branchNameColumns", label: "Branch Name" },
  { key: "bonusColumns", label: "Bonus Qty" },
  { key: "valueColumns", label: "Value" },
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

// Collapse each field to at most ONE column (one box per field).
function oneToOne(fields: Record<FieldKey, string[]>): Record<FieldKey, string[]> {
  const out = {} as Record<FieldKey, string[]>;
  for (const f of FIELDS) out[f.key] = (fields[f.key] ?? []).slice(0, 1);
  return out;
}

export function DistributorProfileEditor() {
  const [profiles, setProfiles] = useState<EditableProfile[]>([]);
  const [headers, setHeaders] = useState<Record<string, string[]>>({});
  const [selected, setSelected] = useState<string>("");
  const [draft, setDraft] = useState<EditableProfile | null>(null);
  const [armed, setArmed] = useState<string | null>(null); // header "picked up" by click
  const [custom, setCustom] = useState("");
  const [customAdded, setCustomAdded] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<"reset" | "import" | null>(null);
  const [message, setMessage] = useState<{ text: string; type: "error" | "success" } | null>(null);
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
      setDraft(found ? { ...found, fields: oneToOne(found.fields) } : null);
      setCustomAdded([]); setArmed(null);
    } catch (e) {
      setMessage({ type: "error", text: e instanceof Error ? e.message : "Failed to load mappings." });
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(() => { void load(false); }, []);

  function selectDistributor(code: string) {
    setSelected(code);
    const found = profiles.find((p) => p.distributorCode === code) ?? null;
    setDraft(found ? { ...found, fields: oneToOne(found.fields) } : null);
    setCustomAdded([]); setArmed(null); setMessage(null);
  }

  // Pool = the distributor's real headers (+ any custom + anything already placed) MINUS what's assigned.
  const pool = useMemo(() => {
    if (!draft) return [];
    const assigned = new Set(FIELDS.flatMap((f) => draft.fields[f.key]));
    const universe = new Set<string>();
    (headers[selected] ?? []).forEach((h) => universe.add(h));
    customAdded.forEach((h) => universe.add(h));
    FIELDS.forEach((f) => draft.fields[f.key].forEach((v) => universe.add(v)));
    return [...universe].filter((h) => !assigned.has(h)).sort((a, b) => a.localeCompare(b));
  }, [draft, headers, selected, customAdded]);

  function assign(key: FieldKey, header: string) {
    if (!draft || !header) return;
    const next = { ...draft.fields };
    for (const f of FIELDS) next[f.key] = next[f.key].filter((v) => v !== header); // header lives in one place only
    next[key] = [header]; // one box per field (replaces whatever was there -> it returns to the pool)
    setDraft({ ...draft, fields: next });
    setArmed(null);
  }
  function clearField(key: FieldKey) {
    if (!draft) return;
    setDraft({ ...draft, fields: { ...draft.fields, [key]: [] } });
  }
  function addCustom() {
    const v = custom.trim();
    if (!v) return;
    if (!customAdded.includes(v)) setCustomAdded([...customAdded, v]);
    setCustom("");
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
      setMessage({ type: "success", text: `Saved ${draft.distributorName}. Re-upload that distributor's file to apply it.` });
      await load(true);
    } catch (e) {
      setMessage({ type: "error", text: e instanceof Error ? e.message : "Save failed." });
    } finally { setSaving(false); }
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
    } finally { setBusy(null); }
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
    } finally { setBusy(null); if (fileRef.current) fileRef.current.value = ""; }
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
        description="Pick a distributor, then drag its column onto a Phoenix field — or click the column, then click the field. Each field takes exactly ONE column; a placed column leaves the list."
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
            <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
              {/* LEFT: sticky pool of this distributor's real headers */}
              <div className="lg:sticky lg:top-4 self-start border border-[#E2E8F0] bg-[#F8FAFC] p-3">
                <p className="mb-1 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">{draft.distributorName} columns</p>
                <p className="mb-2 text-[11px] text-slate-400">{armed ? `“${armed}” picked up — click a field to drop it.` : "Drag onto a field, or click a column then click a field."}</p>
                {pool.length === 0 ? (
                  <p className="text-xs text-slate-400">All columns placed (or none imported yet — add one below).</p>
                ) : (
                  <div className="flex max-h-[420px] flex-wrap gap-1.5 overflow-auto">
                    {pool.map((h) => (
                      <button
                        className={cn("inline-flex cursor-grab items-center border px-2 py-1 text-xs font-semibold active:cursor-grabbing", armed === h ? "border-[#F97316] bg-orange-50 text-[#9A3412]" : "border-[#D8E0EA] bg-white text-[#0F172A] hover:border-[#F97316]")}
                        draggable
                        key={h}
                        onClick={() => setArmed(armed === h ? null : h)}
                        onDragStart={(e) => e.dataTransfer.setData("text/plain", h)}
                        type="button"
                      >
                        {h}
                      </button>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex items-center gap-1 border-t border-[#E2E8F0] pt-3">
                  <input
                    className="h-7 flex-1 border border-[#D8E0EA] px-2 text-xs outline-none focus:border-[#F97316]"
                    onChange={(e) => setCustom(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") addCustom(); }}
                    placeholder="+ add a column name"
                    value={custom}
                  />
                  <button className="border border-[#D8E0EA] p-1.5 hover:border-[#F97316]" onClick={addCustom} type="button"><Plus className="h-3.5 w-3.5" /></button>
                </div>
                <label className="mt-3 flex items-center gap-2 border-t border-[#E2E8F0] pt-3 text-[11px] text-slate-500">
                  <input checked={draft.valueSource === "sheet"} onChange={(e) => setDraft({ ...draft, valueSource: e.target.checked ? "sheet" : "recompute" })} type="checkbox" />
                  Value taken from the sheet (else recomputed)
                </label>
              </div>

              {/* RIGHT: one slot per Phoenix field */}
              <div className="space-y-1.5">
                {FIELDS.map((f) => {
                  const val = draft.fields[f.key][0];
                  return (
                    <div
                      className={cn("flex items-center justify-between gap-3 border px-3 py-2", val ? "border-[#E2E8F0] bg-white" : armed ? "border-dashed border-[#F97316] bg-orange-50/40 cursor-pointer" : "border-dashed border-[#D8E0EA] bg-[#FCFDFE]")}
                      key={f.key}
                      onClick={() => { if (armed) assign(f.key, armed); }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => { e.preventDefault(); assign(f.key, e.dataTransfer.getData("text/plain")); }}
                    >
                      <span className="text-xs font-black text-[#0B0B0B]">{f.label}</span>
                      {val ? (
                        <span className="inline-flex items-center gap-2 border border-[#D8E0EA] bg-[#F8FAFC] px-2 py-1 text-xs font-semibold text-[#0F172A]">
                          {val}
                          <button className="text-slate-400 hover:text-red-500" onClick={(e) => { e.stopPropagation(); clearField(f.key); }} title="remove" type="button"><X className="h-3 w-3" /></button>
                        </span>
                      ) : (
                        <span className="text-xs italic text-slate-300">{armed ? "click to place here" : "drop a column"}</span>
                      )}
                    </div>
                  );
                })}
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
