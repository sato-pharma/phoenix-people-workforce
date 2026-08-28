"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { SortableTh, TableSearchInput } from "@/components/ui/sortable-table";
import { useSortableTable } from "@/components/ui/use-sortable-table";
import type { DoctorListRepSummary, DoctorListRow } from "@/lib/crm/contact-lists";

// Client half of Doctor List. Styling copies rep-doctor-lists-tables.tsx verbatim — flat borders,
// slate-900 header rows, orange accent — because this board sits directly beside it in the same
// shell and must not read as a one-off (owner's standing rule).
//
// The rep choice is a URL parameter, so each change re-runs the server-side access gate rather than
// filtering a payload already in the browser. That is the sibling's rule and the reason for it is
// the same here: the list a viewer may see is a server decision.
//
// NO VISIT COLUMN, DELIBERATELY. The owner's words when he specified this board: "all contact data
// of the doctors in that rep's CRM list — name, address, specialty, grade. Not visits." Activity
// belongs to Rep Doctor Lists and Doctor Coverage next door. This board is the list itself.

const THEAD = "px-3 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-white";
const SELECT_CLASS =
  "h-9 w-full border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400";
const LABEL_CLASS = "block text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400";

const LIST_LABEL: Record<DoctorListRow["listType"], string> = {
  AM: "AM list",
  PM: "Doctor list",
  Pharmacy: "Pharmacy",
};

function gradeClass(grade: string | null): string {
  if (grade === "A" || grade === "A+") return "text-rose-700";
  if (grade === "B") return "text-amber-700";
  if (!grade) return "text-slate-300";
  return "text-slate-500";
}

export function DoctorListRepPicker({
  basePath,
  reps,
  selectedAgentCrmId,
}: {
  basePath: string;
  reps: DoctorListRepSummary[];
  selectedAgentCrmId: number;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  // w-full below `sm`, so the picker takes its own line under the title on a phone rather than
  // sharing the row. A 16rem minimum was measured at 375px overflowing the page by 9px — a
  // sideways-scrolling phone page, which is the one thing the card layout exists to prevent.
  return (
    <label className="block w-full space-y-1 sm:w-72">
      <span className={LABEL_CLASS}>Medical rep</span>
      <select
        className={SELECT_CLASS}
        disabled={pending}
        onChange={(event) => {
          setPending(true);
          router.push(`${basePath}?rep=${encodeURIComponent(event.target.value)}`);
        }}
        value={String(selectedAgentCrmId)}
      >
        {reps.map((rep) => (
          <option key={rep.agentCrmId} value={String(rep.agentCrmId)}>
            {rep.name} — {rep.pmCount} doctors
          </option>
        ))}
      </select>
    </label>
  );
}

const DOCTOR_COLS = [
  { accessor: (r: DoctorListRow) => r.name, defaultDir: "asc" as const, key: "name", type: "string" as const },
  { accessor: (r: DoctorListRow) => r.grade, key: "grade", type: "string" as const },
  { accessor: (r: DoctorListRow) => r.speciality, key: "speciality", type: "string" as const },
  { accessor: (r: DoctorListRow) => r.region, key: "region", type: "string" as const },
  { accessor: (r: DoctorListRow) => r.listType, key: "listType", type: "string" as const },
  { accessor: (r: DoctorListRow) => r.phone, key: "phone", type: "string" as const },
  { accessor: (r: DoctorListRow) => r.address, key: "address", type: "string" as const },
];

export function DoctorListTable({
  repName,
  rows,
  syncedAt,
}: {
  repName: string;
  rows: DoctorListRow[];
  syncedAt: string | null;
}) {
  const table = useSortableTable(rows, {
    columns: DOCTOR_COLS,
    initialSort: { dir: "asc", key: "name" },
    searchAccessors: [
      (r) => r.name,
      (r) => r.nameAr ?? "",
      (r) => r.speciality ?? "",
      (r) => r.region ?? "",
      (r) => r.address ?? "",
      (r) => r.grade ?? "",
    ],
  });

  const exportRows = table.rows.map((row) => ({
    address: row.address ?? "",
    doctor: row.name,
    doctor_ar: row.nameAr ?? "",
    grade: row.grade ?? "",
    list: LIST_LABEL[row.listType],
    locality: row.region ?? "",
    phone: row.phone ?? "",
    speciality: row.speciality ?? "",
  }));

  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TableSearchInput
          onChange={table.setQuery}
          onClear={table.clearQuery}
          placeholder="Search doctor, specialty or address…"
          value={table.query}
        />
        <ExportXlsxButton
          columns={[
            { key: "doctor", label: "Doctor" },
            { key: "doctor_ar", label: "Doctor (Arabic)" },
            { key: "grade", label: "Grade" },
            { key: "speciality", label: "Specialty" },
            { key: "locality", label: "Locality" },
            { key: "list", label: "List" },
            { key: "phone", label: "Phone" },
            { key: "address", label: "Address" },
          ]}
          rows={exportRows}
          sheetName="Doctor List"
          subtitle={syncedAt ? `${repName} · as held by the CRM` : repName}
          title="Doctor List"
        />
      </div>
      <PortalResponsiveDataList
        empty={<p className="px-3 py-6 text-center text-xs text-slate-400">No doctors match this filter.</p>}
        getKey={(row) => `${row.agentCrmId}:${row.contactCrmId}:${row.listType}`}
        items={table.rows}
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
                { label: "Locality", value: row.region ?? "—" },
                { label: "Phone", value: row.phone ?? "—" },
                { label: "Address", value: row.address ?? "—" },
              ]}
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable className="text-xs" minWidth="1180px">
            <thead>
              <tr className="bg-slate-900 text-left">
                <SortableTh className={THEAD} label="Doctor" onSort={table.toggleSort} sort={table.sort} sortKey="name" />
                <SortableTh className={THEAD} label="Grade" onSort={table.toggleSort} sort={table.sort} sortKey="grade" />
                <SortableTh className={THEAD} label="Specialty" onSort={table.toggleSort} sort={table.sort} sortKey="speciality" />
                <SortableTh className={THEAD} label="Locality" onSort={table.toggleSort} sort={table.sort} sortKey="region" />
                <SortableTh className={THEAD} label="List" onSort={table.toggleSort} sort={table.sort} sortKey="listType" />
                <SortableTh className={THEAD} label="Phone" onSort={table.toggleSort} sort={table.sort} sortKey="phone" />
                <SortableTh className={THEAD} label="Address" onSort={table.toggleSort} sort={table.sort} sortKey="address" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.rows.map((row) => (
                <tr
                  className="whitespace-nowrap bg-white hover:bg-slate-50"
                  key={`${row.agentCrmId}:${row.contactCrmId}:${row.listType}`}
                >
                  <td className="px-3 py-2 font-semibold text-slate-900">{row.name}</td>
                  <td className={`px-3 py-2 font-black ${gradeClass(row.grade)}`}>{row.grade ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-600">{row.speciality ?? "Unspecified"}</td>
                  <td className="px-3 py-2 text-slate-400">{row.region ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-400">{LIST_LABEL[row.listType]}</td>
                  {/* Filled on about a third of doctor rows and on none at all for some reps, so a
                      dash here is the CRM's answer, not a load failure. */}
                  <td className="px-3 py-2 text-slate-600">{row.phone ?? "—"}</td>
                  {/* The address is long, genuinely needed, and never truncated or wrapped (owner's
                      standing rule) — the table side-scrolls instead, which is what minWidth is for. */}
                  <td className="px-3 py-2 text-slate-600">{row.address ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </div>
  );
}
