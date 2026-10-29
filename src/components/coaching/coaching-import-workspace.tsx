"use client";

import { useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, UploadCloud, UserX } from "lucide-react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminSectionHeader,
} from "@/components/admin/admin-design-system";
import { adminPanelClassName } from "@/components/admin/admin-design-tokens";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type {
  CoachingImportClassifiedRow,
  CoachingImportCommitResult,
  CoachingImportPreview,
} from "@/lib/coaching/import";

type ApiResponse<T> = {
  data?: T;
  error?: string;
  fileName?: string;
  message?: string;
  success: boolean;
};

type TabKey = "matched" | "duplicate" | "archived" | "skipped";

function scoreSum(scores: Record<string, number>) {
  return Object.values(scores).reduce((total, value) => total + (Number(value) || 0), 0);
}

const tabLabels: Record<TabKey, string> = {
  archived: "Resigned / Unmatched",
  duplicate: "Duplicates",
  matched: "Ready to Import",
  skipped: "Needs Fixing",
};

export function CoachingImportWorkspace() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CoachingImportPreview | null>(null);
  const [result, setResult] = useState<CoachingImportCommitResult | null>(null);
  const [tab, setTab] = useState<TabKey>("matched");
  const [busy, setBusy] = useState<"idle" | "previewing" | "committing">("idle");
  const [error, setError] = useState<string | null>(null);

  const rowsByTab = useMemo(() => {
    const groups: Record<TabKey, CoachingImportClassifiedRow[]> = {
      archived: [],
      duplicate: [],
      matched: [],
      skipped: [],
    };
    for (const row of preview?.rows ?? []) groups[row.classification].push(row);
    return groups;
  }, [preview]);

  async function runPreview(selected: File) {
    setBusy("previewing");
    setError(null);
    setResult(null);
    setPreview(null);
    try {
      const formData = new FormData();
      formData.append("file", selected);
      const response = await fetch("/api/coaching/import/preview", { body: formData, method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as ApiResponse<CoachingImportPreview>;
      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(payload.message || "Failed to read the coaching workbook.");
      }
      setPreview(payload.data);
      setTab(
        payload.data.totals.matched > 0
          ? "matched"
          : payload.data.totals.duplicate > 0
            ? "duplicate"
            : payload.data.totals.archived > 0
              ? "archived"
              : "skipped",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to read the coaching workbook.");
    } finally {
      setBusy("idle");
    }
  }

  async function runCommit() {
    if (!file) return;
    setBusy("committing");
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/coaching/import/commit", { body: formData, method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as ApiResponse<CoachingImportCommitResult>;
      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(payload.message || "Failed to import coaching reports.");
      }
      setResult(payload.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to import coaching reports.");
    } finally {
      setBusy("idle");
    }
  }

  function onSelect(selected: File | null) {
    setFile(selected);
    setResult(null);
    setPreview(null);
    if (selected) void runPreview(selected);
  }

  const totals = preview?.totals;

  return (
    <div className="space-y-6">
      <Card className={cn(adminPanelClassName, "p-0 overflow-hidden")}>
        <AdminSectionHeader
          description="Upload a Field Coaching Report workbook (.xlsx). Scores are read exactly as written (0–5). Reps with no/unknown HR-ID are treated as resigned and archived separately."
          title="Upload coaching workbook"
        />
        <div className="p-5 sm:p-6">
          <label
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-phx-line-strong bg-phx-paper px-6 py-10 text-center transition hover:border-phx-accent-line hover:bg-phx-accent-soft"
            htmlFor="coaching-import-file"
          >
            <UploadCloud className="h-8 w-8 text-phx-accent" />
            <span className="text-sm font-black text-phx-ink">
              {file ? file.name : "Click to choose an .xlsx coaching workbook"}
            </span>
            <span className="text-xs font-semibold text-phx-ink-soft">Max 4 MB · the first sheet is read</span>
            <input
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              id="coaching-import-file"
              onChange={(event) => onSelect(event.target.files?.[0] ?? null)}
              ref={inputRef}
              type="file"
            />
          </label>

          {busy === "previewing" ? (
            <p className="mt-4 flex items-center gap-2 text-sm font-semibold text-phx-ink-soft">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading workbook…
            </p>
          ) : null}

          {error ? (
            <div className="mt-4">
              <AdminCallout tone="danger">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </AdminCallout>
            </div>
          ) : null}
        </div>
      </Card>

      {preview && totals ? (
        <Card className={cn(adminPanelClassName, "p-0 overflow-hidden")}>
          <AdminSectionHeader
            action={
              <button
                className="inline-flex items-center justify-center gap-2 rounded-full bg-phx-accent px-5 py-2.5 text-sm font-black text-white shadow-[0_18px_42px_rgba(249,115,22,0.22)] transition hover:bg-phx-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy !== "idle" || totals.matched + totals.archived === 0 || Boolean(result)}
                onClick={() => void runCommit()}
                type="button"
              >
                {busy === "committing" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                {result ? "Imported" : `Confirm & import (${totals.matched} report${totals.matched === 1 ? "" : "s"})`}
              </button>
            }
            description={`Sheet "${preview.sheetName ?? "—"}" · ${totals.total} rows parsed. Review before importing — duplicates are flagged and skipped; imported reports are submitted and auto-acknowledged by the rep, with no notifications sent.`}
            title="Preview"
          />
          <div className="flex flex-wrap gap-2 px-5 pt-5 sm:px-6">
            <AdminInsightChip surface="light" tone="emerald">{totals.matched} to import</AdminInsightChip>
            <AdminInsightChip surface="light" tone="slate">{totals.duplicate} duplicate</AdminInsightChip>
            <AdminInsightChip surface="light" tone="orange">{totals.archived} resigned / archived</AdminInsightChip>
            <AdminInsightChip surface="light" tone="slate">{totals.skipped} need fixing</AdminInsightChip>
          </div>

          <div className="flex flex-wrap gap-1.5 px-5 pt-4 sm:px-6">
            {(Object.keys(tabLabels) as TabKey[]).map((key) => (
              <button
                className={cn(
                  "rounded-full border px-4 py-1.5 text-xs font-black transition",
                  tab === key
                    ? "border-phx-accent bg-phx-accent text-white"
                    : "border-phx-line bg-white text-phx-ink-2 hover:border-phx-accent-line",
                )}
                key={key}
                onClick={() => setTab(key)}
                type="button"
              >
                {tabLabels[key]} ({rowsByTab[key].length})
              </button>
            ))}
          </div>

          <div className="p-5 sm:p-6">
            <PreviewTable rows={rowsByTab[tab]} tab={tab} />
          </div>
        </Card>
      ) : null}

      {result ? <CommitSummary result={result} /> : null}
    </div>
  );
}

function PreviewTable({ rows, tab }: { rows: CoachingImportClassifiedRow[]; tab: TabKey }) {
  if (rows.length === 0) {
    return <p className="text-sm font-semibold text-phx-ink-soft">No rows in this group.</p>;
  }

  const lastHeading = tab === "matched" ? "Matched employee" : "Reason";
  const lastCell = (row: CoachingImportClassifiedRow) =>
    tab === "matched"
      ? (row.resolvedName ?? "—")
      : tab === "duplicate"
        ? row.duplicateReason
        : tab === "archived"
          ? row.unmatchedReason
          : row.issues.join("; ");
  const dateCell = (row: CoachingImportClassifiedRow) => (
    <>
      {row.coachingDate ?? <span className="text-rose-600">{row.coachingDateRaw || "missing"}</span>}
      {row.dateCorrected ? (
        <span className="ml-1.5 inline-flex items-center bg-phx-accent-soft px-1.5 py-0.5 text-phx-2xs font-bold text-phx-accent-press" title={`Auto-adjusted from ${row.coachingDateRaw} (day/month swapped to day-first)`}>
          adjusted
        </span>
      ) : null}
    </>
  );
  const scoreCell = (row: CoachingImportClassifiedRow) => {
    const sum = scoreSum(row.scores);
    return Object.keys(row.scores).length === 20 ? sum : <span className="text-rose-600">{sum} (incomplete)</span>;
  };

  return (
    <>
      <table className="hidden w-full table-fixed border-collapse text-left md:table">
        <colgroup>
          <col className="w-[7%]" />
          <col className="w-[22%]" />
          <col className="w-[16%]" />
          <col className="w-[17%]" />
          <col className="w-[12%]" />
          <col className="w-[26%]" />
        </colgroup>
        <thead className="bg-phx-ink text-phx-xs font-black uppercase tracking-[0.12em] text-white">
          <tr>
            <th className="px-3 py-3">Row</th>
            <th className="px-3 py-3">Rep</th>
            <th className="px-3 py-3">Territory</th>
            <th className="px-3 py-3">Coaching date</th>
            <th className="px-3 py-3">Overall (/100)</th>
            <th className="px-3 py-3">{lastHeading}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className="border-t border-[#FCE7D2] bg-white text-sm hover:bg-[#FFFBF7]" key={row.rowNumber}>
              <td className="px-3 py-3 font-bold text-phx-ink-soft">{row.rowNumber}</td>
              <td className="break-words px-3 py-3 font-bold text-phx-ink">{row.repName ?? row.sourceName}</td>
              <td className="break-words px-3 py-3 text-phx-ink-2">{row.territory ?? "—"}</td>
              <td className="break-words px-3 py-3 text-phx-ink-2">{dateCell(row)}</td>
              <td className="px-3 py-3 font-black text-phx-ink">{scoreCell(row)}</td>
              <td className={cn("break-words px-3 py-3", tab === "matched" ? "text-phx-ink-2" : "text-[#94532B]")}>{lastCell(row) || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="space-y-2 md:hidden">
        {rows.map((row) => (
          <div className="min-w-0 break-words border border-phx-line bg-white p-3 text-sm" key={row.rowNumber}>
            <p className="font-black text-phx-ink">
              {row.repName ?? row.sourceName} <span className="font-bold text-phx-ink-soft">· row {row.rowNumber}</span>
            </p>
            <p className="text-phx-ink-2">Territory: {row.territory ?? "—"}</p>
            <p className="text-phx-ink-2">Coaching date: {dateCell(row)}</p>
            <p className="font-black text-phx-ink">Overall: {scoreCell(row)}</p>
            <p className={tab === "matched" ? "text-phx-ink-2" : "text-[#94532B]"}>
              {lastHeading}: {lastCell(row) || "—"}
            </p>
          </div>
        ))}
      </div>
    </>
  );
}

function CommitSummary({ result }: { result: CoachingImportCommitResult }) {
  return (
    <Card className={cn(adminPanelClassName, "p-0 overflow-hidden")}>
      <AdminSectionHeader
        description="Historical coaching reports were created as submitted and auto-acknowledged by the rep (no notifications). Resigned-rep evaluations were archived."
        title="Import complete"
      />
      <div className="grid gap-3 p-5 sm:grid-cols-2 sm:p-6">
        <AdminCallout tone="success">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>{result.created.length}</strong> coaching report{result.created.length === 1 ? "" : "s"} imported &amp; auto-acknowledged.
          </span>
        </AdminCallout>
        <AdminCallout tone="warning">
          <UserX className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>{result.archived}</strong> resigned-rep evaluation{result.archived === 1 ? "" : "s"} archived.
          </span>
        </AdminCallout>
        {result.duplicates.length > 0 ? (
          <AdminCallout tone="neutral">
            <FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0" />
            <span><strong>{result.duplicates.length}</strong> row(s) skipped as duplicates (already present).</span>
          </AdminCallout>
        ) : null}
        {result.skipped.length > 0 ? (
          <AdminCallout tone="neutral">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span><strong>{result.skipped.length}</strong> row(s) need fixing in the sheet and were not imported.</span>
          </AdminCallout>
        ) : null}
        {result.errors.length > 0 ? (
          <AdminCallout tone="danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span><strong>{result.errors.length}</strong> row(s) failed: {result.errors.map((e) => `#${e.rowNumber} ${e.error}`).join(" · ")}</span>
          </AdminCallout>
        ) : null}
      </div>
    </Card>
  );
}
