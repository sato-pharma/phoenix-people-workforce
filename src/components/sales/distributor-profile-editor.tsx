"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileSearch, Loader2, Plus, RotateCcw, Save } from "lucide-react";

import { AdminCallout, AdminPageHero } from "@/components/admin/admin-design-system";
import { MappingAuditHistory } from "@/components/sales/mapping-audit-history";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { EditableProfile, ProfileFieldKey } from "@/lib/sales/normalizer/distributor-profile-store";
import { FREE_GOODS_FLAG_HINT, FREE_GOODS_FLAG_LABEL } from "@/lib/sales/normalizer/free-goods-flag";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";

// Field labels mirror PROFILE_FIELDS in the (server-only) store — duplicated here so this client
// component never imports the server module. Order matches the editor form + the DB columns.
// A `hint` renders under the label, above the input.
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
  // A free-goods FLAG that drops the whole row, never a bonus count: a saved mapping replaces the
  // built-in one whole, so a bonus count typed here would drop paid units (free-goods-flag.ts).
  { key: "bonusColumns", label: FREE_GOODS_FLAG_LABEL, hint: FREE_GOODS_FLAG_HINT },
  { key: "areaIdColumns", label: "Area / Territory" },
  { key: "brickIdColumns", label: "Brick ID" },
  { key: "branchCodeColumns", label: "Branch Code" },
  { key: "branchNameColumns", label: "Branch Name" },
  { key: "areaNameColumns", label: "Area Name" },
  { key: "brickNameColumns", label: "Brick Name" },
  { key: "regionColumns", label: "Region" },
];

const NEW = "__new__";
const card = "rounded-[6px] border border-phx-line bg-white shadow-sm";

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

  // ── live alias preview (does this file actually contain my configured aliases?) ─────────────────
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Partial<Record<ProfileFieldKey, { foundAlias: string | null; status: "found" | "missing" | "empty" }>>>({});

  const isNew = selected === NEW;
  const current = useMemo(() => profiles.find((p) => p.distributorCode === selected) ?? null, [profiles, selected]);

  function clearPreview() {
    setPreview({}); setPreviewError(null); setPreviewFile(null);
  }

  function pick(code: string) {
    setSelected(code); setMsg(null); setError(null); clearPreview();
    if (code === NEW) { setDraft(emptyDraft()); return; }
    const p = profiles.find((x) => x.distributorCode === code);
    setDraft(p ? toDraft(p) : emptyDraft());
  }

  async function runPreview() {
    if (!previewFile) return;
    setPreviewing(true); setPreviewError(null);
    try {
      const fields = FIELDS.map((f) => ({ key: f.key, label: f.label, aliases: splitCols(draft.fields[f.key]) }));
      const fd = new FormData();
      fd.set("fields", JSON.stringify(fields));
      fd.set("file", previewFile);
      const res = await fetch("/api/sales/database-mapping/profile/preview", { method: "POST", body: fd });
      const payload = (await res.json()) as { success?: boolean; error?: string; fields?: { key: ProfileFieldKey; foundAlias: string | null; status: "found" | "missing" | "empty" }[] };
      if (!payload.success) { setPreviewError(payload.error ?? "Preview failed."); return; }
      const map: Partial<Record<ProfileFieldKey, { foundAlias: string | null; status: "found" | "missing" | "empty" }>> = {};
      for (const f of payload.fields ?? []) map[f.key] = { foundAlias: f.foundAlias, status: f.status };
      setPreview(map);
    } catch (e) { setPreviewError(e instanceof Error ? e.message : "Preview failed."); }
    finally { setPreviewing(false); }
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
            <span className="text-phx-sm font-black uppercase tracking-[0.12em] text-phx-ink-faint">Distributor</span>
            <select className={`${phxSelectClassName} min-w-64`} onChange={(e) => pick(e.target.value)} value={selected}>
              {profiles.map((p) => (
                <option key={p.distributorCode} value={p.distributorCode}>{p.distributorName} ({p.distributorCode}){p.isCustom ? " · edited" : ""}</option>
              ))}
              <option value={NEW}>➕ New distributor…</option>
            </select>
          </label>
          {current?.isCustom ? <span className="mb-1.5 inline-flex items-center gap-1 rounded-full border border-phx-warn-line bg-phx-warn-bg px-2.5 py-0.5 text-phx-xs font-bold text-phx-warn">Overridden in-app</span> : !isNew ? <span className="mb-1.5 inline-flex items-center gap-1 rounded-full border border-phx-line bg-[#FCFDFE] px-2.5 py-0.5 text-phx-xs font-bold text-phx-ink-soft">Built-in</span> : null}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-phx-sm font-black uppercase tracking-[0.12em] text-phx-ink-faint">Code</span>
            <input className={cn(phxFieldClassName, "font-mono")} disabled={!isNew} onChange={(e) => setDraft((d) => ({ ...d, distributorCode: e.target.value.toUpperCase() }))} placeholder="e.g. NEW-DIST" value={draft.distributorCode} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-phx-sm font-black uppercase tracking-[0.12em] text-phx-ink-faint">Name</span>
            <input className={phxFieldClassName} onChange={(e) => setDraft((d) => ({ ...d, distributorName: e.target.value }))} value={draft.distributorName} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-phx-sm font-black uppercase tracking-[0.12em] text-phx-ink-faint">Value source</span>
            <select className={phxSelectClassName} onChange={(e) => setDraft((d) => ({ ...d, valueSource: e.target.value === "sheet" ? "sheet" : "recompute" }))} value={draft.valueSource}>
              <option value="recompute">recompute (qty × master price)</option>
              <option value="sheet">sheet (value column)</option>
            </select>
          </label>
        </div>

        <label className="flex items-center gap-2 text-sm font-semibold text-phx-ink">
          <input checked={draft.regionOnly} className="h-4 w-4 accent-phx-accent" onChange={(e) => setDraft((d) => ({ ...d, regionOnly: e.target.checked }))} type="checkbox" />
          Region-only (resolving to region/area without a brick is expected)
        </label>

        <div className="rounded-[6px] border border-dashed border-phx-line-strong bg-[#FCFDFE] p-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-phx-sm font-black uppercase tracking-[0.12em] text-phx-ink-faint">Sample file (.xlsx)</span>
              <input accept=".xlsx" className="text-xs" onChange={(e) => setPreviewFile(e.target.files?.[0] ?? null)} type="file" />
            </label>
            <button className="inline-flex h-9 items-center gap-2 rounded-[6px] border border-phx-line bg-white px-4 text-sm font-black text-phx-ink transition hover:border-phx-accent disabled:opacity-60" disabled={previewing || !previewFile} onClick={() => void runPreview()} type="button">
              {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSearch className="h-4 w-4" />}
              Check aliases against file
            </button>
          </div>
          <p className="mt-2 text-phx-xs text-phx-ink-faint">Reads your sample file&rsquo;s header row and flags, per field, whether any of your aliases is found. The file is not stored.</p>
          {previewError ? <p className="mt-1 text-phx-xs font-semibold text-amber-700">{previewError}</p> : null}
        </div>

        <div className="rounded-[6px] border border-phx-line">
          <div className="bg-[#020617] px-3 py-2 text-xs font-black uppercase tracking-wide text-white">Column aliases — comma-separated header titles the file may use</div>
          <div className="grid grid-cols-1 gap-px bg-phx-line sm:grid-cols-2">
            {FIELDS.map((f) => {
              const obs = preview[f.key];
              return (
              <label className="flex flex-col gap-1 bg-white px-3 py-2" key={f.key}>
                <span className="text-phx-xs font-bold text-phx-ink-2">{f.label}</span>
                {f.hint ? <span className="text-phx-sm font-semibold leading-snug text-phx-warn">{f.hint}</span> : null}
                <input className={cn(phxFieldClassName, "font-mono")} onChange={(e) => setField(f.key, e.target.value)} placeholder="—" value={draft.fields[f.key]} />
                {obs && obs.status !== "empty" ? (
                  obs.status === "found"
                    ? <span className="break-words text-phx-sm font-semibold text-emerald-700">✓ found &ldquo;{obs.foundAlias}&rdquo; in file</span>
                    : <span className="break-words text-phx-sm font-bold text-amber-700">✗ none of these aliases is in the file</span>
                ) : null}
              </label>
              );
            })}
          </div>
        </div>

        {error ? <AdminCallout tone="danger"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></AdminCallout> : null}
        {msg ? <AdminCallout tone="success"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>{msg}</span></AdminCallout> : null}

        <div className="flex flex-wrap items-center gap-3">
          <button className="inline-flex h-10 items-center gap-2 rounded-[6px] bg-phx-accent px-5 text-sm font-black text-white transition hover:bg-[#EA6A0C] disabled:bg-phx-line-strong" disabled={busy !== null} onClick={() => void save()} type="button">
            {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : isNew ? <Plus className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {isNew ? "Create distributor mapping" : "Save mapping"}
          </button>
          {!isNew && current?.isCustom ? (
            <button className="inline-flex h-10 items-center gap-2 rounded-[6px] border border-phx-line bg-white px-4 text-sm font-black text-phx-ink transition hover:border-phx-accent disabled:opacity-60" disabled={busy !== null} onClick={() => void reset()} type="button">
              {busy === "reset" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              Reset to built-in
            </button>
          ) : null}
        </div>
        <p className="text-xs text-phx-ink-faint">Required to save: a Product Code or Name, a Quantity, and a location (Customer Code, Area/Territory, or Brick ID). &ldquo;sheet&rdquo; value source also needs a Value column.</p>

        <MappingAuditHistory distributorCode={isNew ? null : draft.distributorCode} entityType="distributor_profile" />
      </Card>
    </div>
  );
}
