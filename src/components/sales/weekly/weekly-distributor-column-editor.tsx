"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileSearch, Info, Loader2, Lock, RotateCcw, Save } from "lucide-react";

import { AdminCallout, AdminPageHero } from "@/components/admin/admin-design-system";
import { MappingAuditHistory } from "@/components/sales/mapping-audit-history";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { WeeklyContractSheet, WeeklyDistributorContract } from "@/lib/sales/weekly/column-contract";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";

// The editor edits an in-memory copy of the resolved contract. Only column indices and the header-row
// number are editable; sheet role / file slot / field set / field semantics / the PS matrix blocks are
// fixed in code (the server rejects any structural change). Types come from the PURE column-contract
// module so this client component never pulls in the server-only store.

type EditableContract = WeeklyDistributorContract & { isCustom: boolean };

const card = "rounded-[6px] border border-phx-line bg-white shadow-sm";

const ROLE_LABEL: Record<string, string> = {
  combined: "Sales + Stock (one sheet)",
  sales: "Sales",
  returns: "Returns",
  stock: "Stock",
};

const FILE_LABEL: Record<string, string> = {
  file: "single file",
  salesFile: "sales file",
  stockFile: "stock file",
};

function clone(contract: EditableContract): EditableContract {
  return structuredClone(contract);
}

export function WeeklyDistributorColumnEditor({ initialContracts }: { initialContracts: EditableContract[] }) {
  const [contracts, setContracts] = useState<EditableContract[]>(initialContracts);
  const [selected, setSelected] = useState<string>(initialContracts[0]?.code ?? "");
  const [draft, setDraft] = useState<EditableContract | null>(initialContracts[0] ? clone(initialContracts[0]) : null);
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── live header preview ──────────────────────────────────────────────────────────────────────
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [previewSalesFile, setPreviewSalesFile] = useState<File | null>(null);
  const [previewStockFile, setPreviewStockFile] = useState<File | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<string, { observedHeader: string; status: "filled" | "empty" }>>({});

  const current = useMemo(() => contracts.find((c) => c.code === selected) ?? null, [contracts, selected]);

  function clearPreview() {
    setPreview({}); setPreviewError(null); setPreviewFile(null); setPreviewSalesFile(null); setPreviewStockFile(null);
  }

  function pick(code: string) {
    setSelected(code); setMsg(null); setError(null); clearPreview();
    const c = contracts.find((x) => x.code === code);
    setDraft(c ? clone(c) : null);
  }

  async function runPreview() {
    if (!draft) return;
    setPreviewing(true); setPreviewError(null);
    try {
      const fd = new FormData();
      fd.set("distributorCode", draft.code);
      fd.set("sheets", JSON.stringify(draft.sheets));
      if (draft.splitFiles) {
        if (previewSalesFile) fd.set("salesFile", previewSalesFile);
        if (previewStockFile) fd.set("stockFile", previewStockFile);
      } else if (previewFile) {
        fd.set("file", previewFile);
      }
      const res = await fetch("/api/sales/database-mapping/weekly-profile/preview", { method: "POST", body: fd });
      const payload = (await res.json()) as { success?: boolean; error?: string; columns?: { sheetRole: string; field: string; observedHeader: string; status: "filled" | "empty" }[]; missingFiles?: string[]; missingSheets?: string[] };
      if (!payload.success) { setPreviewError(payload.error ?? "Preview failed."); return; }
      const map: Record<string, { observedHeader: string; status: "filled" | "empty" }> = {};
      for (const c of payload.columns ?? []) map[`${c.sheetRole}|${c.field}`] = { observedHeader: c.observedHeader, status: c.status };
      setPreview(map);
      const notes: string[] = [];
      if (payload.missingSheets?.length) notes.push(`This file has no ${payload.missingSheets.join(" or ")} sheet, so the import would read nothing from it.`);
      if (payload.missingFiles?.length) notes.push(`Attach the ${payload.missingFiles.join(" + ")} file to preview those sheets too.`);
      if (notes.length) setPreviewError(notes.join(" "));
    } catch (e) { setPreviewError(e instanceof Error ? e.message : "Preview failed."); }
    finally { setPreviewing(false); }
  }

  function setColumnIndex(sheetIdx: number, fieldIdx: number, value: string) {
    setDraft((d) => {
      if (!d) return d;
      const next = clone(d);
      const parsed = Number.parseInt(value, 10);
      next.sheets[sheetIdx].fields[fieldIdx].columnIndex = Number.isFinite(parsed) ? parsed : 0;
      return next;
    });
  }

  function setHeaderRow(sheetIdx: number, value: string) {
    setDraft((d) => {
      if (!d) return d;
      const next = clone(d);
      const parsed = Number.parseInt(value, 10);
      next.sheets[sheetIdx].headerRowNumber = parsed === 2 ? 2 : 1;
      return next;
    });
  }

  async function refetch() {
    try {
      const res = await fetch("/api/sales/database-mapping/weekly-profile");
      const payload = (await res.json()) as { success?: boolean; contracts?: EditableContract[] };
      if (payload.success && payload.contracts) setContracts(payload.contracts);
    } catch { /* list refresh is best-effort */ }
  }

  async function save() {
    if (!draft) return;
    setBusy("save"); setMsg(null); setError(null);
    try {
      const profile = { distributorCode: draft.code, distributorName: draft.name, splitFiles: draft.splitFiles, sheets: draft.sheets };
      const res = await fetch("/api/sales/database-mapping/weekly-profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "save", profile }) });
      const payload = (await res.json()) as { success?: boolean; message?: string; error?: string };
      if (!payload.success) { setError(payload.error ?? "Save failed."); return; }
      setMsg(payload.message ?? "Saved.");
      await refetch();
      setSelected(draft.code);
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed."); }
    finally { setBusy(null); }
  }

  async function reset() {
    if (!draft) return;
    setBusy("reset"); setMsg(null); setError(null);
    try {
      const res = await fetch("/api/sales/database-mapping/weekly-profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reset", distributorCode: draft.code }) });
      const payload = (await res.json()) as { success?: boolean; message?: string; error?: string };
      if (!payload.success) { setError(payload.error ?? "Reset failed."); return; }
      setMsg(payload.message ?? "Reset to built-in.");
      await refetch();
      const fresh = (await (await fetch("/api/sales/database-mapping/weekly-profile")).json()) as { contracts?: EditableContract[] };
      const reverted = fresh.contracts?.find((c) => c.code === draft.code);
      if (reverted) setDraft(clone(reverted));
    } catch (e) { setError(e instanceof Error ? e.message : "Reset failed."); }
    finally { setBusy(null); }
  }

  return (
    <div className="space-y-5">
      <AdminPageHero
        description="Adjust which spreadsheet column the weekly importer reads for each field — for example when a distributor moves a column. Saving changes how files are actually imported (and the pre-upload verification), with no code deploy. Only column numbers and the header row are editable; the sheet layout and the Overseas (PS) branch/location blocks are fixed in code."
        eyebrow="Weekly Sales · Column mapping"
        icon={<Save className="h-4 w-4" />}
        title="Weekly Distributor Column Editor"
      />

      <Card className={cn(card, "space-y-4 p-5")}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Distributor</span>
            <select className={cn(phxSelectClassName, "h-9 w-full sm:w-64")} onChange={(e) => pick(e.target.value)} value={selected}>
              {contracts.map((c) => (
                <option key={c.code} value={c.code}>{c.name}{c.isCustom ? " · edited" : ""}</option>
              ))}
            </select>
          </label>
          {current?.isCustom ? <span className="mb-1.5 inline-flex items-center gap-1 rounded-full border border-phx-warn-line bg-phx-warn-bg px-2.5 py-0.5 text-phx-xs font-bold text-phx-warn">Overridden in-app</span> : current ? <span className="mb-1.5 inline-flex items-center gap-1 rounded-full border border-phx-line bg-[#FCFDFE] px-2.5 py-0.5 text-phx-xs font-bold text-phx-ink-soft">Built-in</span> : null}
          {draft?.splitFiles ? <span className="mb-1.5 inline-flex items-center gap-1 rounded-full border border-phx-line bg-[#FCFDFE] px-2.5 py-0.5 text-phx-xs font-bold text-phx-ink-soft">Two files (sales + stock)</span> : null}
        </div>

        <AdminCallout tone="neutral">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Column numbers are 1-based (column A = 1, B = 2, …). A change here applies to the next upload — there is no need to re-deploy. To undo, use <strong>Reset to built-in</strong>.</span>
        </AdminCallout>

        {draft ? (
          <div className="rounded-[6px] border border-dashed border-phx-line-strong bg-[#FCFDFE] p-3">
            <div className="flex flex-wrap items-end gap-3">
              {draft.splitFiles ? (
                <>
                  <label className="flex flex-col gap-1">
                    <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Sample sales file (.xlsx)</span>
                    <input accept=".xlsx" className="text-xs" onChange={(e) => setPreviewSalesFile(e.target.files?.[0] ?? null)} type="file" />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Sample stock file (.xlsx)</span>
                    <input accept=".xlsx" className="text-xs" onChange={(e) => setPreviewStockFile(e.target.files?.[0] ?? null)} type="file" />
                  </label>
                </>
              ) : (
                <label className="flex flex-col gap-1">
                  <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-phx-ink-faint">Sample file (.xlsx)</span>
                  <input accept=".xlsx" className="text-xs" onChange={(e) => setPreviewFile(e.target.files?.[0] ?? null)} type="file" />
                </label>
              )}
              <button className="inline-flex h-9 items-center gap-2 rounded-[6px] border border-phx-line bg-white px-4 text-sm font-black text-phx-ink transition hover:border-phx-accent disabled:opacity-60" disabled={previewing || (draft.splitFiles ? !previewSalesFile && !previewStockFile : !previewFile)} onClick={() => void runPreview()} type="button">
                {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSearch className="h-4 w-4" />}
                Preview columns from file
              </button>
            </div>
            <p className="mt-2 text-phx-xs text-phx-ink-faint">Reads each column&rsquo;s header from your sample file so you can confirm a column number points at the right field before saving. The file is not stored.</p>
            {previewError ? <p className="mt-1 text-phx-xs font-semibold text-amber-700">{previewError}</p> : null}
          </div>
        ) : null}

        {!draft ? (
          <p className="text-sm text-phx-ink-soft">No weekly distributor selected.</p>
        ) : (
          <div className="space-y-4">
            {draft.sheets.map((sheet, sheetIdx) => (
              <SheetEditor
                key={`${sheet.role}-${sheetIdx}`}
                sheet={sheet}
                preview={preview}
                onColumnIndex={(fieldIdx, value) => setColumnIndex(sheetIdx, fieldIdx, value)}
                onHeaderRow={(value) => setHeaderRow(sheetIdx, value)}
              />
            ))}
          </div>
        )}

        {error ? <AdminCallout tone="danger"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></AdminCallout> : null}
        {msg ? <AdminCallout tone="success"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>{msg}</span></AdminCallout> : null}

        <div className="flex flex-wrap items-center gap-3">
          <button className="inline-flex h-10 items-center gap-2 rounded-[6px] bg-phx-accent px-5 text-sm font-black text-white transition hover:bg-[#EA6A0C] disabled:bg-phx-line-strong" disabled={busy !== null || !draft} onClick={() => void save()} type="button">
            {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save mapping
          </button>
          {current?.isCustom ? (
            <button className="inline-flex h-10 items-center gap-2 rounded-[6px] border border-phx-line bg-white px-4 text-sm font-black text-phx-ink transition hover:border-phx-accent disabled:opacity-60" disabled={busy !== null} onClick={() => void reset()} type="button">
              {busy === "reset" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              Reset to built-in
            </button>
          ) : null}
        </div>
        <p className="text-xs text-phx-ink-faint">A new weekly distributor can&rsquo;t be onboarded here — the weekly importer needs a per-distributor adapter. This editor adjusts the six built-in distributors&rsquo; column positions only.</p>

        <MappingAuditHistory distributorCode={selected} entityType="weekly_distributor_profile" />
      </Card>
    </div>
  );
}

function SheetEditor({
  sheet,
  preview,
  onColumnIndex,
  onHeaderRow,
}: {
  sheet: WeeklyContractSheet;
  preview: Record<string, { observedHeader: string; status: "filled" | "empty" }>;
  onColumnIndex: (fieldIdx: number, value: string) => void;
  onHeaderRow: (value: string) => void;
}) {
  return (
    <div className="rounded-[6px] border border-phx-line">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-[#020617] px-3 py-2 text-white">
        <div className="flex items-center gap-2">
          <span className="text-xs font-black uppercase tracking-wide">{ROLE_LABEL[sheet.role] ?? sheet.role}</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-white/20 px-2 py-0.5 text-phx-2xs font-bold text-white/70"><Lock className="h-3 w-3" /> {FILE_LABEL[sheet.formField] ?? sheet.formField}</span>
        </div>
        <label className="flex items-center gap-1.5 text-phx-xs font-bold text-white/80">
          Header row
          <select className="h-7 rounded-[6px] border border-white/20 bg-[#020617] px-1.5 text-xs text-white" onChange={(e) => onHeaderRow(e.target.value)} value={sheet.headerRowNumber}>
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
        </label>
      </div>

      <div className="grid grid-cols-1 gap-px bg-phx-line sm:grid-cols-2 lg:grid-cols-3">
        {sheet.fields.map((field, fieldIdx) => {
          const obs = preview[`${sheet.role}|${field.field}`];
          return (
          <div className="flex items-center justify-between gap-3 bg-white px-3 py-2" key={field.field}>
            <div className="min-w-0">
              <div className="break-words text-phx-sm font-bold text-phx-ink">{field.label}</div>
              <div className="break-words text-phx-2xs text-phx-ink-faint">{field.expectedHeaderHint || field.field}{field.role === "key" ? " · required" : field.role === "value" ? " · measure" : ""}</div>
              {obs ? (
                obs.status === "empty"
                  ? <div className="mt-0.5 break-words text-phx-2xs font-bold text-amber-700">⚠ column {field.columnIndex} is blank in your file</div>
                  : <div className="mt-0.5 break-words text-phx-2xs font-semibold text-emerald-700" title={obs.observedHeader}>your file: &ldquo;{obs.observedHeader}&rdquo;</div>
              ) : null}
            </div>
            <label className="flex shrink-0 flex-col items-end gap-0.5">
              <span className="text-phx-3xs font-black uppercase tracking-[0.1em] text-phx-ink-faint">Col</span>
              <input
                className={cn(phxFieldClassName, "h-8 w-16 text-right font-mono")}
                inputMode="numeric"
                min={1}
                onChange={(e) => onColumnIndex(fieldIdx, e.target.value)}
                type="number"
                value={field.columnIndex}
              />
            </label>
          </div>
          );
        })}
      </div>

      {sheet.matrix ? (
        <div className="border-t border-phx-line bg-[#FCFDFE] px-3 py-2 text-phx-xs text-phx-ink-soft">
          <span className="inline-flex items-center gap-1 font-bold text-phx-ink-2"><Lock className="h-3 w-3" /> {sheet.matrix.kind === "branch-headers" ? "Branch columns" : "Location columns"} (fixed in code)</span>
          <span className="ml-1">from column {sheet.matrix.firstColumn}{sheet.matrix.lastColumn ? `–${sheet.matrix.lastColumn}` : "+"}. {sheet.matrix.note}</span>
        </div>
      ) : null}
    </div>
  );
}
