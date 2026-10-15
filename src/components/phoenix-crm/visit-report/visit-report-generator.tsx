"use client";

/**
 * Phoenix CRM — the Visit report generator: pick a rep or a district and a period, choose the fields,
 * press Apply, and read the dashboard, the map and every visit — or download the same thing as one
 * workbook tab (owner, 2026-10-15).
 *
 * 🔴 WHAT IS ON SCREEN IS WHAT IS IN THE FILE. The download link is built from the choice that was APPLIED,
 * never from the form as it stands now, so editing a field after Apply cannot make the file differ from the
 * page. Both are answered by the same server loader, which is also what removes a field above the viewer's
 * sight: the SFE Manager is never offered the mock-location evidence and could not ask for it by hand.
 *
 * The choice rides in the page address so a link reopens the same report. The address is read-write only
 * from the page's own path — this file names no route.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";

import { crmPost, crmUrl, messageOf } from "@/components/phoenix-crm/api";
import { countText, dayLabelWithYear, shiftIsoDay } from "@/components/phoenix-crm/format";
import { VisitReportDashboardView } from "@/components/phoenix-crm/visit-report/visit-report-dashboard";
import { VisitReportMap } from "@/components/phoenix-crm/visit-report/visit-report-map";
import { VisitReportTable } from "@/components/phoenix-crm/visit-report/visit-report-table";
import {
  CrmBlock,
  CrmButton,
  CrmField,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmSelect,
  crmInputClassName,
} from "@/components/phoenix-crm/ui";
import { CheckTile } from "@/components/ui/form-kit";
import { cn } from "@/lib/utils";
import {
  VISIT_REPORT_CATEGORIES,
  resolveVisitReportPeriod,
  visitReportFieldsFor,
  type VisitReportScopeView,
  type VisitReportView,
} from "@/lib/phoenix-crm/visit-report-fields";

export type VisitReportInitial = {
  /** `rep:<seat id>` or `district:<seat id>`, as the picker's own value. */
  target: string;
  from: string;
  to: string;
  fields: string[];
  apply: boolean;
};

type Applied = { kind: "rep" | "district"; id: string; from: string; to: string; fields: string[] };

const REPORT_ENDPOINT = "/api/phoenix-crm/visit-report";
const EXPORT_ENDPOINT = "/api/phoenix-crm/visit-report/export";

function splitTarget(value: string): { kind: "rep" | "district"; id: string } | null {
  const [kind, ...rest] = value.split(":");
  const id = rest.join(":");
  if ((kind !== "rep" && kind !== "district") || !id) return null;
  return { id, kind };
}

/** First and last day of the month before the one `isoDay` falls in. */
function previousMonth(isoDay: string): { from: string; to: string } {
  const year = Number(isoDay.slice(0, 4));
  const month = Number(isoDay.slice(5, 7));
  const first = new Date(Date.UTC(year, month - 2, 1));
  const last = new Date(Date.UTC(year, month - 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

export function VisitReportGenerator({ initial, scope }: { initial: VisitReportInitial; scope: VisitReportScopeView }) {
  const offered = useMemo(() => visitReportFieldsFor(scope.sight), [scope.sight]);
  const offeredKeys = useMemo(() => new Set(offered.map((field) => field.key)), [offered]);

  const [target, setTarget] = useState(initial.target);
  const [from, setFrom] = useState(initial.from || scope.defaults.from);
  const [to, setTo] = useState(initial.to || scope.defaults.to);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(initial.fields.filter((key) => offeredKeys.has(key))),
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<VisitReportView | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const autoRan = useRef(false);
  const resultRef = useRef<HTMLDivElement | null>(null);

  const parsedTarget = splitTarget(target);

  const toggleField = (key: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const toggleCategory = (categoryId: string) =>
    setSelected((current) => {
      const keys = offered.filter((field) => field.category === categoryId).map((field) => field.key);
      const every = keys.every((key) => current.has(key));
      const next = new Set(current);
      for (const key of keys) {
        if (every) next.delete(key);
        else next.add(key);
      }
      return next;
    });

  const toggleCollapsed = (categoryId: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });

  const run = useCallback(
    async (choice: Applied) => {
      setBusy(true);
      setError(null);
      try {
        const answer = await crmPost<VisitReportView>(
          REPORT_ENDPOINT,
          { fields: choice.fields, from: choice.from, id: choice.id, kind: choice.kind, to: choice.to },
          "view",
        );
        setView(answer);
        setApplied(choice);
        setHighlightId(null);
        const params = new URLSearchParams({
          apply: "1",
          fields: choice.fields.join(","),
          from: choice.from,
          target: `${choice.kind}:${choice.id}`,
          to: choice.to,
        });
        window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const apply = () => {
    if (!parsedTarget) {
      setError("Choose a rep or a district first.");
      return;
    }
    const period = resolveVisitReportPeriod({ cairoToday: scope.cairoToday, from, kind: parsedTarget.kind, to });
    if (!period.ok) {
      setError(period.error);
      return;
    }
    if (selected.size === 0) {
      setError("Choose at least one field.");
      return;
    }
    void run({
      fields: offered.filter((field) => selected.has(field.key)).map((field) => field.key),
      from: period.from,
      id: parsedTarget.id,
      kind: parsedTarget.kind,
      to: period.to,
    });
  };

  // A link carrying `apply=1` reopens its own report once, on arrival — never again after he edits the form.
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    const linked = splitTarget(initial.target);
    if (!initial.apply || !linked || !initial.from || !initial.to) return;
    // In the catalogue's order, the way the form lists them, so the page never reads its own link as an edit.
    const keys = offered.filter((field) => initial.fields.includes(field.key)).map((field) => field.key);
    // Deferred a tick: the report's own state is set by `run`, and an effect must not set state in the same
    // breath it runs (react-hooks/set-state-in-effect). No cleanup, so a development double-run still fires once.
    if (keys.length > 0) queueMicrotask(() => void run({ fields: keys, from: initial.from, id: linked.id, kind: linked.kind, to: initial.to }));
  }, [initial, offered, run]);

  const chips = useMemo(() => {
    const lastMonth = previousMonth(scope.cairoToday);
    return [
      { from: shiftIsoDay(scope.cairoToday, -6), label: "Last 7 days", to: scope.cairoToday },
      { from: `${scope.cairoToday.slice(0, 7)}-01`, label: "This month", to: scope.cairoToday },
      { from: lastMonth.from, label: "Last month", to: lastMonth.to },
    ];
  }, [scope.cairoToday]);

  const downloadHref = applied
    ? crmUrl(EXPORT_ENDPOINT, {
        fields: applied.fields.join(","),
        from: applied.from,
        id: applied.id,
        kind: applied.kind,
        to: applied.to,
      })
    : null;

  // The page and the file always match what was APPLIED; say so out loud when the form has moved on since.
  const dirty = useMemo(() => {
    if (!applied) return false;
    const now = offered.filter((field) => selected.has(field.key)).map((field) => field.key).join(",");
    return `${applied.kind}:${applied.id}` !== target || applied.from !== from || applied.to !== to || applied.fields.join(",") !== now;
  }, [applied, from, offered, selected, target, to]);

  useEffect(() => {
    if (view) resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [view]);

  const appliedFields = useMemo(() => {
    if (!view) return [];
    const chosen = new Set(view.selected);
    return offered.filter((field) => chosen.has(field.key));
  }, [offered, view]);

  return (
    <div className="grid min-w-0 gap-5">
      <CrmPanel
        description="Choose who and when, then the fields. The dashboard, the map, the visits and the Excel file are all built from exactly this choice."
        eyebrow="Visit report"
        title="Build a report"
      >
        <CrmBlock title="1 · Who and when">
          <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <CrmField htmlFor="visit-report-target" label="Rep or district">
              <CrmSelect id="visit-report-target" onChange={(event) => setTarget(event.target.value)} value={target}>
                <option value="">Choose a rep or a district</option>
                {scope.reps.map((rep) => (
                  <option key={`rep:${rep.id}`} value={`rep:${rep.id}`}>
                    Rep — {rep.label}
                  </option>
                ))}
                {scope.districts.map((district) => (
                  <option key={`district:${district.id}`} value={`district:${district.id}`}>
                    District — {district.label} · {countText(district.repCount)} rep{district.repCount === 1 ? "" : "s"}
                  </option>
                ))}
              </CrmSelect>
            </CrmField>
            <CrmField htmlFor="visit-report-from" label="From">
              <input
                className={cn(crmInputClassName, "appearance-none")}
                id="visit-report-from"
                max={scope.cairoToday}
                onChange={(event) => setFrom(event.target.value)}
                type="date"
                value={from}
              />
            </CrmField>
            <CrmField htmlFor="visit-report-to" label="To">
              <input
                className={cn(crmInputClassName, "appearance-none")}
                id="visit-report-to"
                max={scope.cairoToday}
                onChange={(event) => setTo(event.target.value)}
                type="date"
                value={to}
              />
            </CrmField>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {chips.map((chip) => (
              <CrmButton
                key={chip.label}
                onClick={() => {
                  setFrom(chip.from);
                  setTo(chip.to);
                }}
                size="sm"
              >
                {chip.label}
              </CrmButton>
            ))}
          </div>
          <p className="mt-2 text-xs font-medium leading-5 text-slate-500">
            One rep up to 92 days; a district up to 31 days. Days after today are cut off.
          </p>
        </CrmBlock>

        <CrmBlock
          actions={
            <>
              <CrmButton onClick={() => setSelected(new Set(offered.map((field) => field.key)))} size="sm">
                Select everything
              </CrmButton>
              <CrmButton onClick={() => setSelected(new Set())} size="sm">
                Clear
              </CrmButton>
            </>
          }
          title={`2 · Fields — ${countText(selected.size)} of ${countText(offered.length)} chosen`}
        >
          <div className="grid min-w-0 gap-3">
            {VISIT_REPORT_CATEGORIES.map((category) => {
              const fields = offered.filter((field) => field.category === category.id);
              if (fields.length === 0) return null;
              const chosen = fields.filter((field) => selected.has(field.key)).length;
              const isClosed = collapsed.has(category.id);
              return (
                <section className="min-w-0 border border-slate-200 bg-white" key={category.id}>
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3.5 py-3">
                    <button
                      aria-expanded={!isClosed}
                      className="min-w-0 flex-1 text-left"
                      onClick={() => toggleCollapsed(category.id)}
                      type="button"
                    >
                      <span className="block break-words text-sm font-black text-slate-950">{category.label}</span>
                      <span className="mt-0.5 block break-words text-xs font-medium text-slate-500">{category.blurb}</span>
                    </button>
                    <div className="flex flex-wrap items-center gap-2">
                      <CrmPill tone={chosen > 0 ? "orange" : "neutral"}>
                        {chosen} of {fields.length}
                      </CrmPill>
                      <CrmButton onClick={() => toggleCategory(category.id)} size="sm">
                        {chosen === fields.length ? "Clear category" : "Whole category"}
                      </CrmButton>
                    </div>
                  </div>
                  {isClosed ? null : (
                    <div className="grid gap-2 p-3.5 sm:grid-cols-2 xl:grid-cols-3">
                      {fields.map((field) => (
                        <CheckTile checked={selected.has(field.key)} key={field.key} onChange={(on) => toggleField(field.key, on)}>
                          <span className="min-w-0 break-words">
                            {field.label}
                            {field.sight === "superAdmin" ? (
                              <span className="mt-1 block text-phx-2xs font-black uppercase tracking-[0.12em] text-amber-700">Super Admin only</span>
                            ) : null}
                            {field.hint ? <span className="mt-1 block text-xs font-medium leading-4 text-slate-500">{field.hint}</span> : null}
                          </span>
                        </CheckTile>
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </CrmBlock>

        <div className="sticky bottom-0 z-10 min-w-0 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:px-5">
          {error ? (
            <CrmNote className="mb-3" tone="bad">
              {error}
            </CrmNote>
          ) : null}
          {dirty ? (
            <CrmNote className="mb-3" tone="warn">
              The choice above has changed since you pressed Apply. The page and the Excel file below still show the earlier choice.
            </CrmNote>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <CrmButton busy={busy} onClick={apply} variant="primary">
              {applied ? "Apply again" : "Apply"}
            </CrmButton>
            {downloadHref ? (
              <a
                className="inline-flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-none border border-slate-200 bg-white px-4 py-2 text-center text-sm font-black text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
                href={downloadHref}
              >
                <Download aria-hidden className="h-4 w-4 shrink-0" />
                Download Excel
              </a>
            ) : null}
            <p className="min-w-0 shrink grow basis-full break-words text-xs font-semibold text-slate-500 sm:basis-0 sm:text-right">
              {countText(selected.size)} of {countText(offered.length)} fields chosen
              {downloadHref ? " · the file holds exactly the visits and fields shown below" : ""}
            </p>
          </div>
        </div>
      </CrmPanel>

      {busy && !view ? <CrmLoading label="Building the report" /> : null}

      {view ? (
        <div className="grid min-w-0 scroll-mt-4 gap-5" ref={resultRef}>
          <CrmPanel
            eyebrow="Result"
            title={view.target.name}
            description={
              <>
                {dayLabelWithYear(view.period.from)} to {dayLabelWithYear(view.period.to)} · {countText(view.total)} visit{view.total === 1 ? "" : "s"} ·{" "}
                {countText(view.selected.length)} field{view.selected.length === 1 ? "" : "s"}
                {view.target.kind === "district" ? ` · ${countText(view.target.reps.length)} reps` : ""}
              </>
            }
          />
          <VisitReportDashboardView dashboard={view.dashboard} />
          <VisitReportMap highlightId={highlightId} onPick={setHighlightId} rows={view.rows} />
          <VisitReportTable fields={appliedFields} highlightId={highlightId} rows={view.rows} />
        </div>
      ) : null}
    </div>
  );
}
