"use client";

import Link from "next/link";

import {
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { SortableTh, TableSearchInput } from "@/components/ui/sortable-table";
import { useSortableTable } from "@/components/ui/use-sortable-table";
import {
  REP_VISIT_SESSION_LABELS,
  REP_VISIT_STANDING_LABELS,
  contactLabel,
  isProspectRow,
  offDutyReason,
  partitionRepVisitRows,
  territoryLabel,
  unscoredLabel,
  type RepVisitRow,
  type RepVisitStanding,
  type RepVisitsSummary,
} from "@/lib/crm/rep-visits";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";

// The visits behind one rep's call rate. Styling copies the board next door verbatim — flat borders,
// slate-900 header row, orange focus — because this IS that board, one level down (owner's standing
// rule: match the sibling pages, never invent a one-off look).
//
// Desktop table / mobile cards via PortalResponsiveDataList — AGENTS.md §4.
//
// THE DESKTOP TABLE FITS; IT NEVER SCROLLS SIDEWAYS (the owner's fits-the-screen golden rule). Until
// 2026-09-21 it was nine unwrapped columns over a 1,500px minimum, so on every desktop the reader
// scrolled right to find the proof of the row he was reading. It is now `w-full table-fixed` with a
// colgroup and FIVE columns, each merging the fields that belong together — day with session,
// doctor with his speciality, clinic with the place, visit type with the double-visit partner — so
// every field is still on screen and no type was shrunk. Text wraps inside its cell; nothing
// ellipsises.
//
// NAMES, NEVER CODES, on screen: the CRM contact number that used to sit under each doctor is gone.
// It stays in the export, where somebody reconciles against the CRM and a name alone cannot be
// matched back.

const THEAD = "px-3 py-2.5 text-phx-sm font-black uppercase tracking-[0.12em] text-white";
const CHIP = "px-2 py-0.5 text-phx-sm font-black uppercase tracking-[0.1em]";

/** The proof bucket, coloured. Green proved, rose unproved, sky campaign, slate not-field-work. */
function standingChip(standing: RepVisitStanding): string {
  if (standing === "verified") return `${CHIP} border border-emerald-300 bg-emerald-50 text-emerald-700`;
  if (standing === "unverified") return `${CHIP} border border-rose-300 bg-rose-50 text-rose-700`;
  if (standing === "campaign") return `${CHIP} border border-sky-300 bg-sky-50 text-sky-700`;
  return `${CHIP} border border-slate-300 bg-slate-50 text-slate-500`;
}

function standingText(standing: RepVisitStanding): string {
  return REP_VISIT_STANDING_LABELS.get(standing) ?? standing;
}

/**
 * The Phoenix field set's lines, MERGED INTO THE FIVE CELLS THAT ALREADY EXIST.
 *
 * 🔴 NOT NEW COLUMNS, and this is the fits-the-screen golden rule deciding the shape rather than the
 * count. The owner asked for the whole field set on the admin reports (2026-10-07, "everything, GPS
 * and evidence included"); his older rule says fit by MERGING columns and never by shrinking type, and
 * this very table was rebuilt on 2026-09-21 because nine unwrapped columns over a 1,500px minimum made
 * every reader scroll right to find the proof of the row he was reading. Thirty-four columns would be
 * that defect back, many times over.
 *
 * Where each half lands is not arbitrary:
 *
 *   - the WORK — products, samples, the shelf, the objection, the next step, a pharmacy named as
 *     feedback, an off-plan reason — goes under the DOCTOR, because it is what happened in that call.
 *   - the PEOPLE — the visit's kind, the second manager on a chain visit — go under VISIT TYPE.
 *   - the LOCATION, the EVIDENCE and the CAPTURE go under PROOF, because a distance IS the proof of a
 *     call: that column already answers "did this happen where it says it did".
 *
 * The XLSX export keeps them FLAT, one column each — a sheet has no viewport and nothing is lost.
 */
const PHOENIX_LINE = "block text-phx-sm font-semibold leading-4 text-slate-500";

function phoenixLines(values: ReadonlyArray<string | null>): React.ReactNode {
  const lines = values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line) => (
        <span className={PHOENIX_LINE} key={line}>
          {line}
        </span>
      ))}
    </>
  );
}

/**
 * Who he was out with, BOTH people on a chain visit.
 *
 * Slot 1 is `coalesce(manager, product_manager, senior)` and slot 2 holds whoever is left, so the two
 * never name one person and joining them can never repeat a name.
 */
function partnerLine(row: RepVisitRow): string | null {
  const names = [row.partnerName, row.partner2Name]
    .map((name) => name?.trim() ?? "")
    .filter((name) => name.length > 0);
  if (names.length === 0) return null;
  return `Double visit with ${names.join(" · ")}`;
}

/** The card fields a Phoenix row adds on mobile, in the same order the desktop cells read. */
function phoenixCardFields(row: RepVisitRow): Array<{ label: string; value: React.ReactNode }> {
  const detail = row.phoenix;
  if (!detail) return [];
  const pairs: Array<[string, string | null]> = [
    ["Products", detail.products.length > 0 ? detail.products.join(" · ") : null],
    ["Samples", detail.samples],
    ["Availability", detail.availability],
    ["Objection", detail.objection],
    ["Next step", detail.nextStep],
    ["Pharmacy feedback", detail.pharmacyFeedback],
    ["Off plan", detail.offPlan],
    ["Visit kind", detail.kindLabel],
    ["Location", detail.location],
    ["Evidence", detail.evidence],
    ["Capture", detail.capture],
  ];
  return pairs
    .filter((pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].trim().length > 0)
    .map(([label, value]) => ({ label, value: <span className="text-slate-600">{value}</span> }));
}

function sessionText(row: RepVisitRow): string {
  return REP_VISIT_SESSION_LABELS.get(row.session) ?? "—";
}

/** "Sat 02 Aug" — the weekday matters, because the KPI only counts Sat–Wed.
 *
 * DATE-ONLY (`ireports360_visits.visit_date`, a `date` column), pinned to UTC midnight. UTC
 * here is CORRECT and must stay: shifting it to Cairo would move a late visit onto the next
 * weekday and silently change which days the KPI counts. */
function dayText(dateIso: string): string {
  if (!dateIso) return "—";
  const parsed = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return dateIso;
  return formatStableEnGb(parsed, {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    weekday: "short",
  });
}

/**
 * The doctor, named — never a bare id.
 *
 * The CRM contact id rides alongside as the LINK (it is what the visit actually points at, and what
 * survives a rename), but it is never the label: the owner's standing rule is that a human-readable
 * name is always what is shown. On a campaign row there is no contact record at all — the doctor is
 * real but off the rep's list — so the rep's own comment is the name. See `contactLabel`.
 */
function contactText(row: RepVisitRow): string {
  return contactLabel(row);
}

/**
 * The one sentence a campaign row's doctor line is allowed to say, in one place.
 *
 * Desktop, mobile and the export all read this, because the owner's standing rule is that an export
 * must MATCH the screen — and because the three of them saying slightly different things about the
 * same row is exactly how "Prospect · not on their list" survived on 3,126 visits where it was false.
 *
 * Returns null when the row carries a real CRM contact, which needs no explanation at all.
 */
function campaignContactNote(row: RepVisitRow): { text: string; tone: string } | null {
  const match = row.knownContact;
  if (match) {
    // NAMED, not just flagged. "Already on his list" leaves the reader to go and find out who; the
    // CRM's own spelling of the name is what lets them see at a glance why it matched, which matters
    // most when it matched WRONGLY. Never an ellipsis, never a wrap — owner's standing rule.
    return match.scope === "own"
      ? { text: `Already their contact · ${match.contactName}`, tone: "text-orange-600" }
      : { text: `On a colleague's list · ${match.contactName}`, tone: "text-violet-600" };
  }
  if (isProspectRow(row)) return { text: "Prospect · not on their list", tone: "text-amber-600" };
  return null;
}

const VISIT_COLS = [
  { accessor: (r: RepVisitRow) => r.dateIso, defaultDir: "desc" as const, key: "dateIso", type: "string" as const },
  { accessor: (r: RepVisitRow) => sessionText(r), defaultDir: "asc" as const, key: "session", type: "string" as const },
  { accessor: (r: RepVisitRow) => contactText(r), defaultDir: "asc" as const, key: "contact", type: "string" as const },
  { accessor: (r: RepVisitRow) => r.speciality ?? "", defaultDir: "asc" as const, key: "speciality", type: "string" as const },
  { accessor: (r: RepVisitRow) => r.customerName ?? "", defaultDir: "asc" as const, key: "customer", type: "string" as const },
  { accessor: (r: RepVisitRow) => territoryLabel(r), defaultDir: "asc" as const, key: "territory", type: "string" as const },
  { accessor: (r: RepVisitRow) => r.visitTypeLabel, defaultDir: "asc" as const, key: "visitType", type: "string" as const },
  { accessor: (r: RepVisitRow) => standingText(r.standing), defaultDir: "asc" as const, key: "standing", type: "string" as const },
  { accessor: (r: RepVisitRow) => r.partnerName ?? "", defaultDir: "asc" as const, key: "partner", type: "string" as const },
];

/**
 * The reconciliation strip.
 *
 * States, in the rep's own numbers, that these rows ARE the rate on the board — the whole reason a
 * drill-down exists. `fieldCalls` here is the same figure the board calls "reported", derived from
 * the same rows through the same classifier.
 */
function SummaryStrip({ summary }: { summary: RepVisitsSummary }) {
  // Wrapped, never scrolled: cells grow to fill each line, so no line ends in an empty grey slot.
  const cells: Array<{ label: string; tone: string; value: number }> = [
    { label: "Calls", tone: "text-slate-900", value: summary.fieldCalls },
    { label: "Proved", tone: "text-emerald-700", value: summary.verified },
    { label: "No proof", tone: "text-rose-700", value: summary.unverified },
    { label: "Campaign", tone: "text-sky-700", value: summary.campaign },
    // Of those campaign calls, the ones on a doctor he already visits normally. It sits beside
    // "Campaign" because it is a SUBSET of it, and reading the two apart is the point: a rep with 40
    // campaign calls and 2 of these is prospecting; one with 40 and 35 is mis-coding his day.
    { label: "Already theirs", tone: "text-orange-600", value: summary.campaignAlreadyKnown },
    { label: "AM", tone: "text-slate-700", value: summary.am },
    { label: "PM", tone: "text-slate-700", value: summary.pm },
    // Separate from AM/PM entirely (owner, 2026-09-05) — see crm/call-rate.ts.
    { label: "Pharmacy", tone: "text-slate-700", value: summary.pharmacy },
    { label: "Doctors", tone: "text-slate-700", value: summary.distinctContacts },
    // Field calls listed below and left OUT of the rate — Thursday or Friday, a public holiday, or
    // the CRM's catch-all contact — by the rate's own gate (callRateExclusionOf). They are not in
    // "Calls" or any number beside it; each one is marked on its own row.
    { label: "Not scored", tone: "text-slate-500", value: summary.unscored },
    { label: "Not field work", tone: "text-slate-400", value: summary.excluded },
  ];
  return (
    <div className="flex flex-wrap border-l border-t border-slate-200">
      {cells.map((cell) => (
        <div className="min-w-0 basis-32 flex-1 border-b border-r border-slate-200 bg-white px-3 py-2.5" key={cell.label}>
          <p className="text-phx-xs font-black uppercase tracking-[0.16em] text-slate-400">{cell.label}</p>
          <p className={`text-lg font-black ${cell.tone}`}>{cell.value.toLocaleString("en-US")}</p>
        </div>
      ))}
    </div>
  );
}

export function RepVisitsDetail({
  mappedRegions,
  monthLabel,
  rows,
  summary,
  surface = "admin",
}: {
  /** How many CRM regions have been tied to a brick. Zero means the whole column is still waiting. */
  mappedRegions: number;
  monthLabel: string;
  rows: RepVisitRow[];
  summary: RepVisitsSummary;
  /**
   * `portal` drops the "map them in CRM → Region Mapping" instruction: that screen is /admin/crm, which
   * has no portal twin, so a rep or a field manager was sent to a link that could not open for him.
   * The fact itself — how many calls sit in an unmapped region — is still said. `admin` is unchanged.
   */
  surface?: "admin" | "portal";
}) {
  // OWNER'S RULE, 2026-08-28: vacations and visits are separated. A public holiday, a leave day, a
  // meeting or a training day arrives down the same CRM feed as a call — same date, same AM/PM flag,
  // same comment field — and left in one list it reads as a visit to a doctor named
  // "اجازة بمناسبة المولد النبوي الشريف". Two lists, one predicate, counted the same way the
  // summary strip counts them.
  const { fieldRows, offDutyRows } = partitionRepVisitRows(rows);

  const table = useSortableTable(fieldRows, {
    columns: VISIT_COLS,
    // Newest first: a manager opening this is asking "what has he been doing", and the answer starts
    // at the most recent day.
    initialSort: { dir: "desc", key: "dateIso" },
    searchAccessors: [
      (r) => contactText(r),
      // So "already his" filters the list down to the mis-coded calls in one typed phrase, and the
      // CRM's spelling of a matched doctor finds his campaign rows even though the row itself is
      // labelled with the rep's own spelling.
      (r) => campaignContactNote(r)?.text ?? "",
      (r) => r.customerName ?? "",
      (r) => r.speciality ?? "",
      (r) => territoryLabel(r),
      (r) => r.visitTypeLabel,
      (r) => r.partnerName ?? "",
    ],
  });

  // THE SHEET IS FLAT — one column per field, never the screen's merged cells. A sheet has no viewport,
  // so the fits-the-screen rule does not reach it, and a manager filtering on "Objection" wants that
  // objection in its own cell. The headers come from the FIRST row that carries any, because a column
  // this reader may not read is absent from the map rather than present and empty.
  const phoenixHeaders = Object.keys(table.rows.find((row) => row.phoenixColumns)?.phoenixColumns ?? {});
  const exportRows = table.rows.map((row) => ({
    // Spread FIRST, so a named column below always wins over a same-named field-set cell.
    ...Object.fromEntries(phoenixHeaders.map((header) => [header, row.phoenixColumns?.[header] ?? ""])),
    contact: contactText(row),
    // The id is exported beside the name because a spreadsheet is where someone reconciles against
    // the CRM, and a name alone cannot be matched back.
    contact_crm_id: row.contactCrmId ?? "",
    // The same sentence the screen shows under the doctor's name — including the CRM's spelling of
    // the matched name, because the spreadsheet is where somebody checks whether the match is right.
    contact_status: campaignContactNote(row)?.text ?? "",
    crm_region: row.crmRegionName ?? "",
    crm_region_id: row.crmRegionId ?? "",
    customer: row.customerName ?? "",
    date: row.dateIso,
    grade: row.grade ?? "",
    // The same words the row shows, blank when the call is in the rate.
    not_scored: unscoredLabel(row) ?? "",
    partner: row.partnerName ?? "",
    partner2: row.partner2Name ?? "",
    session: sessionText(row),
    speciality: row.speciality ?? "",
    standing: standingText(row.standing),
    // Matches the screen exactly (owner's standing rule) — including the "not mapped yet" wording,
    // so the file cannot read as though the geography were known.
    territory: territoryLabel(row),
    visit_crm_id: row.visitCrmId ?? "",
    visit_type: row.visitTypeLabel,
  }));

  return (
    <div className="space-y-4">
      <SummaryStrip summary={summary} />

      {/* The one honest gap on this page, stated in numbers rather than left to be inferred from a
          column of markers. It is a TODO with a route attached, not a fault: the CRM region is a real
          coded record on every one of these rows, it has simply never been tied to a Phoenix brick. */}
      {summary.unmappedTerritory > 0 ? (
        <div className="border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-xs font-bold text-amber-900">
            {summary.unmappedTerritory.toLocaleString("en-US")} of these calls sit in a CRM region that is not tied to a
            Phoenix brick yet, so their area and region cannot be resolved.
          </p>
          {surface === "portal" ? (
            <p className="mt-1 text-phx-md text-amber-800">
              The place is still named on every row — it is the brick, area and region behind it that are missing.
            </p>
          ) : (
          <p className="mt-1 text-phx-md text-amber-800">
            {mappedRegions === 0
              ? "No CRM region has been mapped at all so far."
              : `${mappedRegions.toLocaleString("en-US")} CRM regions are mapped so far.`}{" "}
            The place is still named on every row — it is the brick, area and region behind it that are missing. Map them
            once in{" "}
            <Link className="font-bold underline hover:text-amber-950" href="/admin/crm">
              CRM → Region Mapping
            </Link>{" "}
            and this column resolves everywhere, for every rep and every month.
          </p>
          )}
        </div>
      ) : null}

      <div className="border border-slate-200 bg-white">
        <div className="space-y-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {/* Given a width: bare, it sized to about 180px and cut its own placeholder short. */}
            <TableSearchInput
              className="w-full sm:w-80"
              onChange={table.setQuery}
              onClear={table.clearQuery}
              placeholder="Search doctor, clinic, speciality, place…"
              value={table.query}
            />
            <ExportXlsxButton
              columns={[
                { key: "date", label: "Date" },
                { key: "session", label: "AM / PM" },
                { key: "contact", label: "Doctor" },
                { key: "contact_crm_id", label: "CRM Contact ID" },
                { key: "contact_status", label: "Contact Status" },
                { key: "speciality", label: "Speciality" },
                { key: "grade", label: "Grade" },
                { key: "customer", label: "Clinic / Account" },
                { key: "territory", label: "Where" },
                { key: "crm_region", label: "CRM Region" },
                { key: "crm_region_id", label: "CRM Region ID" },
                { key: "visit_type", label: "Visit Type" },
                { key: "standing", label: "Proof" },
                { key: "not_scored", label: "Not Scored" },
                { key: "partner", label: "Double Visit With" },
                // The chain visit's SECOND manager, in his own column: a sheet is where somebody
                // reconciles who rode with whom, and two names in one cell cannot be filtered.
                { key: "partner2", label: "And With" },
                { key: "visit_crm_id", label: "CRM Visit ID" },
                ...phoenixHeaders.map((header) => ({ key: header, label: header })),
              ]}
              rows={exportRows}
              sheetName="Visits"
              subtitle={monthLabel}
              title="Visits behind the call rate"
            />
          </div>

          <PortalResponsiveDataList
            empty={<p className="px-3 py-6 text-center text-xs text-slate-400">No visits recorded in this period.</p>}
            getKey={(row, index) => `${row.visitCrmId ?? "row"}-${index}`}
            items={table.rows}
            renderCard={(row) => {
              const note = campaignContactNote(row);
              const unscored = unscoredLabel(row);
              return (
              <PortalRecordCard
                accent={
                  row.standing === "verified"
                    ? "emerald"
                    : row.standing === "unverified"
                      ? "rose"
                      : row.standing === "campaign"
                        ? "sky"
                        : "slate"
                }
                meta={`${dayText(row.dateIso)} · ${sessionText(row)} · ${row.visitTypeLabel}`}
                status={<span className={standingChip(row.standing)}>{standingText(row.standing)}</span>}
                title={contactText(row)}
              >
                <PortalRecordFields
                  fields={[
                    /* Same line the desktop table prints under the doctor's name: a campaign
                       call carries the marker saying this is a real doctor who is simply not on this
                       rep's list, so the card title cannot read as a resolved contact on one screen
                       and as free text on the other. A registered contact needs no line at all. */
                    ...(row.contactCrmId == null && note
                      ? [
                          {
                            label: "Doctor",
                            value: (
                              <span className={`font-black uppercase tracking-[0.1em] ${note.tone}`}>{note.text}</span>
                            ),
                          },
                        ]
                      : []),
                    // Marked on the card exactly as on the desktop row: listed, and not in the rate.
                    ...(unscored ? [{ label: "Rate", value: <span className="text-slate-500">{unscored}</span> }] : []),
                    ...(row.speciality
                      ? [{ label: "Speciality", value: <span className="text-slate-600">{row.speciality}</span> }]
                      : []),
                    ...(row.customerName
                      ? [{ label: "Clinic", value: <span className="text-slate-600">{row.customerName}</span> }]
                      : []),
                    {
                      label: "Where",
                      value:
                        row.territory.status === "mapped" ? (
                          <span className="text-slate-600">{territoryLabel(row)}</span>
                        ) : (
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="text-slate-600">{territoryLabel(row)}</span>
                            {row.territory.status === "unmapped" ? (
                              <span className={`${CHIP} border border-amber-300 bg-amber-50 text-amber-700`}>
                                Not mapped
                              </span>
                            ) : null}
                          </span>
                        ),
                    },
                    ...(partnerLine(row)
                      ? [{ label: "Double with", value: <span className="text-slate-600">{partnerLine(row)}</span> }]
                      : []),
                    ...phoenixCardFields(row),
                  ]}
                />
              </PortalRecordCard>
              );
            }}
            renderTable={() => (
              <div className="hidden md:block">
                <table className="w-full table-fixed border-collapse text-left text-xs" data-portal-desktop-table>
                  <colgroup>
                    <col style={{ width: "13%" }} />
                    <col style={{ width: "27%" }} />
                    <col style={{ width: "26%" }} />
                    <col style={{ width: "16%" }} />
                    <col style={{ width: "18%" }} />
                  </colgroup>
                  <thead>
                    <tr className="bg-slate-900 text-left">
                      <SortableTh className={THEAD} label="Day" onSort={table.toggleSort} sort={table.sort} sortKey="dateIso" />
                      <SortableTh className={THEAD} label="Doctor" onSort={table.toggleSort} sort={table.sort} sortKey="contact" />
                      <SortableTh
                        className={`${THEAD} border-l border-slate-700`}
                        label="Clinic · Where"
                        onSort={table.toggleSort}
                        sort={table.sort}
                        sortKey="territory"
                      />
                      <SortableTh
                        className={`${THEAD} border-l border-slate-700`}
                        label="Visit Type"
                        onSort={table.toggleSort}
                        sort={table.sort}
                        sortKey="visitType"
                      />
                      <SortableTh className={THEAD} label="Proof" onSort={table.toggleSort} sort={table.sort} sortKey="standing" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {table.rows.map((row, index) => {
                      const note = campaignContactNote(row);
                      const unscored = unscoredLabel(row);
                      return (
                        <tr className="bg-white align-top hover:bg-slate-50" key={`${row.visitCrmId ?? "row"}-${index}`}>
                          <td className="break-words px-3 py-2">
                            <span className="block font-semibold text-slate-900">{dayText(row.dateIso)}</span>
                            <span className="block font-bold text-slate-500">{sessionText(row)}</span>
                          </td>
                          {/* The doctor, named, with his speciality beneath. A campaign row has no
                              contact record — the doctor is real but off the rep's registered list —
                              so what shows is the rep's own note, MARKED as free text rather than
                              passed off as a resolved contact. */}
                          <td className="break-words px-3 py-2">
                            <span className="block font-semibold leading-tight text-slate-900">{contactText(row)}</span>
                            {row.contactCrmId == null && note ? (
                              <span className={`block text-phx-sm font-black uppercase tracking-[0.1em] ${note.tone}`}>
                                {note.text}
                              </span>
                            ) : null}
                            {row.speciality ? <span className="block text-slate-500">{row.speciality}</span> : null}
                            {phoenixLines([
                              row.phoenix && row.phoenix.products.length > 0 ? row.phoenix.products.join(" · ") : null,
                              row.phoenix?.samples ?? null,
                              row.phoenix?.availability ?? null,
                              row.phoenix?.objection ?? null,
                              row.phoenix?.nextStep ?? null,
                              row.phoenix?.pharmacyFeedback ?? null,
                            ])}
                          </td>
                          {/* The clinic, then Brick · Area · Region once the CRM region is mapped.
                              Until then the region still NAMES itself and is marked — never blank,
                              never a silent guess. */}
                          <td className="break-words border-l border-slate-100 px-3 py-2">
                            {row.customerName ? <span className="block text-slate-700">{row.customerName}</span> : null}
                            <span className="block text-slate-500">{territoryLabel(row)}</span>
                            {row.territory.status === "unmapped" ? (
                              <span className={`mt-1 inline-block ${CHIP} border border-amber-300 bg-amber-50 text-amber-700`}>
                                Not mapped
                              </span>
                            ) : null}
                          </td>
                          <td className="break-words border-l border-slate-100 px-3 py-2">
                            <span className="block text-slate-600">{row.visitTypeLabel}</span>
                            {phoenixLines([
                              // BOTH managers, not one. A chain visit carries two, the door has returned
                              // both since #5477, and naming one is what made the other's day read empty.
                              partnerLine(row),
                              row.phoenix?.kindLabel ?? null,
                              row.phoenix?.offPlan ?? null,
                            ])}
                          </td>
                          {/* The proof, and — when the rate's own gate left this call out — why, on
                              the row itself. Before this a Thursday call carried a green "Proved" and
                              nothing to say it was not in the number above. */}
                          <td className="break-words px-3 py-2">
                            <span className={`inline-block ${standingChip(row.standing)}`}>{standingText(row.standing)}</span>
                            {unscored ? (
                              <span className="mt-1 block text-phx-sm font-semibold leading-4 text-slate-500">{unscored}</span>
                            ) : null}
                            {phoenixLines([
                              row.phoenix?.location ?? null,
                              row.phoenix?.evidence ?? null,
                              row.phoenix?.capture ?? null,
                            ])}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          />
        </div>
      </div>

      {/* THE SEPARATION, on screen. Leave, public holidays, meetings and training arrive down the
          same CRM feed as a call and are NOT calls — so they sit here, under their own heading, with
          the reason under a "Reason" label instead of a doctor's name. They are shown rather than
          dropped because "where was he on the 27th" is a real question, and a rep whose month is
          half holidays is the explanation for a low rate, not a hidden one. */}
      {offDutyRows.length > 0 ? (
        <div className="border border-slate-200 bg-white">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 bg-slate-100 px-5 py-3">
            <h3 className="text-phx-md font-black uppercase tracking-[0.14em] text-slate-600">Days not in the field</h3>
            <p className="text-phx-md text-slate-500">
              {offDutyRows.length.toLocaleString("en-US")}{" "}
              {offDutyRows.length === 1 ? "day" : "days"} · leave, public holidays, meetings and training · counted in no
              rate, and never a visit
            </p>
          </div>
          <div className="p-5">
            <PortalResponsiveDataList
              empty={<p className="px-3 py-6 text-center text-xs text-slate-400">None in this period.</p>}
              getKey={(row, index) => `${row.visitCrmId ?? "off"}-${index}`}
              items={offDutyRows}
              renderCard={(row) => (
                <PortalRecordCard
                  accent="slate"
                  meta={dayText(row.dateIso)}
                  status={<span className={standingChip("excluded")}>{standingText("excluded")}</span>}
                  title={row.visitTypeLabel}
                >
                  <PortalRecordFields
                    fields={
                      offDutyReason(row)
                        ? [{ label: "Reason", value: <span className="text-slate-600">{offDutyReason(row)}</span> }]
                        : []
                    }
                  />
                </PortalRecordCard>
              )}
              renderTable={() => (
                // Fitted like the table above — three columns never needed a 700px minimum.
                <div className="hidden md:block">
                  <table className="w-full table-fixed border-collapse text-left text-xs" data-portal-desktop-table>
                    <colgroup>
                      <col style={{ width: "18%" }} />
                      <col style={{ width: "28%" }} />
                      <col style={{ width: "54%" }} />
                    </colgroup>
                    <thead>
                      <tr className="bg-slate-600 text-left">
                        <th className={THEAD} scope="col">
                          Date
                        </th>
                        <th className={THEAD} scope="col">
                          Type
                        </th>
                        <th className={THEAD} scope="col">
                          Reason
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {offDutyRows.map((row, index) => (
                        <tr className="bg-white align-top hover:bg-slate-50" key={`${row.visitCrmId ?? "off"}-${index}`}>
                          <td className="break-words px-3 py-2 font-semibold text-slate-900">{dayText(row.dateIso)}</td>
                          <td className="break-words px-3 py-2 font-semibold text-slate-600">{row.visitTypeLabel}</td>
                          <td className="break-words px-3 py-2 text-slate-600">
                            {offDutyReason(row) ?? <span className="text-slate-300">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
