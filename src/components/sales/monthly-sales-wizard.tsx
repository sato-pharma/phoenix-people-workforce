"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Lock,
  LockOpen,
  SkipForward,
  UploadCloud,
  X,
} from "lucide-react";
import { useMemo, useRef, useState, useCallback } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { CrmCard, CrmCardsOnPhone, CrmFacts, CrmTable } from "@/components/phoenix-crm/ui";
import { Card } from "@/components/ui/card";
import type { PreviewResult } from "@/components/sales/import-preview-modal";
import { ProductAddForm, CustomerBrickAddForm, TerritoryAddForm } from "@/components/sales/source-of-sales-mapping-tab";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import type { DistributorSalesValidationIssue, DistributorSalesValidationResult } from "@/lib/sales/monthly-distributor-import";
import type { MonthlySalesRun, MonthlySalesStep } from "@/lib/sales/monthly-sales-run";
import { officeCommitMessage, type StepConfirmation } from "@/lib/sales/step-confirmation";
import { cn } from "@/lib/utils";
import { phxFieldClassName } from "@/components/ui/form-tokens";

type RunResponse = { success: boolean; data?: MonthlySalesRun; error?: string; code?: string };
type ValidateResponse = {
  success: boolean;
  data?: DistributorSalesValidationResult & { stepConfirmation?: StepConfirmation | null };
  error?: string;
};
type PreviewResponse = { success: boolean; data?: PreviewResult; error?: string };

const OFFICE = "OFFICE";

// Blocking issues from the raw/Normalizer fallback path (source-of-sales-upload.ts's exceptionToIssue)
// carry one of these exact field labels — the coded-template path uses different field labels (sheet
// header names) with no alias step behind them, so those stay text-only (nothing to "map").
type MapNowKind = "product" | "customer" | "territory";
type MapNowGroup = {
  key: string;
  field: string;
  message: string;
  count: number;
  kinds: MapNowKind[];
  productAlias: string | null;
  customerCode: string | null;
  territoryRaw: string | null;
};

// "Product & Territory" issues embed BOTH raw values as quoted substrings in the message (the
// structured `value` field only ever carries one) — pull both out by position, product first.
function extractQuotedPair(message: string): [string | null, string | null] {
  const matches = [...message.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? null);
  return [matches[0] ?? null, matches[1] ?? null];
}

function mapNowGroupsFromIssues(issues: DistributorSalesValidationIssue[]): MapNowGroup[] {
  const groups = new Map<string, MapNowGroup>();
  for (const issue of issues) {
    if (issue.severity !== "failure") continue;
    let kinds: MapNowKind[] | null = null;
    let productAlias: string | null = null;
    let customerCode: string | null = null;
    let territoryRaw: string | null = null;
    if (issue.field === "Product") { kinds = ["product"]; productAlias = issue.value ?? null; }
    else if (issue.field === "Customer code") { kinds = ["customer"]; customerCode = issue.value ?? null; }
    else if (issue.field === "Territory") { kinds = ["territory"]; territoryRaw = issue.value ?? null; }
    else if (issue.field === "Product & Territory") {
      kinds = ["product", "territory"];
      [productAlias, territoryRaw] = extractQuotedPair(issue.message);
    }
    if (!kinds) continue;
    const key = `${issue.field}::${issue.message}`;
    const existing = groups.get(key);
    if (existing) { existing.count += 1; continue; }
    groups.set(key, { customerCode, field: issue.field, kinds, key, message: issue.message, count: 1, productAlias, territoryRaw });
  }
  return [...groups.values()];
}

function MapNowModal({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
      <div
        aria-modal="true"
        className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-[6px] border border-phx-line bg-white shadow-[0_28px_90px_rgba(15,23,42,0.28)]"
        role="dialog"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-phx-line bg-white px-5 py-3">
          <h2 className="text-sm font-black text-phx-ink">{title}</h2>
          <button
            className="inline-flex h-8 w-8 items-center justify-center rounded-[6px] border border-phx-line text-phx-ink-soft transition hover:border-phx-accent-line"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">{children}</div>
      </div>
    </div>
  );
}

function statusTone(status: MonthlySalesStep["stepStatus"]): string {
  switch (status) {
    case "confirmed": return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "skipped": return "bg-slate-200 text-slate-700 border-slate-300";
    case "validated": return "bg-sky-100 text-sky-800 border-sky-200";
    case "uploaded": return "bg-amber-100 text-amber-800 border-amber-200";
    default: return "bg-white text-slate-500 border-phx-line";
  }
}

async function readJson<T>(response: Response, fallback: T): Promise<T> {
  const text = await response.text();
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

export function MonthlySalesWizard({
  products = [],
  bricks = [],
}: {
  /** Master products, for the inline "Map now" product-alias form. */
  products?: { code: string; name: string }[];
  /** Master bricks, for the inline "Map now" customer/territory forms. */
  bricks?: { id: string; name: string }[];
}) {
  const [period, setPeriod] = useState("");
  const [run, setRun] = useState<MonthlySalesRun | null>(null);
  const [activeCode, setActiveCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "error" | "success" } | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [mapNowGroup, setMapNowGroup] = useState<MapNowGroup | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Captured at preview time so Confirm always uses the file that was actually reviewed,
  // even if the user accidentally triggers the file picker again between Preview and Confirm.
  const previewFileRef = useRef<File | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const onFileChange = useCallback(() => {
    setSelectedFileName(fileRef.current?.files?.[0]?.name ?? null);
  }, []);

  const activeStep = useMemo(() => {
    if (!run) return null;
    if (activeCode) return run.steps.find((s) => s.distributorCode === activeCode) ?? null;
    return run.steps.find((s) => s.stepStatus !== "confirmed" && s.stepStatus !== "skipped") ?? run.steps[0] ?? null;
  }, [run, activeCode]);

  const isOfficeStep = activeStep ? activeStep.distributorCode.toUpperCase() === OFFICE : false;

  function applyRun(next: MonthlySalesRun) {
    setRun(next);
  }

  async function startRun() {
    if (!/^\d{4}-\d{2}$/.test(period)) { setMessage({ type: "error", text: "Pick a month first." }); return; }
    setBusy(true); setMessage(null); setPreview(null);
    try {
      const res = await fetch("/api/sales/monthly-sales/run", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ period }),
      });
      const payload = await readJson<RunResponse>(res, { success: false });
      if (payload.success && payload.data) { applyRun(payload.data); setActiveCode(null); }
      else setMessage({ type: "error", text: payload.error ?? "Could not start the monthly run." });
    } finally { setBusy(false); }
  }

  // Step 1 — validate WITHOUT persisting, then render the preview. Mirrors the Office step and the
  // Uploaded Sheets tab: nothing is written until the user reviews and confirms.
  async function distributorPreview() {
    if (!activeStep || !fileRef.current?.files?.[0]) { setMessage({ type: "error", text: "Choose a file to upload." }); return; }
    setBusy(true); setMessage(null); setPreview(null);
    try {
      const form = new FormData();
      form.set("file", fileRef.current.files[0]);
      form.set("distributorCode", activeStep.distributorCode);
      form.set("period", period);
      const res = await fetch("/api/sales/monthly-import/preview", { method: "POST", body: form });
      const payload = await readJson<PreviewResponse>(res, { success: false });
      if (payload.data) {
        setPreview(payload.data);
        previewFileRef.current = fileRef.current?.files?.[0] ?? null;
      }
      if (!payload.data) {
        setMessage({ type: "error", text: payload.error ?? "Preview failed." });
      } else if (payload.data.status === "validated") {
        setMessage({ type: "success", text: "Preview ready — review below, then confirm to import." });
      } else {
        setMessage({ type: "error", text: "Blocked — fix the rows listed below, then re-upload." });
      }
    } finally { setBusy(false); }
  }

  // A "Map now" save closes the modal and re-runs the SAME preview in place — never a page navigation,
  // never a re-pick of the file (fileRef still holds it from the original Preview click).
  async function handleMappingSaved() {
    setMapNowGroup(null);
    await distributorPreview();
  }

  const mapNowGroups = useMemo(() => mapNowGroupsFromIssues(preview?.issues ?? []), [preview]);
  const failureIssues = useMemo(() => (preview?.issues ?? []).filter((issue) => issue.severity === "failure").slice(0, 50), [preview]);

  // Step 2 — persist the previewed upload, then record confirmation against the run with the batch id.
  // Uses previewFileRef (captured at preview time) rather than re-reading fileRef.current.files[0],
  // so a stale file picker state between Preview and Confirm cannot commit the wrong file.
  async function distributorConfirm() {
    if (!activeStep || !previewFileRef.current || preview?.status !== "validated") return;
    setBusy(true); setMessage(null);
    try {
      const form = new FormData();
      form.set("file", previewFileRef.current);
      form.set("distributorCode", activeStep.distributorCode);
      form.set("period", period);
      // Carry the reviewed diff + unmapped details so a coverage snapshot is recorded on commit.
      if (preview.previewDiff) form.set("previewDiff", JSON.stringify(preview.previewDiff));
      if (preview.unmappedCustomers?.length) form.set("unmappedCustomers", JSON.stringify(preview.unmappedCustomers));
      const res = await fetch("/api/sales/monthly-import/commit", { method: "POST", body: form });
      const payload = await readJson<PreviewResponse>(res, { success: false });
      if (!payload.success || !payload.data?.batchId) {
        setMessage({ type: "error", text: payload.error ?? "Import failed." });
        return;
      }
      await confirmStep(activeStep.distributorCode, payload.data.batchId ?? null);
      previewFileRef.current = null;
      setPreview(null);
      setMessage({ type: "success", text: `${activeStep.distributorName} imported and confirmed.` });
      if (fileRef.current) fileRef.current.value = "";
      setSelectedFileName(null);
    } finally { setBusy(false); }
  }

  async function confirmStep(code: string, batchId: string | null) {
    const res = await fetch(`/api/sales/monthly-sales/step/${encodeURIComponent(code)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ period, action: "confirm", batchId }),
    });
    const payload = await readJson<RunResponse>(res, { success: false });
    if (payload.success && payload.data) { applyRun(payload.data); setActiveCode(null); }
    else setMessage({ type: "error", text: payload.error ?? "Could not confirm the step." });
  }

  async function skipStep() {
    if (!activeStep) return;
    const reason = window.prompt(`Why is ${activeStep.distributorName} skipped this month?`)?.trim();
    if (!reason) return;
    setBusy(true); setMessage(null);
    try {
      const res = await fetch(`/api/sales/monthly-sales/step/${encodeURIComponent(activeStep.distributorCode)}/skip`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ period, reason }),
      });
      const payload = await readJson<RunResponse>(res, { success: false });
      if (payload.success && payload.data) { applyRun(payload.data); setActiveCode(null); }
      else setMessage({ type: "error", text: payload.error ?? "Could not skip the step." });
    } finally { setBusy(false); }
  }

  async function reopenStep(code: string) {
    setBusy(true); setMessage(null);
    try {
      const res = await fetch(`/api/sales/monthly-sales/step/${encodeURIComponent(code)}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ period, action: "reopen" }),
      });
      const payload = await readJson<RunResponse>(res, { success: false });
      if (payload.success && payload.data) { applyRun(payload.data); setActiveCode(code); }
      else setMessage({ type: "error", text: payload.error ?? "Could not re-open the step." });
    } finally { setBusy(false); }
  }

  async function officeAction(mode: "preview" | "commit") {
    if (!fileRef.current?.files?.[0]) { setMessage({ type: "error", text: "Choose the office file first." }); return; }
    setBusy(true); setMessage(null);
    try {
      const form = new FormData();
      form.set("file", fileRef.current.files[0]);
      form.set("period", period);
      const res = await fetch(`/api/sales/monthly-sales/office/${mode}`, { method: "POST", body: form });
      const payload = await readJson<ValidateResponse>(res, { success: false });
      if (!payload.success || !payload.data) {
        setPreview(payload.data ?? null);
        setMessage({ type: "error", text: payload.error ?? "Office allocation blocked. Map the missing product names." });
        return;
      }
      setPreview(payload.data);
      if (mode === "commit") {
        // The save stands either way; an unconfirmed step is shown as the error it is, not as success.
        const stepConfirmation = payload.data.stepConfirmation ?? null;
        setMessage({
          type: stepConfirmation && !stepConfirmation.confirmed ? "error" : "success",
          text: officeCommitMessage(stepConfirmation),
        });
        if (fileRef.current) fileRef.current.value = ""; setSelectedFileName(null);
        await refreshRun();
      } else {
        setMessage({ type: "success", text: "Preview ready — review the allocation, then confirm." });
      }
    } finally { setBusy(false); }
  }

  async function refreshRun() {
    const res = await fetch(`/api/sales/monthly-sales/run?period=${encodeURIComponent(period)}`, { cache: "no-store" });
    const payload = await readJson<RunResponse>(res, { success: false });
    if (payload.success && payload.data) { applyRun(payload.data); setActiveCode(null); }
  }

  async function lockAction(action: "lock" | "reopen") {
    setBusy(true); setMessage(null);
    try {
      const res = await fetch("/api/sales/monthly-sales/lock", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ period, action }),
      });
      const payload = await readJson<RunResponse>(res, { success: false });
      if (payload.success && payload.data) {
        applyRun(payload.data);
        setMessage({ type: "success", text: action === "lock" ? `${period} locked.` : `${period} re-opened.` });
      } else setMessage({ type: "error", text: payload.error ?? "Lock action failed." });
    } finally { setBusy(false); }
  }

  const allDone = run ? run.steps.every((s) => s.stepStatus === "confirmed" || s.stepStatus === "skipped") : false;

  return (
    <div className="flex flex-col gap-4">
      <Card className="rounded-2xl border-phx-line p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-black uppercase tracking-wide text-slate-500">Month</label>
            <input
              type="month"
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
              className={phxFieldClassName}
            />
          </div>
          <Button className="gap-2 rounded-xl font-black" disabled={busy} onClick={() => void startRun()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
            {run ? "Reload run" : "Start monthly close"}
          </Button>
          {run ? (
            <div className="ml-auto flex items-center gap-3">
              <div className="text-right">
                <p className="text-xs font-black uppercase tracking-wide text-slate-500">Monthly closing complete</p>
                <p className="text-2xl font-black text-slate-900">{run.completionPct === null ? "—" : `${run.completionPct}%`}</p>
                <p className="text-xs font-semibold text-slate-500">
                  {run.completionPct === null ? "Sales shares could not be read" : "by sales value"}
                </p>
              </div>
              <div className="h-2 w-40 overflow-hidden rounded-full bg-slate-200">
                <div className="h-full bg-phx-accent" style={{ width: `${run.completionPct ?? 0}%` }} />
              </div>
            </div>
          ) : null}
        </div>
      </Card>

      {message ? (
        <AdminCallout tone={message.type === "success" ? "success" : "danger"}>
          {message.type === "success" ? <CheckCircle2 className="mt-0.5 h-4 w-4" /> : <AlertTriangle className="mt-0.5 h-4 w-4" />}
          <p>{message.text}</p>
        </AdminCallout>
      ) : null}

      {run ? (
        <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
          {/* Left rail — steps */}
          <Card className="rounded-2xl border-phx-line p-3">
            <ol className="flex flex-col gap-1">
              {run.steps.map((step, index) => {
                const active = activeStep?.distributorCode === step.distributorCode;
                return (
                  <li key={step.distributorCode}>
                    <button
                      type="button"
                      onClick={() => { setActiveCode(step.distributorCode); setPreview(null); setMessage(null); }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm font-bold transition",
                        active ? "border-[#0B0B0B] bg-[#0B0B0B] text-white" : "border-transparent hover:border-phx-line",
                      )}
                    >
                      <span className={cn("flex h-6 w-6 items-center justify-center rounded-full border text-xs font-black", active ? "border-white text-white" : "border-phx-line text-slate-500")}>
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 break-words">{step.distributorName}</span>
                      <span className={cn("rounded-full border px-2 py-0.5 text-phx-sm font-black uppercase", active ? "border-white/40 text-white" : statusTone(step.stepStatus))}>
                        {step.stepStatus}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </Card>

          {/* Right — active step body */}
          <Card className="rounded-2xl border-phx-line p-5">
            {run.locked ? (
              <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                <p className="flex items-center gap-2 text-sm font-bold text-amber-900"><Lock className="h-4 w-4" /> {period} is locked. Uploads are frozen.</p>
                <Button className="gap-2 rounded-xl font-black" disabled={busy} onClick={() => void lockAction("reopen")} variant="secondary">
                  <LockOpen className="h-4 w-4" /> Re-open
                </Button>
              </div>
            ) : null}

            {activeStep ? (
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-black text-slate-900">{activeStep.distributorName}</h3>
                    <p className="text-sm text-slate-500">
                      {isOfficeStep
                        ? "Upload the office pivot — units are allocated to bricks from every other channel's contribution."
                        : `Upload ${activeStep.distributorName}'s monthly sheet, then confirm.`}
                    </p>
                  </div>
                  <span className={cn("rounded-full border px-3 py-1 text-xs font-black uppercase", statusTone(activeStep.stepStatus))}>{activeStep.stepStatus}</span>
                </div>

                {activeStep.stepStatus === "skipped" ? (
                  <AdminCallout tone="neutral"><SkipForward className="mt-0.5 h-4 w-4" /><p>Skipped: {activeStep.skipReason}</p></AdminCallout>
                ) : null}
                {activeStep.batch ? (
                  <div className="grid grid-cols-3 gap-3 rounded-xl border border-phx-line bg-slate-50 p-4">
                    <div><p className="text-xs font-black uppercase text-slate-500">File</p><p className="break-words text-sm font-bold text-slate-800">{activeStep.batch.fileName}</p></div>
                    <div><p className="text-xs font-black uppercase text-slate-500">Units</p><p className="text-sm font-bold text-slate-800">{formatNumber(activeStep.batch.totalQty)}</p></div>
                    <div><p className="text-xs font-black uppercase text-slate-500">Value</p><p className="text-sm font-bold text-slate-800">{formatCurrency(activeStep.batch.totalValue)}</p></div>
                  </div>
                ) : null}

                {!run.locked ? (
                  <div className="flex flex-col gap-3">
                    {/* File picker — must select before any action button works */}
                    <label className="flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed border-phx-line bg-slate-50 px-4 py-3 transition-colors hover:border-orange-400 hover:bg-orange-50">
                      <UploadCloud className="h-5 w-5 shrink-0 text-slate-400" />
                      <span className="flex-1 text-sm">
                        {selectedFileName
                          ? <span className="font-bold text-slate-800">{selectedFileName}</span>
                          : <span className="text-slate-500">Click here to choose the Excel file (.xlsx)</span>}
                      </span>
                      <input ref={fileRef} type="file" accept=".xls,.xlsx" className="sr-only" onChange={onFileChange} />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {isOfficeStep ? (
                        <>
                          <Button className="gap-2 rounded-xl font-black" disabled={busy || !selectedFileName} onClick={() => void officeAction("preview")} variant="secondary">
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />} Preview allocation
                          </Button>
                          <Button className="gap-2 rounded-xl font-black" disabled={busy || !preview || preview.status !== "validated"} onClick={() => void officeAction("commit")}>
                            <CheckCircle2 className="h-4 w-4" /> Confirm allocation
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button className="gap-2 rounded-xl font-black" disabled={busy || !selectedFileName} onClick={() => void distributorPreview()} variant="secondary">
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />} Preview
                          </Button>
                          <Button className="gap-2 rounded-xl font-black" disabled={busy || !preview || preview.status !== "validated"} onClick={() => void distributorConfirm()}>
                            <CheckCircle2 className="h-4 w-4" /> Confirm import
                          </Button>
                          <Button className="gap-2 rounded-xl font-black" disabled={busy} onClick={() => void skipStep()} variant="secondary">
                            <SkipForward className="h-4 w-4" /> Skip with reason
                          </Button>
                        </>
                      )}
                      {(activeStep.stepStatus === "confirmed" || activeStep.stepStatus === "skipped") ? (
                        <Button className="gap-2 rounded-xl font-black" disabled={busy} onClick={() => void reopenStep(activeStep.distributorCode)} variant="ghost">
                          Re-do this step
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {/* Office allocation preview */}
                {isOfficeStep && preview ? (
                  <div className="flex flex-col gap-3">
                    {preview.advisories?.map((advisory) => (
                      <AdminCallout key={advisory} tone="neutral"><AlertTriangle className="mt-0.5 h-4 w-4" /><p>{advisory}</p></AdminCallout>
                    ))}
                    {preview.status === "validated" ? (
                      <div className="grid grid-cols-3 gap-3 rounded-xl border border-phx-line bg-slate-50 p-4">
                        <div><p className="text-xs font-black uppercase text-slate-500">Allocated units</p><p className="text-sm font-bold text-slate-800">{formatNumber(preview.totals.totalQty)}</p></div>
                        <div><p className="text-xs font-black uppercase text-slate-500">Allocated value</p><p className="text-sm font-bold text-slate-800">{formatCurrency(preview.totals.totalValue)}</p></div>
                        <div><p className="text-xs font-black uppercase text-slate-500">Bricks touched</p><p className="text-sm font-bold text-slate-800">{formatNumber(preview.byBrick.length)}</p></div>
                      </div>
                    ) : null}
                    {preview.byBrickProduct && preview.byBrickProduct.length > 0 ? (
                      <div className="max-h-96 overflow-y-auto border border-phx-line">
                        <CrmCardsOnPhone>
                          {preview.byBrickProduct.map((row, i) => (
                            <CrmCard
                              key={`${row.brickId}-${row.productCode}-${i}`}
                              meta={row.productName}
                              title={row.brickName || (row.brickId ? "—" : "NATIONAL")}
                            >
                              <CrmFacts
                                facts={[
                                  { label: "Region", value: row.regionName || "—" },
                                  { label: "Area", value: row.areaName || "—" },
                                  { label: "Units", value: formatNumber(row.qty) },
                                  { label: "Value", value: formatCurrency(row.value) },
                                ]}
                              />
                            </CrmCard>
                          ))}
                        </CrmCardsOnPhone>
                        <CrmTable columns={["22%", "22%", "26%", "12%", "18%"]}>
                          <thead className="sticky top-0 bg-[#0B0B0B] text-white">
                            <tr>
                              <th className="px-3 py-2 text-left font-black">Region and area</th>
                              <th className="px-3 py-2 text-left font-black">Brick</th>
                              <th className="px-3 py-2 text-left font-black">Product</th>
                              <th className="px-3 py-2 text-right font-black">Units</th>
                              <th className="px-3 py-2 text-right font-black">Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {preview.byBrickProduct.map((row, i) => (
                              <tr key={`${row.brickId}-${row.productCode}-${i}`} className="border-t border-[#F1E4D8]">
                                <td className="break-words px-3 py-2 align-top text-slate-500">
                                  <span className="block">{row.regionName || "—"}</span>
                                  <span className="block">{row.areaName || "—"}</span>
                                </td>
                                <td className="break-words px-3 py-2 align-top font-bold text-slate-800">{row.brickName || (row.brickId ? "—" : "NATIONAL")}</td>
                                <td className="break-words px-3 py-2 align-top text-slate-700">{row.productName}</td>
                                <td className="break-words px-3 py-2 text-right align-top tabular-nums">{formatNumber(row.qty)}</td>
                                <td className="break-words px-3 py-2 text-right align-top tabular-nums">{formatCurrency(row.value)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </CrmTable>
                      </div>
                    ) : preview.byRegion.length > 0 ? (
                      <div className="overflow-hidden border border-phx-line">
                        <CrmCardsOnPhone>
                          {preview.byRegion.map((row) => (
                            <CrmCard key={`${row.regionCode}-${row.regionName}`} title={row.regionName || "—"}>
                              <CrmFacts
                                facts={[
                                  { label: "Units", value: formatNumber(row.totalQty) },
                                  { label: "Value", value: formatCurrency(row.totalValue) },
                                ]}
                              />
                            </CrmCard>
                          ))}
                        </CrmCardsOnPhone>
                        <CrmTable columns={["50%", "20%", "30%"]}>
                          <thead className="bg-[#0B0B0B] text-white"><tr><th className="px-3 py-2 text-left font-black">Region</th><th className="px-3 py-2 text-right font-black">Units</th><th className="px-3 py-2 text-right font-black">Value</th></tr></thead>
                          <tbody>
                            {preview.byRegion.map((row) => (
                              <tr key={`${row.regionCode}-${row.regionName}`} className="border-t border-[#F1E4D8]">
                                <td className="break-words px-3 py-2 align-top font-bold text-slate-800">{row.regionName || "—"}</td>
                                <td className="break-words px-3 py-2 text-right align-top">{formatNumber(row.totalQty)}</td>
                                <td className="break-words px-3 py-2 text-right align-top">{formatCurrency(row.totalValue)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </CrmTable>
                      </div>
                    ) : null}
                    {preview.issues.length > 0 ? (
                      <AdminCallout tone="danger"><AlertTriangle className="mt-0.5 h-4 w-4" /><div><p className="font-bold">Unmapped office product names:</p><ul className="list-disc pl-5">{preview.issues.slice(0, 20).map((issue) => (<li key={`${issue.rowNumber}-${issue.value}`}>{issue.value}</li>))}</ul></div></AdminCallout>
                    ) : null}
                  </div>
                ) : null}

                {/* Distributor preview — review before persisting (nothing is written until Confirm import) */}
                {!isOfficeStep && preview ? (
                  <div className="flex flex-col gap-3">
                    {preview.status === "validated" ? (
                      <AdminCallout tone="success"><CheckCircle2 className="mt-0.5 h-4 w-4" /><p>Validation passed — review the totals, then confirm to import.</p></AdminCallout>
                    ) : (
                      <AdminCallout tone="danger"><AlertTriangle className="mt-0.5 h-4 w-4" /><p>{preview.failedRows} row(s) must be fixed before this sheet can import.</p></AdminCallout>
                    )}
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div className="rounded-xl border border-phx-line bg-slate-50 p-3"><p className="text-xs font-black uppercase text-slate-500">Importable</p><p className="text-sm font-bold text-slate-800">{formatNumber(preview.importableRows)}</p></div>
                      <div className="rounded-xl border border-phx-line bg-slate-50 p-3"><p className="text-xs font-black uppercase text-slate-500">Failed</p><p className={cn("text-sm font-bold", preview.failedRows > 0 ? "text-red-600" : "text-slate-800")}>{formatNumber(preview.failedRows)}</p></div>
                      <div className="rounded-xl border border-phx-line bg-slate-50 p-3"><p className="text-xs font-black uppercase text-slate-500">Total value</p><p className="text-sm font-bold text-slate-800">{formatCurrency(preview.totals.totalValue)}</p></div>
                      <div className="rounded-xl border border-phx-line bg-slate-50 p-3"><p className="text-xs font-black uppercase text-slate-500">Period</p><p className="text-sm font-bold text-slate-800">{preview.period ?? "—"}</p></div>
                    </div>
                    {mapNowGroups.length > 0 ? (
                      <div className="flex flex-col gap-2 rounded-xl border border-phx-line bg-white p-3">
                        <p className="text-xs font-black uppercase tracking-wide text-slate-500">Fix inline, without leaving this page</p>
                        <ul className="flex flex-col gap-2">
                          {mapNowGroups.map((group) => (
                            <li key={group.key} className="flex items-center justify-between gap-3 rounded-lg border border-[#F1E4D8] bg-slate-50 px-3 py-2">
                              <div className="min-w-0">
                                <p className="break-words text-sm font-bold text-slate-800">{group.message}</p>
                                <p className="text-xs text-slate-500">{group.count} row{group.count === 1 ? "" : "s"}</p>
                              </div>
                              <Button className="shrink-0 gap-1 rounded-xl font-black" onClick={() => setMapNowGroup(group)} size="sm" variant="secondary">
                                Map now
                              </Button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {preview.issues.length > 0 ? (
                      <div className="max-h-72 overflow-y-auto border border-phx-line">
                        <CrmCardsOnPhone>
                          {failureIssues.map((issue, i) => (
                            <CrmCard key={`${issue.rowNumber}-${issue.field}-${i}`} meta={issue.message} title={`Row ${issue.rowNumber}`}>
                              <CrmFacts
                                facts={[
                                  { label: "Field", value: issue.field },
                                  { label: "Value", value: issue.value ?? "—" },
                                ]}
                              />
                            </CrmCard>
                          ))}
                        </CrmCardsOnPhone>
                        <CrmTable columns={["10%", "20%", "25%", "45%"]}>
                          <thead className="sticky top-0 bg-[#0B0B0B] text-white"><tr><th className="px-3 py-2 text-left font-black">Row</th><th className="px-3 py-2 text-left font-black">Field</th><th className="px-3 py-2 text-left font-black">Value</th><th className="px-3 py-2 text-left font-black">Error</th></tr></thead>
                          <tbody>
                            {failureIssues.map((issue, i) => (
                              <tr key={`${issue.rowNumber}-${issue.field}-${i}`} className="border-t border-[#F1E4D8]">
                                <td className="break-words px-3 py-2 align-top font-bold text-slate-800">{issue.rowNumber}</td>
                                <td className="break-words px-3 py-2 align-top text-slate-600">{issue.field}</td>
                                <td className="break-words px-3 py-2 align-top text-slate-600">{issue.value ?? "—"}</td>
                                <td className="break-words px-3 py-2 align-top text-slate-600">{issue.message}</td>
                              </tr>
                            ))}
                          </tbody>
                        </CrmTable>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-slate-500">All steps complete.</p>
            )}

            {/* Closing lock at 100% */}
            {allDone && !run.locked ? (
              <div className="mt-5 flex items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                <p className="flex items-center gap-2 text-sm font-bold text-emerald-900"><CheckCircle2 className="h-4 w-4" /> Every distributor is confirmed or skipped. Lock the month to freeze it.</p>
                <Button className="gap-2 rounded-xl font-black" disabled={busy} onClick={() => void lockAction("lock")}>
                  <Lock className="h-4 w-4" /> Lock {period}
                </Button>
              </div>
            ) : null}
          </Card>
        </div>
      ) : (
        <Card className="rounded-2xl border-phx-line p-8 text-center">
          <p className="text-sm text-slate-500">Pick a month and start the guided monthly close. You&apos;ll be walked through every distributor — upload, validate, confirm — then Office is computed last and the period is locked.</p>
        </Card>
      )}

      {mapNowGroup && activeStep ? (
        <MapNowModal onClose={() => setMapNowGroup(null)} title={`Map now — ${mapNowGroup.field}`}>
          {mapNowGroup.kinds.includes("product") ? (
            <ProductAddForm
              distributorCode={activeStep.distributorCode}
              onSaved={() => void handleMappingSaved()}
              prefillAlias={mapNowGroup.productAlias ?? undefined}
              products={products}
            />
          ) : null}
          {mapNowGroup.kinds.includes("customer") ? (
            <CustomerBrickAddForm
              bricks={bricks}
              distributorCode={activeStep.distributorCode}
              onSaved={() => void handleMappingSaved()}
              prefillCustomerCode={mapNowGroup.customerCode ?? undefined}
            />
          ) : null}
          {mapNowGroup.kinds.includes("territory") ? (
            <TerritoryAddForm
              bricks={bricks}
              onSaved={() => void handleMappingSaved()}
              prefillRaw={mapNowGroup.territoryRaw ?? undefined}
            />
          ) : null}
        </MapNowModal>
      ) : null}
    </div>
  );
}
