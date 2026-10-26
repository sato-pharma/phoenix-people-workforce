"use client";

/**
 * Field Activity — the screen.
 *
 * The filters answer the owner's ask of 2026-09-28: any person inside the viewer's own scope, any
 * period, and the same report the PDF prints. The picker is fed by the API, which builds it from the
 * viewer's org-tree scope — so a District Manager's list holds his own reps, a National Sales
 * Manager's holds his line, and nobody has to be told which list they are on.
 *
 * LAYOUT RULES THIS SCREEN OBEYS. Desktop gets the full table, mobile gets cards. Every table is
 * `w-full table-fixed` with a `<colgroup>` and fits by MERGING columns rather than shrinking type —
 * there is no horizontal scroll at 375px. Nothing is truncated with an ellipsis: a long customer
 * name or address wraps. Corners are square everywhere.
 */

import { Download, Loader2, MapPin } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { FieldWorkforceRouteMap, type RouteCheckin } from "@/components/field-workforce-compliance/field-workforce-route-map";
import { Card } from "@/components/ui/card";
import { formatVisitCountSplit, type VisitCountSplit } from "@/lib/crm/visit-count-buckets";
import { legDistanceLabel, loggingWindowNote, stopLogNote } from "@/lib/field-activity/format";
import { phxFieldClassName } from "@/components/ui/form-tokens";

type Subject = {
  areaName: string | null;
  hrId: string;
  jobTitle: string | null;
  lineName: string | null;
  name: string;
  regionName: string | null;
};

type Stop = {
  address: string | null;
  ampm: string | null;
  checkedAt: string;
  contactCrmId: number | null;
  customerName: string;
  grade: string | null;
  index: number;
  lat: number;
  legMetres: number | null;
  logLagMinutes: number | null;
  /** A Phoenix CRM visit: its check-in is its log, so no lag is measured. Optional for a report built before it. */
  phoenixVisit?: boolean;
  formOpenSeconds?: number | null;
  lon: number;
  savedAt: string | null;
  savedOn: string | null;
  speciality: string | null;
  viaName: string | null;
  phoenix: PhoenixDetail | null;
};

/**
 * The Phoenix field set as the server shaped it for THIS reader. Structurally mirrored rather than
 * imported as a type from the shaper, like every other row shape in this file: the view is a client
 * component and the shaper's own module is reachable from the server tree.
 */
type PhoenixDetail = {
  availability: string | null;
  capture: string | null;
  evidence: string | null;
  kindLabel: string | null;
  location: string | null;
  nextStep: string | null;
  objection: string | null;
  offPlan: string | null;
  pharmacyFeedback: string | null;
  products: string[];
  samples: string | null;
};

/**
 * The field set, as one wrapped sentence under the row it belongs to.
 *
 * 🔴 NOT COLUMNS, and not a table. The fits-the-screen golden rule says fit by MERGING, never by
 * shrinking type — and this list is already prose, so the detail costs no width at all. What the reader
 * is allowed to see was decided on the SERVER (`phoenix-visit-detail.ts`); this prints what arrived and
 * never re-derives a tier, because a tier decided in the browser is a tier the browser can change.
 */
function phoenixLine(detail: PhoenixDetail | null): string | null {
  if (!detail) return null;
  const parts = [
    detail.products.length > 0 ? detail.products.join(" · ") : null,
    detail.samples ? `samples ${detail.samples}` : null,
    detail.availability,
    detail.objection,
    detail.nextStep,
    detail.pharmacyFeedback ? `pharmacy ${detail.pharmacyFeedback}` : null,
    detail.offPlan,
    detail.location,
    detail.evidence,
    detail.capture,
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  return parts.length > 0 ? parts.join(" · ") : null;
}

type Day = {
  averageLogLagMinutes: number | null;
  counts: VisitCountSplit;
  countedTotal: number;
  dateIso: string;
  firstCheckin: string | null;
  firstLog: string | null;
  kind: string;
  lastCheckin: string | null;
  lastLog: string | null;
  leave: { dayPart: string | null; managerName: string | null; paymentStatus: string | null; reference: string | null; status: string | null; type: string | null } | null;
  logsLandedNextDay: boolean;
  movementMetres: number;
  notes: string[];
  onTerritoryMinutes: number | null;
  partners: Array<{ hrId: string | null; name: string }>;
  partnerSoloCalls: number;
  /** A manager's own single visits, display only (owner, 2026-10-20). Optional: a report built before them has none. */
  ownVisits?: Array<{
    comment: string | null;
    customerName: string;
    grade: string | null;
    half: "AM" | "PM";
    inVacantTerritory: boolean;
    loggedAt: string | null;
    planned: boolean;
    products: string[];
    speciality: string | null;
    where: string | null;
  }>;
  punches: { count: number; firstTime: string | null; lastTime: string | null } | null;
  stops: Stop[];
  trip: {
    allowance: number;
    claimedTotal: number;
    destination: string | null;
    distanceKm: number | null;
    evidenceGate: string | null;
    fuel: number;
    reference: string;
    status: string | null;
    tickets: number;
    transport: string | null;
    workloadGate: string | null;
  } | null;
  unlocated: Array<{
    ampm: string | null;
    counts: boolean;
    label: string;
    savedAt: string | null;
    savedOn: string | null;
    phoenix: PhoenixDetail | null;
  }>;
  weekday: string;
};

type Report = {
  days: Day[];
  fromIso: string;
  subject: { areaName: string | null; hrId: string; jobTitle: string | null; lineName: string | null; name: string; regionName: string | null };
  toIso: string;
  totals: {
    claimedTotal: number;
    counts: VisitCountSplit;
    countedTotal: number;
    fieldDays: number;
    movementMetres: number;
    stops: number;
    tripCount: number;
  };
  flags: Array<{ dateIso: string; message: string }>;
};

function clock12(value: string | null | undefined): string {
  if (!value) return "—";
  const text = value.length > 8 ? value.slice(-8) : value;
  const hour = Number(text.slice(0, 2));
  if (Number.isNaN(hour)) return "—";
  return `${hour % 12 || 12}:${text.slice(3, 5)} ${hour < 12 ? "AM" : "PM"}`;
}

function longDate(dateIso: string, weekday: string): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  return `${weekday} ${date.getUTCDate()} ${date.toLocaleString("en-GB", { month: "long", timeZone: "UTC" })} ${date.getUTCFullYear()}`;
}

function money(value: number): string {
  return "EGP " + value.toLocaleString("en-GB", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

function duration(minutes: number | null): string {
  if (minutes == null) return "—";
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

const DAY_LABEL: Record<string, string> = {
  empty: "No activity recorded",
  "field-no-gps": "Field record with no GPS",
  field: "Field day",
  leave: "Approved leave",
  "own-visits": "Own visits, made alone",
  office: "Head office day",
  weekend: "Weekend",
};

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex border border-orange-300 px-2 py-0.5 text-phx-2xs font-black uppercase tracking-wide text-orange-700">
      {children}
    </span>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="border-b border-r border-slate-200 px-3 py-2">
      <p className="text-phx-2xs font-black uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 text-sm font-bold text-slate-900">{value}</p>
    </div>
  );
}

/** An own visit's second line: who the customer is, where, what was presented and what was noted. */
function ownVisitDetail(item: NonNullable<Day["ownVisits"]>[number]): string {
  return [item.speciality, item.grade ? `Grade ${item.grade}` : null, item.where, item.products.join(", ") || null, item.comment]
    .filter(Boolean)
    .join(" · ");
}

function DayCard({ day, subjectName }: { day: Day; subjectName: string }) {
  const checkins: RouteCheckin[] = day.stops.map((stop) => ({
    address: stop.address,
    // A CAIRO WALL CLOCK carrying no zone, deliberately — `stop.checkedAt` is "HH:MM:SS" sliced from
    // a vendor time that is already Cairo (field-activity/model.ts rule 3). The route map tags it
    // UTC before parsing it (`utcTaggedWallClock`); without that the browser read it as LOCAL time
    // and printed every stop three hours early. Do not "fix" this by shifting the value here.
    checkDate: `${day.dateIso}T${stop.checkedAt}`,
    contactName: stop.customerName,
    id: stop.contactCrmId ?? stop.index,
    lat: stop.lat,
    lon: stop.lon,
  }));

  return (
    <Card className="overflow-hidden border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b-2 border-orange-500 px-4 py-3">
        <h3 className="text-lg font-black text-slate-950">{longDate(day.dateIso, day.weekday)}</h3>
        <Chip>{DAY_LABEL[day.kind] ?? day.kind}</Chip>
      </div>

      <div className="grid grid-cols-1 border-l border-t border-slate-200 sm:grid-cols-2 lg:grid-cols-4">
        {day.partners.length > 0 ? (
          <Fact label="Out with" value={day.partners.map((partner) => partner.name).join(", ")} />
        ) : null}
        {day.leave ? (
          <Fact
            label="Where they were"
            value={
              <>
                On approved leave
                <span className="block text-phx-2xs font-semibold text-slate-500">
                  {[day.leave.type, day.leave.dayPart, day.leave.paymentStatus, day.leave.reference].filter(Boolean).join(" · ")}
                </span>
              </>
            }
          />
        ) : null}
        {day.countedTotal > 0 ? (
          <Fact label="Counted visits" value={formatVisitCountSplit(day.counts)} />
        ) : null}
        {day.firstCheckin ? <Fact label="GPS window" value={`${clock12(day.firstCheckin)} to ${clock12(day.lastCheckin)}`} /> : null}
        {day.onTerritoryMinutes != null ? <Fact label="Time on territory" value={duration(day.onTerritoryMinutes)} /> : null}
        {day.firstLog ? (
          <Fact
            label="Logging window"
            value={
              <>
                {clock12(day.firstLog)} to {clock12(day.lastLog)}
                <span className="block text-phx-2xs font-semibold text-slate-500">{loggingWindowNote(day)}</span>
              </>
            }
          />
        ) : null}
        {day.stops.length > 1 ? <Fact label="Movement between stops" value={`${(day.movementMetres / 1000).toFixed(2)} km`} /> : null}
        {day.punches ? (
          <Fact label="Fingerprint punch" value={`${clock12(day.punches.firstTime)} to ${clock12(day.punches.lastTime)} · ${day.punches.count}`} />
        ) : null}
      </div>

      {day.notes.length > 0 ? (
        <p className="border-l-4 border-orange-500 bg-orange-50 px-4 py-2 text-sm font-semibold text-orange-900">
          {day.notes.join(" ")}
        </p>
      ) : null}

      {day.stops.length > 0 ? (
        <div className="px-4 py-3">
          <h4 className="mb-2 text-phx-2xs font-black uppercase tracking-wide text-slate-500">
            Every stop, in the order their phone recorded it
          </h4>

          {/* Desktop: the full table. */}
          <div className="hidden md:block">
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[5%]" />
                <col className="w-[13%]" />
                <col className="w-[38%]" />
                <col className="w-[16%]" />
                <col className="w-[16%]" />
                <col className="w-[12%]" />
              </colgroup>
              <thead>
                <tr className="bg-slate-950 text-left text-phx-2xs font-black uppercase tracking-wide text-white">
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Checked in</th>
                  <th className="px-3 py-2">Customer and address</th>
                  <th className="px-3 py-2">Speciality</th>
                  <th className="px-3 py-2">Logged at</th>
                  <th className="px-3 py-2 text-right">Leg</th>
                </tr>
              </thead>
              <tbody>
                {day.stops.map((stop) => (
                  <tr className="border-t border-orange-100 align-top text-slate-700" key={`${stop.index}-${stop.checkedAt}`}>
                    <td className="px-3 py-2 font-bold text-slate-900">{stop.index}</td>
                    <td className="px-3 py-2">{clock12(stop.checkedAt)}</td>
                    <td className="px-3 py-2">
                      <span className="font-semibold text-slate-900">{stop.customerName}</span>
                      <span className="block break-words text-phx-2xs text-slate-500">
                        {stop.lat.toFixed(6)}, {stop.lon.toFixed(6)}
                        {stop.address ? ` — ${stop.address}` : ""}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {stop.speciality ?? "—"}
                      <span className="block text-phx-2xs text-slate-500">
                        {[stop.grade ? `Grade ${stop.grade}` : "", stop.ampm ?? ""].filter(Boolean).join(" · ")}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {clock12(stop.savedAt)}
                      <span className="block text-phx-2xs text-slate-500">
                        {stopLogNote(stop)}
                        {stop.savedOn ? ` (${stop.savedOn})` : ""}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">{stop.legMetres == null ? "—" : legDistanceLabel(stop.legMetres)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: one card per stop. */}
          <ul className="space-y-2 md:hidden">
            {day.stops.map((stop) => (
              <li className="border border-slate-200 px-3 py-2" key={`m-${stop.index}-${stop.checkedAt}`}>
                <p className="text-sm font-bold text-slate-900">
                  {stop.index}. {stop.customerName}
                </p>
                <p className="text-phx-2xs font-semibold text-slate-600">
                  Checked in {clock12(stop.checkedAt)} · logged {clock12(stop.savedAt)}
                  {stopLogNote(stop) ? ` (${stopLogNote(stop)})` : ""}
                </p>
                <p className="text-phx-2xs text-slate-600">
                  {[stop.speciality, stop.grade ? `Grade ${stop.grade}` : "", stop.ampm].filter(Boolean).join(" · ")}
                </p>
                <p className="break-words text-phx-2xs text-slate-500">
                  {stop.lat.toFixed(6)}, {stop.lon.toFixed(6)}
                  {stop.address ? ` — ${stop.address}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {day.unlocated.length > 0 ? (
        <div className="px-4 pb-3">
          <h4 className="mb-1 text-phx-2xs font-black uppercase tracking-wide text-slate-500">
            {/* 🔴 THE HEADING WAS A FALSE SENTENCE FOR A PHOENIX VISIT, and that is the owner's reported
                defect in one line. A Phoenix visit IS its own check-in, so it never matches an
                iReports360 GPS fix and every one of them lands in this list — under a heading that said
                there was no GPS behind it, while Phoenix had measured the distance all along. The
                heading now says what is actually true, and each row carries its own measurement. */}
            Recorded on this day with no iReports360 check-in to match
          </h4>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
            {day.unlocated.map((item, index) => (
              <li key={`u-${index}`}>
                <strong>{clock12(item.savedAt)}</strong>
                {item.savedOn ? ` (${item.savedOn})` : ""} · {item.ampm ?? "—"} · {item.label}
                {item.counts ? "" : " — not a customer call, counted in nothing"}
                {phoenixLine(item.phoenix) ? (
                  <span className="mt-0.5 block text-phx-2xs font-semibold leading-4 text-slate-500">
                    {phoenixLine(item.phoenix)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {(day.ownVisits ?? []).length > 0 ? (
        <div className="px-4 pb-3">
          <h4 className="mb-1 text-phx-2xs font-black uppercase tracking-wide text-slate-500">
            {/* Owner, 2026-10-20 ("Show, keep out of reps"): the single visits a manager logged alone are shown on
                the manager's own day and counted in nothing — no figure above includes them, and none is asked
                for a position or a photo. */}
            Own visits, made alone — listed, counted in no figure
          </h4>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
            {(day.ownVisits ?? []).map((item, index) => (
              <li key={`own-${index}`}>
                <strong>{clock12(item.loggedAt)}</strong> · {item.half} half · {item.planned ? "Planned" : "Not on the plan"}
                {item.inVacantTerritory ? " · vacant area" : ""} · {item.customerName}
                {ownVisitDetail(item) ? (
                  <span className="mt-0.5 block break-words text-phx-2xs font-semibold leading-4 text-slate-500">{ownVisitDetail(item)}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {day.trip ? (
        <div className="px-4 pb-3">
          <h4 className="mb-1 text-phx-2xs font-black uppercase tracking-wide text-slate-500">
            Outstation claim {day.trip.reference}
          </h4>
          <p className="text-sm text-slate-700">
            {day.trip.destination ?? "—"} · {day.trip.transport ?? "—"}
            {day.trip.distanceKm == null ? "" : ` · ${day.trip.distanceKm.toFixed(2)} km`} · claimed{" "}
            <strong>{money(day.trip.claimedTotal)}</strong> · {day.trip.status ?? "—"}
          </p>
          <p className="text-phx-2xs text-slate-500">
            fuel {money(day.trip.fuel)} · allowance {money(day.trip.allowance)} · tickets {money(day.trip.tickets)} ·{" "}
            {day.trip.evidenceGate ?? "—"} · workload {day.trip.workloadGate ?? "—"}
          </p>
        </div>
      ) : null}

      {checkins.length > 0 ? (
        <div className="px-4 pb-4">
          <FieldWorkforceRouteMap checkins={checkins} route={null} />
        </div>
      ) : null}

      {day.partnerSoloCalls > 0 ? (
        <p className="border-t border-slate-200 px-4 py-2 text-phx-2xs font-semibold text-slate-500">
          The medical representative recorded a further {day.partnerSoloCalls} call
          {day.partnerSoloCalls === 1 ? "" : "s"} on this day that {subjectName.split(" ")[0]} is not tagged on. They are
          the representative&apos;s own work and are counted nowhere here.
        </p>
      ) : null}
    </Card>
  );
}

export function FieldActivityView({
  chrome = "admin",
  defaultFrom,
  defaultTo,
}: {
  /**
   * Which shell this is rendered in, and therefore who owns the page title.
   *
   * `admin` — `app/(admin)/admin/field-activity/page.tsx` renders this component BARE, with no shell
   * around it, so the `<h1>` below is the page's only title and must stay.
   *
   * `portal` — `app/employee-portals/field-activity/page.tsx` wraps it in `EmployeePortalPageShell`,
   * which already paints the navy command header with the `Coaching` badge, the title `Field
   * Activity` and the module sentence. Drawing the heading here as well printed the same words twice
   * under two type scales (owner, 2026-09-30: "add kpis, field activity and double visit analytics
   * to 4889 too"). Same vocabulary as `KpisBoardView`, which solved this first.
   */
  chrome?: "admin" | "portal";
  defaultFrom: string;
  defaultTo: string;
}) {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [scopeLabel, setScopeLabel] = useState("");
  const [search, setSearch] = useState("");
  const [hrId, setHrId] = useState("");
  const [fromIso, setFromIso] = useState(defaultFrom);
  const [toIso, setToIso] = useState(defaultTo);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/admin/field-activity/subjects");
        const payload = await response.json();
        if (!active) return;
        if (payload.success) {
          setSubjects(payload.data.subjects ?? []);
          setScopeLabel(payload.data.scopeLabel ?? "");
        } else {
          setError(payload.message ?? "Could not load the people you can report on.");
        }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "Could not load the people you can report on.");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return subjects;
    return subjects.filter((subject) =>
      [subject.name, subject.jobTitle, subject.lineName, subject.areaName, subject.regionName]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [search, subjects]);

  /**
   * ONE TYPEABLE BOX, not a search field beside a dropdown (owner, 2026-09-28: "make me able to type
   * in the combo box"). A manager who knows the name types it; a manager who does not opens the list
   * and reads it. The label carries the job title and the area as well as the name, so two people
   * with the same first name are still told apart, and it is the label that maps back to the hr id —
   * the id itself never has to be typed or known.
   */
  const labelOf = useCallback(
    (subject: Subject) => [subject.name, subject.jobTitle, subject.areaName].filter(Boolean).join(" · "),
    [],
  );

  const pick = useCallback(
    (typed: string) => {
      setSearch(typed);
      const needle = typed.trim().toLowerCase();
      // An exact label is a deliberate choice from the list. A single remaining match while typing
      // is the same answer reached a keystroke earlier, so it is honoured too; anything wider leaves
      // the selection empty rather than guessing which person was meant.
      const exact = subjects.find((subject) => labelOf(subject).toLowerCase() === needle);
      if (exact) {
        setHrId(exact.hrId);
        return;
      }
      const narrowed = subjects.filter((subject) =>
        [subject.name, subject.jobTitle, subject.lineName, subject.areaName, subject.regionName]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle)),
      );
      setHrId(needle && narrowed.length === 1 ? narrowed[0].hrId : "");
    },
    [labelOf, subjects],
  );

  const picked = useMemo(() => subjects.find((subject) => subject.hrId === hrId) ?? null, [hrId, subjects]);

  const run = useCallback(async () => {
    if (!hrId) {
      setError("Pick a person first.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ from: fromIso, hrId, to: toIso });
      const response = await fetch(`/api/admin/field-activity/report?${query.toString()}`);
      const payload = await response.json();
      if (payload.success) setReport(payload.data.report);
      else {
        setReport(null);
        setError(payload.message ?? "Could not build that report.");
      }
    } catch (caught) {
      setReport(null);
      setError(caught instanceof Error ? caught.message : "Could not build that report.");
    } finally {
      setLoading(false);
    }
  }, [fromIso, hrId, toIso]);

  const exportPdf = useCallback(async () => {
    if (!hrId) return;
    setExporting(true);
    setError(null);
    try {
      const query = new URLSearchParams({ from: fromIso, hrId, to: toIso });
      const response = await fetch(`/api/admin/field-activity/pdf?${query.toString()}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        setError(payload?.message ?? "The export failed.");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `field-activity-${hrId}-${fromIso}-to-${toIso}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The export failed.");
    } finally {
      setExporting(false);
    }
  }, [fromIso, hrId, toIso]);

  return (
    <div className="space-y-5 p-4 sm:p-6">
      {/* The title and the module sentence are the SHELL'S in the portal — see `chrome` above. The
          scope line is not: it says whose days you are looking at, it changes with the viewer, and
          the shell header is written once, so it survives in both shells. */}
      {chrome === "admin" ? (
        <div>
          <h1 className="text-2xl font-black text-slate-950">Field Activity</h1>
          <p className="mt-1 text-sm font-semibold text-slate-500">
            Any person in your scope, any period — every visit, GPS fix, logged time and expense, day by day.
            {scopeLabel ? ` You are seeing ${scopeLabel}.` : ""}
          </p>
        </div>
      ) : scopeLabel ? (
        <p className="text-sm font-semibold text-slate-500">You are seeing {scopeLabel}.</p>
      ) : null}

      <Card className="border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <label className="block md:col-span-2">
            <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-500">Person</span>
            <input
              autoComplete="off"
              className={`${phxFieldClassName} mt-1`}
              list="field-activity-people"
              onChange={(event) => pick(event.target.value)}
              placeholder={`Type a name, job title, line or area — ${subjects.length} in your scope`}
              value={search}
            />
            {/* The browser's own combo list: it opens on focus and narrows as he types. */}
            <datalist id="field-activity-people">
              {filtered.slice(0, 200).map((subject) => (
                <option key={subject.hrId} value={labelOf(subject)} />
              ))}
            </datalist>
            <span className="mt-1 block text-phx-2xs font-semibold text-slate-500">
              {picked
                ? `Selected: ${picked.name}${picked.lineName ? ` · ${picked.lineName}` : ""}${picked.regionName ? ` · ${picked.regionName}` : ""}`
                : search.trim()
                  ? `${filtered.length} match${filtered.length === 1 ? "" : "es"} — keep typing or pick one from the list`
                  : `${subjects.length} people in your scope`}
            </span>
          </label>
          <label className="block">
            <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-500">From</span>
            <input
              className={`${phxFieldClassName} mt-1`}
              onChange={(event) => setFromIso(event.target.value)}
              type="date"
              value={fromIso}
            />
          </label>
          <label className="block">
            <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-500">To</span>
            <input
              className={`${phxFieldClassName} mt-1`}
              onChange={(event) => setToIso(event.target.value)}
              type="date"
              value={toIso}
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="inline-flex items-center gap-2 border border-orange-600 bg-orange-600 px-4 py-2 text-sm font-black text-white disabled:opacity-60"
            disabled={loading || !hrId}
            onClick={() => void run()}
            type="button"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />} Build the report
          </button>
          <button
            className="inline-flex items-center gap-2 border border-slate-300 px-4 py-2 text-sm font-black text-slate-800 disabled:opacity-60"
            disabled={exporting || !report}
            onClick={() => void exportPdf()}
            type="button"
          >
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Export PDF
          </button>
        </div>
        {error ? <p className="mt-3 text-sm font-semibold text-rose-700">{error}</p> : null}
      </Card>

      {report ? (
        <>
          <Card className="border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-lg font-black text-slate-950">{report.subject.name}</h2>
            <p className="text-sm font-semibold text-slate-500">
              {[report.subject.jobTitle, report.subject.lineName, report.subject.areaName].filter(Boolean).join(" · ")}
            </p>
            <div className="mt-3 grid grid-cols-1 border-l border-t border-slate-200 sm:grid-cols-3 lg:grid-cols-5">
              <Fact label="Counted visits" value={formatVisitCountSplit(report.totals.counts)} />
              <Fact label="Field days" value={String(report.totals.fieldDays)} />
              <Fact label="GPS stops" value={String(report.totals.stops)} />
              <Fact label="Movement" value={`${(report.totals.movementMetres / 1000).toFixed(2)} km`} />
              <Fact label="Claimed" value={`${money(report.totals.claimedTotal)} · ${report.totals.tripCount} trip${report.totals.tripCount === 1 ? "" : "s"}`} />
            </div>
            {report.flags.length > 0 ? (
              <div className="mt-3 border-l-4 border-rose-500 bg-rose-50 px-4 py-2">
                <p className="text-phx-2xs font-black uppercase tracking-wide text-rose-700">What could not be reconciled</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-rose-900">
                  {report.flags.map((flag) => (
                    <li key={flag.dateIso}>
                      <strong>{flag.dateIso}</strong> — {flag.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>

          {report.days.map((day) => (
            <DayCard day={day} key={day.dateIso} subjectName={report.subject.name} />
          ))}
        </>
      ) : null}
    </div>
  );
}
