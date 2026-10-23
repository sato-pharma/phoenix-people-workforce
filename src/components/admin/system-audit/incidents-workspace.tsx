"use client";

import { AlertTriangle, ChevronLeft, ChevronRight, Download, Loader2 } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { IncidentDrawer } from "@/components/admin/system-audit/incident-drawer";
import { IncidentsFilters, type IncidentFilters, type PersonOption } from "@/components/admin/system-audit/incidents-filters";
import { IncidentsTable } from "@/components/admin/system-audit/incidents-table";
import { phxButtonGhostClassName } from "@/components/ui/form-tokens";
import { incidentTotalsLine } from "@/lib/system-audit/incidents-display";
import {
  SYSTEM_AUDIT_MAX_OFFSET,
  SYSTEM_AUDIT_PAGE_SIZE,
  SYSTEM_AUDIT_SCREEN_ROW_CAP,
  systemAuditQueryToParams,
  type SystemAuditQuery,
} from "@/lib/system-audit/page-query";
import type { SystemAuditPage, SystemAuditSort } from "@/lib/system-audit/types";
import { cn } from "@/lib/utils";

/**
 * The Incidents tab: filters, the 11-column list, paging, the export buttons and the row drawer.
 *
 * The first page arrives from the server with the page; every later change refetches through
 * /api/admin/system-audit and mirrors the filters into the address bar (so a reload or a shared
 * link shows the same rows, and the export carries exactly these filters). Nothing polls.
 *
 * A read that fails shows "Unavailable — <reason>" and NO table: an empty table would read as
 * "no errors", which is the one thing this page must never say falsely.
 */

export type IncidentsInitial = {
  query: SystemAuditQuery;
  page: SystemAuditPage | null;
  error: string | null;
  modules: string[] | null;
  modulesError: string | null;
};

const DEFAULT_FILTERS: IncidentFilters = {
  from: null,
  to: null,
  hrKeys: [],
  modules: [],
  statuses: [],
  rootCauseLevels: [],
  families: [],
  scope: null,
  search: null,
  includeSilent: true,
  includeTest: false,
};

function addressFor(query: { filters: IncidentFilters; sort: SystemAuditSort; offset: number }): string {
  const params = systemAuditQueryToParams(query);
  const text = params.toString();
  return text ? `/admin/system-audit?${text}` : "/admin/system-audit";
}

function exportHref(filters: IncidentFilters, format: "csv" | "xlsx"): string {
  const params = systemAuditQueryToParams({ filters });
  params.set("format", format);
  return `/api/admin/system-audit/export?${params.toString()}`;
}

type ExportMessage = { tone: "error" | "info"; text: string };

function filenameFrom(disposition: string | null, fallback: string): string {
  const match = disposition ? /filename="([^"]+)"/.exec(disposition) : null;
  return match?.[1] ?? fallback;
}

/**
 * Fetch, then save. A plain link would save the server's refusal (the XLSX limit, an expired
 * session, a failed read) as a file nobody opens; this shows the refusal on the page instead.
 */
function ExportButton({
  filters,
  format,
  onMessage,
}: {
  filters: IncidentFilters;
  format: "csv" | "xlsx";
  onMessage: (message: ExportMessage | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    onMessage({ tone: "info", text: `Preparing the ${format.toUpperCase()} — every matching row is being read.` });
    try {
      const response = await fetch(exportHref(filters, format), { cache: "no-store" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        onMessage({ tone: "error", text: payload?.message ?? `The export failed — the server answered ${response.status}.` });
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filenameFrom(response.headers.get("content-disposition"), `system-audit.${format}`);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      onMessage(null);
    } catch (caught) {
      onMessage({
        tone: "error",
        text: `The export did not finish — ${caught instanceof Error ? caught.message : "the download was interrupted"}.`,
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className={cn(phxButtonGhostClassName, "h-9 px-3 py-1 text-xs")} disabled={busy} onClick={() => void run()} type="button">
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
      Export {format.toUpperCase()}
    </button>
  );
}

export function IncidentsWorkspace({ initial }: { initial: IncidentsInitial }) {
  const [query, setQuery] = useState<SystemAuditQuery>(initial.query);
  const [page, setPage] = useState<SystemAuditPage | null>(initial.page);
  const [error, setError] = useState<string | null>(initial.error);
  const [loading, setLoading] = useState(false);
  const [modules, setModules] = useState<string[] | null>(initial.modules);
  const [modulesError, setModulesError] = useState<string | null>(initial.modulesError);
  const [openId, setOpenId] = useState<string | null>(null);
  const [rememberedPeople, setRememberedPeople] = useState<Record<string, string>>({});
  const [exportMessage, setExportMessage] = useState<ExportMessage | null>(null);
  const pageAbort = useRef<AbortController | null>(null);
  const modulesAbort = useRef<AbortController | null>(null);

  const load = useCallback(async (next: SystemAuditQuery) => {
    pageAbort.current?.abort();
    const controller = new AbortController();
    pageAbort.current = controller;
    setLoading(true);
    try {
      const params = systemAuditQueryToParams(next);
      const response = await fetch(`/api/admin/system-audit?${params.toString()}`, { cache: "no-store", signal: controller.signal });
      const payload = (await response.json().catch(() => null)) as { page?: SystemAuditPage; message?: string } | null;
      if (controller.signal.aborted) return;
      if (!response.ok || !payload?.page) {
        setError(payload?.message ?? `Unavailable — the server answered ${response.status}.`);
        setPage(null);
        return;
      }
      setError(null);
      setPage(payload.page);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(`Unavailable — ${caught instanceof Error ? caught.message : "the request failed"}`);
      setPage(null);
    } finally {
      if (pageAbort.current === controller) setLoading(false);
    }
  }, []);

  const loadModules = useCallback(async (filters: IncidentFilters) => {
    modulesAbort.current?.abort();
    const controller = new AbortController();
    modulesAbort.current = controller;
    const params = systemAuditQueryToParams({
      filters: { ...DEFAULT_FILTERS, from: filters.from, to: filters.to, includeTest: filters.includeTest },
    });
    params.set("view", "modules");
    try {
      const response = await fetch(`/api/admin/system-audit?${params.toString()}`, { cache: "no-store", signal: controller.signal });
      const payload = (await response.json().catch(() => null)) as { labels?: string[]; message?: string } | null;
      if (controller.signal.aborted) return;
      if (!response.ok || !payload?.labels) {
        setModules(null);
        setModulesError(payload?.message ?? `the server answered ${response.status}`);
        return;
      }
      setModules(payload.labels);
      setModulesError(null);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setModules(null);
      setModulesError(caught instanceof Error ? caught.message : "the request failed");
    }
  }, []);

  const apply = useCallback(
    (next: SystemAuditQuery) => {
      const periodChanged =
        next.filters.from !== query.filters.from ||
        next.filters.to !== query.filters.to ||
        next.filters.includeTest !== query.filters.includeTest;
      setQuery(next);
      window.history.replaceState(null, "", addressFor(next));
      void load(next);
      if (periodChanged) void loadModules(next.filters);
    },
    [load, loadModules, query.filters.from, query.filters.includeTest, query.filters.to],
  );

  const peopleNames = useMemo(() => {
    const names: Record<string, string> = { ...rememberedPeople };
    for (const row of page?.rows ?? []) {
      if (row.hrKey && row.employeeName && !names[row.hrKey]) names[row.hrKey] = row.employeeName;
    }
    return names;
  }, [page, rememberedPeople]);

  const total = page?.total ?? 0;
  const reachable = Math.min(total, SYSTEM_AUDIT_SCREEN_ROW_CAP);
  const from = total === 0 ? 0 : query.offset + 1;
  const to = Math.min(query.offset + (page?.rows.length ?? 0), total);
  const canPrev = query.offset > 0;
  const canNext = query.offset + SYSTEM_AUDIT_PAGE_SIZE < reachable && query.offset + SYSTEM_AUDIT_PAGE_SIZE <= SYSTEM_AUDIT_MAX_OFFSET;

  const goTo = (offset: number) => apply({ ...query, offset: Math.max(0, Math.min(offset, SYSTEM_AUDIT_MAX_OFFSET)) });

  return (
    <div className="min-w-0 space-y-4">
      <IncidentsFilters
        filters={query.filters}
        modulesError={modulesError}
        moduleOptions={modules}
        onApply={(filters, sort) => apply({ ...query, filters, sort, offset: 0 })}
        onRememberPeople={(people: PersonOption[]) =>
          setRememberedPeople((current) => {
            const next = { ...current };
            for (const person of people) next[person.hrKey] = person.name;
            return next;
          })
        }
        onReset={() => apply({ ...query, filters: DEFAULT_FILTERS, sort: "occurred_desc", offset: 0 })}
        peopleNames={peopleNames}
        sort={query.sort}
      />

      <div className="flex flex-col gap-3 border border-slate-200 bg-white px-3 py-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <p aria-live="polite" className="min-w-0 break-words text-sm font-bold text-slate-800">
          {loading ? (
            <span className="inline-flex items-center gap-2 text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading the ledger
            </span>
          ) : error ? (
            "No figures — the read failed."
          ) : (
            incidentTotalsLine(total, page?.rows ?? [])
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          <ExportButton filters={query.filters} format="csv" onMessage={setExportMessage} />
          <ExportButton filters={query.filters} format="xlsx" onMessage={setExportMessage} />
        </div>
      </div>
      <p className="text-xs leading-relaxed text-slate-500">
        The export carries every row these filters match, not only this page. The XLSX stops at 100,000 rows; the CSV has no limit.
      </p>
      {exportMessage ? (
        <p
          className={cn(
            "break-words border px-3 py-2 text-sm font-semibold",
            exportMessage.tone === "error" ? "border-rose-300 bg-rose-50 text-rose-800" : "border-slate-200 bg-slate-50 text-slate-700",
          )}
          role={exportMessage.tone === "error" ? "alert" : "status"}
        >
          {exportMessage.text}
        </p>
      ) : null}

      {error ? (
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="break-words">{error.startsWith("Unavailable") ? error : `Unavailable — ${error}`}</p>
        </AdminCallout>
      ) : page && page.rows.length === 0 ? (
        <AdminCallout tone="neutral">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="break-words">No incident matches these filters.</p>
        </AdminCallout>
      ) : page ? (
        <div aria-busy={loading} className={cn("min-w-0 border border-slate-200 bg-white", loading ? "opacity-60" : "")}>
          <IncidentsTable onOpen={(row) => setOpenId(row.id)} rows={page.rows} selectedId={openId} />
          <div className="flex flex-col gap-2 border-t border-slate-100 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-phx-xs font-bold text-slate-500">
              {from.toLocaleString("en-US")}–{to.toLocaleString("en-US")} of {total.toLocaleString("en-US")}
            </p>
            <div className="flex items-center gap-1">
              <button
                aria-label="Previous page"
                className="inline-flex h-10 w-10 items-center justify-center border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 disabled:opacity-40 md:h-8 md:w-8"
                disabled={!canPrev || loading}
                onClick={() => goTo(query.offset - SYSTEM_AUDIT_PAGE_SIZE)}
                type="button"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="px-2 text-phx-xs font-bold text-slate-700">
                Page {Math.floor(query.offset / SYSTEM_AUDIT_PAGE_SIZE) + 1} of {Math.max(1, Math.ceil(reachable / SYSTEM_AUDIT_PAGE_SIZE))}
              </span>
              <button
                aria-label="Next page"
                className="inline-flex h-10 w-10 items-center justify-center border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 disabled:opacity-40 md:h-8 md:w-8"
                disabled={!canNext || loading}
                onClick={() => goTo(query.offset + SYSTEM_AUDIT_PAGE_SIZE)}
                type="button"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          {total > SYSTEM_AUDIT_SCREEN_ROW_CAP ? (
            <p className="border-t border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
              {total.toLocaleString("en-US")} incidents match; the screen pages through the first{" "}
              {SYSTEM_AUDIT_SCREEN_ROW_CAP.toLocaleString("en-US")}. Narrow the filters to reach the rest, or export — the export carries every row.
            </p>
          ) : null}
        </div>
      ) : null}

      <IncidentDrawer
        key={openId ?? "closed"}
        occurrenceId={openId}
        onChanged={() => void load(query)}
        onClose={() => setOpenId(null)}
      />
    </div>
  );
}
