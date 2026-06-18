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
} from "lucide-react";
import { useMemo, useRef, useState, useCallback } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCurrency, formatNumber } from "@/lib/sales/format";
import type { DistributorSalesValidationResult } from "@/lib/sales/monthly-distributor-import";
import type { MonthlySalesRun, MonthlySalesStep } from "@/lib/sales/monthly-sales-run";
import { cn } from "@/lib/utils";

type RunResponse = { success: boolean; data?: MonthlySalesRun; error?: string; code?: string };
type ValidateResponse = { success: boolean; data?: DistributorSalesValidationResult; error?: string };

const OFFICE = "OFFICE";

function statusTone(status: MonthlySalesStep["stepStatus"]): string {
  switch (status) {
    case "confirmed": return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "skipped": return "bg-slate-200 text-slate-700 border-slate-300";
    case "validated": return "bg-sky-100 text-sky-800 border-sky-200";
    case "uploaded": return "bg-amber-100 text-amber-800 border-amber-200";
    default: return "bg-white text-slate-500 border-[#D8E0EA]";
  }
}

async function readJson<T>(response: Response, fallback: T): Promise<T> {
  const text = await response.text();
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

export function MonthlySalesWizard() {
  const [period, setPeriod] = useState("");
  const [run, setRun] = useState<MonthlySalesRun | null>(null);
  const [activeCode, setActiveCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: "error" | "success" } | null>(null);
  const [preview, setPreview] = useState<DistributorSalesValidationResult | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
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

  async function uploadDistributor() {
    if (!activeStep || !fileRef.current?.files?.[0]) { setMessage({ type: "error", text: "Choose a file to upload." }); return; }
    setBusy(true); setMessage(null);
    try {
      const form = new FormData();
      form.set("file", fileRef.current.files[0]);
      form.set("distributorCode", activeStep.distributorCode);
      form.set("period", period);
      const res = await fetch("/api/sales/monthly-import/validate", { method: "POST", body: form });
      const payload = await readJson<ValidateResponse>(res, { success: false });
      if (!payload.success || !payload.data) {
        setMessage({ type: "error", text: payload.error ?? "Validation blocked. Fix the file and re-upload." });
        return;
      }
      // Validated + persisted — record confirmation against the run with the new batch id.
      await confirmStep(activeStep.distributorCode, payload.data.batchId ?? null);
      setMessage({ type: "success", text: `${activeStep.distributorName} validated and confirmed.` });
      if (fileRef.current) fileRef.current.value = ""; setSelectedFileName(null);
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
        setMessage({ type: "success", text: "Office allocation saved." });
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
      <Card className="rounded-2xl border-[#D8E0EA] p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-black uppercase tracking-wide text-slate-500">Month</label>
            <input
              type="month"
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
              className="h-10 rounded-xl border border-[#D8E0EA] bg-white px-3 text-sm font-bold text-slate-800"
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
                <p className="text-2xl font-black text-slate-900">{run.completionPct}%</p>
              </div>
              <div className="h-2 w-40 overflow-hidden rounded-full bg-slate-200">
                <div className="h-full bg-[#F97316]" style={{ width: `${run.completionPct}%` }} />
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
          <Card className="rounded-2xl border-[#D8E0EA] p-3">
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
                        active ? "border-[#0B0B0B] bg-[#0B0B0B] text-white" : "border-transparent hover:border-[#D8E0EA]",
                      )}
                    >
                      <span className={cn("flex h-6 w-6 items-center justify-center rounded-full border text-xs font-black", active ? "border-white text-white" : "border-[#D8E0EA] text-slate-500")}>
                        {index + 1}
                      </span>
                      <span className="flex-1 truncate">{step.distributorName}</span>
                      <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-black uppercase", active ? "border-white/40 text-white" : statusTone(step.stepStatus))}>
                        {step.stepStatus}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </Card>

          {/* Right — active step body */}
          <Card className="rounded-2xl border-[#D8E0EA] p-5">
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
                  <div className="grid grid-cols-3 gap-3 rounded-xl border border-[#D8E0EA] bg-slate-50 p-4">
                    <div><p className="text-xs font-black uppercase text-slate-500">File</p><p className="truncate text-sm font-bold text-slate-800">{activeStep.batch.fileName}</p></div>
                    <div><p className="text-xs font-black uppercase text-slate-500">Units</p><p className="text-sm font-bold text-slate-800">{formatNumber(activeStep.batch.totalQty)}</p></div>
                    <div><p className="text-xs font-black uppercase text-slate-500">Value</p><p className="text-sm font-bold text-slate-800">{formatCurrency(activeStep.batch.totalValue)}</p></div>
                  </div>
                ) : null}

                {!run.locked ? (
                  <div className="flex flex-col gap-3">
                    {/* File picker — must select before any action button works */}
                    <label className="flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed border-[#D8E0EA] bg-slate-50 px-4 py-3 transition-colors hover:border-orange-400 hover:bg-orange-50">
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
                          <Button className="gap-2 rounded-xl font-black" disabled={busy || !selectedFileName} onClick={() => void uploadDistributor()}>
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />} Upload &amp; confirm
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
                      <div className="grid grid-cols-3 gap-3 rounded-xl border border-[#D8E0EA] bg-slate-50 p-4">
                        <div><p className="text-xs font-black uppercase text-slate-500">Allocated units</p><p className="text-sm font-bold text-slate-800">{formatNumber(preview.totals.totalQty)}</p></div>
                        <div><p className="text-xs font-black uppercase text-slate-500">Allocated value</p><p className="text-sm font-bold text-slate-800">{formatCurrency(preview.totals.totalValue)}</p></div>
                        <div><p className="text-xs font-black uppercase text-slate-500">Bricks touched</p><p className="text-sm font-bold text-slate-800">{formatNumber(preview.byBrick.length)}</p></div>
                      </div>
                    ) : null}
                    {preview.byBrickProduct && preview.byBrickProduct.length > 0 ? (
                      <div className="max-h-96 overflow-auto rounded-xl border border-[#D8E0EA]">
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 bg-[#0B0B0B] text-white">
                            <tr>
                              <th className="px-3 py-2 text-left font-black">Region</th>
                              <th className="px-3 py-2 text-left font-black">Area</th>
                              <th className="px-3 py-2 text-left font-black">Brick</th>
                              <th className="px-3 py-2 text-left font-black">Product</th>
                              <th className="px-3 py-2 text-right font-black">Units</th>
                              <th className="px-3 py-2 text-right font-black">Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {preview.byBrickProduct.map((row, i) => (
                              <tr key={`${row.brickId}-${row.productCode}-${i}`} className="border-t border-[#F1E4D8]">
                                <td className="px-3 py-2 text-slate-500">{row.regionName || row.regionCode || "—"}</td>
                                <td className="px-3 py-2 text-slate-500">{row.areaName || row.areaCode || "—"}</td>
                                <td className="px-3 py-2 font-bold text-slate-800">{row.brickName || row.brickId || "NATIONAL"}</td>
                                <td className="px-3 py-2 text-slate-700">{row.productName}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{formatNumber(row.qty)}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(row.value)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : preview.byRegion.length > 0 ? (
                      <div className="overflow-hidden rounded-xl border border-[#D8E0EA]">
                        <table className="w-full text-sm">
                          <thead className="bg-[#0B0B0B] text-white"><tr><th className="px-3 py-2 text-left font-black">Region</th><th className="px-3 py-2 text-right font-black">Units</th><th className="px-3 py-2 text-right font-black">Value</th></tr></thead>
                          <tbody>
                            {preview.byRegion.map((row) => (
                              <tr key={`${row.regionCode}-${row.regionName}`} className="border-t border-[#F1E4D8]">
                                <td className="px-3 py-2 font-bold text-slate-800">{row.regionName || row.regionCode || "—"}</td>
                                <td className="px-3 py-2 text-right">{formatNumber(row.totalQty)}</td>
                                <td className="px-3 py-2 text-right">{formatCurrency(row.totalValue)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                    {preview.issues.length > 0 ? (
                      <AdminCallout tone="danger"><AlertTriangle className="mt-0.5 h-4 w-4" /><div><p className="font-bold">Unmapped office product names:</p><ul className="list-disc pl-5">{preview.issues.slice(0, 20).map((issue) => (<li key={`${issue.rowNumber}-${issue.value}`}>{issue.value}</li>))}</ul></div></AdminCallout>
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
        <Card className="rounded-2xl border-[#D8E0EA] p-8 text-center">
          <p className="text-sm text-slate-500">Pick a month and start the guided monthly close. You&apos;ll be walked through every distributor — upload, validate, confirm — then Office is computed last and the period is locked.</p>
        </Card>
      )}
    </div>
  );
}
