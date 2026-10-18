"use client";

import Link from "next/link";
import { Download, Search, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { adminPanelDepthClassName } from "@/components/admin/admin-design-tokens";
import { phxButtonGhostClassName, phxFieldClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import {
  filterHubRows,
  HUB_HAS_LABELS,
  sortHubRows,
  summarizeHubRows,
  type HubHasFilter,
  type HubListFilters,
  type HubListRow,
} from "@/lib/customer-360/list";
import type { HubKind } from "@/lib/customer-360/validated";
import { VERDICT_LABELS, type Verdict } from "@/lib/customer-360/verdict";
import { cn } from "@/lib/utils";

type Tab = HubKind | "matches";

const VERDICT_TONE: Record<Verdict, string> = {
  blacklist: "border-rose-300 bg-rose-50 text-rose-800",
  not_enough_data: "border-slate-300 bg-slate-50 text-slate-600",
  watch: "border-amber-300 bg-amber-50 text-amber-800",
  whitelist: "border-emerald-300 bg-emerald-50 text-emerald-800",
};

const PAGE = 200;

const egp = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;

export function VerdictBadge({ verdict, early }: { verdict: Verdict; early?: boolean }) {
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1 border px-1.5 py-0.5 text-phx-2xs font-black uppercase tracking-wide", VERDICT_TONE[verdict])}>
      {VERDICT_LABELS[verdict]}
      {early ? <span className="font-bold normal-case tracking-normal">· early</span> : null}
    </span>
  );
}

/**
 * Customer 360's list: validated doctors, validated accounts, and (for the Super Admin) the pharmacy
 * names waiting for his decision. Filtering is `filterHubRows`, the same function the Excel export
 * runs, so the file holds exactly the rows on screen.
 */
export function Customer360HubList({
  rows,
  initialFilters,
  initialTab,
  lines,
  moneyVisible,
  canDecideMatches,
  waitingMatches,
  matchesTab,
}: {
  rows: HubListRow[];
  initialFilters: HubListFilters;
  initialTab: Tab;
  lines: string[];
  moneyVisible: boolean;
  canDecideMatches: boolean;
  waitingMatches: number;
  matchesTab: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState(initialFilters.query ?? "");
  const [line, setLine] = useState(initialFilters.line ?? "");
  const [area, setArea] = useState(initialFilters.area ?? "");
  const [verdict, setVerdict] = useState<Verdict | "">(initialFilters.verdict ?? "");
  const [has, setHas] = useState<HubHasFilter>(initialFilters.has ?? "");

  const kind: HubKind = tab === "account" ? "account" : "doctor";
  const filters: HubListFilters = { area, has, kind, line, query, verdict };
  const summary = useMemo(() => summarizeHubRows(rows), [rows]);
  const ofKind = useMemo(() => rows.filter((row) => row.kind === kind), [rows, kind]);
  const areas = useMemo(
    () => [...new Set(ofKind.map((row) => row.areaName).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b)),
    [ofKind],
  );
  const shown = useMemo(() => sortHubRows(filterHubRows(rows, filters)), [rows, area, has, kind, line, query, verdict]); // eslint-disable-line react-hooks/exhaustive-deps

  // Two thousand rows drawn at once make a phone crawl; the list grows on request instead. The limit is
  // kept with the filters it was raised for, so any filter change starts again at one page.
  const filterKey = JSON.stringify([tab, query, line, area, verdict, has]);
  const [paging, setPaging] = useState({ key: filterKey, limit: PAGE });
  const limit = paging.key === filterKey ? paging.limit : PAGE;
  const visible = shown.slice(0, limit);

  const params = new URLSearchParams();
  params.set("kind", kind);
  if (query.trim()) params.set("q", query.trim());
  if (line) params.set("line", line);
  if (area) params.set("area", area);
  if (verdict) params.set("verdict", verdict);
  if (has) params.set("has", has);
  const exportHref = `/api/customer-360/export?${params.toString()}`;

  // The address bar carries the filters, so a link sent to a colleague opens the same list.
  useEffect(() => {
    const next = new URLSearchParams(params);
    if (tab === "matches") next.set("tab", "matches");
    window.history.replaceState(null, "", `/customer-360?${next.toString()}`);
  }, [tab, query, line, area, verdict, has]); // eslint-disable-line react-hooks/exhaustive-deps

  const clear = () => {
    setQuery("");
    setLine("");
    setArea("");
    setVerdict("");
    setHas("");
  };
  const filtered = Boolean(query.trim() || line || area || verdict || has);

  const tabs: { key: Tab; label: string; count: number }[] = [
    { count: summary.doctors, key: "doctor", label: "Doctors" },
    { count: summary.accounts, key: "account", label: "Accounts" },
    ...(canDecideMatches ? [{ count: waitingMatches, key: "matches" as const, label: "Pharmacy matches" }] : []),
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="Validated doctors" value={summary.doctors} />
        <Kpi label="Validated accounts" value={summary.accounts} />
        <Kpi label="Visited by two lines or more" value={summary.twoLines} />
        <Kpi label="With a marketing request" value={summary.withMarketing} />
        <Kpi label="Whitelist" value={summary.verdicts.whitelist} tone="emerald" />
        <Kpi label="Blacklist" value={summary.verdicts.blacklist} tone="rose" />
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Customer 360 views">
        {tabs.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={tab === entry.key}
            onClick={() => setTab(entry.key)}
            className={cn(
              "border px-3 py-1.5 text-phx-xs font-black uppercase tracking-wide transition",
              tab === entry.key ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-600 hover:border-slate-400",
            )}
          >
            {entry.label} <span className="opacity-70">{entry.count}</span>
          </button>
        ))}
      </div>

      {tab === "matches" ? (
        matchesTab
      ) : (
        <>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(4,minmax(0,1fr))]">
            <label className="relative">
              <span className="sr-only">Search</span>
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={kind === "doctor" ? "Search by doctor, speciality, area or brick" : "Search by account, area or brick"}
                className={cn(phxFieldClassName, "pl-9")}
              />
            </label>
            <label>
              <span className="sr-only">Line</span>
              <select value={line} onChange={(event) => setLine(event.target.value)} className={phxSelectClassName}>
                <option value="">All lines</option>
                {lines.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Area</span>
              <select value={area} onChange={(event) => setArea(event.target.value)} className={phxSelectClassName}>
                <option value="">All areas</option>
                {areas.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Verdict</span>
              <select value={verdict} onChange={(event) => setVerdict(event.target.value as Verdict | "")} className={phxSelectClassName}>
                <option value="">Every verdict</option>
                {(Object.keys(VERDICT_LABELS) as Verdict[]).map((entry) => (
                  <option key={entry} value={entry}>
                    {VERDICT_LABELS[entry]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="sr-only">Has</span>
              <select value={has} onChange={(event) => setHas(event.target.value as HubHasFilter)} className={phxSelectClassName}>
                <option value="">Everything linked</option>
                {(Object.keys(HUB_HAS_LABELS) as Array<Exclude<HubHasFilter, "">>).map((entry) => (
                  <option key={entry} value={entry}>
                    {HUB_HAS_LABELS[entry]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 text-xs font-semibold text-slate-500">
            <span>
              {shown.length} of {ofKind.length} {kind === "doctor" ? "doctors" : "accounts"}
            </span>
            <span className="flex flex-wrap items-center gap-3">
              {filtered ? (
                <button type="button" onClick={clear} className="inline-flex items-center gap-1 font-bold text-orange-700 hover:underline">
                  <X aria-hidden className="h-3.5 w-3.5" />
                  Clear
                </button>
              ) : null}
              <a href={exportHref} className={phxButtonGhostClassName}>
                <Download aria-hidden className="h-4 w-4" />
                Export to Excel
              </a>
            </span>
          </div>

          {shown.length === 0 ? (
            <div className="border border-dashed border-slate-300 bg-white p-10 text-center text-sm font-semibold text-slate-500">
              No {kind === "doctor" ? "doctor" : "account"} matches those filters.
            </div>
          ) : (
            <div className="@container space-y-3">
              <HubCards rows={visible} moneyVisible={moneyVisible} />
              <HubTable rows={visible} moneyVisible={moneyVisible} />
              {shown.length > visible.length ? (
                <button type="button" onClick={() => setPaging({ key: filterKey, limit: limit + PAGE })} className={phxButtonGhostClassName}>
                  Show {Math.min(PAGE, shown.length - visible.length)} more of the {shown.length - visible.length} left
                </button>
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: "emerald" | "rose" }) {
  return (
    <div className={cn("border border-slate-200 bg-white p-3", adminPanelDepthClassName)}>
      <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className={cn("mt-1 text-2xl font-black tracking-tight", tone === "emerald" ? "text-emerald-700" : tone === "rose" ? "text-rose-700" : "text-slate-900")}>
        {value.toLocaleString("en-US")}
      </p>
    </div>
  );
}

function place(row: HubListRow): string {
  return [row.brickName, row.areaName, row.regionName].filter(Boolean).join(" · ") || "No place recorded";
}

function linesText(row: HubListRow): string {
  return row.linesVisiting.length > 0 ? row.linesVisiting.join(" · ") : "No visits on record";
}

function marketingText(row: HubListRow, moneyVisible: boolean): string {
  if (row.requests === 0) return "None";
  const count = `${row.requests} ${row.requests === 1 ? "request" : "requests"}`;
  return moneyVisible && row.marketingCost !== null ? `${count} · ${egp(row.marketingCost)}` : count;
}

function pharmaciesText(row: HubListRow): string {
  if (row.pharmacies === 0) return "None linked";
  return `${row.pharmacies} linked · ${row.pharmaciesSelling} selling`;
}

/** Desktop: a fixed table that fits its container — merged columns, never a horizontal scroll. */
function HubTable({ rows, moneyVisible }: { rows: HubListRow[]; moneyVisible: boolean }) {
  return (
    <table className={cn("hidden w-full table-fixed border border-slate-200 bg-white text-left text-xs @min-[880px]:table", adminPanelDepthClassName)}>
      <colgroup>
        <col className="w-[28%]" />
        <col className="w-[14%]" />
        <col className="w-[14%]" />
        <col className="w-[14%]" />
        <col className="w-[12%]" />
        <col className="w-[18%]" />
      </colgroup>
      <thead className="border-b border-slate-200 bg-slate-50 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
        <tr>
          <th className="px-3 py-2">Customer</th>
          <th className="px-3 py-2">Lines visiting</th>
          <th className="px-3 py-2">Pharmacies</th>
          <th className="px-3 py-2">Marketing</th>
          <th className="px-3 py-2 text-right">Sales, last 3 months</th>
          <th className="px-3 py-2">Verdict</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row) => (
          <tr key={row.id} className="align-top hover:bg-slate-50">
            <td className="px-3 py-2">
              <Link dir="auto" href={row.href} className="block break-words text-sm font-bold text-slate-900 hover:text-orange-700 hover:underline">
                {row.name}
              </Link>
              <p className="break-words text-slate-500">{[row.speciality, row.dropped ? "Dropped from the list" : null].filter(Boolean).join(" · ")}</p>
              <p className="break-words text-slate-500">{place(row)}</p>
            </td>
            <td className="break-words px-3 py-2 text-slate-700">{linesText(row)}</td>
            <td className="break-words px-3 py-2 text-slate-700">
              {pharmaciesText(row)}
              {row.directOrderVenues > 0 ? <p className="text-slate-500">Direct orders: {egp(row.directOrderValue)}</p> : null}
            </td>
            <td className="break-words px-3 py-2 text-slate-700">{marketingText(row, moneyVisible)}</td>
            <td className="break-words px-3 py-2 text-right font-bold tabular-nums text-slate-900">{egp(row.salesLast3)}</td>
            <td className="px-3 py-2">
              <VerdictBadge verdict={row.verdict} early={row.early} />
              {row.headline ? <p className="mt-1 break-words text-slate-500">{row.headline}</p> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Narrow: one card per customer. */
function HubCards({ rows, moneyVisible }: { rows: HubListRow[]; moneyVisible: boolean }) {
  return (
    <ul className="grid grid-cols-1 gap-3 @min-[560px]:grid-cols-2 @min-[880px]:hidden">
      {rows.map((row) => (
        <li key={row.id}>
          <Link href={row.href} className={cn("block h-full space-y-1.5 border border-slate-200 bg-white p-3 text-xs text-slate-600 hover:border-orange-300", adminPanelDepthClassName)}>
            <p dir="auto" className="break-words text-sm font-bold text-slate-900">
              {row.name}
            </p>
            <VerdictBadge verdict={row.verdict} early={row.early} />
            <p className="break-words">{place(row)}</p>
            <p className="break-words">Lines: {linesText(row)}</p>
            <p className="break-words">Pharmacies: {pharmaciesText(row)}</p>
            <p className="break-words">Marketing: {marketingText(row, moneyVisible)}</p>
            <p className="font-bold text-slate-900">Sales, last 3 months: {egp(row.salesLast3)}</p>
          </Link>
        </li>
      ))}
    </ul>
  );
}
