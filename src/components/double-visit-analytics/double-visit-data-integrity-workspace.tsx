"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Search } from "lucide-react";

import { cn } from "@/lib/utils";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";
import type {
  DoubleVisitIntegrityIssue,
  DoubleVisitIntegrityIssueType,
  DoubleVisitIntegrityReport,
} from "@/lib/double-visit-analytics/types";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { humanizeCode } from "@/lib/format/code-label";
import { CrmCard, CrmCardsOnPhone, CrmFacts, CrmTable } from "@/components/phoenix-crm/ui";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";

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
  return formatStableEnGb(new Date(value), { day: "2-digit", month: "short", year: "numeric" });
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
          "inline-flex items-center gap-1 text-phx-sm font-black uppercase tracking-wider transition-colors hover:text-orange-400",
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

function IssueBadge({ issue }: { issue: DoubleVisitIntegrityIssue }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 break-words bg-rose-50 px-2 py-0.5 text-phx-sm font-bold uppercase tracking-wide text-rose-700">
      <AlertTriangle className="h-3 w-3 shrink-0" />
      {ISSUE_TYPE_LABELS[issue.issueType]}
    </span>
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
                <p className="mt-1 text-phx-sm font-semibold uppercase leading-tight tracking-wide text-slate-500">
                  {ISSUE_TYPE_LABELS[type]}
                </p>
              </button>
            ))}
          </div>

          {report.importSummaries.length > 0 && (
            <div className="overflow-hidden border border-slate-200 bg-white">
              <div className="bg-slate-900 px-5 py-3">
                <h2 className="text-phx-sm font-bold uppercase tracking-widest text-slate-300">
                  Imports With Dropped or Flagged Rows
                </h2>
              </div>
              <div className="divide-y divide-slate-100">
                {report.importSummaries.map((importRow) => (
                  <div key={importRow.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                    <div>
                      <p className="font-semibold text-slate-900">{importRow.sourceFilename}</p>
                      <p className="text-phx-md text-slate-500">
                        {formatDate(importRow.uploadedAt)} · {humanizeCode(importRow.sourceType)} · {humanizeCode(importRow.status)} · {importRow.totalRows} rows
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-3 text-phx-md font-bold uppercase tracking-wide">
                      {importRow.duplicateWarningCount > 0 && (
                        <span className="text-amber-600">{importRow.duplicateWarningCount} duplicate rows dropped</span>
                      )}
                      {importRow.vacantOrUnmappedVisitCount > 0 && (
                        <span className="text-rose-600">{importRow.vacantOrUnmappedVisitCount} vacant/unmapped</span>
                      )}
                      {importRow.missingVisitedHrIdCount > 0 && (
                        <span className="text-rose-600">{importRow.missingVisitedHrIdCount} with no visited person recorded</span>
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
                placeholder="Search name…"
                className={cn(phxFieldClassName, "pl-8")}
              />
            </div>
            <select
              value={issueTypeFilter}
              onChange={(event) => setIssueTypeFilter(event.target.value as DoubleVisitIntegrityIssueType | typeof ALL)}
              className={phxSelectClassName}
            >
              <option value={ALL}>All issue types</option>
              {(Object.keys(ISSUE_TYPE_LABELS) as DoubleVisitIntegrityIssueType[]).map((type) => (
                <option key={type} value={type}>{ISSUE_TYPE_LABELS[type]}</option>
              ))}
            </select>
          </div>

          {sorted.length === 0 ? (
            <div className="border border-slate-200 bg-white px-3 py-8 text-center text-sm text-slate-500">No flagged rows match these filters.</div>
          ) : (
            <div className="border border-slate-200 bg-white">
              <CrmTable columns={["10%", "15%", "16%", "16%", "11%", "10%", "14%", "8%"]}>
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
                  {sorted.map((issue, index) => (
                    <tr key={issue.id} className={index % 2 === 0 ? "bg-white" : "bg-orange-50/30"}>
                      <td className="min-w-0 break-words px-3 py-2.5">{formatDate(issue.activityDate)}</td>
                      <td className="min-w-0 px-3 py-2.5">
                        <IssueBadge issue={issue} />
                      </td>
                      <td className="min-w-0 break-words px-3 py-2.5 font-medium text-slate-900">{issue.doubleVisitorName ?? "—"}</td>
                      <td className="min-w-0 break-words px-3 py-2.5 font-medium text-slate-900">{issue.visitedName ?? "—"}</td>
                      <td className="min-w-0 break-words px-3 py-2.5">{issue.areaName ?? "—"}</td>
                      <td className="min-w-0 break-words px-3 py-2.5">{issue.lineName ?? "—"}</td>
                      <td className="min-w-0 break-words px-3 py-2.5">{issue.sourceFilename ?? "—"}</td>
                      <td className="px-3 py-2.5 text-right font-bold tabular-nums">{issue.visitCount}</td>
                    </tr>
                  ))}
                </tbody>
              </CrmTable>
              <CrmCardsOnPhone>
                {sorted.map((issue) => (
                  <CrmCard key={issue.id} meta={formatDate(issue.activityDate)} status={<IssueBadge issue={issue} />} title={issue.doubleVisitorName ?? "—"}>
                    <CrmFacts
                      facts={[
                        { label: "Visited", value: issue.visitedName ?? "—" },
                        { label: "Visits", value: issue.visitCount },
                        { label: "Area", value: issue.areaName ?? "—" },
                        { label: "Line", value: issue.lineName ?? "—" },
                        { label: "Source file", value: issue.sourceFilename ?? "—" },
                      ]}
                    />
                  </CrmCard>
                ))}
              </CrmCardsOnPhone>
            </div>
          )}
        </>
      )}
    </div>
  );
}
