"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, ArrowUpDown, Link2, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";
import type {
  DoubleVisitIntegrityIssue,
  DoubleVisitIntegrityIssueType,
  DoubleVisitIntegrityReport,
} from "@/lib/double-visit-analytics/types";

const ALL = "ALL";

const ISSUE_TYPE_LABELS: Record<DoubleVisitIntegrityIssueType, string> = {
  double_visitor_unmapped: "Unmapped Double Visitor",
  visited_blank_or_unmapped: "Unmapped Visited MR",
  visited_is_manager: "Visited Party Is a Manager",
  visited_resigned: "Visited MR Resigned",
  visited_vacant_seat: "Vacant Seat Visited",
};

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function SortHeader<T extends string>({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = "left",
}: {
  activeKey: T;
  align?: "left" | "right";
  dir: "asc" | "desc";
  label: string;
  onSort: (key: T) => void;
  sortKey: T;
}) {
  const isActive = activeKey === sortKey;
  return (
    <th className={cn("px-3 py-3", align === "right" ? "text-right" : "text-left")}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider transition-colors hover:text-orange-400",
          isActive ? "text-orange-400" : "text-slate-300",
          align === "right" && "flex-row-reverse",
        )}
      >
        {label}
        {isActive ? dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" /> : <ArrowUpDown className="h-3 w-3 opacity-40" />}
      </button>
    </th>
  );
}

type SortKey = "date" | "issue" | "visitor" | "visited" | "area" | "line" | "source" | "visits";

export function DoubleVisitDataIntegrityWorkspace({ report }: { report: DoubleVisitIntegrityReport }) {
  const [search, setSearch] = useState("");
  const [issueTypeFilter, setIssueTypeFilter] = useState<DoubleVisitIntegrityIssueType | typeof ALL>(ALL);
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return report.issues.filter((issue) => {
      if (issueTypeFilter !== ALL && issue.issueType !== issueTypeFilter) return false;
      if (!term) return true;
      return (
        (issue.doubleVisitorName ?? "").toLowerCase().includes(term) ||
        (issue.doubleVisitorHrIdRaw ?? "").toLowerCase().includes(term) ||
        (issue.visitedName ?? "").toLowerCase().includes(term) ||
        (issue.visitedHrIdRaw ?? "").toLowerCase().includes(term)
      );
    });
  }, [report.issues, search, issueTypeFilter]);

  const sorted = useMemo(() => {
    const value = (issue: DoubleVisitIntegrityIssue): string | number => {
      switch (sortKey) {
        case "date": return issue.activityDate;
        case "issue": return issue.issueType;
        case "visitor": return issue.doubleVisitorName ?? issue.doubleVisitorHrIdRaw ?? "";
        case "visited": return issue.visitedName ?? issue.visitedHrIdRaw ?? "";
        case "area": return issue.areaName ?? "";
        case "line": return issue.lineName ?? "";
        case "source": return issue.sourceFilename ?? "";
        case "visits": return issue.visitCount;
      }
    };
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  function onSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const exportColumns: ExportColumn[] = [
    { key: "date", label: "Date" },
    { key: "issue", label: "Issue" },
    { key: "visitor", label: "Double Visitor (as recorded)" },
    { key: "visitorHrId", label: "Double Visitor HR ID (raw)" },
    { key: "visited", label: "Visited MR (as recorded)" },
    { key: "visitedHrId", label: "Visited HR ID (raw)" },
    { key: "status", label: "Visited Status" },
    { key: "area", label: "Area" },
    { key: "line", label: "Line" },
    { key: "source", label: "Source File" },
    { key: "visits", label: "Visits", numeric: true },
  ];
  const exportRows: ExportRow[] = sorted.map((issue) => ({
    date: issue.activityDate,
    issue: ISSUE_TYPE_LABELS[issue.issueType],
    visitor: issue.doubleVisitorName ?? "—",
    visitorHrId: issue.doubleVisitorHrIdRaw ?? "—",
    visited: issue.visitedName ?? "—",
    visitedHrId: issue.visitedHrIdRaw ?? "—",
    status: issue.visitedStatus,
    area: issue.areaName ?? "—",
    line: issue.lineName ?? "—",
    source: issue.sourceFilename ?? "—",
    visits: issue.visitCount,
  }));

  const totalIssues = report.issues.length;

  const recovered = report.recoveredChains ?? [];
  const recoveredVisits = recovered.reduce((sum, chain) => sum + chain.visitCount, 0);
  const recoveredExportColumns: ExportColumn[] = [
    { key: "date", label: "Date" },
    { key: "creditedManager", label: "Credited Manager" },
    { key: "creditedManagerHrId", label: "Credited Manager HR ID" },
    { key: "viaManager", label: "Via (hinge manager)" },
    { key: "viaManagerHrId", label: "Via HR ID" },
    { key: "resolvedMr", label: "Resolved MR" },
    { key: "resolvedMrHrId", label: "Resolved MR HR ID" },
    { key: "area", label: "Area" },
    { key: "line", label: "Line" },
    { key: "customers", label: "Customer Sample" },
    { key: "visits", label: "Visits", numeric: true },
  ];
  const recoveredExportRows: ExportRow[] = recovered.map((chain) => ({
    date: chain.activityDate,
    creditedManager: chain.higherManagerName ?? "—",
    creditedManagerHrId: chain.higherManagerHrId ?? "—",
    viaManager: chain.hingeManagerName ?? "—",
    viaManagerHrId: chain.hingeManagerHrId ?? "—",
    resolvedMr: chain.resolvedMrName ?? "—",
    resolvedMrHrId: chain.resolvedMrHrId ?? "—",
    area: chain.areaName ?? "—",
    line: chain.lineName ?? "—",
    customers: chain.customerSample.join(", ") || "—",
    visits: chain.visitCount,
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">Data governance</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">Double Visit Data Integrity</h1>
          <p className="mt-2 max-w-3xl text-sm font-medium text-slate-600">
            Every recorded double visit that could not be confidently attributed or counted — {totalIssues} of {report.totalRowsScanned}{" "}
            rows scanned, all time. Nothing here is excluded from the numbers automatically; review each and decide.
          </p>
        </div>
        <ExportXlsxButton title="Double Visit Data Integrity" subtitle={`${totalIssues} flagged rows`} sheetName="Data Integrity" columns={exportColumns} rows={exportRows} />
      </div>

      {!report.schemaReady ? (
        <div className="border border-slate-200 bg-white px-5 py-8 text-center text-sm text-slate-500">
          Double Visit Analytics tables are not provisioned yet.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-px bg-slate-200 sm:grid-cols-3 lg:grid-cols-5">
            {(Object.keys(ISSUE_TYPE_LABELS) as DoubleVisitIntegrityIssueType[]).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setIssueTypeFilter((prev) => (prev === type ? ALL : type))}
                className={cn(
                  "bg-white px-4 py-4 text-left transition-colors hover:bg-orange-50",
                  issueTypeFilter === type && "bg-orange-50 ring-1 ring-inset ring-orange-300",
                )}
              >
                <p className="text-2xl font-black text-slate-900">{report.countsByType[type]}</p>
                <p className="mt-1 text-[10px] font-semibold uppercase leading-tight tracking-wide text-slate-500">
                  {ISSUE_TYPE_LABELS[type]}
                </p>
              </button>
            ))}
          </div>

          {recovered.length > 0 && (
            <div className="overflow-hidden border border-slate-200 bg-white">
              <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900 px-5 py-3">
                <div>
                  <h2 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-emerald-300">
                    <Link2 className="h-3.5 w-3.5" />
                    Recovered Via Chain
                  </h2>
                  <p className="mt-1 max-w-3xl text-[11px] font-medium leading-snug text-slate-300">
                    {recovered.length} double {recovered.length === 1 ? "visit" : "visits"} ({recoveredVisits} activity{" "}
                    {recoveredVisits === 1 ? "count" : "counts"}) that looked like a manager visiting a manager were
                    re-credited to the real Medical Rep the convoy actually saw — matched by the same-day double visit
                    the hinge manager performed. No longer counted as defects.
                  </p>
                </div>
                <ExportXlsxButton
                  title="Double Visit Recovered Chains"
                  subtitle={`${recovered.length} recovered rows`}
                  sheetName="Recovered Chains"
                  columns={recoveredExportColumns}
                  rows={recoveredExportRows}
                />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[960px] text-left text-sm">
                  <thead className="bg-slate-900">
                    <tr>
                      <th className="px-3 py-3 text-left text-[10px] font-black uppercase tracking-wider text-slate-300">Date</th>
                      <th className="px-3 py-3 text-left text-[10px] font-black uppercase tracking-wider text-slate-300">Credited Manager</th>
                      <th className="px-3 py-3 text-left text-[10px] font-black uppercase tracking-wider text-slate-300">Resolved Chain</th>
                      <th className="px-3 py-3 text-left text-[10px] font-black uppercase tracking-wider text-slate-300">Area</th>
                      <th className="px-3 py-3 text-left text-[10px] font-black uppercase tracking-wider text-slate-300">Line</th>
                      <th className="px-3 py-3 text-right text-[10px] font-black uppercase tracking-wider text-slate-300">Visits</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-orange-100">
                    {recovered.map((chain, index) => (
                      <tr key={chain.id} className={index % 2 === 0 ? "bg-white" : "bg-emerald-50/30"}>
                        <td className="whitespace-nowrap px-3 py-2.5">{formatDate(chain.activityDate)}</td>
                        <td className="px-3 py-2.5">
                          <p className="font-medium text-slate-900">{chain.higherManagerName ?? "—"}</p>
                          <p className="text-[11px] text-slate-400">{chain.higherManagerHrId ?? "no HR ID"}</p>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-slate-600">
                            <span className="whitespace-nowrap text-slate-400">{chain.hingeManagerName ?? "hinge manager"}</span>
                            <ArrowRight className="h-3 w-3 text-emerald-500" />
                            <span className="inline-flex items-center gap-1 whitespace-nowrap bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700">
                              {chain.resolvedMrName ?? chain.resolvedMrHrId ?? "MR"}
                            </span>
                          </div>
                          {chain.customerSample.length > 0 && (
                            <p className="mt-1 text-[10px] text-slate-400">{chain.customerSample.join(" · ")}</p>
                          )}
                        </td>
                        <td className="px-3 py-2.5">{chain.areaName ?? "—"}</td>
                        <td className="px-3 py-2.5">{chain.lineName ?? "—"}</td>
                        <td className="px-3 py-2.5 text-right font-bold tabular-nums">{chain.visitCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {report.importSummaries.length > 0 && (
            <div className="overflow-hidden border border-slate-200 bg-white">
              <div className="bg-slate-900 px-5 py-3">
                <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">
                  Imports With Dropped or Flagged Rows
                </h2>
              </div>
              <div className="divide-y divide-slate-100">
                {report.importSummaries.map((importRow) => (
                  <div key={importRow.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                    <div>
                      <p className="font-semibold text-slate-900">{importRow.sourceFilename}</p>
                      <p className="text-[11px] text-slate-500">
                        {formatDate(importRow.uploadedAt)} · {importRow.sourceType} · {importRow.status} · {importRow.totalRows} rows
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-3 text-[11px] font-bold uppercase tracking-wide">
                      {importRow.duplicateWarningCount > 0 && (
                        <span className="text-amber-600">{importRow.duplicateWarningCount} duplicate rows dropped</span>
                      )}
                      {importRow.vacantOrUnmappedVisitCount > 0 && (
                        <span className="text-rose-600">{importRow.vacantOrUnmappedVisitCount} vacant/unmapped</span>
                      )}
                      {importRow.missingVisitedHrIdCount > 0 && (
                        <span className="text-rose-600">{importRow.missingVisitedHrIdCount} missing visited HR ID</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3 border border-slate-200 bg-white px-4 py-3">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search name or HR ID…"
                className="h-9 w-full border border-[#D8E0EA] bg-white pl-8 pr-2 text-sm text-slate-800"
              />
            </div>
            <select
              value={issueTypeFilter}
              onChange={(event) => setIssueTypeFilter(event.target.value as DoubleVisitIntegrityIssueType | typeof ALL)}
              className="h-9 border border-[#D8E0EA] bg-white px-2 text-sm text-slate-700"
            >
              <option value={ALL}>All issue types</option>
              {(Object.keys(ISSUE_TYPE_LABELS) as DoubleVisitIntegrityIssueType[]).map((type) => (
                <option key={type} value={type}>{ISSUE_TYPE_LABELS[type]}</option>
              ))}
            </select>
          </div>

          <div className="overflow-x-auto border border-slate-200 bg-white">
            <table className="w-full min-w-[1080px] text-left text-sm">
              <thead className="bg-slate-900">
                <tr>
                  <SortHeader label="Date" sortKey="date" activeKey={sortKey} dir={sortDir} onSort={onSort} />
                  <SortHeader label="Issue" sortKey="issue" activeKey={sortKey} dir={sortDir} onSort={onSort} />
                  <SortHeader label="Double Visitor" sortKey="visitor" activeKey={sortKey} dir={sortDir} onSort={onSort} />
                  <SortHeader label="Visited" sortKey="visited" activeKey={sortKey} dir={sortDir} onSort={onSort} />
                  <SortHeader label="Area" sortKey="area" activeKey={sortKey} dir={sortDir} onSort={onSort} />
                  <SortHeader label="Line" sortKey="line" activeKey={sortKey} dir={sortDir} onSort={onSort} />
                  <SortHeader label="Source File" sortKey="source" activeKey={sortKey} dir={sortDir} onSort={onSort} />
                  <SortHeader label="Visits" sortKey="visits" activeKey={sortKey} dir={sortDir} onSort={onSort} align="right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-100">
                {sorted.length === 0 ? (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-slate-500">No flagged rows match these filters.</td></tr>
                ) : (
                  sorted.map((issue, index) => (
                    <tr key={issue.id} className={index % 2 === 0 ? "bg-white" : "bg-orange-50/30"}>
                      <td className="whitespace-nowrap px-3 py-2.5">{formatDate(issue.activityDate)}</td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap bg-rose-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-700">
                          <AlertTriangle className="h-3 w-3" />
                          {ISSUE_TYPE_LABELS[issue.issueType]}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-slate-900">{issue.doubleVisitorName ?? "—"}</p>
                        <p className="text-[11px] text-slate-400">{issue.doubleVisitorHrIdRaw ?? "no HR ID recorded"}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="font-medium text-slate-900">{issue.visitedName ?? "—"}</p>
                        <p className="text-[11px] text-slate-400">{issue.visitedHrIdRaw ?? "no HR ID recorded"}</p>
                      </td>
                      <td className="px-3 py-2.5">{issue.areaName ?? "—"}</td>
                      <td className="px-3 py-2.5">{issue.lineName ?? "—"}</td>
                      <td className="px-3 py-2.5">{issue.sourceFilename ?? "—"}</td>
                      <td className="px-3 py-2.5 text-right font-bold tabular-nums">{issue.visitCount}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
