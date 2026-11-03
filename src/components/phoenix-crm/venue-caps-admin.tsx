"use client";

/**
 * Phoenix CRM — the Polyclinic Caps page of the Super Admin and the SFE Manager (owner, 2026-11-02).
 *
 * Opens on every exception that stands, at which rep, who set it and when ("the first thing that appears", 2026-11-03).
 * Under them the ordinary module: one filter, the rep; then every polyclinic and centre on that rep's territory, each with the switch that takes
 * the cap away and the number that raises it ("I can remove the cap for a rep in the chosen polyclinic, or I can
 * increase the ceiling of the cap"). A row that frees unplanned visits only says so, and can be ended here.
 *
 * It fits the screen: a phone draws cards, the desktop a `table-fixed` table whose colgroup and header row come
 * from ONE array, so the two cannot disagree. No `overflow-x`, no ellipsis.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { cairoClock24 } from "@/components/phoenix-crm/format";
import {
  CrmButton,
  CrmCard,
  CrmCardsOnPhone,
  CrmEmpty,
  CrmField,
  CrmPill,
  CrmSelect,
  CrmTable,
  crmInputClassName,
  crmTdClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import { Switch } from "@/components/ui/switch";
import { formatPhoenixLongDate } from "@/lib/i18n/format";
import {
  effectiveVenueCap,
  VENUE_CAP_MAX,
  VENUE_CAPS_ADMIN_PATH,
  venueCapNumberProblem,
  venueCapStateLabel,
  venueCapsExplainer,
  venueExceptionLabel,
  venueKindLabel,
  type VenueCapAction,
  type VenueCapRow,
  type VenueCapsAdminView,
  type VenueExceptionRow,
} from "@/lib/phoenix-crm/venue-cap-rules";

const VENUE_COLUMNS = [
  { head: "Polyclinic or centre", width: "33%" },
  { head: "Customers", width: "15%" },
  { head: "No cap", width: "18%" },
  { head: "Visits a day", width: "34%" },
] as const;

const EXCEPTION_COLUMNS = [
  { head: "Polyclinic or centre", width: "27%" },
  { head: "Rep", width: "31%" },
  { head: "Exception", width: "20%" },
  { head: "Set by", width: "22%" },
] as const;

function whenText(name: string | null, at: string | null): string {
  const when = at ? `${formatPhoenixLongDate(at)}, ${cairoClock24(at)}` : null;
  return [name ? `By ${name}` : null, when].filter(Boolean).join(" · ");
}

export function VenueCapsAdmin({ view }: { view: VenueCapsAdminView }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [touched, setTouched] = useState<string | null>(null);
  const [error, setError] = useState<{ sharedPlaceId: string; message: string } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [confirmEnd, setConfirmEnd] = useState<string | null>(null);

  const locked = busy !== null || refreshing;
  const selected = view.selected;

  function choose(hrId: string, anchor = "") {
    setError(null);
    setConfirmEnd(null);
    setDrafts({});
    startRefresh(() => router.push(hrId ? `${VENUE_CAPS_ADMIN_PATH}?rep=${encodeURIComponent(hrId)}${anchor}` : VENUE_CAPS_ADMIN_PATH));
  }

  function exceptionReps(row: VenueExceptionRow) {
    return (
      <div className="grid min-w-0 gap-2">
        {row.reps.length === 0 ? (
          <div className="grid min-w-0 gap-1">
            <span className="break-words font-black text-slate-900">{"Vacant territory"}</span>
            <span className="break-words text-xs font-semibold text-slate-500">It can be changed here once a rep holds this territory.</span>
          </div>
        ) : (
          row.reps.map((rep) => (
            <div className="grid min-w-0 justify-items-start gap-1" key={rep.hrId}>
              <span className="break-words font-black text-slate-900" dir="auto">
                {rep.name}
              </span>
              <CrmButton disabled={refreshing} onClick={() => choose(rep.hrId, "#venue-cap-controls")} size="sm" variant="secondary">
                Change
              </CrmButton>
            </div>
          ))
        )}
        <span className="break-words text-xs font-semibold text-slate-600">{`${row.lineName} · ${row.areaName}`}</span>
      </div>
    );
  }

  function exceptionSetter(row: VenueExceptionRow) {
    return (
      <p className="break-words text-xs font-semibold text-slate-600" dir="auto">
        {whenText(row.setByName, row.setAt) || "Not recorded"}
      </p>
    );
  }

  function exceptionsSection() {
    return (
      <section className="min-w-0 border border-slate-200 bg-white">
        <header className="min-w-0 border-b border-slate-200 px-4 py-3.5 sm:px-5">
          <h2 className="text-base font-black text-slate-950">Exceptions in force</h2>
          <p className="mt-1 break-words text-sm font-medium leading-6 text-slate-600">
            {`Every polyclinic and centre not on the company number of ${view.companyCap} visits a day, at which rep, who set it and when.`}
          </p>
        </header>
        {view.exceptions.length === 0 ? (
          <CrmEmpty message={`Every polyclinic and centre is on the company number of ${view.companyCap} visits a day.`} title="No polyclinic has an exception" />
        ) : (
          <>
            <CrmCardsOnPhone>
              {view.exceptions.map((row) => (
                <CrmCard
                  accent="border-l-orange-500"
                  key={row.sharedPlaceId}
                  meta={venueKindLabel(row.kind)}
                  status={
                    <>
                      <CrmPill tone="warn">{venueExceptionLabel(row, view.companyCap)}</CrmPill>
                      {row.held ? <CrmPill tone="warn">On hold</CrmPill> : null}
                    </>
                  }
                  title={
                    <span className="break-words font-black text-slate-900" dir="auto">
                      {row.name}
                    </span>
                  }
                >
                  <div className="grid min-w-0 gap-3">
                    {exceptionReps(row)}
                    {exceptionSetter(row)}
                  </div>
                </CrmCard>
              ))}
            </CrmCardsOnPhone>

            <CrmTable columns={[...EXCEPTION_COLUMNS.map((column) => column.width)]}>
              <thead>
                <tr>
                  {EXCEPTION_COLUMNS.map((column) => (
                    <th className={crmThClassName} key={column.head}>
                      {column.head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.exceptions.map((row) => (
                  <tr key={row.sharedPlaceId}>
                    <td className={crmTdClassName}>
                      <span className="break-words font-black text-slate-900" dir="auto">
                        {row.name}
                      </span>
                      <div className="mt-1.5 flex min-w-0 flex-wrap gap-1.5">
                        <CrmPill tone="info">{venueKindLabel(row.kind)}</CrmPill>
                        {row.held ? <CrmPill tone="warn">On hold</CrmPill> : null}
                      </div>
                    </td>
                    <td className={crmTdClassName}>{exceptionReps(row)}</td>
                    <td className={crmTdClassName}>
                      <p className="break-words text-sm font-black text-slate-900">{venueExceptionLabel(row, view.companyCap)}</p>
                    </td>
                    <td className={crmTdClassName}>{exceptionSetter(row)}</td>
                  </tr>
                ))}
              </tbody>
            </CrmTable>
          </>
        )}
      </section>
    );
  }

  async function act(venue: VenueCapRow, action: VenueCapAction, cap?: string) {
    if (!selected || locked) return;
    if (action === "raise") {
      const problem = venueCapNumberProblem(cap, view.companyCap);
      if (problem) {
        setError({ sharedPlaceId: venue.sharedPlaceId, message: problem });
        return;
      }
    }
    const key = `${venue.sharedPlaceId}:${action}`;
    setBusy(key);
    setTouched(key);
    setError(null);
    try {
      await crmPost("/api/phoenix-crm/venue-caps", { hrId: selected.hrId, sharedPlaceId: venue.sharedPlaceId, action, cap: cap ?? null }, "result");
      setConfirmEnd(null);
      setDrafts((current) => {
        const next = { ...current };
        delete next[venue.sharedPlaceId];
        return next;
      });
      startRefresh(() => router.refresh());
    } catch (failure) {
      setError({ sharedPlaceId: venue.sharedPlaceId, message: messageOf(failure) });
    } finally {
      setBusy(null);
    }
  }

  const saving = (venue: VenueCapRow, ...actions: VenueCapAction[]) =>
    actions.some((action) => {
      const key = `${venue.sharedPlaceId}:${action}`;
      return busy === key || (refreshing && touched === key);
    });

  function capSwitch(venue: VenueCapRow) {
    return (
      <div className="grid min-w-0 gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <Switch
            checked={venue.lifted}
            label={`No cap: ${venue.name}`}
            onChange={(next) => {
              if (locked) return;
              void act(venue, next ? "lift" : "unlift");
            }}
          />
          <span className="text-xs font-black text-slate-600">{saving(venue, "lift", "unlift") ? "Saving" : venue.lifted ? "On" : "Off"}</span>
        </div>
        {venue.lifted && whenText(venue.liftedByName, venue.liftedAt) ? (
          <p className="break-words text-xs font-semibold text-slate-500">{whenText(venue.liftedByName, venue.liftedAt)}</p>
        ) : null}
      </div>
    );
  }

  function numberControl(venue: VenueCapRow, surface: "card" | "row") {
    const inputId = `venue-cap-${surface}-${venue.sharedPlaceId}`;
    const rowError = error?.sharedPlaceId === venue.sharedPlaceId ? error.message : null;
    if (venue.lifted) {
      return (
        <div className="grid min-w-0 gap-1">
          <p className="break-words text-sm font-black text-slate-900">{venueCapStateLabel(venue, view.companyCap)}</p>
          <p className="break-words text-xs font-semibold text-slate-500">
            {`Switching No cap off returns it to ${effectiveVenueCap(view.companyCap, venue.dailyCap)} visits a day.`}
          </p>
          {rowError ? <p className="break-words text-xs font-bold text-rose-800">{rowError}</p> : null}
        </div>
      );
    }
    return (
      <div className="grid min-w-0 gap-2">
        <p className="break-words text-sm font-black text-slate-900">{venueCapStateLabel(venue, view.companyCap)}</p>
        {venue.dailyCap !== null && whenText(venue.dailyCapSetByName, venue.dailyCapSetAt) ? (
          <p className="break-words text-xs font-semibold text-slate-500">{whenText(venue.dailyCapSetByName, venue.dailyCapSetAt)}</p>
        ) : null}
        <CrmField error={rowError} htmlFor={inputId} label="Raise to">
          <input
            className={crmInputClassName}
            disabled={locked}
            id={inputId}
            inputMode="numeric"
            max={VENUE_CAP_MAX}
            min={view.companyCap + 1}
            onChange={(event) => setDrafts((current) => ({ ...current, [venue.sharedPlaceId]: event.target.value }))}
            type="number"
            value={drafts[venue.sharedPlaceId] ?? ""}
          />
        </CrmField>
        <div className="flex min-w-0 flex-wrap gap-2">
          <CrmButton
            busy={saving(venue, "raise")}
            disabled={locked}
            onClick={() => void act(venue, "raise", drafts[venue.sharedPlaceId] ?? "")}
            size="sm"
            variant="primary"
          >
            Save number
          </CrmButton>
          {venue.dailyCap !== null ? (
            <CrmButton busy={saving(venue, "standard")} disabled={locked} onClick={() => void act(venue, "standard")} size="sm" variant="secondary">
              Back to {view.companyCap} a day
            </CrmButton>
          ) : null}
        </div>
      </div>
    );
  }

  function unplannedNote(venue: VenueCapRow) {
    if (!venue.unplannedFree) return null;
    if (confirmEnd === venue.sharedPlaceId) {
      return (
        <div className="mt-2 grid min-w-0 gap-2">
          <p className="break-words text-xs font-bold text-rose-800">End this exception? Unplanned visits here return to the usual limit, and this page cannot set it again.</p>
          <div className="flex min-w-0 flex-wrap gap-2">
            <CrmButton busy={saving(venue, "end_partial")} disabled={locked} onClick={() => void act(venue, "end_partial")} size="sm" variant="danger">
              End it
            </CrmButton>
            <CrmButton disabled={locked} onClick={() => setConfirmEnd(null)} size="sm" variant="secondary">
              Keep it
            </CrmButton>
          </div>
        </div>
      );
    }
    return (
      <div className="mt-2 grid min-w-0 justify-items-start gap-1.5">
        <p className="break-words text-xs font-semibold text-slate-600">Unplanned visits here carry no limit. Planned visits hold the daily number.</p>
        <CrmButton disabled={locked} onClick={() => setConfirmEnd(venue.sharedPlaceId)} size="sm" variant="secondary">
          End this exception
        </CrmButton>
      </div>
    );
  }

  function venueName(venue: VenueCapRow) {
    return (
      <span className="break-words font-black text-slate-900" dir="auto">
        {venue.name}
      </span>
    );
  }

  function venuePills(venue: VenueCapRow) {
    return (
      <div className="mt-1.5 flex min-w-0 flex-wrap gap-1.5">
        <CrmPill tone="info">{venueKindLabel(venue.kind)}</CrmPill>
        {venue.held ? <CrmPill tone="warn">On hold</CrmPill> : null}
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-5">
      {exceptionsSection()}

      <section className="min-w-0 scroll-mt-20 border border-slate-200 bg-white" id="venue-cap-controls">
        <header className="grid min-w-0 gap-3 border-b border-slate-200 px-4 py-3.5 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-base font-black text-slate-950">Rep</h2>
            <p className="mt-1 break-words text-sm font-medium leading-6 text-slate-600">{venueCapsExplainer(view)}</p>
          </div>
          <CrmField htmlFor="venue-caps-rep" label="Medical rep">
            <CrmSelect disabled={refreshing} id="venue-caps-rep" onChange={(event) => choose(event.target.value)} value={selected?.hrId ?? ""}>
              <option value="">Choose a rep</option>
              {view.reps.map((rep) => (
                <option key={rep.hrId} value={rep.hrId}>
                  {`${rep.name} · ${rep.lineName} · ${rep.areaName}`}
                </option>
              ))}
            </CrmSelect>
          </CrmField>
        </header>

        {!selected ? (
          <CrmEmpty message="Every polyclinic and centre on that rep's territory appears here." title="Choose a rep" />
        ) : view.venues.length === 0 ? (
          <CrmEmpty message={`${selected.name} has no polyclinic or centre on the territory yet. One appears here as soon as it is captured.`} title="Nothing to set yet" />
        ) : (
          <>
            <CrmCardsOnPhone>
              {view.venues.map((venue) => (
                <CrmCard
                  accent={venue.lifted ? "border-l-orange-500" : venue.dailyCap !== null ? "border-l-amber-500" : "border-l-slate-300"}
                  key={venue.sharedPlaceId}
                  meta={venue.seated === 1 ? "1 customer" : `${venue.seated} customers`}
                  status={
                    <>
                      <CrmPill tone="info">{venueKindLabel(venue.kind)}</CrmPill>
                      {venue.held ? <CrmPill tone="warn">On hold</CrmPill> : null}
                    </>
                  }
                  title={venueName(venue)}
                >
                  <div className="grid min-w-0 gap-3">
                    {capSwitch(venue)}
                    {numberControl(venue, "card")}
                    {unplannedNote(venue)}
                  </div>
                </CrmCard>
              ))}
            </CrmCardsOnPhone>

            <CrmTable columns={[...VENUE_COLUMNS.map((column) => column.width)]}>
              <thead>
                <tr>
                  {VENUE_COLUMNS.map((column) => (
                    <th className={crmThClassName} key={column.head}>
                      {column.head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.venues.map((venue) => (
                  <tr key={venue.sharedPlaceId}>
                    <td className={crmTdClassName}>
                      {venueName(venue)}
                      {venuePills(venue)}
                      {unplannedNote(venue)}
                    </td>
                    <td className={crmTdClassName}>{venue.seated}</td>
                    <td className={crmTdClassName}>{capSwitch(venue)}</td>
                    <td className={crmTdClassName}>{numberControl(venue, "row")}</td>
                  </tr>
                ))}
              </tbody>
            </CrmTable>
          </>
        )}
      </section>
    </div>
  );
}
