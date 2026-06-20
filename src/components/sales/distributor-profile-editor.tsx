"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Plus, RotateCcw, Save } from "lucide-react";

import { AdminCallout, AdminPageHero } from "@/components/admin/admin-design-system";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { EditableProfile, ProfileFieldKey } from "@/lib/sales/normalizer/distributor-profile-store";

// Field labels mirror PROFILE_FIELDS in the (server-only) store — duplicated here so this client
// component never imports the server module. Order matches the editor form + the DB columns.
const FIELDS: { key: ProfileFieldKey; label: string; hint?: string }[] = [
  { key: "productCodeColumns", label: "Product Code" },
  { key: "productNameColumns", label: "Product Name" },
  { key: "qtyColumns", label: "Quantity" },
  { key: "customerCodeColumns", label: "Customer Code" },
  { key: "customerNameColumns", label: "Customer Name" },
  { key: "customerAddressColumns", label: "Customer Address" },
  { key: "dateColumns", label: "Invoice Date" },
  { key: "valueColumns", label: "Value" },
  { key: "discountColumns", label: "Discount %" },
  { key: "bonusColumns", label: "Bonus Qty" },
  { key: "areaIdColumns", label: "Area / Territory" },
  { key: "brickIdColumns", label: "Brick ID" },
  { key: "branchCodeColumns", label: "Branch Code" },
  { key: "branchNameColumns", label: "Branch Name" },
  { key: "areaNameColumns", label: "Area Name" },
  { key: "brickNameColumns", label: "Brick Name" },
  { key: "regionColumns", label: "Region" },
];

const NEW = "__new__";
const card = "rounded-[6px] border border-[#E2E8F0] bg-white shadow-sm";

type Draft = {
  distributorCode: string;
  distributorName: string;
  valueSource: "recompute" | "sheet";
  regionOnly: boolean;
  fields: Record<ProfileFieldKey, string>; // comma-separated for the inputs
};

function toDraft(p: EditableProfile): Draft {
  const fields = {} as Record<ProfileFieldKey, string>;
  for (const f of FIELDS) fields[f.key] = (p.fields[f.key] ?? []).join(", ");
  return { distributorCode: p.distributorCode, distributorName: p.distributorName, valueSource: p.valueSource, regionOnly: p.regionOnly, fields };
}

function emptyDraft(): Draft {
  const fields = {} as Record<ProfileFieldKey, string>;
  for (const f of FIELDS) fields[f.key] = "";
  return { distributorCode: "", distributorName: "", valueSource: "recompute", regionOnly: false, fields };
}

function splitCols(value: string): string[] {
  return [...new Set(value.split(",").map((s) => s.trim()).filter(Boolean))];
}

export function DistributorProfileEditor({ initialProfiles }: { initialProfiles: EditableProfile[] }) {
  const [profiles, setProfiles] = useState<EditableProfile[]>(initialProfiles);
  const [selected, setSelected] = useState<string>(initialProfiles[0]?.distributorCode ?? NEW);
  const [draft, setDraft] = useState<Draft>(initialProfiles[0] ? toDraft(initialProfiles[0]) : emptyDraft());
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isNew = selected === NEW;
  const current = useMemo(() => profiles.find((p) => p.distributorCode === selected) ?? null, [profiles, selected]);

  function pick(code: string) {
    setSelected(code); setMsg(null); setError(null);
    if (code === NEW) { setDraft(emptyDraft()); return; }
    const p = profiles.find((x) => x.distributorCode === code);
    setDraft(p ? toDraft(p) : emptyDraft());
  }

  function setField(key: ProfileFieldKey, value: string) {
    setDraft((d) => ({ ...d, fields: { ...d.fields, [key]: value } }));
  }

  async function refetch() {
    try {
      const res = await fetch("/api/sales/database-mapping/profile");
      const payload = (await res.json()) as { success?: boolean; profiles?: EditableProfile[] };
      if (payload.success && payload.profiles) setProfiles(payload.profiles);
    } catch { /* list refresh is best-effort */ }
  }

  async function save() {
    setBusy("save"); setMsg(null); setError(null);
    try {
      const profile = {
        distributorCode: draft.distributorCode,
        distributorName: draft.distributorName,
        valueSource: draft.valueSource,
        regionOnly: draft.regionOnly,
        fields: Object.fromEntries(FIELDS.map((f) => [f.key, splitCols(draft.fields[f.key])])) as Record<ProfileFieldKey, string[]>,
      };
      const res = await fetch("/api/sales/database-mapping/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", profile }) });
      const payload = (await res.json()) as { success?: boolean; message?: string; error?: string };
      if (!payload.success) { setError(payload.error ?? "Save failed."); return; }
      setMsg(payload.message ?? "Saved.");
      await refetch();
      setSelected(profile.distributorCode);
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed."); }
    finally { setBusy(null); }
  }

  async function reset() {
    if (isNew) return;
    setBusy("reset"); setMsg(null); setError(null);
    try {
      const res = await fetch("/api/sales/database-mapping/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reset", distributorCode: draft.distributorCode }) });
      const payload = (await res.json()) as { success?: boolean; message?: string; error?: string };
      if (!payload.success) { setError(payload.error ?? "Reset failed."); return; }
      setMsg(payload.message ?? "Reset to built-in.");
      await refetch();
    } catch (e) { setError(e instanceof Error ? e.message : "Reset failed."); }
    finally { setBusy(null); }
  }

  return (
    <div className="space-y-5">
      <AdminPageHero
        description="Edit how the system reads each distributor's monthly (Source of Sales) file, or onboard a new distributor — without a code deploy. A saved mapping fully overrides the built-in one for that distributor; reset returns it to built-in."
        eyebrow="Sales Operations · Column mapping"
        icon={<Save className="h-4 w-4" />}
        title="Distributor Column Mapping"
      />

      <Card className={cn(card, "space-y-4 p-5")}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Distributor</span>
            <select className="h-9 min-w-64 rounded-[6px] border border-[#E2E8F0] px-2 text-sm" onChange={(e) => pick(e.target.value)} value={selected}>
              {profiles.map((p) => (
                <option key={p.distributorCode} value={p.distributorCode}>{p.distributorName} ({p.distributorCode}){p.isCustom ? " · edited" : ""}</option>
              ))}
              <option value={NEW}>➕ New distributor…</option>
            </select>
          </label>
          {current?.isCustom ? <span className="mb-1.5 inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-bold text-amber-800">Overridden in-app</span> : !isNew ? <span className="mb-1.5 inline-flex items-center gap-1 rounded-full border border-[#E2E8F0] bg-[#FCFDFE] px-2.5 py-0.5 text-[11px] font-bold text-[#64748B]">Built-in</span> : null}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Code</span>
            <input className="h-9 rounded-[6px] border border-[#E2E8F0] px-2 text-sm font-mono disabled:bg-[#F1F5F9]" disabled={!isNew} onChange={(e) => setDraft((d) => ({ ...d, distributorCode: e.target.value.toUpperCase() }))} placeholder="e.g. NEW-DIST" value={draft.distributorCode} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Name</span>
            <input className="h-9 rounded-[6px] border border-[#E2E8F0] px-2 text-sm" onChange={(e) => setDraft((d) => ({ ...d, distributorName: e.target.value }))} value={draft.distributorName} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-black uppercase tracking-[0.12em] text-[#94A3B8]">Value source</span>
            <select className="h-9 rounded-[6px] border border-[#E2E8F0] px-2 text-sm" onChange={(e) => setDraft((d) => ({ ...d, valueSource: e.target.value === "sheet" ? "sheet" : "recompute" }))} value={draft.valueSource}>
              <option value="recompute">recompute (qty × master price)</option>
              <option value="sheet">sheet (value column)</option>
            </select>
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm font-semibold text-[#0F172A]">
          <input checked={draft.regionOnly} className="h-4 w-4 accent-[#F97316]" onChange={(e) => setDraft((d) => ({ ...d, regionOnly: e.target.checked }))} type="checkbox" />
          Region-only (resolving to region/area without a brick is expected)
        </label>

        <div className="rounded-[6px] border border-[#E2E8F0]">
          <div className="bg-[#020617] px-3 py-2 text-xs font-black uppercase tracking-wide text-white">Column aliases — comma-separated header titles the file may use</div>
          <div className="grid grid-cols-1 gap-px bg-[#E2E8F0] sm:grid-cols-2">
            {FIELDS.map((f) => (
              <label className="flex flex-col gap-1 bg-white px-3 py-2" key={f.key}>
                <span className="text-[11px] font-bold text-[#475569]">{f.label}</span>
                <input className="h-8 rounded-[6px] border border-[#E2E8F0] px-2 text-xs font-mono" onChange={(e) => setField(f.key, e.target.value)} placeholder="—" value={draft.fields[f.key]} />
              </label>
            ))}
          </div>
        </div>

        {error ? <AdminCallout tone="danger"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></AdminCallout> : null}
        {msg ? <AdminCallout tone="success"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>{msg}</span></AdminCallout> : null}

        <div className="flex flex-wrap items-center gap-3">
          <button className="inline-flex h-10 items-center gap-2 rounded-[6px] bg-[#F97316] px-5 text-sm font-black text-white transition hover:bg-[#EA6A0C] disabled:bg-[#CBD5E1]" disabled={busy !== null} onClick={() => void save()} type="button">
            {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : isNew ? <Plus className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {isNew ? "Create distributor mapping" : "Save mapping"}
          </button>
          {!isNew && current?.isCustom ? (
            <button className="inline-flex h-10 items-center gap-2 rounded-[6px] border border-[#E2E8F0] bg-white px-4 text-sm font-black text-[#0F172A] transition hover:border-[#F97316] disabled:opacity-60" disabled={busy !== null} onClick={() => void reset()} type="button">
              {busy === "reset" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              Reset to built-in
            </button>
          ) : null}
        </div>
        <p className="text-xs text-[#94A3B8]">Required to save: a Product Code or Name, a Quantity, and a location (Customer Code, Area/Territory, or Brick ID). &ldquo;sheet&rdquo; value source also needs a Value column.</p>
      </Card>
    </div>
  );
}
