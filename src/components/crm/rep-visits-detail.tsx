"use client";

import Link from "next/link";

import {
  PortalDesktopTable,
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
  type RepVisitRow,
  type RepVisitStanding,
  type RepVisitsSummary,
} from "@/lib/crm/rep-visits";

// The visits behind one rep's call rate. Styling copies the board next door verbatim — flat borders,
// slate-900 header row, orange focus — because this IS that board, one level down (owner's standing
// rule: match the sibling pages, never invent a one-off look).
//
// Desktop table / mobile cards via PortalResponsiveDataList — AGENTS.md §4. Nothing wraps or
// ellipsises; the table scrolls inside its own container.

const THEAD = "px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.12em] text-white";
const CHIP = "px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em]";

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

function sessionText(row: RepVisitRow): string {
  return REP_VISIT_SESSION_LABELS.get(row.session) ?? "—";
}

/** "Sat 02 Aug" — the weekday matters, because the KPI only counts Sat–Wed. */
function dayText(dateIso: string): string {
  if (!dateIso) return "—";
  const parsed = new Date(`${dateIso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return dateIso;
  return parsed.toLocaleDateString("en-GB", {
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
 * same row is exactly how "Prospect · not on his list" survived on 3,126 visits where it was false.
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
      ? { text: `Already his contact · ${match.contactName}`, tone: "text-orange-600" }
      : { text: `On a colleague's list · ${match.contactName}`, tone: "text-violet-600" };
  }
  if (isProspectRow(row)) return { text: "Prospect · not on his list", tone: "text-amber-600" };
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
  const cells: Array<{ label: string; tone: string; value: number }> = [
    { label: "Calls", tone: "text-slate-900", value: summary.fieldCalls },
    { label: "Proved", tone: "text-emerald-700", value: summary.verified },
    { label: "No proof", tone: "text-rose-700", value: summary.unverified },
    { label: "Campaign", tone: "text-sky-700", value: summary.campaign },
    // Of those campaign calls, the ones on a doctor he already visits normally. It sits beside
    // "Campaign" because it is a SUBSET of it, and reading the two apart is the point: a rep with 40
    // campaign calls and 2 of these is prospecting; one with 40 and 35 is mis-coding his day.
    { label: "Already his", tone: "text-orange-600", value: summary.campaignAlreadyKnown },
    { label: "AM", tone: "text-slate-700", value: summary.am },
    { label: "PM", tone: "text-slate-700", value: summary.pm },
    { label: "Doctors", tone: "text-slate-700", value: summary.distinctContacts },
    { label: "Not field work", tone: "text-slate-400", value: summary.excluded },
  ];
  return (
    <div className="grid grid-cols-2 gap-px border border-slate-200 bg-slate-200 sm:grid-cols-3 lg:grid-cols-9">
      {cells.map((cell) => (
        <div className="bg-white px-3 py-2.5" key={cell.label}>
          <p className="text-[9px] font-black uppercase tracking-[0.16em] text-slate-400">{cell.label}</p>
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
}: {
  /** How many CRM regions have been tied to a brick. Zero means the whole column is still waiting. */
  mappedRegions: number;
  monthLabel: string;
  rows: RepVisitRow[];
  summary: RepVisitsSummary;
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

  const exportRows = table.rows.map((row) => ({
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
    partner: row.partnerName ?? "",
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
          <p className="mt-1 text-[11px] text-amber-800">
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
        </div>
      ) : null}

      <div className="border border-slate-200 bg-white">
        <div className="space-y-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TableSearchInput
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
                { key: "partner", label: "Double Visit With" },
                { key: "visit_crm_id", label: "CRM Visit ID" },
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
                    /* Same provenance line the desktop table prints under the doctor's name: a
                       registered contact carries its CRM id, and a campaign call carries the marker
                       saying this is a real doctor who is simply not on this rep's list. Without it
                       the card title reads as a resolved contact on mobile and as free text on
                       desktop — the same row telling two different stories. */
                    ...(row.contactCrmId != null
                      ? [
                          {
                            label: "Doctor",
                            value: <span className="font-semibold text-slate-500">CRM #{row.contactCrmId}</span>,
                          },
                        ]
                      : note
                        ? [
                            {
                              label: "Doctor",
                              value: (
                                <span className={`font-black uppercase tracking-[0.1em] ${note.tone}`}>
                                  {note.text}
                                </span>
                              ),
                            },
                          ]
                        : []),
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
                    ...(row.partnerName
                      ? [{ label: "Double with", value: <span className="text-slate-600">{row.partnerName}</span> }]
                      : []),
                  ]}
                />
              </PortalRecordCard>
              );
            }}
            renderTable={() => (
              <PortalDesktopTable className="text-xs" minWidth="1500px">
                <thead>
                  <tr className="bg-slate-900 text-left">
                    <SortableTh className={THEAD} label="Date" onSort={table.toggleSort} sort={table.sort} sortKey="dateIso" />
                    <SortableTh className={THEAD} label="AM / PM" onSort={table.toggleSort} sort={table.sort} sortKey="session" />
                    <SortableTh className={THEAD} label="Doctor" onSort={table.toggleSort} sort={table.sort} sortKey="contact" />
                    <SortableTh
                      className={THEAD}
                      label="Speciality"
                      onSort={table.toggleSort}
                      sort={table.sort}
                      sortKey="speciality"
                    />
                    <SortableTh
                      className={THEAD}
                      label="Clinic / Account"
                      onSort={table.toggleSort}
                      sort={table.sort}
                      sortKey="customer"
                    />
                    <SortableTh
                      className={`${THEAD} border-l border-slate-700`}
                      label="Where"
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
                    <SortableTh
                      className={THEAD}
                      label="Double Visit With"
                      onSort={table.toggleSort}
                      sort={table.sort}
                      sortKey="partner"
                    />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {table.rows.map((row, index) => {
                    const note = campaignContactNote(row);
                    return (
                    <tr className="whitespace-nowrap bg-white hover:bg-slate-50" key={`${row.visitCrmId ?? "row"}-${index}`}>
                      <td className="px-3 py-2 font-semibold text-slate-900">{dayText(row.dateIso)}</td>
                      <td className="px-3 py-2 font-bold text-slate-500">{sessionText(row)}</td>
                      {/* The doctor, named, with the CRM contact id beneath — the record this row
                          points at, so a reader can reconcile against the CRM without guessing.

                          A campaign row has no such record: the doctor is real but off the rep's
                          registered list, so what shows is the rep's own note and it is MARKED as
                          free text rather than passed off as a resolved contact. */}
                      <td className="px-3 py-2">
                        <span className="flex flex-col leading-tight">
                          <span className="font-semibold text-slate-900">{contactText(row)}</span>
                          {row.contactCrmId != null ? (
                            <span className="text-[10px] font-semibold text-slate-400">CRM #{row.contactCrmId}</span>
                          ) : note ? (
                            <span className={`text-[10px] font-black uppercase tracking-[0.1em] ${note.tone}`}>
                              {note.text}
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-slate-600">
                        {row.speciality ?? <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-2 text-slate-600">
                        {row.customerName ?? <span className="text-slate-300">—</span>}
                      </td>
                      {/* Brick · Area · Region once the CRM region is mapped. Until then the region
                          still NAMES itself and is marked — never blank, never a silent guess. */}
                      <td className="border-l border-slate-100 px-3 py-2">
                        <span className="flex items-center gap-2">
                          <span className="text-slate-600">{territoryLabel(row)}</span>
                          {row.territory.status === "unmapped" ? (
                            <span className={`${CHIP} border border-amber-300 bg-amber-50 text-amber-700`}>Not mapped</span>
                          ) : null}
                        </span>
                      </td>
                      <td className="border-l border-slate-100 px-3 py-2 text-slate-600">{row.visitTypeLabel}</td>
                      <td className="px-3 py-2">
                        <span className={standingChip(row.standing)}>{standingText(row.standing)}</span>
                      </td>
                      <td className="px-3 py-2 text-slate-600">
                        {row.partnerName ?? <span className="text-slate-300">—</span>}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </PortalDesktopTable>
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
            <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-600">Days not in the field</h3>
            <p className="text-[11px] text-slate-500">
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
                <PortalDesktopTable className="text-xs" minWidth="700px">
                  <thead>
                    <tr className="bg-slate-600 text-left">
                      <th className={THEAD}>Date</th>
                      <th className={THEAD}>Day</th>
                      <th className={THEAD}>Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {offDutyRows.map((row, index) => (
                      <tr className="whitespace-nowrap bg-white hover:bg-slate-50" key={`${row.visitCrmId ?? "off"}-${index}`}>
                        <td className="px-3 py-2 font-semibold text-slate-900">{dayText(row.dateIso)}</td>
                        <td className="px-3 py-2 font-semibold text-slate-600">{row.visitTypeLabel}</td>
                        <td className="px-3 py-2 text-slate-600">
                          {offDutyReason(row) ?? <span className="text-slate-300">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </PortalDesktopTable>
              )}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
