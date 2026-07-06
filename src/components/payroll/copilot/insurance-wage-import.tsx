"use client";

import { useState } from "react";

type Issue = { row: number; message: string };
type Unmatched = { hrId: string; wage: number };
type SampleRow = { hrId: string; employeeHrId: string; wage: number };

type PreviewResponse = {
  committed: false;
  issues: Issue[];
  matchedCount: number;
  unmatchedCount: number;
  unmatched: Unmatched[];
  sample: SampleRow[];
};

type ApplyResponse = {
  committed: true;
  updated: number;
  failed: { employeeHrId: string; message: string }[];
  matchedCount: number;
  unmatchedCount: number;
  unmatched: Unmatched[];
  issues: Issue[];
};

function egp(value: number): string {
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}

export function InsuranceWageImport() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [applied, setApplied] = useState<ApplyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(commit: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      if (commit) body.append("commit", "true");
      const res = await fetch("/api/payroll/statutory/insurance-wages/import", {
        method: "POST",
        credentials: "same-origin",
        body,
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof data.message === "string" ? data.message : "Upload failed.");
      if (commit) {
        setApplied(data as unknown as ApplyResponse);
        setPreview(null);
      } else {
        setPreview(data as unknown as PreviewResponse);
        setApplied(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="border-l-4 border-l-orange-500 bg-slate-900 px-6 py-5 text-white">
          <h1 className="text-xl font-bold tracking-tight">Insurance Wages — bulk import</h1>
          <p className="mt-1 text-sm text-slate-300">
            Set each employee&apos;s social-insurance (subject) wage. The Payroll Copilot uses it to compute social
            insurance and income tax. Restricted to CEO &amp; Super Admin.
          </p>
        </header>

        <section className="border border-slate-200 bg-white p-6">
          <p className="text-sm text-slate-600">
            Upload an Excel file with two columns: <strong>HR_ID</strong> and <strong>Insurance Wage</strong>. I&apos;ll
            preview the matches first — nothing is saved until you confirm.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setPreview(null);
                setApplied(null);
              }}
              className="text-sm"
            />
            <button
              type="button"
              onClick={() => send(false)}
              disabled={busy || !file}
              className="bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {busy ? "Reading…" : "Preview"}
            </button>
          </div>
        </section>

        {error ? (
          <div className="border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
        ) : null}

        {preview ? (
          <section className="border border-slate-200 bg-white">
            <div className="border-b border-slate-200 bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
              Preview
            </div>
            <div className="grid grid-cols-3 gap-3 p-4">
              <Stat label="Will update" value={preview.matchedCount} tone="text-emerald-600" />
              <Stat label="Unmatched HR_ID" value={preview.unmatchedCount} tone="text-amber-600" />
              <Stat label="Rows with issues" value={preview.issues.length} tone="text-rose-600" />
            </div>
            {preview.sample.length > 0 ? (
              <div className="px-4 pb-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Sample</p>
                <ul className="mt-1 text-sm text-slate-700">
                  {preview.sample.map((row) => (
                    <li key={row.employeeHrId} className="flex justify-between border-b border-slate-100 py-1">
                      <span>{row.employeeHrId}</span>
                      <span className="font-medium">{egp(row.wage)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {preview.unmatched.length > 0 ? (
              <p className="px-4 pb-2 text-xs text-amber-700">
                Unmatched HR_IDs (skipped): {preview.unmatched.map((u) => u.hrId).join(", ")}
              </p>
            ) : null}
            {preview.issues.length > 0 ? (
              <ul className="px-4 pb-2 text-xs text-rose-700">
                {preview.issues.slice(0, 10).map((issue, index) => (
                  <li key={index}>
                    Row {issue.row}: {issue.message}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex justify-end border-t border-slate-200 p-4">
              <button
                type="button"
                onClick={() => send(true)}
                disabled={busy || preview.matchedCount === 0}
                className="bg-orange-500 px-5 py-2 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
              >
                Apply to {preview.matchedCount} employee(s)
              </button>
            </div>
          </section>
        ) : null}

        {applied ? (
          <div className="border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            Updated {applied.updated} employee(s).{" "}
            {applied.unmatchedCount > 0 ? `${applied.unmatchedCount} HR_ID(s) were unmatched and skipped. ` : ""}
            {applied.failed.length > 0 ? `${applied.failed.length} failed.` : "No failures."}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone ?? "text-slate-900"}`}>{value}</p>
    </div>
  );
}
