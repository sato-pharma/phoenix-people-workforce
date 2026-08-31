"use client";

import { useMemo, useState } from "react";

import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { TableSearchInput } from "@/components/ui/sortable-table";
import type { DoctorListRow } from "@/lib/crm/contact-lists";
import type { RepsListGroup } from "@/lib/crm/reps-list";

// Client half of Reps List — the rep's contacts, one block per brick.
//
// Styling copies doctor-list-tables.tsx verbatim (flat borders, slate-900 header rows, orange
// accent, the same THEAD/grade vocabulary) because this board replaces it in the same shell.
//
// THE FILTER AND SEARCH ARE CLIENT-SIDE HERE, unlike the cascade next door, and deliberately so:
// the cascade decides WHICH REP a viewer may open, which is an access decision and therefore the
// server's; narrowing one already-authorised rep's own list to pharmacies is a view preference and
// costs a round trip for nothing.
//
// ONE SEARCH AND ONE EXPORT FOR THE WHOLE REP, NOT ONE PER BRICK. A per-brick search would mean a
// hook per group and a different number of hooks on every render, which React forbids outright; it
// would also make "find this doctor" a hunt through fifteen boxes. Group headings stay visible while
// a filter is active, minus any group the filter empties.

const THEAD = "px-3 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-white";
const LABEL_CLASS = "block text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400";
const SELECT_CLASS =
  "h-9 w-full border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400";

/**
 * The three list names, in the owner's own words — corrected by him on 2026-09-01: PM list, AM list,
 * Pharmacist. The first build renamed `PM` to something friendlier because that is what it holds,
 * and that is exactly what he refused: the CRM says PM, the reps and the managers say PM, so a
 * prettier name on this one screen only makes Phoenix and the CRM disagree out loud in front of a
 * user. Pinned in tests/reps-list.test.ts, because a rename reads as a harmless copy tidy-up.
 */
const LIST_LABEL: Record<DoctorListRow["listType"], string> = {
  AM: "AM list",
  PM: "PM list",
  Pharmacy: "Pharmacist",
};

const LIST_FILTERS = [
  { label: "All three lists", value: "" },
  { label: "PM list only", value: "PM" },
  { label: "AM list only", value: "AM" },
  { label: "Pharmacists only", value: "Pharmacy" },
] as const;

function gradeClass(grade: string | null): string {
  if (grade === "A" || grade === "A+") return "text-rose-700";
  if (grade === "B") return "text-amber-700";
  if (!grade) return "text-slate-300";
  return "text-slate-500";
}

/** What the pickers and the table show when the CRM left the field empty. */
const NO_GRADE = "No grade";
const UNSPECIFIED = "Unspecified";

const gradeOf = (row: DoctorListRow): string => row.grade?.trim() || NO_GRADE;
const specialityOf = (row: DoctorListRow): string => row.speciality?.trim() || UNSPECIFIED;

/** A group's stable key — the brick id when it has one, else its locality name. */
const groupKey = (group: RepsListGroup): string => group.brickId ?? `region:${group.heading}`;

/**
 * Distinct values for one picker, in the order a reader expects.
 *
 * Built from THIS REP'S OWN CONTACTS rather than from a company-wide vocabulary, for the same
 * reason the cascade next door is built from real cells: a picker that offers a specialty this rep
 * does not carry is a dead end, and a dead end reads as "the filter is broken".
 */
function distinct(rows: readonly DoctorListRow[], read: (row: DoctorListRow) => string): string[] {
  const seen = new Set<string>();
  for (const row of rows) seen.add(read(row));
  // The two placeholders sort last wherever they appear — an absent value is not a category.
  return [...seen].sort((left, right) => {
    const placeholder = (value: string) => (value === NO_GRADE || value === UNSPECIFIED ? 1 : 0);
    return placeholder(left) - placeholder(right) || left.localeCompare(right);
  });
}

function matches(row: DoctorListRow, needle: string): boolean {
  if (!needle) return true;
  const haystack = [row.name, row.nameAr, row.speciality, row.region, row.address, row.grade, row.phone]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

function GroupHeading({ group, shown }: { group: RepsListGroup; shown: number }) {
  // A mapped brick and an unmapped locality are visually distinct because they mean different
  // things: the first is a real territory, the second is a locality nobody has mapped to one yet.
  // Same shape, different tone — never a hidden row and never an identical-looking one.
  return (
    <div
      className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-y px-5 py-2.5 ${
        group.mapped ? "border-slate-200 bg-slate-50" : "border-amber-200 bg-amber-50"
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* dir="auto" on the heading: brick names in production are single-language Arabic locality
            names, which is the case where block-level auto is house style and correct. */}
        <h3 className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-900" dir="auto">
          {group.heading}
        </h3>
        {group.mapped && group.areaName ? (
          <span className="text-phx-2xs font-semibold text-slate-500">{group.areaName}</span>
        ) : null}
        {group.mapped ? null : (
          <span className="text-phx-2xs font-black uppercase tracking-[0.1em] text-amber-700">
            Locality not yet mapped to a brick
          </span>
        )}
      </div>
      <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">
        {shown === group.contacts.length
          ? `${group.contacts.length} contacts`
          : `${shown} of ${group.contacts.length} contacts`}
      </span>
    </div>
  );
}

function GroupTable({ group, rows }: { group: RepsListGroup; rows: DoctorListRow[] }) {
  // The owner asked for the Locality column to become the BRICK (2026-09-01), and the HEADING SAYS
  // BRICK ON EVERY GROUP — a column that renames itself block by block is not a column. Every row in
  // a group shares one brick by construction, so the cell repeats the heading, which is the point:
  // it makes the brick filterable and exportable per row rather than only per block.
  //
  // An unmapped group has no brick to name, so its cell carries the locality in AMBER, the same tone
  // as the heading above it that already says the locality is not mapped to a brick yet. Amber and
  // slate are doing the work a second column name would have done, without the column lying.
  const brickCell = group.heading;
  return (
    <PortalResponsiveDataList
      empty={<p className="px-3 py-6 text-center text-xs text-slate-400">No contacts match this filter.</p>}
      getKey={(row) => `${row.agentCrmId}:${row.contactCrmId}:${row.listType}`}
      items={rows}
      renderCard={(row) => (
        <PortalRecordCard
          accent={row.listType === "Pharmacy" ? "sky" : "slate"}
          meta={`${row.speciality ?? "Unspecified"} · ${LIST_LABEL[row.listType]}`}
          status={
            <span className={`text-phx-2xs font-black uppercase tracking-[0.1em] ${gradeClass(row.grade)}`}>
              {row.grade ?? "No grade"}
            </span>
          }
          title={row.name}
        >
          <PortalRecordFields
            fields={[
              { label: "Brick", value: group.mapped ? brickCell : `${brickCell} — no brick yet` },
              { label: "Address", value: row.address ?? "—" },
              { label: "Phone", value: row.phone ?? "—" },
            ]}
          />
        </PortalRecordCard>
      )}
      renderTable={() => (
        <PortalDesktopTable className="text-xs" minWidth="1120px">
          <thead>
            <tr className="bg-slate-900 text-left">
              <th className={THEAD}>Contact</th>
              <th className={THEAD}>Grade</th>
              <th className={THEAD}>Specialty</th>
              <th className={THEAD}>List</th>
              <th className={THEAD}>Brick</th>
              <th className={THEAD}>Address</th>
              <th className={THEAD}>Phone</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr
                className="whitespace-nowrap bg-white hover:bg-slate-50"
                key={`${row.agentCrmId}:${row.contactCrmId}:${row.listType}`}
              >
                <td className="px-3 py-2 font-semibold text-slate-900" dir="auto">
                  {row.name}
                </td>
                <td className={`px-3 py-2 font-black ${gradeClass(row.grade)}`}>{row.grade ?? "—"}</td>
                <td className="px-3 py-2 text-slate-600">{row.speciality ?? "Unspecified"}</td>
                <td className="px-3 py-2 text-slate-400">{LIST_LABEL[row.listType]}</td>
                <td
                  className={`px-3 py-2 font-semibold ${group.mapped ? "text-slate-600" : "text-amber-700"}`}
                  dir="auto"
                >
                  {brickCell}
                </td>
                {/* Never truncated and never wrapped (owner's standing rule): the table side-scrolls
                    inside its own container instead, which is what minWidth is for. A dash is the
                    CRM's own answer on the address and the phone, not a load failure — phone is
                    filled on about a third of rows and the address on none at all for some reps. */}
                <td className="px-3 py-2 text-slate-600" dir="auto">
                  {row.address ?? "—"}
                </td>
                <td className="px-3 py-2 text-slate-600">{row.phone ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </PortalDesktopTable>
      )}
    />
  );
}

export function RepsListContacts({
  groups,
  repName,
  syncedAt,
}: {
  groups: RepsListGroup[];
  repName: string;
  syncedAt: string | null;
}) {
  // Five filters, all client-side: brick, list, grade, specialty and free text. The owner asked for
  // them on 2026-09-01 — "filter by grade, or by specialty, or by AM or PM or pharmacist, or by
  // brick". They compose rather than replace each other, so "grade A neurologists in Smouha" is one
  // question, not three passes.
  const [brick, setBrick] = useState("");
  const [grade, setGrade] = useState("");
  const [listType, setListType] = useState("");
  const [speciality, setSpeciality] = useState("");
  const [query, setQuery] = useState("");

  // Picker options come from the rep's whole list, never from the currently filtered rows: options
  // that vanish as you narrow make the controls feel broken and strand you with no way back.
  const allRows = useMemo(() => groups.flatMap((group) => group.contacts), [groups]);
  const gradeOptions = useMemo(() => distinct(allRows, gradeOf), [allRows]);
  const specialityOptions = useMemo(() => distinct(allRows, specialityOf), [allRows]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return groups
      .filter((group) => !brick || groupKey(group) === brick)
      .map((group) => ({
        group,
        rows: group.contacts.filter(
          (row) =>
            (!listType || row.listType === listType) &&
            (!grade || gradeOf(row) === grade) &&
            (!speciality || specialityOf(row) === speciality) &&
            matches(row, needle),
        ),
      }))
      .filter((entry) => entry.rows.length > 0);
  }, [brick, grade, groups, listType, query, speciality]);

  // The export carries the brick and the area on every row, because the grouping IS the finding
  // here — a flat contact export would throw away the one thing this board adds. Unmapped rows
  // export with an explicit note rather than an empty cell, so a blank never reads as a data gap.
  const exportRows = visible.flatMap((entry) =>
    entry.rows.map((row) => ({
      address: row.address ?? "",
      area: entry.group.mapped ? (entry.group.areaName ?? "") : "",
      brick: entry.group.mapped ? entry.group.heading : `${entry.group.heading} (not yet mapped to a brick)`,
      contact: row.name,
      contact_ar: row.nameAr ?? "",
      grade: row.grade ?? "",
      list: LIST_LABEL[row.listType],
      locality: row.region ?? "",
      phone: row.phone ?? "",
      speciality: row.speciality ?? "",
    })),
  );

  const shownCount = exportRows.length;
  const totalCount = groups.reduce((total, group) => total + group.contacts.length, 0);
  // Bricks and unmapped localities are counted apart in the summary line for the same reason the
  // headings are coloured apart: calling a locality a brick states that Phoenix knows where it is.
  const brickCount = groups.filter((group) => group.mapped).length;
  const localityCount = groups.length - brickCount;
  const bricks = `${brickCount} ${brickCount === 1 ? "brick" : "bricks"}`;
  const localities = `${localityCount} ${localityCount === 1 ? "locality" : "localities"}`;
  const spread =
    localityCount === 0
      ? bricks
      : brickCount === 0
        ? `${localities} awaiting a brick`
        : `${bricks} and ${localities} awaiting one`;

  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block w-full sm:w-56">
            <span className={LABEL_CLASS}>Brick</span>
            <select className={`mt-1 ${SELECT_CLASS}`} onChange={(event) => setBrick(event.target.value)} value={brick}>
              <option value="">All bricks</option>
              {groups.map((group) => (
                <option key={groupKey(group)} value={groupKey(group)}>
                  {group.mapped ? group.heading : `${group.heading} — no brick yet`}
                </option>
              ))}
            </select>
          </label>
          <label className="block w-full sm:w-48">
            <span className={LABEL_CLASS}>List</span>
            <select
              className={`mt-1 ${SELECT_CLASS}`}
              onChange={(event) => setListType(event.target.value)}
              value={listType}
            >
              {LIST_FILTERS.map((option) => (
                <option key={option.value || "all"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block w-full sm:w-40">
            <span className={LABEL_CLASS}>Grade</span>
            <select className={`mt-1 ${SELECT_CLASS}`} onChange={(event) => setGrade(event.target.value)} value={grade}>
              <option value="">All grades</option>
              {gradeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="block w-full sm:w-56">
            <span className={LABEL_CLASS}>Specialty</span>
            <select
              className={`mt-1 ${SELECT_CLASS}`}
              onChange={(event) => setSpeciality(event.target.value)}
              value={speciality}
            >
              <option value="">All specialties</option>
              {specialityOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <TableSearchInput
            onChange={setQuery}
            onClear={() => setQuery("")}
            placeholder="Search contact, specialty or address…"
            value={query}
          />
        </div>
        <ExportXlsxButton
          columns={[
            { key: "brick", label: "Brick" },
            { key: "area", label: "Area" },
            { key: "contact", label: "Contact" },
            { key: "contact_ar", label: "Contact (Arabic)" },
            { key: "grade", label: "Grade" },
            { key: "speciality", label: "Specialty" },
            { key: "list", label: "List" },
            { key: "locality", label: "Locality" },
            { key: "phone", label: "Phone" },
            { key: "address", label: "Address" },
          ]}
          rows={exportRows}
          sheetName="Reps List"
          subtitle={syncedAt ? `${repName} · grouped by brick, as held by the CRM` : repName}
          title="Reps List"
        />
      </div>

      <p className="text-phx-2xs font-semibold text-slate-400">
        {shownCount === totalCount
          ? `${totalCount} contacts across ${spread}`
          : `${shownCount} of ${totalCount} contacts · ${visible.length} of ${groups.length} groups`}
      </p>

      {visible.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-slate-400">No contacts match this filter.</p>
      ) : (
        <div className="border border-slate-200">
          {visible.map((entry) => (
            <div key={groupKey(entry.group)}>
              <GroupHeading group={entry.group} shown={entry.rows.length} />
              <GroupTable group={entry.group} rows={entry.rows} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
