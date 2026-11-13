"use client";

/**
 * Location integrity — the board itself, with every case told as a story the reader can judge.
 *
 * The owner asked for seven things on 2026-10-13: filter by every possible thing · multi-select and
 * settle · more explanation per case · show the difference in locations live · show the photograph
 * where there is one · spell the names out · make every case a story in clear simple English. His
 * four answers on shape: strong cases first with the weak folded into a counted band; one headline
 * per row and the rest on opening it; a note still REQUIRED for a bulk settle, with ready-made
 * reasons; and every filter group.
 *
 * 🔴 THE MEASUREMENT THAT SAYS THE OLD BOARD WAS UNUSABLE IS THAT NOTHING HAD EVER BEEN SETTLED ON
 * IT — 0 of 164 cases, read on production the morning this was written. It showed five columns and a
 * per-row button, and judging one case meant leaving the page: the signboard's own words were on the
 * row and never rendered, the photograph was a visit away, and 161 of the 164 carried the same weak
 * finding, burying the 10 that stood on their own. Everything below exists to put the evidence in
 * front of the decision.
 *
 * 🔴 IT IS A CLIENT COMPONENT AND MAY NEVER IMPORT A RUNTIME SYMBOL FROM `server/integrity-board.ts`
 * — that module pulls in the service-role Supabase client, and one value import would carry it into
 * the browser bundle. `IntegrityCase` comes in as a TYPE, which is erased; the labels and the whole
 * story come from the pure modules under `src/lib/crm-integrity/`, which is why the story module
 * carries its own copy of the detector names.
 *
 * 🔴 AND IT LIVES OUTSIDE `src/components/phoenix-crm/`, WHICH IS THE REP'S OWN BUNDLE. Every file
 * under that directory is swept by the blind-half guard and may not so much as say "integrity": no
 * rep is ever told the judging exists, so none can be told a flag was closed either. Nothing here
 * notifies anybody, and nothing here deletes anything.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronRight, Download, X } from "lucide-react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { IntegritySettleControl } from "@/components/crm-integrity/integrity-settle";
import { crmPost, useCrmAction } from "@/components/phoenix-crm/api";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { rowDetailToggleProps, TableRowDetail } from "@/components/ui/table-row-detail";
import { CrmButton, CrmField, CrmNote, CrmSearchField, CrmSelect, crmInputClassName, crmTextareaClassName } from "@/components/phoenix-crm/ui";
import {
  activeIntegrityFilterChips,
  clearIntegrityFilter,
  EMPTY_INTEGRITY_FILTERS,
  hasActiveIntegrityFilter,
  INTEGRITY_DISTANCE_BAND_LABELS,
  INTEGRITY_PHOTO_LABELS,
  INTEGRITY_STANDING_LABELS,
  INTEGRITY_STRENGTH_LABELS,
  integrityFilterOptions,
  integrityFiltersFromParams,
  integrityFiltersToQuery,
  matchesIntegrityFilters,
  type IntegrityDistanceBand,
  type IntegrityFilters,
  type IntegrityPhoto,
  type IntegrityStanding,
  type IntegrityStrength,
} from "@/lib/crm-integrity/integrity-board-filters";
import { integrityBoardRow, type IntegrityBoardRow } from "@/lib/crm-integrity/integrity-board-rows";
import type { CaseMap } from "@/lib/crm-integrity/integrity-case-map";
import {
  type CaseComparison,
  type CaseComparisonSide,
  integritySourceStoryLabel,
  integritySubjectKindLabel,
} from "@/lib/crm-integrity/integrity-case-story";
import { INTEGRITY_SETTLE_PRESETS } from "@/lib/crm-integrity/integrity-settle-presets";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { INTEGRITY_BULK_SETTLE_CAP, INTEGRITY_NOTE_LIMIT, INTEGRITY_NOTE_REQUIRED } from "@/lib/phoenix-crm/integrity-settlement";
import type { IntegrityCase } from "@/lib/phoenix-crm/server/integrity-board";

/** The two routes this board writes to and downloads from. Both under `/api/admin/`, deliberately. */
const EXPORT_PATH = "/api/admin/phoenix-crm/integrity/export";
const SETTLE_MANY_PATH = "/api/admin/phoenix-crm/integrity/settle-many";

// Africa/Cairo, human-readable — never raw UTC (owner standing rule). The formatter is the shared
// one and NOT `new Intl.DateTimeFormat("en-GB", …)`: CLDR 42 renamed the en-GB September
// abbreviation "Sep" to "Sept", so a client component that asks the reader's own ICU build for a
// short month renders bytes the server never sent — React hydration error #418, and only ever in
// September. `stableEnGbFormatter` serves the month from the shipped table instead.
function cairo(value: string): string {
  return stableEnGbFormatter({
    timeZone: "Africa/Cairo",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

/**
 * One case with everything the screen needs, plus the one thing only the screen knows.
 *
 * 🔴 THE MAPPING ITSELF IS IN `@/lib/crm-integrity/integrity-board-rows` AND NOT HERE, because the
 * XLSX export route builds the same rows from the same loaded board and filters them with the same
 * matcher. He asked to download what he is looking at; one mapping is the only thing that keeps that
 * true as either side is touched. What stays here is `settleable`, which depends on the VIEWER.
 */
type BoardRow = IntegrityBoardRow & {
  /** Whether this row may be ticked for a bulk settle. A withdrawn case never may. */
  settleable: boolean;
};

function rowOf(entry: IntegrityCase, standing: IntegrityBoardRow["standing"], canSettle: boolean): BoardRow {
  const row = integrityBoardRow(entry, standing);
  return {
    ...row,
    // 🔴 `withdrawsFlag`, not `!supportsFlag`: a sign that merely could not be read again has given
    // nothing away, and that case must keep the decision it needs in order to be decided at all.
    settleable: canSettle && standing !== "withdrawn" && (entry.laterReading === null || !entry.laterReading.withdrawsFlag),
  };
}

/**
 * Where the capture was read, how sure the phone was, and how far it fell from the place it names.
 * One component for the table cell AND the phone card, so the two can never print different facts
 * (Phoenix CRM audit, 2026-10-02: the card dropped this whole column).
 */
function Position({ entry }: { entry: IntegrityCase }) {
  return (
    <>
      {entry.lat !== null && entry.lon !== null ? (
        <span className="tabular-nums">
          {entry.lat.toFixed(5)}, {entry.lon.toFixed(5)}
        </span>
      ) : (
        "—"
      )}
      {entry.accuracyMeters !== null ? <div className="text-xs text-slate-500">within {Math.round(entry.accuracyMeters)} m</div> : null}
      {/* How far the visit was saved from the place it names. Read from the visit
          row, so this board and the place-vs-actual report can never print two
          different numbers for one visit. Null is UNKNOWN and is simply absent -
          it must not render as 0 m, which is a rep standing exactly on the pin. */}
      {entry.placeDistanceMeters !== null ? (
        <div className="text-xs text-slate-500">
          {entry.placeDistanceMeters < 1000
            ? `${Math.round(entry.placeDistanceMeters)} m from the place`
            : `${(entry.placeDistanceMeters / 1000).toFixed(1)} km from the place`}
        </div>
      ) : null}
    </>
  );
}

/**
 * A signboard case's own evidence: what the sign said when it was flagged, and what it says now.
 *
 * The words of the sign were kept on the row from the first day and never shown, so "the signboard
 * names somebody else" named nobody — the one thing a Super Admin needs in order to judge the case
 * was a database query away. `dir="auto"` per line, because a sign is in Arabic, Latin or both and
 * direction belongs to the line rather than to the block. Never truncated.
 */
function SignEvidence({ entry }: { entry: IntegrityCase }) {
  if (entry.source !== "signboard") return null;
  const later = entry.laterReading;
  return (
    <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
      {entry.signText ? (
        <p className="break-words text-xs text-slate-600" dir="auto">
          The sign read: {entry.signText}
        </p>
      ) : (
        <p className="text-xs text-slate-500">Nothing was transcribed from the sign.</p>
      )}
      {later ? (
        <p className="break-words text-xs text-slate-600">
          Read again on {cairo(later.checkedAt)} and {later.sameFinding ? "it still says this" : later.words}.
        </p>
      ) : (
        <p className="text-xs text-slate-500">The sign has not been read again since.</p>
      )}
      {later?.signText && later.signText !== entry.signText ? (
        <p className="break-words text-xs text-slate-600" dir="auto">
          That reading read: {later.signText}
        </p>
      ) : null}
    </div>
  );
}

// Exported for the one-by-one review (`integrity-review-slide.tsx`, owner 2026-10-18), which draws a
// case from these same parts — so this board and the review can never print different facts.
export function Reasons({ entry }: { entry: IntegrityCase }) {
  return (
    <>
      <ul className="space-y-1">
        {entry.reasons.map((reason) => (
          <li key={reason} className="flex items-start gap-2 text-sm leading-6 text-slate-700">
            <span className={`mt-2 h-1.5 w-1.5 shrink-0 ${entry.strong ? "bg-rose-500" : "bg-amber-500"}`} />
            <span>{reason}</span>
          </li>
        ))}
      </ul>
      <SignEvidence entry={entry} />
    </>
  );
}

/**
 * The difference between a case's readings, drawn — the fourth thing he asked for.
 *
 * 🔴 THE MARKERS AND EVERY METRE FIGURE ARE OURS, SO THE PANEL IS STILL TRUE WITH NO STREETS BEHIND
 * IT. If the map picture never loads — a dead connection, Google refusing the key — the
 * readings, the leader lines and the numbers below are unchanged, and the caption says the streets
 * are missing rather than leaving a reader to wonder what failed. That is the rule the field-activity
 * route map has carried since it lost its basemap for weeks.
 *
 * The picture is only requested once a case is OPENED, so Google is asked about an area only for a
 * case somebody actually read — and each picture asked for is counted against the company's account.
 */
export function CaseMapPanel({ map }: { map: CaseMap | null }) {
  if (map === null) {
    return <p className="text-xs leading-5 text-slate-500">No usable reading was kept for this case, so there is nothing to place on a map.</p>;
  }
  return (
    <div className="min-w-0 space-y-2">
      <div className="relative max-w-full overflow-hidden border border-slate-200 bg-slate-100" style={{ height: map.height, width: map.width }}>
        {/* The streets: one picture from this app's own route, which asks Google with the server key (13 Nov 2026).
            It is asked for only once a case is opened; the image optimiser would fetch it a second time for nothing.
            🔴 Its size is pinned in pixels and `max-w-none` stays: the markers and lines are placed in the frame's own
            pixels, so a picture that shrank to fit a phone-width box would put every marker on the wrong street.
            A narrower box clips the frame, as it clips the markers. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt="" aria-hidden className="absolute left-0 top-0 max-w-none select-none" height={map.height} src={map.basemapUrl} style={{ height: map.height, maxWidth: "none", width: map.width }} width={map.width} />
        {/* The leader lines, over the streets and under the markers. */}
        <svg aria-hidden className="pointer-events-none absolute inset-0" height={map.height} width={map.width}>
          {map.pairs.map((pair) => {
            const from = map.markers[pair.fromIndex - 1];
            const to = map.markers[pair.toIndex - 1];
            if (!from || !to) return null;
            return (
              <line
                key={`${pair.fromIndex}-${pair.toIndex}`}
                stroke="#e11d48"
                strokeDasharray="4 3"
                strokeWidth={2}
                x1={from.left}
                x2={to.left}
                y1={from.top}
                y2={to.top}
              />
            );
          })}
        </svg>
        {map.markers.map((marker) => (
          // Square, like everything else on this platform (the square-edge golden rule).
          <span
            className="absolute -ml-3 -mt-3 flex h-6 w-6 items-center justify-center border-2 border-white bg-rose-600 text-phx-sm font-black text-white"
            key={`${marker.index}-${marker.lat}-${marker.lon}`}
            style={{ left: marker.left, top: marker.top }}
          >
            {marker.index}
          </span>
        ))}
      </div>
      <p className="text-phx-sm font-bold uppercase tracking-[0.08em] text-slate-400">
        {map.attribution} — if the streets are missing the map picture did not load, and every number below is unaffected
      </p>
      <ul className="space-y-1">
        {map.markers.map((marker) => (
          <li className="break-words text-xs leading-5 text-slate-600" key={`fact-${marker.index}`}>
            <span className="font-bold text-slate-800">{marker.index}.</span> {marker.label} —{" "}
            <span className="tabular-nums">
              {marker.lat.toFixed(5)}, {marker.lon.toFixed(5)}
            </span>
            {marker.accuracyMeters !== null ? ` (within ${Math.round(marker.accuracyMeters)} m)` : ""}
            {marker.sharesPointWith !== null ? `, sitting on reading ${marker.sharesPointWith}` : ""}
          </li>
        ))}
      </ul>
      {map.pairs.length > 0 ? (
        <ul className="space-y-1">
          {map.pairs.map((pair) => (
            <li className="break-words text-xs leading-5 text-slate-700" key={`pair-${pair.fromIndex}-${pair.toIndex}`}>
              {pair.text}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs leading-5 text-slate-500">
          Only one reading was kept, so there is no distance to measure — a replayed coordinate has one point by definition.
        </p>
      )}
    </div>
  );
}

/** What has happened to this place or this customer, oldest first. Names, never HR ids. */
export function CaseTimeline({ entry }: { entry: IntegrityCase }) {
  if (entry.history.length === 0) {
    return <p className="text-xs leading-5 text-slate-500">Nothing else has been recorded about this place or this customer beyond the capture itself.</p>;
  }
  return (
    <ol className="space-y-1">
      {entry.history.map((event, index) => (
        <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs leading-5 text-slate-600" key={`${event.atIso}-${index}`}>
          <span className="font-bold tabular-nums text-slate-800">{cairo(event.atIso)}</span>
          <span className="min-w-0 break-words">
            {event.what}
            {event.byName !== null ? ` — ${event.byName}` : ""}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * What a case's photograph is called, and whose it is.
 *
 * 🔴 WHOSE PICTURE THIS IS, AND WHEN IT WAS TAKEN, IS NOT THE SAME ON EVERY CASE — and the caption
 * used to assert one answer for all of them. On the eight older detectors the photograph is the
 * one saved WITH the capture this case is about, so the rep's name and the case's own Cairo time
 * are right. On a visit-against-the-photograph case it is the picture the PLACE was validated
 * with, taken by whoever validated it on whatever day that was: captioning it with this rep and
 * this visit's time would put a name and a date on a photograph neither belongs to.
 *
 * Exported for the one-by-one review, so the panel below and the review caption a photo the same way.
 */
export function casePhoto(entry: IntegrityCase): { heading: string; alt: string; caption: string } {
  const photographAt = typeof entry.signals.photographAtIso === "string" ? entry.signals.photographAtIso : null;
  return entry.source === "visit_photo"
    ? {
        heading: "The photograph of the place",
        alt: `The photograph the place was validated with: ${entry.customerName}`,
        caption: `${entry.customerName} · validated${photographAt === null ? "" : ` ${cairo(photographAt)}`}`,
      }
    : {
        heading: "The photograph",
        alt: `${entry.repName} at ${entry.customerName}`,
        caption: `${entry.repName} · ${entry.customerName} · ${cairo(entry.capturedAt)}`,
      };
}

/**
 * Everything behind the headline: the story in plain English, the photograph, the map and its
 * numbers, the measurements, the history, and the decision.
 */
function CasePanel({ canSettle, joined = false, row }: { canSettle: boolean; joined?: boolean; row: BoardRow }) {
  const { entry, story } = row;
  // 🔴 A BOOLEAN, NOT A NESTED COMPONENT. A function returning JSX declared inside a render is a NEW
  // component TYPE on every render, so React unmounts and remounts what it returns — here the settle
  // control, taking the half-typed note in its field with it. `eslint-plugin-react-hooks` catches it
  // as "Cannot create components during render", which turned the required `checks` job red.
  //
  // It is not `row.settleable` either: that one is false for a SETTLED case, because a settled case
  // may not be ticked for a bulk settle — but it is exactly the case whose panel must still offer the
  // control, which is how a settled case is reopened.
  const offersDecision = canSettle && (entry.laterReading === null || !entry.laterReading.withdrawsFlag);
  const photo = casePhoto(entry);
  return (
    <div className={joined ? "min-w-0 space-y-4" : "min-w-0 space-y-4 border-t border-slate-200 pt-4"}>
      {/* 1. The comparison, first and biggest: this location against the validation location. */}
      <CaseComparisonPanel comparison={story.comparison} />

      {/* 2. The story, numbered. He asked for 1, 2, 3 — so it is an ordered list, not a paragraph. */}
      <ol className="min-w-0 list-decimal space-y-1 pl-5">
        {story.story.map((sentence, index) => (
          <li className="break-words text-sm leading-6 text-slate-700" dir="auto" key={`${index}-${sentence.slice(0, 24)}`}>
            {sentence}
          </li>
        ))}
      </ol>

      {/* 3. The map and the photograph, side by side — the two things he reads without words. */}
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <div className="min-w-0 space-y-2">
          <div className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">The two locations on the map</div>
          <CaseMapPanel map={row.map} />
        </div>
        <div className="min-w-0 space-y-2">
          <div className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">{photo.heading}</div>
          {entry.photoPath !== null ? (
            <CrmPhotoThumb alt={photo.alt} caption={photo.caption} className="h-40 w-40" lazy path={entry.photoPath} />
          ) : (
            <p className="text-xs leading-5 text-slate-500">None kept — a one-tap visit keeps no photograph at all, by design.</p>
          )}
        </div>
      </div>

      {/* 4. Everything a reader only wants when he doubts the four points above, folded away. The
          measurements and the history used to sit open beside the photograph, and together they were
          longer than the story itself — which is how the panel stopped being readable. */}
      <details className="min-w-0 border border-slate-200 bg-slate-50 px-3 py-2">
        <summary className="cursor-pointer text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">
          The measurements behind this
        </summary>
        <div className="min-w-0 space-y-2 pt-3">
          <ul className="space-y-1">
            {story.evidence.map((fact) => (
              <li className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs leading-5 text-slate-600" key={fact.label}>
                <span className="font-bold text-slate-800">{fact.label}:</span>
                <span className="min-w-0 break-words" dir="auto">
                  {fact.value}
                </span>
              </li>
            ))}
          </ul>
          <div className="pt-2 text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">What has happened here</div>
          <CaseTimeline entry={entry} />
          <Reasons entry={entry} />
        </div>
      </details>

      {offersDecision ? (
        <div className="min-w-0">
          <IntegritySettleControl caseId={entry.id} settlement={entry.settlement} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The two locations, side by side, with the distance between them in the middle.
 *
 * 🔴 THIS IS THE FIRST THING IN THE PANEL AND THE OWNER'S OWN FRAMING: "location versus the
 * validation location" (13 October 2026). Everything else on the board is support for this one
 * comparison, and before this it was two rows buried in a measurements list under the photograph.
 * On a phone the two stack with the distance between them, so the order still reads as a comparison.
 */
export function CaseComparisonPanel({ comparison }: { comparison: CaseComparison | null }) {
  if (comparison === null) {
    return (
      <p className="text-sm leading-6 text-slate-600">
        This case has one location only, so there is nothing to compare it against.
      </p>
    );
  }
  const side = (label: string, value: CaseComparisonSide) => (
    <div className="min-w-0 border border-slate-200 bg-white px-3 py-2">
      <div className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">{label}</div>
      <div className="break-words pt-1 text-sm font-bold leading-6 text-slate-800" dir="auto">
        {value.label}
      </div>
      <div className="break-words text-xs leading-5 text-slate-600">{value.coordinates}</div>
      {value.accuracy === null ? null : <div className="text-xs leading-5 text-slate-500">{value.accuracy}</div>}
      {value.at === null ? null : <div className="text-xs leading-5 text-slate-500">{cairo(value.at)}</div>}
    </div>
  );
  return (
    <div className="min-w-0 space-y-2">
      <div className="grid min-w-0 items-stretch gap-2 md:grid-cols-[1fr_auto_1fr]">
        {side("Where this says it happened", comparison.capture)}
        <div className="flex min-w-0 flex-col items-center justify-center px-2 py-1 text-center">
          <div className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">apart</div>
          <div className="break-words text-lg font-black leading-7 text-slate-900">{comparison.apart}</div>
        </div>
        {side("The validation location", comparison.validation)}
      </div>
    </div>
  );
}

/** How a list offers its rows for a bulk settle. Null for a list where nothing may be selected. */
type CaseSelection = {
  selected: ReadonlySet<string>;
  selectableIds: ReadonlyArray<string>;
  onToggle: (caseId: string) => void;
  onAll: (next: boolean) => void;
};

/**
 * One list of cases — the desktop table and the phone's cards, from the same entries.
 *
 * ONE component for all three lists on this board, so the live cases, the withdrawn ones and the
 * settled ones can never print different facts about the same row: the photo audit of 2026-10-02
 * found the phone card had silently dropped a whole column, and a second copy of this markup is how
 * that happens again.
 *
 * 🔴 THE COLGROUP SUMS TO EXACTLY 100 AND THERE IS NO MIN-WIDTH ANYWHERE. `table-fixed` with named
 * columns, cards below `lg`, nothing truncated — the fits-the-screen golden rule. The select column
 * is rendered for every list and left empty where nothing may be selected, because two colgroups is
 * how one of them stops summing to 100 six months later.
 */
function CaseList({ canSettle, entries, selection }: { canSettle: boolean; entries: ReadonlyArray<BoardRow>; selection: CaseSelection | null }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set<string>());
  const allBox = useRef<HTMLInputElement | null>(null);
  const toggleOpen = (caseId: string): void =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(caseId)) next.delete(caseId);
      else next.add(caseId);
      return next;
    });

  const selectable = selection?.selectableIds ?? [];
  const pickedHere = selectable.filter((id) => selection?.selected.has(id) === true).length;
  // `indeterminate` is not an attribute — it exists only on the node — and it is the one thing that
  // tells a reader that SOME of what is on screen is ticked rather than all of it or none. Set in an
  // effect rather than in the render body, where the ref is still null on the first pass.
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = pickedHere > 0 && pickedHere < selectable.length;
  }, [pickedHere, selectable.length]);

  const Tick = ({ row }: { row: BoardRow }) =>
    selection !== null && row.settleable ? (
      <input
        aria-label={`Select the case about ${row.entry.customerName}`}
        checked={selection.selected.has(row.entry.id)}
        className="h-4 w-4 shrink-0 rounded-none accent-orange-600"
        onChange={() => selection.onToggle(row.entry.id)}
        type="checkbox"
      />
    ) : null;

  return (
    <>
      {/* Desktop: the full table. `table-fixed` with a colgroup, never a min-width in a scroller. */}
      <div className="hidden lg:block">
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col className="w-[4%]" />
            <col className="w-[13%]" />
            <col className="w-[15%]" />
            <col className="w-[15%]" />
            <col className="w-[38%]" />
            <col className="w-[15%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-500">
              <th className="px-3 py-3">
                {selection !== null && selectable.length > 0 ? (
                  <input
                    aria-label="Select every case shown"
                    checked={pickedHere === selectable.length && selectable.length > 0}
                    className="h-4 w-4 shrink-0 rounded-none accent-orange-600"
                    onChange={(event) => selection.onAll(event.target.checked)}
                    ref={allBox}
                    type="checkbox"
                  />
                ) : null}
              </th>
              <th className="px-5 py-3">When</th>
              <th className="px-5 py-3">Who</th>
              <th className="px-5 py-3">Customer</th>
              <th className="px-5 py-3">What was found</th>
              <th className="px-5 py-3">Position</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((row) => (
              <Fragment key={row.entry.id}>
                <tr className="border-b border-slate-100 align-top even:bg-slate-50/60">
                  <td className="px-3 py-4">
                    <Tick row={row} />
                  </td>
                  <td className="px-5 py-4 text-sm text-slate-700">
                    <div className="font-semibold text-slate-900">{cairo(row.entry.capturedAt)}</div>
                    <div className="break-words text-xs text-slate-500">
                      {integritySubjectKindLabel(row.entry.subjectKind)} · {integritySourceStoryLabel(row.entry.source).toLowerCase()}
                    </div>
                  </td>
                  <td className="px-5 py-4 text-sm text-slate-700">
                    <div className="break-words font-semibold text-slate-900">{row.entry.repName}</div>
                    {row.entry.repLine !== null ? <div className="break-words text-xs text-slate-500">{row.entry.repLine}</div> : null}
                  </td>
                  <td className="px-5 py-4 text-sm text-slate-700">
                    <div className="break-words">{row.entry.customerName}</div>
                    {row.entry.customerSpeciality !== null || row.entry.customerList !== null ? (
                      <div className="break-words text-xs text-slate-500">
                        {[row.entry.customerSpeciality, row.entry.customerList !== null ? `${row.entry.customerList} list` : null]
                          .filter((part) => part !== null)
                          .join(" · ")}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-5 py-4">
                    {/* A chromeless control: no border, background, radius or height is written
                        here, so the one form design has nothing to be in breach of. */}
                    <button
                      {...rowDetailToggleProps(`case-detail-${row.entry.id}`, open.has(row.entry.id))}
                      className="flex w-full min-w-0 items-start gap-2 text-left"
                      onClick={() => toggleOpen(row.entry.id)}
                      type="button"
                    >
                      <span className={`mt-1.5 h-2 w-2 shrink-0 ${row.entry.strong ? "bg-rose-500" : "bg-amber-500"}`} />
                      <span className="min-w-0 break-words text-sm font-semibold leading-6 text-slate-900" dir="auto">
                        {row.story.headline}
                      </span>
                      {open.has(row.entry.id) ? (
                        <ChevronDown aria-hidden className="mt-1.5 h-4 w-4 shrink-0 text-slate-400" />
                      ) : (
                        <ChevronRight aria-hidden className="mt-1.5 h-4 w-4 shrink-0 text-slate-400" />
                      )}
                    </button>
                  </td>
                  <td className="px-5 py-4 text-sm text-slate-600">
                    <Position entry={row.entry} />
                  </td>
                </tr>
                {open.has(row.entry.id) ? (
                  <TableRowDetail className="px-5 pb-5" colSpan={6} id={`case-detail-${row.entry.id}`}>
                    <CasePanel canSettle={canSettle} joined row={row} />
                  </TableRowDetail>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile: the same cases as cards. */}
      <div className="space-y-3 px-5 py-4 lg:hidden sm:px-6">
        {entries.map((row) => (
          <div className="border border-slate-200 bg-white p-4" key={row.entry.id}>
            <div className="flex min-w-0 items-start gap-2">
              <Tick row={row} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="break-words text-sm font-bold text-slate-900">{row.entry.repName}</span>
                  <span className="text-xs text-slate-500">{cairo(row.entry.capturedAt)}</span>
                </div>
                <p className="mt-1 break-words text-sm text-slate-700">
                  {row.entry.customerName} · {integritySubjectKindLabel(row.entry.subjectKind).toLowerCase()} ·{" "}
                  {integritySourceStoryLabel(row.entry.source).toLowerCase()}
                </p>
              </div>
            </div>
            <button
              aria-expanded={open.has(row.entry.id)}
              className="mt-3 flex w-full min-w-0 items-start gap-2 text-left"
              onClick={() => toggleOpen(row.entry.id)}
              type="button"
            >
              <span className={`mt-1.5 h-2 w-2 shrink-0 ${row.entry.strong ? "bg-rose-500" : "bg-amber-500"}`} />
              <span className="min-w-0 break-words text-sm font-semibold leading-6 text-slate-900" dir="auto">
                {row.story.headline}
              </span>
              {open.has(row.entry.id) ? (
                <ChevronDown aria-hidden className="mt-1.5 h-4 w-4 shrink-0 text-slate-400" />
              ) : (
                <ChevronRight aria-hidden className="mt-1.5 h-4 w-4 shrink-0 text-slate-400" />
              )}
            </button>
            <div className="mt-3 border-t border-slate-100 pt-3 text-sm text-slate-600">
              <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Position</div>
              <div className="mt-1 break-words">
                <Position entry={row.entry} />
              </div>
            </div>
            {open.has(row.entry.id) ? <CasePanel canSettle={canSettle} row={row} /> : null}
          </div>
        ))}
      </div>
    </>
  );
}

/** A dropdown over values the board itself holds. The empty option is the "every" case, never a gap. */
function FilterSelect({
  id,
  label,
  onChange,
  options,
  value,
  whenEmpty,
}: {
  id: string;
  label: string;
  onChange: (next: string) => void;
  options: ReadonlyArray<string>;
  value: string;
  whenEmpty: string;
}) {
  return (
    <CrmField htmlFor={id} label={label}>
      <CrmSelect id={id} onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="">{whenEmpty}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </CrmSelect>
    </CrmField>
  );
}

/** A dropdown over a fixed set of words — strength, standing, photograph, distance. */
function FixedSelect<T extends string>({
  id,
  label,
  labels,
  onChange,
  value,
}: {
  id: string;
  label: string;
  labels: Record<T, string>;
  onChange: (next: T) => void;
  value: T;
}) {
  return (
    <CrmField htmlFor={id} label={label}>
      <CrmSelect id={id} onChange={(event) => onChange(event.target.value as T)} value={value}>
        {(Object.keys(labels) as T[]).map((key) => (
          <option key={key} value={key}>
            {labels[key]}
          </option>
        ))}
      </CrmSelect>
    </CrmField>
  );
}

function DayField({ id, label, onChange, value }: { id: string; label: string; onChange: (next: string) => void; value: string }) {
  return (
    <CrmField htmlFor={id} label={label}>
      <input className={crmInputClassName} id={id} onChange={(event) => onChange(event.target.value)} type="date" value={value} />
    </CrmField>
  );
}

/**
 * The board, filtered, selected, settled and exported.
 *
 * The page keeps the hero, the counters, every callout, the behaviour table and the By-rep list and
 * hands the three lists over as data. Everything from here down runs in the reader's own browser, so
 * narrowing 164 cases is instant and costs no server read at all.
 */
export function IntegrityBoardView({
  canSettle,
  cases,
  settled,
  withdrawn,
}: {
  canSettle: boolean;
  cases: IntegrityCase[];
  settled: IntegrityCase[];
  withdrawn: IntegrityCase[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  // The address is read ONCE, for the opening view: a kept or pasted link restores exactly what was
  // on screen. After that this component owns the filters, and the URL follows it.
  const [filters, setFilters] = useState<IntegrityFilters>(() => integrityFiltersFromParams(new URLSearchParams(params.toString())));
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [showWeak, setShowWeak] = useState(false);
  const [note, setNote] = useState("");
  const [missingNote, setMissingNote] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [failures, setFailures] = useState<ReadonlyArray<{ caseId: string; message: string }>>([]);
  const action = useCrmAction();

  /**
   * Narrowing writes the address, and it must NOT re-render the page.
   *
   * 🔴 `history.replaceState`, never `router.replace`. This board is one server render of up to ten
   * chunked reads; a `router.replace` per keystroke would re-run every one of them to produce a
   * payload this component already holds. The address still changes, so a reload and a bookmark
   * restore the view — which is the whole of what he asked for.
   */
  function apply(next: IntegrityFilters): void {
    setFilters(next);
    const query = integrityFiltersToQuery(next).toString();
    if (typeof window === "undefined") return;
    window.history.replaceState(null, "", query === "" ? window.location.pathname : `${window.location.pathname}?${query}`);
  }

  const rows = useMemo(
    () => [
      ...cases.map((entry) => rowOf(entry, "open", canSettle)),
      ...withdrawn.map((entry) => rowOf(entry, "withdrawn", canSettle)),
      ...settled.map((entry) => rowOf(entry, "settled", canSettle)),
    ],
    [canSettle, cases, settled, withdrawn],
  );

  // Derived from EVERY row the board holds, never from the filtered ones: a dropdown that empties as
  // it is used cannot be used to widen a view again.
  const options = useMemo(() => integrityFilterOptions(rows.map((row) => row.filterable)), [rows]);
  const filtered = useMemo(() => rows.filter((row) => matchesIntegrityFilters(row.filterable, filters)), [filters, rows]);

  // Strong first, weak folded — his own answer on shape. Nothing is hidden: the band says how many
  // and opens, and the strength filter reaches them directly. With no strong case to put first there
  // is nothing to fold behind, so the weak ones are simply the list.
  //
  // All four in ONE memo over `filtered`, rather than four plain `const`s: `shownCases` is the
  // dependency of `selectableIds`, which is the dependency of `picked` — the set the sticky bar
  // counts and the bulk settle sends. Built fresh on every render it re-derived that whole chain over
  // the entire filtered board on every keystroke in the filter bar.
  const { weakRows, folded, shownCases } = useMemo(() => {
    const openRows = filtered.filter((row) => row.standing === "open");
    const strong = openRows.filter((row) => row.entry.strong);
    const weak = openRows.filter((row) => !row.entry.strong);
    const fold = !showWeak && strong.length > 0 && weak.length > 0;
    return { weakRows: weak, folded: fold, shownCases: fold ? strong : [...strong, ...weak] };
  }, [filtered, showWeak]);

  const selectableIds = useMemo(() => shownCases.filter((row) => row.settleable).map((row) => row.entry.id), [shownCases]);
  // 🔴 THE ACTED-ON SET IS INTERSECTED WITH WHAT IS ON SCREEN, every time. A tick left behind by a
  // filter change, or on a row that was folded away, must never reach the route — the reader would be
  // settling a case nobody is looking at.
  const picked = useMemo(() => selectableIds.filter((id) => selected.has(id)), [selectableIds, selected]);

  function toggleOne(caseId: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(caseId)) next.delete(caseId);
      else next.add(caseId);
      return next;
    });
  }

  function toggleAll(wanted: boolean): void {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of selectableIds) {
        if (wanted) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  async function settleMany(): Promise<void> {
    if (note.trim() === "") {
      setMissingNote(true);
      return;
    }
    const ids = [...picked];
    const done: string[] = [];
    const failed: Array<{ caseId: string; message: string }> = [];
    setFailures([]);
    await action.run("settle-many", async () => {
      for (let index = 0; index < ids.length; index += INTEGRITY_BULK_SETTLE_CAP) {
        const chunk = ids.slice(index, index + INTEGRITY_BULK_SETTLE_CAP);
        setProgress(`Settling ${Math.min(index + chunk.length, ids.length)} of ${ids.length}`);
        const result = await crmPost<{ settled: string[]; failed: Array<{ caseId: string; message: string }> }>(
          SETTLE_MANY_PATH,
          { caseIds: chunk, note },
          "result",
        );
        done.push(...result.settled);
        failed.push(...result.failed);
      }
    });
    setProgress(null);
    // 🔴 ONLY THE ROWS THAT SUCCEEDED ARE UN-TICKED, so a failure stays selected and can be tried
    // again without finding it a second time among 164.
    if (done.length > 0) {
      setSelected((current) => {
        const next = new Set(current);
        for (const id of done) next.delete(id);
        return next;
      });
      router.refresh();
    }
    setFailures(failed);
    if (failed.length === 0) {
      setNote("");
      setConfirming(false);
    }
  }

  function download(): void {
    const query = integrityFiltersToQuery(filters).toString();
    if (typeof window === "undefined") return;
    window.location.assign(query === "" ? EXPORT_PATH : `${EXPORT_PATH}?${query}`);
  }

  const chips = activeIntegrityFilterChips(filters);
  const narrowed = hasActiveIntegrityFilter(filters);
  const selection: CaseSelection | null =
    canSettle && selectableIds.length > 0 ? { onAll: toggleAll, onToggle: toggleOne, selectableIds, selected } : null;

  return (
    <CrmSurfaceProvider surface="admin">
      <div className="space-y-5">
        <AdminTableShell
          description="Sixteen groups and a free-text box. The board narrows as you type and the address follows, so a kept link reopens the same view."
          title="Narrow the board"
        >
          <div className="space-y-4 px-5 py-4 sm:px-6">
            <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <CrmSearchField
                id="integrity-text"
                label="Anything in the case"
                onChange={(next) => apply({ ...filters, text: next })}
                placeholder="A name, a place, a brick, a word from the finding"
                value={filters.text}
              />
              <FilterSelect
                id="integrity-rep"
                label="Who"
                onChange={(next) => apply({ ...filters, rep: next })}
                options={options.reps}
                value={filters.rep}
                whenEmpty="Everybody"
              />
              <FilterSelect
                id="integrity-line"
                label="Line"
                onChange={(next) => apply({ ...filters, line: next })}
                options={options.lines}
                value={filters.line}
                whenEmpty="Every line"
              />
              <FilterSelect
                id="integrity-area"
                label="Area"
                onChange={(next) => apply({ ...filters, area: next })}
                options={options.areas}
                value={filters.area}
                whenEmpty="Every area"
              />
              <FilterSelect
                id="integrity-region"
                label="Region"
                onChange={(next) => apply({ ...filters, region: next })}
                options={options.regions}
                value={filters.region}
                whenEmpty="Every region"
              />
              <FilterSelect
                id="integrity-source"
                label="Which check filed it"
                onChange={(next) => apply({ ...filters, source: next })}
                options={options.sources}
                value={filters.source}
                whenEmpty="Every check"
              />
              <FilterSelect
                id="integrity-flag"
                label="The finding"
                onChange={(next) => apply({ ...filters, flag: next })}
                options={options.reasons}
                value={filters.flag}
                whenEmpty="Every finding"
              />
              <FixedSelect<IntegrityStrength>
                id="integrity-strength"
                label="How strong"
                labels={INTEGRITY_STRENGTH_LABELS}
                onChange={(next) => apply({ ...filters, strength: next })}
                value={filters.strength}
              />
              <FixedSelect<IntegrityStanding>
                id="integrity-standing"
                label="Where it stands"
                labels={INTEGRITY_STANDING_LABELS}
                onChange={(next) => apply({ ...filters, standing: next })}
                value={filters.standing}
              />
              <FixedSelect<IntegrityPhoto>
                id="integrity-photo"
                label="A photograph"
                labels={INTEGRITY_PHOTO_LABELS}
                onChange={(next) => apply({ ...filters, photo: next })}
                value={filters.photo}
              />
              <FixedSelect<IntegrityDistanceBand>
                id="integrity-distance"
                label="How far apart the readings are"
                labels={INTEGRITY_DISTANCE_BAND_LABELS}
                onChange={(next) => apply({ ...filters, distance: next })}
                value={filters.distance}
              />
              <FilterSelect
                id="integrity-customer"
                label="Customer"
                onChange={(next) => apply({ ...filters, customer: next })}
                options={options.customers}
                value={filters.customer}
                whenEmpty="Every customer"
              />
              <FilterSelect
                id="integrity-speciality"
                label="Speciality"
                onChange={(next) => apply({ ...filters, speciality: next })}
                options={options.specialities}
                value={filters.speciality}
                whenEmpty="Every speciality"
              />
              <FilterSelect
                id="integrity-list"
                label="List"
                onChange={(next) => apply({ ...filters, list: next })}
                options={options.lists}
                value={filters.list}
                whenEmpty="Both lists"
              />
              <DayField id="integrity-vfrom" label="Captured from" onChange={(next) => apply({ ...filters, visitFrom: next })} value={filters.visitFrom} />
              <DayField id="integrity-vto" label="Captured up to" onChange={(next) => apply({ ...filters, visitTo: next })} value={filters.visitTo} />
              <DayField id="integrity-ffrom" label="Filed from" onChange={(next) => apply({ ...filters, filedFrom: next })} value={filters.filedFrom} />
              <DayField id="integrity-fto" label="Filed up to" onChange={(next) => apply({ ...filters, filedTo: next })} value={filters.filedTo} />
            </div>

            {chips.length > 0 ? (
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {chips.map((chip) => (
                  <button
                    className="inline-flex max-w-full items-center gap-1 border border-slate-300 bg-slate-50 px-2 py-1 text-left text-xs font-semibold text-slate-700"
                    key={`${chip.field}-${chip.label}`}
                    onClick={() => apply(clearIntegrityFilter(filters, chip.field))}
                    type="button"
                  >
                    <span className="min-w-0 break-words" dir="auto">
                      {chip.label}
                    </span>
                    <X aria-hidden className="h-3 w-3 shrink-0" />
                  </button>
                ))}
              </div>
            ) : null}

            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <span className="text-sm font-semibold text-slate-700">
                {narrowed
                  ? `Showing ${filtered.length} of the ${rows.length} cases on the board`
                  : `All ${rows.length} cases on the board`}
              </span>
              {narrowed ? (
                <CrmButton onClick={() => apply(EMPTY_INTEGRITY_FILTERS)} size="sm" variant="secondary">
                  Clear every filter
                </CrmButton>
              ) : null}
              <CrmButton onClick={download} size="sm" variant="secondary">
                <Download aria-hidden className="h-4 w-4 shrink-0" />
                Download what is on screen
              </CrmButton>
            </div>
          </div>
        </AdminTableShell>

        {shownCases.length > 0 ? (
          <AdminTableShell
            description="Strong findings first, one line each. Open one for the two locations, the numbered story, the map and the photograph."
            title="Cases"
          >
            <CaseList canSettle={canSettle} entries={shownCases} selection={selection} />
            {folded ? (
              <div className="border-t border-slate-100 px-5 py-4 sm:px-6">
                <CrmButton onClick={() => setShowWeak(true)} size="sm" variant="secondary">
                  {weakRows.length === 1
                    ? "1 more case carries corroborating signals only — open it"
                    : `${weakRows.length} more cases carry corroborating signals only — open them`}
                </CrmButton>
              </div>
            ) : null}
          </AdminTableShell>
        ) : null}

        {filtered.length === 0 && rows.length > 0 ? (
          <AdminTableShell
            description="Every case is still on the board — nothing has been deleted and nothing has been decided. Clear a filter above to reach them again."
            title="Nothing matches these filters"
          >
            <div className="px-5 py-4 sm:px-6">
              <CrmButton onClick={() => apply(EMPTY_INTEGRITY_FILTERS)} size="sm" variant="secondary">
                Clear every filter
              </CrmButton>
            </div>
          </AdminTableShell>
        ) : null}

        {filtered.some((row) => row.standing === "withdrawn") ? (
          <AdminTableShell
            description="Flagged by the signboard pass, then read again to a verdict without the flag. Both readings are below. Nothing here has been deleted and no decision was taken on them, so there is nothing to settle."
            title="Flags a later reading no longer supports"
          >
            {/* No settle button here, by the same reasoning: the evidence has already given way. */}
            <CaseList canSettle={false} entries={filtered.filter((row) => row.standing === "withdrawn")} selection={null} />
          </AdminTableShell>
        ) : null}

        {filtered.some((row) => row.standing === "settled") ? (
          <AdminTableShell
            description="Looked at, with the reason written on it. Nothing is deleted, and a new finding on the same subject brings the case back by itself."
            title="Settled"
          >
            <CaseList canSettle={canSettle} entries={filtered.filter((row) => row.standing === "settled")} selection={null} />
          </AdminTableShell>
        ) : null}

        {/* The bulk bar. Sticky at the foot, and present only while something on screen is ticked. */}
        {canSettle && picked.length > 0 ? (
          <div className="sticky bottom-0 z-20 min-w-0 border border-slate-300 bg-white p-4 shadow-[0_-12px_32px_rgba(15,23,42,0.12)]">
            <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
              <span className="text-sm font-bold text-slate-900">
                {picked.length === 1 ? "1 case selected" : `${picked.length} cases selected`}
              </span>
              <CrmButton onClick={() => toggleAll(false)} size="sm" variant="secondary">
                Clear the selection
              </CrmButton>
            </div>
            <div className="mt-3 min-w-0 space-y-2">
              <div className="flex min-w-0 flex-wrap gap-2">
                {INTEGRITY_SETTLE_PRESETS.map((preset) => (
                  <CrmButton
                    key={preset.id}
                    onClick={() => {
                      setNote(preset.note);
                      setMissingNote(false);
                    }}
                    size="sm"
                    variant="secondary"
                  >
                    {preset.label}
                  </CrmButton>
                ))}
              </div>
              <CrmField
                error={missingNote && note.trim() === "" ? INTEGRITY_NOTE_REQUIRED : undefined}
                hint="One reason is written onto every case selected. Kept on the record for ever, and never shown to the rep. Press a reason above to start from it, then edit it."
                htmlFor="integrity-bulk-note"
                label="Why are these settled"
              >
                <textarea
                  className={crmTextareaClassName}
                  id="integrity-bulk-note"
                  maxLength={INTEGRITY_NOTE_LIMIT}
                  onChange={(event) => {
                    setNote(event.target.value);
                    if (event.target.value.trim() !== "") setMissingNote(false);
                  }}
                  rows={3}
                  value={note}
                />
              </CrmField>
              {action.error !== null ? <CrmNote tone="bad">{action.error}</CrmNote> : null}
              {failures.length > 0 ? (
                <CrmNote tone="bad">
                  {failures.length === 1 ? "One case was not settled and is still selected" : `${failures.length} cases were not settled and are still selected`}:{" "}
                  {failures.map((failure) => failure.message).join(" · ")}
                </CrmNote>
              ) : null}
              {progress !== null ? <p className="text-xs font-semibold text-slate-600">{progress}</p> : null}
              {confirming ? (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-slate-700">
                    {picked.length === 1
                      ? "Settle this case with that reason? Nothing is deleted and nobody is told."
                      : `Settle all ${picked.length} with that reason? Nothing is deleted and nobody is told.`}
                  </span>
                  <CrmButton busy={action.busy === "settle-many"} onClick={settleMany} size="sm">
                    Yes, settle them
                  </CrmButton>
                  <CrmButton onClick={() => setConfirming(false)} size="sm" variant="secondary">
                    Not yet
                  </CrmButton>
                </div>
              ) : (
                <CrmButton
                  onClick={() => {
                    if (note.trim() === "") {
                      setMissingNote(true);
                      return;
                    }
                    setConfirming(true);
                  }}
                  size="sm"
                >
                  Settle {picked.length === 1 ? "this case" : `these ${picked.length}`}
                </CrmButton>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </CrmSurfaceProvider>
  );
}
