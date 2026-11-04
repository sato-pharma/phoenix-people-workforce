"use client";

/**
 * Phoenix CRM — the Visit report generator: pick a rep, a manager or a district and a period, choose the fields,
 * press Apply, and read the dashboard, the map and every visit — or download the same thing as one
 * workbook tab (owner, 2026-10-15).
 *
 * 🔴 WHAT IS ON SCREEN IS WHAT IS IN THE FILE. The download link is built from the choice that was APPLIED,
 * never from the form as it stands now, so editing a field after Apply cannot make the file differ from the
 * page. Both are answered by the same server loader, which is also what removes a field above the viewer's
 * sight: the SFE Manager is never offered the mock-location evidence and could not ask for it by hand. The
 * result filters (2026-10-16) keep the same promise: they narrow the dashboard, the map and the table
 * through `narrowVisitReportView`, and the link carries the same four filters to the workbook route, which
 * narrows through the same function.
 *
 * Choosing fields (owner, 2026-10-16): three ready-made sets cut to the reader's sight, the reader's own
 * saved views (server-side, owner only, fields only), and — with no link to reopen — the last choice made
 * in this browser, ticked on arrival. None of them applies anything; Apply still does.
 *
 * One doctor or account (owner, 2026-11-04: "filter by rep or area then filter by dr or polyclinic"): once a rep or
 * a district is chosen, its customers are offered, and choosing one reads that customer's visits alone — every rep
 * who held the seat — over up to a year, so whoever takes the seat next can read where it stands.
 *
 * The choice rides in the page address so a link reopens the same report. The address is read-write only
 * from the page's own path — this file names no page route.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Trash2 } from "lucide-react";

import { crmDelete, crmPost, crmUrl, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
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
  EMPTY_VISIT_REPORT_FILTER,
  describeVisitReportFilter,
  isVisitReportFilterEmpty,
  narrowVisitReportView,
  visitReportFilterOptions,
  visitReportFilterParams,
  type VisitReportFilter,
} from "@/lib/phoenix-crm/visit-report-filters";
import {
  VISIT_REPORT_CATEGORIES,
  VISIT_REPORT_MAX_DAYS_CUSTOMER,
  VISIT_REPORT_SAVED_VIEWS_MAX,
  VISIT_REPORT_STARTER_SETS,
  VISIT_REPORT_VIEW_NAME_MAX,
  resolveVisitReportPeriod,
  visitReportFieldsFor,
  visitReportStarterFields,
  type VisitReportSavedView,
  type VisitReportScopeCustomer,
  type VisitReportScopeView,
  type VisitReportTargetKind,
  type VisitReportView,
} from "@/lib/phoenix-crm/visit-report-fields";

export type VisitReportInitial = {
  /** `rep:<seat id>`, `district:<seat id>` or `manager:<hr id>`, as the picker's own value. */
  target: string;
  /** One doctor or account of that rep or district, by its id; empty for all of them. */
  customer: string;
  from: string;
  to: string;
  fields: string[];
  apply: boolean;
};

type Applied = { kind: VisitReportTargetKind; id: string; customer: string | null; from: string; to: string; fields: string[] };

const REPORT_ENDPOINT = "/api/phoenix-crm/visit-report";
const EXPORT_ENDPOINT = "/api/phoenix-crm/visit-report/export";
const VIEWS_ENDPOINT = "/api/phoenix-crm/visit-report/views";
const CUSTOMERS_ENDPOINT = "/api/phoenix-crm/visit-report/customers";

/**
 * The last choice of fields, in THIS browser only — a convenience. The saved views are the durable store,
 * on the server; this is lost with a private window or cleared site data, and the page works without it.
 */
const LAST_FIELDS_KEY = "phoenix-crm:visit-report:last-fields";

function readLastFields(): string[] {
  try {
    const raw = window.localStorage.getItem(LAST_FIELDS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

function writeLastFields(keys: ReadonlyArray<string>): void {
  try {
    window.localStorage.setItem(LAST_FIELDS_KEY, JSON.stringify(keys));
  } catch {
    // Blocked or full storage: the choice is simply not remembered.
  }
}

function splitTarget(value: string): { kind: VisitReportTargetKind; id: string } | null {
  const [kind, ...rest] = value.split(":");
  const id = rest.join(":");
  // A manager is a person, not a seat (owner, 2026-10-20: "when filter by manager u find no manager").
  if ((kind !== "rep" && kind !== "district" && kind !== "manager") || !id) return null;
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

const SUBHEAD = "text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500";

export function VisitReportGenerator({ initial, scope }: { initial: VisitReportInitial; scope: VisitReportScopeView }) {
  const offered = useMemo(() => visitReportFieldsFor(scope.sight), [scope.sight]);
  const offeredKeys = useMemo(() => new Set(offered.map((field) => field.key)), [offered]);

  const [target, setTarget] = useState(initial.target);
  const [customer, setCustomer] = useState(initial.customer);
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
  const [filter, setFilter] = useState<VisitReportFilter>(EMPTY_VISIT_REPORT_FILTER);
  /** Where the ticked fields came from — a ready-made set, a saved view or the last choice — said under the buttons. */
  const [startedFrom, setStartedFrom] = useState<string | null>(null);
  const [viewName, setViewName] = useState("");
  const [viewsBusy, setViewsBusy] = useState<string | null>(null);
  const [viewsNote, setViewsNote] = useState<{ tone: "bad" | "good"; text: string } | null>(null);
  const savedViews = useCrmGet<VisitReportSavedView[]>(VIEWS_ENDPOINT, "views");
  const autoRan = useRef(false);
  const resultRef = useRef<HTMLDivElement | null>(null);

  const parsedTarget = splitTarget(target);
  // A manager's report is about the manager; one doctor or account is chosen on a rep or a district.
  const offersCustomer = parsedTarget !== null && parsedTarget.kind !== "manager";
  const customers = useCrmGet<VisitReportScopeCustomer[]>(
    offersCustomer && parsedTarget ? crmUrl(CUSTOMERS_ENDPOINT, { id: parsedTarget.id, kind: parsedTarget.kind }) : null,
    "customers",
  );
  const chosenCustomer = offersCustomer && customer ? customer : null;

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

  /** Ticks exactly these fields (those this reader is offered) and says where they came from. */
  const startFrom = (label: string, keys: ReadonlyArray<string>) => {
    const wanted = new Set(keys);
    setSelected(new Set(offered.filter((field) => wanted.has(field.key)).map((field) => field.key)));
    setStartedFrom(label);
  };

  const run = useCallback(
    async (choice: Applied) => {
      setBusy(true);
      setError(null);
      try {
        const answer = await crmPost<VisitReportView>(
          REPORT_ENDPOINT,
          { customer: choice.customer, fields: choice.fields, from: choice.from, id: choice.id, kind: choice.kind, to: choice.to },
          "view",
        );
        setView(answer);
        setApplied(choice);
        setHighlightId(null);
        // A new answer starts unnarrowed: a person or a day chosen for the last one may not be in this one.
        setFilter(EMPTY_VISIT_REPORT_FILTER);
        writeLastFields(choice.fields);
        const params = new URLSearchParams({
          apply: "1",
          fields: choice.fields.join(","),
          from: choice.from,
          target: `${choice.kind}:${choice.id}`,
          to: choice.to,
        });
        if (choice.customer) params.set("customer", choice.customer);
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
      setError("Choose a rep, a manager or a district first.");
      return;
    }
    const period = resolveVisitReportPeriod({ cairoToday: scope.cairoToday, customer: chosenCustomer !== null, from, kind: parsedTarget.kind, to });
    if (!period.ok) {
      setError(period.error);
      return;
    }
    if (selected.size === 0) {
      setError("Choose at least one field.");
      return;
    }
    void run({
      customer: chosenCustomer,
      fields: offered.filter((field) => selected.has(field.key)).map((field) => field.key),
      from: period.from,
      id: parsedTarget.id,
      kind: parsedTarget.kind,
      to: period.to,
    });
  };

  // On arrival, once: a link carrying `apply=1` reopens its own report; with no link and no fields in the
  // address, the last choice made in this browser is ticked. Never again after the form is edited.
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    const linked = splitTarget(initial.target);
    if (initial.apply && linked && initial.from && initial.to) {
      // In the catalogue's order, the way the form lists them, so the page never reads its own link as an edit.
      const keys = offered.filter((field) => initial.fields.includes(field.key)).map((field) => field.key);
      // Deferred a tick: the report's own state is set by `run`, and an effect must not set state in the same
      // breath it runs (react-hooks/set-state-in-effect). No cleanup, so a development double-run still fires once.
      const linkedCustomer = linked.kind !== "manager" && initial.customer ? initial.customer : null;
      if (keys.length > 0) {
        queueMicrotask(() => void run({ customer: linkedCustomer, fields: keys, from: initial.from, id: linked.id, kind: linked.kind, to: initial.to }));
      }
      return;
    }
    if (initial.fields.length > 0) return;
    const remembered = readLastFields().filter((key) => offeredKeys.has(key));
    if (remembered.length === 0) return;
    queueMicrotask(() => {
      setSelected(new Set(remembered));
      setStartedFrom("your last choice");
    });
  }, [initial, offered, offeredKeys, run]);

  const saveView = async () => {
    const keys = offered.filter((field) => selected.has(field.key)).map((field) => field.key);
    setViewsBusy("save");
    setViewsNote(null);
    try {
      const saved = await crmPost<VisitReportSavedView>(VIEWS_ENDPOINT, { fields: keys, name: viewName }, "view");
      const others = (savedViews.data ?? []).filter((entry) => entry.id !== saved.id && entry.name !== saved.name);
      savedViews.replace([...others, saved].sort((left, right) => left.name.localeCompare(right.name)));
      setViewName("");
      setViewsNote({ text: `Saved "${saved.name}" with ${countText(saved.fields.length)} field${saved.fields.length === 1 ? "" : "s"}.`, tone: "good" });
    } catch (cause) {
      setViewsNote({ text: messageOf(cause), tone: "bad" });
    } finally {
      setViewsBusy(null);
    }
  };

  const deleteView = async (entry: VisitReportSavedView) => {
    setViewsBusy(entry.id);
    setViewsNote(null);
    try {
      await crmDelete<boolean>(crmUrl(VIEWS_ENDPOINT, { id: entry.id }), "deleted");
      savedViews.replace((savedViews.data ?? []).filter((other) => other.id !== entry.id));
      setViewsNote({ text: `Deleted "${entry.name}".`, tone: "good" });
    } catch (cause) {
      setViewsNote({ text: messageOf(cause), tone: "bad" });
    } finally {
      setViewsBusy(null);
    }
  };

  const chips = useMemo(() => {
    const lastMonth = previousMonth(scope.cairoToday);
    return [
      { from: shiftIsoDay(scope.cairoToday, -6), label: "Last 7 days", to: scope.cairoToday },
      { from: `${scope.cairoToday.slice(0, 7)}-01`, label: "This month", to: scope.cairoToday },
      { from: lastMonth.from, label: "Last month", to: lastMonth.to },
      // One customer's story runs months, so the year is one press away once one is chosen.
      ...(chosenCustomer
        ? [
            { from: shiftIsoDay(scope.cairoToday, -89), label: "Last 3 months", to: scope.cairoToday },
            { from: shiftIsoDay(scope.cairoToday, -(VISIT_REPORT_MAX_DAYS_CUSTOMER - 1)), label: "Last 12 months", to: scope.cairoToday },
          ]
        : []),
    ];
  }, [chosenCustomer, scope.cairoToday]);

  const downloadHref = applied
    ? crmUrl(EXPORT_ENDPOINT, {
        fields: applied.fields.join(","),
        from: applied.from,
        id: applied.id,
        kind: applied.kind,
        to: applied.to,
        ...(applied.customer ? { customer: applied.customer } : {}),
        ...visitReportFilterParams(filter),
      })
    : null;

  // The page and the file always match what was APPLIED; say so out loud when the form has moved on since.
  const dirty = useMemo(() => {
    if (!applied) return false;
    const now = offered.filter((field) => selected.has(field.key)).map((field) => field.key).join(",");
    return `${applied.kind}:${applied.id}` !== target || applied.customer !== chosenCustomer || applied.from !== from || applied.to !== to || applied.fields.join(",") !== now;
  }, [applied, chosenCustomer, from, offered, selected, target, to]);

  useEffect(() => {
    if (view) resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [view]);

  const appliedFields = useMemo(() => {
    if (!view) return [];
    const chosen = new Set(view.selected);
    return offered.filter((field) => chosen.has(field.key));
  }, [offered, view]);

  // The applied answer, narrowed by the result filters — the dashboard, the map, the table and the file.
  const shown = useMemo(() => (view ? narrowVisitReportView(view, filter, appliedFields) : null), [appliedFields, filter, view]);
  const options = useMemo(() => (view ? visitReportFilterOptions(view.rows) : null), [view]);
  const narrowed = !isVisitReportFilterEmpty(filter);
  const setFilterPart = <K extends keyof VisitReportFilter>(key: K, value: VisitReportFilter[K]) =>
    setFilter((current) => ({ ...current, [key]: value }));

  const views = savedViews.data;
  const nameTaken = views?.some((entry) => entry.name === viewName.replace(/\s+/g, " ").trim()) ?? false;
  const atCap = (views?.length ?? 0) >= VISIT_REPORT_SAVED_VIEWS_MAX && !nameTaken;

  return (
    <div className="grid min-w-0 gap-5">
      <CrmPanel
        description="Choose who and when, then the fields. The dashboard, the map, the visits and the Excel file are all built from exactly this choice."
        eyebrow="Visit report"
        title="Build a report"
      >
        <CrmBlock title="1 · Who and when">
          <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <CrmField htmlFor="visit-report-target" label="Rep, manager or district">
              <CrmSelect
                id="visit-report-target"
                onChange={(event) => {
                  setTarget(event.target.value);
                  // A doctor of the last rep is not on the next one's list.
                  setCustomer("");
                }}
                value={target}
              >
                <option value="">Choose a rep, a manager or a district</option>
                {scope.reps.map((rep) => (
                  <option key={`rep:${rep.id}`} value={`rep:${rep.id}`}>
                    Rep — {rep.label}
                  </option>
                ))}
                {scope.managers.map((manager) => (
                  <option key={`manager:${manager.id}`} value={`manager:${manager.id}`}>
                    Manager — {manager.label}
                  </option>
                ))}
                {scope.districts.map((district) => (
                  <option key={`district:${district.id}`} value={`district:${district.id}`}>
                    District — {district.label} ·{" "}
                    {district.repCount === 0 ? "every seat vacant" : `${countText(district.repCount)} rep${district.repCount === 1 ? "" : "s"}`}
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
          {offersCustomer ? (
            <div className="mt-3 grid min-w-0">
              <CrmField
                hint={
                  customers.error
                    ? customers.error
                    : customers.data === null
                      ? "Reading the customers."
                      : `${countText(customers.data.length)} on the list, waiting for validation or met outside it. Choose one to read that customer's visits alone, by every rep who held the territory, over up to 12 months.`
                }
                htmlFor="visit-report-customer"
                label="Customer"
              >
                <CrmSelect
                  disabled={customers.data === null}
                  id="visit-report-customer"
                  onChange={(event) => setCustomer(event.target.value)}
                  value={customer}
                >
                  <option value="">Every customer</option>
                  {(customers.data ?? []).map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                  {/* A link may name a customer the list no longer offers (dropped since): keep it chosen, by name unknown. */}
                  {customer && customers.data && !customers.data.some((entry) => entry.id === customer) ? (
                    <option value={customer}>The customer in the link</option>
                  ) : null}
                </CrmSelect>
              </CrmField>
            </div>
          ) : null}
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
            One rep up to 92 days; a manager or a district up to 31 days; one customer up to 12 months. A manager&apos;s report holds every visit a rep logged
            with that manager and, under the manager&apos;s own name, the visits made alone — those count in no rep&apos;s figure. Days after today are
            cut off.
          </p>
        </CrmBlock>

        <CrmBlock
          actions={
            <>
              <CrmButton
                onClick={() => {
                  setSelected(new Set(offered.map((field) => field.key)));
                  setStartedFrom(null);
                }}
                size="sm"
              >
                Select everything
              </CrmButton>
              <CrmButton
                onClick={() => {
                  setSelected(new Set());
                  setStartedFrom(null);
                }}
                size="sm"
              >
                Clear
              </CrmButton>
            </>
          }
          title={`2 · Fields — ${countText(selected.size)} of ${countText(offered.length)} chosen`}
        >
          <div className="mb-3 grid min-w-0 gap-4 border border-slate-200 bg-slate-50 p-3.5">
            <div className="grid min-w-0 gap-2">
              <p className={SUBHEAD}>Start from a ready-made set</p>
              <div className="flex min-w-0 flex-wrap gap-2">
                {VISIT_REPORT_STARTER_SETS.map((set) => {
                  const keys = visitReportStarterFields(set, scope.sight).map((field) => field.key);
                  return (
                    <CrmButton key={set.id} onClick={() => startFrom(set.label, keys)} size="sm" title={set.blurb}>
                      {set.label} · {countText(keys.length)}
                    </CrmButton>
                  );
                })}
              </div>
            </div>

            <div className="grid min-w-0 gap-2">
              <p className={SUBHEAD}>Your saved views</p>
              {savedViews.error ? (
                <p className="break-words text-xs font-semibold leading-5 text-rose-700">{savedViews.error}</p>
              ) : views === null ? (
                <p className="text-xs font-medium leading-5 text-slate-500">Reading your saved views.</p>
              ) : views.length === 0 ? (
                <p className="text-xs font-medium leading-5 text-slate-500">None yet. Tick the fields you use, name them below and save.</p>
              ) : (
                <div className="flex min-w-0 flex-wrap gap-2">
                  {views.map((entry) => (
                    <span className="inline-flex min-w-0 max-w-full items-stretch" key={entry.id}>
                      <CrmButton className="min-w-0 break-words" onClick={() => startFrom(entry.name, entry.fields)} size="sm">
                        {entry.name} · {countText(entry.fields.length)}
                      </CrmButton>
                      <CrmButton
                        aria-label={`Delete the saved view ${entry.name}`}
                        busy={viewsBusy === entry.id}
                        className="-ml-px shrink-0"
                        onClick={() => void deleteView(entry)}
                        size="sm"
                        title="Delete this saved view"
                        variant="danger"
                      >
                        {viewsBusy === entry.id ? null : <Trash2 aria-hidden className="h-3.5 w-3.5" />}
                      </CrmButton>
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <CrmField
                hint={`Only you see your saved views, on any device. Up to ${VISIT_REPORT_SAVED_VIEWS_MAX}; the same name again replaces that view.`}
                htmlFor="visit-report-view-name"
                label="Save the ticked fields as a view"
              >
                <input
                  className={crmInputClassName}
                  id="visit-report-view-name"
                  maxLength={VISIT_REPORT_VIEW_NAME_MAX}
                  onChange={(event) => setViewName(event.target.value)}
                  placeholder="A name, such as Monday review"
                  type="text"
                  value={viewName}
                />
              </CrmField>
              <CrmButton
                busy={viewsBusy === "save"}
                disabled={!viewName.trim() || selected.size === 0 || atCap || views === null}
                onClick={() => void saveView()}
              >
                {nameTaken ? "Replace view" : "Save view"}
              </CrmButton>
            </div>
            {atCap ? (
              <p className="text-xs font-semibold leading-5 text-amber-800">
                You have {VISIT_REPORT_SAVED_VIEWS_MAX} saved views. Delete one to save another, or reuse a name to replace it.
              </p>
            ) : null}
            {viewsNote ? (
              <CrmNote tone={viewsNote.tone}>{viewsNote.text}</CrmNote>
            ) : null}
            {startedFrom ? (
              <p className="break-words text-xs font-semibold leading-5 text-slate-600">
                Ticked from {startedFrom}. Change any box below, then press Apply.
              </p>
            ) : null}
          </div>

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
              {downloadHref
                ? ` · the file holds exactly the visits shown below${narrowed ? " after narrowing" : ""}, and always starts with the date, who visited and the customer`
                : ""}
            </p>
          </div>
        </div>
      </CrmPanel>

      {busy && !view ? <CrmLoading label="Building the report" /> : null}

      {view && shown && options ? (
        <div className="grid min-w-0 scroll-mt-4 gap-5" ref={resultRef}>
          <CrmPanel
            eyebrow="Result"
            title={view.target.name}
            description={
              <>
                {dayLabelWithYear(view.period.from)} to {dayLabelWithYear(view.period.to)} ·{" "}
                {narrowed ? `${countText(shown.total)} of ${countText(view.total)} visits shown` : `${countText(view.total)} visit${view.total === 1 ? "" : "s"}`} ·{" "}
                {countText(view.selected.length)} field{view.selected.length === 1 ? "" : "s"}
                {view.target.kind === "district" || view.target.kind === "manager" ? ` · ${countText(view.target.reps.length)} reps` : ""}
              </>
            }
          >
            <CrmBlock title="Show only">
              <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <CrmField htmlFor="visit-report-filter-who" label="Who visited">
                  <CrmSelect id="visit-report-filter-who" onChange={(event) => setFilterPart("who", event.target.value || null)} value={filter.who ?? ""}>
                    <option value="">Everyone</option>
                    {options.who.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </CrmSelect>
                </CrmField>
                <CrmField htmlFor="visit-report-filter-day" label="Day">
                  <CrmSelect id="visit-report-filter-day" onChange={(event) => setFilterPart("day", event.target.value || null)} value={filter.day ?? ""}>
                    <option value="">Every day</option>
                    {options.days.map((day) => (
                      <option key={day} value={day}>
                        {dayLabelWithYear(day)}
                      </option>
                    ))}
                  </CrmSelect>
                </CrmField>
                <CrmField htmlFor="visit-report-filter-planned" label="On the plan">
                  <CrmSelect
                    id="visit-report-filter-planned"
                    onChange={(event) => {
                      const value = event.target.value;
                      setFilterPart("planned", value === "planned" || value === "unplanned" ? value : null);
                    }}
                    value={filter.planned ?? ""}
                  >
                    <option value="">Planned and unplanned</option>
                    <option value="planned">Planned only</option>
                    <option value="unplanned">Unplanned only</option>
                  </CrmSelect>
                </CrmField>
                <CrmField htmlFor="visit-report-filter-position" label="Position against the place">
                  <CrmSelect id="visit-report-filter-position" onChange={(event) => setFilterPart("position", event.target.value || null)} value={filter.position ?? ""}>
                    <option value="">Any position</option>
                    {options.positions.map((position) => (
                      <option key={position} value={position}>
                        {position}
                      </option>
                    ))}
                  </CrmSelect>
                </CrmField>
              </div>
              <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2">
                <p className="min-w-0 grow break-words text-xs font-semibold leading-5 text-slate-500">
                  {narrowed
                    ? `Showing ${countText(shown.total)} of ${countText(view.total)} visits · ${describeVisitReportFilter(filter)}. The dashboard, the map, the visits and the Excel file are narrowed together.`
                    : "Narrows the dashboard, the map, the visits and the Excel file together, without reading the report again."}
                </p>
                {narrowed ? (
                  <CrmButton onClick={() => setFilter(EMPTY_VISIT_REPORT_FILTER)} size="sm">
                    Show everything
                  </CrmButton>
                ) : null}
              </div>
            </CrmBlock>
          </CrmPanel>
          <VisitReportDashboardView dashboard={shown.dashboard} />
          <VisitReportMap highlightId={highlightId} onPick={setHighlightId} rows={shown.rows} />
          <VisitReportTable fields={appliedFields} highlightId={highlightId} rows={shown.rows} />
        </div>
      ) : null}
    </div>
  );
}
