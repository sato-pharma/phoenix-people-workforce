"use client";

// The Business Review pack — choosing what goes in it.
//
// Owner, 2026-09-26: "he has the option to choose what metrics he wants, and then press export."
// This is the choosing half. It reads the ONE catalogue in lib/business-review/pack/metrics.ts, so
// a tick here and a section in the deck cannot drift apart.
//
// Owner, 2026-10-29: "U R USING EXPRESSIONS WE NOT USE IN OUR COMPANY … MAKE USE PHX AND SATO
// EXPRESSIONS … MORE USER FRIENDLY". The words live in the catalogue (Ach %, MRs, DSMs, Class A
// doctors, DV days, Market Awareness, Marketing ROI — the names the sidebar and the KPIs board
// already use); this file only lays them out: one block per section, Tick all / Untick all, and a
// download that carries exactly the boxes ticked.
//
// A PLAIN GET FORM, like the period filter beside it and for the same reason: "Show on screen" is a
// real navigation, so the page's server-side role gate re-runs on the new selection rather than a
// client fetch quietly reusing the gate that passed for the previous one. It also makes a chosen
// pack a URL — which is what lets one be sent to somebody, and what makes `narrowSelection`
// necessary when a district manager opens a link built at company level.
//
// THE DOWNLOAD CARRIES THE TICKS ON SCREEN. Until 2026-10-29 the three exports were links built
// from the APPLIED selection, so a manager who ticked, then pressed Export, got the pack he had
// before he ticked. Now they are submit buttons of this same form, pointed at the pack route with
// `formAction`: the browser sends the same hidden fields, the ticked `m` boxes and `format`, which
// is byte for byte what the old link carried. The route answers with an attachment, so the page
// does not move. The scope is still NOT in the form — the route resolves it from the session.
//
// Only metrics this LEVEL can answer are offered. A medical rep is never shown a line comparison or
// a rep-by-rep tick, because there are no lines to compare and nobody beneath him.

import { useRef, useState, type MouseEvent } from "react";

import {
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
  phxCheckInputClassName,
  phxCheckTileClassName,
  phxFormBlockClassName,
  phxFormBlockHeaderClassName,
} from "@/components/ui/form-tokens";
import {
  METRIC_GROUPS,
  metricsForLevel,
  type PackLevel,
  type ReviewMetric,
  type ReviewMetricId,
} from "@/lib/business-review/pack/metrics";
import { packFileNameFromDisposition } from "@/lib/business-review/pack/filename";
import { cn } from "@/lib/utils";

import { hiddenEntries, type HiddenFields } from "./hidden-fields";

type Props = {
  /** Where "Show on screen" submits — the page's own path. */
  action: string;
  /** Params that must survive the navigation: the window, the line switcher, the territory narrowing. */
  hidden?: HiddenFields;
  level: PackLevel;
  selected: readonly ReviewMetricId[];
};

const PACK_ROUTE = "/api/business-review/pack";

const DOWNLOADS = [
  { format: "pdf", label: "PDF" },
  { format: "xlsx", label: "Excel" },
  { format: "pptx", label: "PowerPoint" },
] as const;

/** The heavier reads — the Monthly Closing's customer-by-customer rows, the CRM lists, the KPIs board. */
function takesLonger(metric: ReviewMetric): boolean {
  return Boolean(metric.needsClosingDetail || metric.needsFieldLink || metric.needsCrmKpis);
}

/**
 * The same page with NO selection in the URL, which is how it falls back to this level's defaults.
 *
 * Built from the params that must survive rather than from the current location, so it cannot carry
 * a stale `m` back: what is not in `hidden` is not in the link.
 */
function resetHref(action: string, hidden?: HiddenFields): string {
  const query = new URLSearchParams(hiddenEntries(hidden)).toString();
  return query ? `${action}?${query}` : action;
}

const textButtonClassName =
  "text-xs font-bold text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline disabled:pointer-events-none disabled:opacity-40";

/**
 * Keyed on the applied selection, so a "Show on screen" that lands with new ticks starts the boxes
 * from what the page now shows rather than from what this instance remembered.
 */
export function PackPicker(props: Props) {
  return <PackPickerForm key={props.selected.join(",")} {...props} />;
}

function PackPickerForm({ action, hidden, level, selected }: Props) {
  const available = metricsForLevel(level);
  const [ticked, setTicked] = useState<ReadonlySet<ReviewMetricId>>(() => new Set(selected));
  const groups = METRIC_GROUPS.map((group) => ({
    group,
    metrics: available.filter((metric) => metric.group === group.id),
  })).filter((entry) => entry.metrics.length > 0);

  const applied = new Set(selected);
  const changed = ticked.size !== applied.size || [...ticked].some((id) => !applied.has(id));
  const none = ticked.size === 0;

  function setMany(ids: readonly ReviewMetricId[], on: boolean) {
    setTicked((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  const allIds = available.map((metric) => metric.id);

  // 🔴 ONE DOWNLOAD AT A TIME (14 Nov 2026). The buttons used to submit the form straight at the pack route,
  // and the answer is an attachment, so the page showed nothing while a slow pack was built. On 12 Nov one
  // browser sent 188 requests in five minutes: every click cancelled the last and started another, and the
  // server built them all (see lib/business-review/pack/single-flight.ts). Now the page fetches the file
  // itself, says it is preparing it, and ignores every click until that file has arrived or failed. The
  // buttons keep their formAction, so without JavaScript they still download as before.
  const [preparing, setPreparing] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const busy = useRef(false);

  async function download(event: MouseEvent<HTMLButtonElement>, format: string, label: string) {
    event.preventDefault();
    if (busy.current) return;
    const form = event.currentTarget.form;
    if (!form) return;
    busy.current = true;
    setPreparing(label);
    setDownloadError(null);
    try {
      const query = new URLSearchParams();
      for (const [name, value] of new FormData(form)) {
        if (typeof value === "string" && name !== "format") query.append(name, value);
      }
      query.set("format", format);
      const response = await fetch(`${PACK_ROUTE}?${query.toString()}`, { credentials: "same-origin" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(typeof body?.error === "string" ? body.error : "The file could not be built. Please try again.");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = packFileNameFromDisposition(response.headers.get("Content-Disposition")) ?? `Sales Review.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      setDownloadError(error instanceof Error && error.message ? error.message : "The file could not be built. Please try again.");
    } finally {
      busy.current = false;
      setPreparing(null);
    }
  }

  return (
    <details className={cn(phxFormBlockClassName, "group")}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
        <span className="min-w-0">
          <span className="block text-phx-2xs font-bold uppercase tracking-[0.14em] text-orange-700">
            Download the Business Review
          </span>
          <span className="mt-0.5 block break-words text-sm font-bold text-slate-900">
            Choose the sections, then download PDF, Excel or PowerPoint
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="font-semibold text-slate-600">
            {ticked.size} of {available.length} sections ticked
          </span>
          <span className="border border-slate-300 px-2.5 py-1 font-bold text-slate-700 group-open:hidden">Choose</span>
          <span className="hidden border border-slate-300 px-2.5 py-1 font-bold text-slate-700 group-open:inline">
            Close
          </span>
        </span>
      </summary>

      <form action={action} className="border-t border-slate-200 px-4 py-4" method="get">
        {hiddenEntries(hidden).map(([name, value], i) => (
          <input key={`${name}:${i}`} name={name} type="hidden" value={value} />
        ))}

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <p className="min-w-0 break-words text-xs text-slate-500">
            Everything is ticked to start with. Untick what you do not want in the file.
          </p>
          <span className="flex items-center gap-3">
            <button
              className={textButtonClassName}
              disabled={ticked.size === allIds.length}
              onClick={() => setMany(allIds, true)}
              type="button"
            >
              Tick all
            </button>
            <button className={textButtonClassName} disabled={none} onClick={() => setMany(allIds, false)} type="button">
              Untick all
            </button>
          </span>
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {groups.map(({ group, metrics }) => {
            const ids = metrics.map((metric) => metric.id);
            const on = ids.filter((id) => ticked.has(id)).length;
            return (
              <fieldset className={cn(phxFormBlockClassName, "min-w-0")} key={group.id}>
                <legend className="sr-only">{group.label}</legend>
                <div className={cn(phxFormBlockHeaderClassName, "flex-wrap gap-x-3 gap-y-1")}>
                  <span className="min-w-0">
                    <span className="block break-words text-sm font-bold text-slate-900">{group.label}</span>
                    <span className="block break-words text-xs text-slate-500">{group.question}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs font-semibold tabular-nums text-slate-500">
                      {on}/{ids.length}
                    </span>
                    <button
                      className={textButtonClassName}
                      onClick={() => setMany(ids, on < ids.length)}
                      type="button"
                    >
                      {on < ids.length ? "Tick all" : "Untick all"}
                    </button>
                  </span>
                </div>
                <ul className="space-y-2 p-3">
                  {metrics.map((metric) => {
                    const checked = ticked.has(metric.id);
                    return (
                      <li key={metric.id}>
                        <label className={cn(phxCheckTileClassName(checked), "items-start")}>
                          <input
                            checked={checked}
                            className={cn(phxCheckInputClassName, "mt-0.5")}
                            name="m"
                            onChange={(event) => setMany([metric.id], event.target.checked)}
                            type="checkbox"
                            value={metric.id}
                          />
                          <span className="min-w-0">
                            <span className="block break-words">
                              {metric.label}
                              {takesLonger(metric) && (
                                <span className="ml-1.5 whitespace-nowrap text-phx-2xs font-bold uppercase tracking-wide text-slate-400">
                                  · takes longer
                                </span>
                              )}
                            </span>
                            <span className="mt-0.5 block break-words text-xs font-normal leading-relaxed text-slate-500">
                              {metric.hint}
                            </span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
            );
          })}
        </div>

        {/* The sections marked "takes longer" read the Monthly Closing's customer-by-customer rows —
            a round trip per line per month — or the reps' CRM lists, visits, DV days, direct orders
            and requests for this scope. Saying so is the difference between a slow file and an
            unexplained one. */}
        <p className="mt-3 break-words text-xs text-slate-500">
          Sections marked <span className="font-bold text-slate-600">takes longer</span> read the Monthly Closing
          customer by customer, or the CRM lists and visits. Untick them for a quicker file.
        </p>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-4">
          <span className="flex flex-wrap items-center gap-2">
            <button className={phxButtonGhostClassName} disabled={none} type="submit">
              Show on screen
            </button>
            {/* A LINK, not a submit. Back to default means "no selection in the URL at all", which is
                how the page knows to fall back to this level's defaults — and a submit button cannot
                remove the ticked boxes travelling beside it. */}
            <a className={phxButtonGhostClassName} href={resetHref(action, hidden)}>
              Back to default
            </a>
          </span>
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Download</span>
            {DOWNLOADS.map(({ format, label }) => (
              <button
                aria-busy={preparing === label}
                className={phxButtonPrimaryClassName}
                disabled={none || preparing !== null}
                formAction={PACK_ROUTE}
                key={format}
                name="format"
                onClick={(event) => void download(event, format, label)}
                type="submit"
                value={format}
              >
                {preparing === label ? "Preparing…" : label}
              </button>
            ))}
          </span>
        </div>

        <p aria-live="polite" className="mt-2 break-words text-xs empty:mt-0">
          {preparing ? (
            <span className="font-bold text-slate-700">
              Preparing your {preparing} file. Sections marked takes longer can need a minute; it downloads on its own
              when it is ready.
            </span>
          ) : downloadError ? (
            <span className="font-bold text-rose-700">{downloadError}</span>
          ) : null}
        </p>

        {none ? (
          <p className="mt-2 break-words text-xs font-bold text-rose-700">Tick at least one section to download.</p>
        ) : changed ? (
          <p className="mt-2 break-words text-xs text-slate-500">
            You changed the ticks. The download uses them now; press Show on screen to see them on this page too.
          </p>
        ) : null}
      </form>
    </details>
  );
}
