"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Braces, ChevronLeft, ChevronRight, Download, Info, Loader2, Search, TriangleAlert, X } from "lucide-react";

import { rowDetailToggleProps, TableRowDetail } from "@/components/ui/table-row-detail";
import { PortalRecordCard, PortalRecordFields } from "@/components/employee-portal/portal-primitives";
import {
  formatVendorLocal,
  formatVendorTimeOnly,
  recognitionLabel,
  renderCell,
} from "@/lib/crm/master-cell-format";
import { crmMasterSupportsFilter, type CrmMasterFilterKey } from "@/lib/crm/master-datasets";
import type {
  CrmMasterAmpm,
  CrmMasterColumn,
  CrmMasterData,
  CrmMasterMappingStatus,
  CrmMasterRow,
} from "@/lib/crm/master";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

// renderCell / formatVendorLocal / formatVendorTimeOnly / recognitionLabel — and the export-only
// renderExportCell — now live in the shared, server-safe @/lib/crm/master-cell-format, so the
// server-side streaming XLSX export renders every cell exactly as this table does. The four helpers
// used on screen are imported at the top of this file.

/** The Visit Time cell: date+time on top, a GPS/Logged source badge below — the same visual as
 * the Visits Report's Visit Time column, so the two screens read identically. `source` is the raw
 * row.visit_time_source value ("GPS check-in" | "Logged/save" | null); visit_time_source is
 * deliberately not its own table column (redundant once folded in here). */
function VisitTimeCell({ source, value, wrap = false }: { source: unknown; value: unknown; wrap?: boolean }) {
  if (value === null || value === undefined || value === "") return <span className="text-slate-400">—</span>;
  const isGps = source === "GPS check-in";
  return (
    // `wrap` (portal only): in a narrow merged Day column the chip drops under the time rather than
    // pushing the cell wider. The admin grid's nowrap cells render exactly as before.
    <span className={wrap ? "inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5" : "inline-flex items-center gap-1.5"}>
      <span title={formatVendorLocal(value)}>{formatVendorTimeOnly(value)}</span>
      <span
        className={`rounded px-1 py-0.5 text-phx-3xs font-bold uppercase tracking-wide ${
          isGps ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
        }`}
        title={isGps ? "Real GPS check-in time (on site)" : "Logged/save time — not GPS-verified; may be logged later"}
      >
        {isGps ? "GPS" : "Logged"}
      </span>
    </span>
  );
}

/** The Recognized cell: a color-coded badge for the row's recognition_score (100/75/50/null),
 * hovering shows exactly which checks failed (row.recognition_missing) — so a bad score is
 * immediately actionable, not just a mystery color. Red/unlabeled (score null) is deliberately the
 * loudest state: those are the "mostly unresolved" rows the column exists to surface at a glance. */
function RecognitionBadge({ missing, score }: { missing: unknown; score: unknown }) {
  const label = recognitionLabel(score);
  const tone =
    score === 100
      ? "bg-emerald-100 text-emerald-700"
      : score === 75
        ? "bg-amber-100 text-amber-700"
        : score === 50
          ? "bg-orange-100 text-orange-700"
          : "bg-rose-100 text-rose-700";
  const title = typeof missing === "string" && missing ? `Missing: ${missing}` : "All checks resolved";
  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-phx-xs font-bold ${tone}`} title={title}>
      {label}
    </span>
  );
}

/** One cell, rendered the same way whether it lands in a desktop `<td>` or a mobile card field.
 * The two special-cased columns live here rather than in the table body so the phone view cannot
 * quietly degrade Visit Time back to a bare timestamp or Recognized back to a naked number. */
function masterCell(col: CrmMasterColumn, row: CrmMasterRow) {
  if (col.key === "visit_time") return <VisitTimeCell source={row.visit_time_source} value={row[col.key]} />;
  if (col.key === "recognition_score") return <RecognitionBadge missing={row.recognition_missing} score={row[col.key]} />;
  return renderCell(row[col.key], col.kind);
}

// ── The employee-portal surface ─────────────────────────────────────────────────────────────────
//
// /employee-portals/crm renders this same component with `surface="portal"`; /admin/crm renders it
// with the default and is byte-for-byte what it was. For a medical rep the admin grid was the raw
// dataset explorer: 44 nowrap columns in a scroll box (a sideways scroll at every width from 768px,
// behind a 1px mirrored scrollbar a touch tablet never shows), phone cards titled "CRM Visit ID" and
// then ~43 fields of HR ids, CRM ids, region ids, numeric type codes, coordinates and the raw JSON.
//
// So the portal draws a FITTED table instead: `w-full table-fixed` over a percentage colgroup, the
// fields merged into a handful of columns a person reads (day with its AM/PM and time chip, the
// doctor with his speciality and grade, the type with how it is counted, who was on the visit, where,
// and the comment). Every OTHER column is one tap away under "All fields" — ids and coordinates live
// only there — so the owner's 2026-07-30 requirement that these seats get the FULL grid
// (portal-crm-scope.ts) still holds, without a sideways scroll. No raw JSON is shown in the portal.

/** One merged column of the portal table, and the card field it becomes on a phone. */
type PortalColumn = {
  id: string;
  label: string;
  /** Percentage of the table; every dataset's widths sum to 100. */
  width: string;
  /** The dataset columns this merged column shows, so "All fields" does not repeat them. */
  keys: readonly string[];
  render: (row: CrmMasterRow) => ReactNode;
  /** The phone card's field. Omitted = `render`; returning null leaves the field off the card. */
  card?: (row: CrmMasterRow) => ReactNode | null;
  /** The phone card field's label, when `card` shows something other than the column head says. */
  cardLabel?: string;
  /** Already said in the card's title or meta line, so not repeated as a field. */
  inCardHeader?: boolean;
};

function textOf(row: CrmMasterRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text && text !== "—" ? text : null;
}

function dateOf(row: CrmMasterRow, key: string): string | null {
  return textOf(row, key) ? renderCell(row[key], "date") : null;
}

function joined(parts: ReadonlyArray<string | null>): string | null {
  const kept = parts.filter((part): part is string => Boolean(part));
  return kept.length > 0 ? kept.join(" · ") : null;
}

function Sub({ children }: { children: ReactNode }) {
  return <span className="mt-0.5 block break-words text-slate-500">{children}</span>;
}

function Lead({ children }: { children: ReactNode }) {
  return (
    <span className="block break-words font-semibold text-slate-900" dir="auto">
      {children}
    </span>
  );
}

const DASH = <span className="text-slate-400">—</span>;

function visitDayText(row: CrmMasterRow): string | null {
  return joined([dateOf(row, "visit_date"), textOf(row, "ampm")]);
}

function contactSub(row: CrmMasterRow): string | null {
  const grade = textOf(row, "crm_contact_grade");
  return joined([textOf(row, "speciality"), grade ? `grade ${grade}` : null]);
}

/** Where the visit happened: the GPS-resolved brick when a check-in matched, else the CRM's own
 * region name, each said as what it is. Never blank without saying so. */
function whereCell(row: CrmMasterRow): ReactNode {
  const gps = joined([textOf(row, "geo_brick"), textOf(row, "geo_area")]);
  if (gps) {
    return (
      <>
        <Lead>{gps}</Lead>
        <Sub>Brick (GPS)</Sub>
      </>
    );
  }
  const region = textOf(row, "crm_region_name");
  if (region) {
    return (
      <>
        <Lead>{region}</Lead>
        <Sub>CRM region</Sub>
      </>
    );
  }
  return DASH;
}

function commentCell(row: CrmMasterRow): ReactNode {
  const comment = textOf(row, "comment");
  return comment ? (
    <span className="block break-words text-slate-700" dir="auto">
      {comment}
    </span>
  ) : (
    DASH
  );
}

/**
 * The merged columns for a dataset. `selfScope` is a medical rep reading his own rows: he needs no
 * "whose visit" column, while a district, regional or line manager in the same portal does.
 */
function portalColumnsFor(dataset: CrmMasterData["dataset"], selfScope: boolean): PortalColumn[] {
  if (dataset === "checkins") {
    return [
      {
        id: "when",
        inCardHeader: true,
        keys: ["check_date"],
        label: "Date & time",
        render: (row) => <Lead>{textOf(row, "check_date") ? formatVendorLocal(row.check_date) : "—"}</Lead>,
        width: "22%",
      },
      {
        id: "contact",
        inCardHeader: true,
        keys: ["contact_name"],
        label: "Contact",
        render: (row) => <Lead>{textOf(row, "contact_name") ?? "—"}</Lead>,
        width: "26%",
      },
      {
        id: "address",
        keys: ["address"],
        label: "Address",
        render: (row) => {
          const address = textOf(row, "address");
          return address ? (
            <span className="block break-words text-slate-700" dir="auto">
              {address}
            </span>
          ) : (
            DASH
          );
        },
        width: "30%",
      },
      {
        id: "where",
        keys: ["geo_brick", "geo_area", "geo_confidence"],
        label: "Brick · Area (GPS)",
        render: (row) => {
          const gps = joined([textOf(row, "geo_brick"), textOf(row, "geo_area")]);
          const confidence = textOf(row, "geo_confidence");
          return gps ? (
            <>
              <Lead>{gps}</Lead>
              {confidence ? <Sub>{confidence}</Sub> : null}
            </>
          ) : (
            DASH
          );
        },
        width: "22%",
      },
    ];
  }

  if (dataset === "vacations") {
    const period: PortalColumn = {
      id: "period",
      inCardHeader: true,
      keys: ["from_date", "to_date"],
      label: "Period",
      render: (row) => {
        const from = dateOf(row, "from_date");
        const to = dateOf(row, "to_date");
        return <Lead>{from && to && from !== to ? `${from} to ${to}` : (from ?? to ?? "—")}</Lead>;
      },
      width: selfScope ? "26%" : "22%",
    };
    const days: PortalColumn = {
      id: "days",
      keys: ["duration", "half_days"],
      label: "Days",
      render: (row) => {
        const duration = textOf(row, "duration");
        const halves = Number(row.half_days ?? 0);
        return (
          <>
            <Lead>{duration ?? "—"}</Lead>
            {halves > 0 ? <Sub>{halves === 1 ? "1 half-day" : `${halves} half-days`}</Sub> : null}
          </>
        );
      },
      width: selfScope ? "14%" : "12%",
    };
    // The card's TITLE is the leave type, so its field carries only the holiday, when there is one.
    const type: PortalColumn = {
      card: (row) => textOf(row, "national_holiday"),
      cardLabel: "National holiday",
      id: "type",
      keys: ["visit_type_description", "national_holiday"],
      label: "Type",
      render: (row) => {
        const holiday = textOf(row, "national_holiday");
        return (
          <>
            <Lead>{textOf(row, "visit_type_description") ?? "—"}</Lead>
            {holiday ? <span className="mt-0.5 block break-words font-semibold text-amber-800">{holiday}</span> : null}
          </>
        );
      },
      width: selfScope ? "26%" : "22%",
    };
    const comment: PortalColumn = {
      id: "comment",
      keys: ["comment"],
      label: "Comment",
      render: commentCell,
      width: selfScope ? "34%" : "22%",
    };
    if (selfScope) return [period, days, type, comment];
    return [
      {
        id: "rep",
        keys: ["agent_name"],
        label: "Rep",
        render: (row) => <Lead>{textOf(row, "agent_name") ?? "—"}</Lead>,
        width: "22%",
      },
      period,
      days,
      type,
      comment,
    ];
  }

  if (dataset === "triple_visits") {
    return [
      {
        id: "day",
        inCardHeader: true,
        keys: ["visit_date"],
        label: "Day",
        render: (row) => <Lead>{dateOf(row, "visit_date") ?? "—"}</Lead>,
        width: "16%",
      },
      {
        id: "contact",
        inCardHeader: true,
        keys: ["contact_name"],
        label: "Contact",
        render: (row) => <Lead>{textOf(row, "contact_name") ?? "—"}</Lead>,
        width: "26%",
      },
      {
        id: "chain",
        keys: ["base_name", "mid_name", "top_name", "line"],
        label: "Rep → manager → manager",
        render: (row) => (
          <>
            <Lead>
              {[textOf(row, "base_name"), textOf(row, "mid_name"), textOf(row, "top_name")]
                .map((name) => name ?? "—")
                .join(" → ")}
            </Lead>
            {textOf(row, "line") ? <Sub>{textOf(row, "line")}</Sub> : null}
          </>
        ),
        width: "38%",
      },
      {
        id: "confidence",
        keys: ["confidence"],
        label: "Confidence",
        render: (row) => (
          <span className="block break-words text-slate-700">{textOf(row, "confidence") ?? "—"}</span>
        ),
        width: "20%",
      },
    ];
  }

  // Every visit-shaped dataset: Visits, Double Visits and the three "no check-in / no doctor" tabs.
  return [
    {
      id: "day",
      inCardHeader: true,
      keys: ["visit_date", "ampm", "visit_time"],
      label: "Day",
      render: (row) => (
        <>
          <Lead>{visitDayText(row) ?? "—"}</Lead>
          <span className="mt-1 block">
            <VisitTimeCell source={row.visit_time_source} value={row.visit_time} wrap />
          </span>
        </>
      ),
      width: "16%",
    },
    {
      id: "contact",
      keys: ["contact_name", "speciality", "crm_contact_grade"],
      label: "Contact",
      render: (row) => {
        const sub = contactSub(row);
        return (
          <>
            <Lead>{textOf(row, "contact_name") ?? "—"}</Lead>
            {sub ? <Sub>{sub}</Sub> : null}
          </>
        );
      },
      // The card's TITLE is the contact, so its field carries only what sits under the name.
      card: contactSub,
      cardLabel: "Speciality",
      width: "22%",
    },
    {
      id: "type",
      keys: ["visit_type_description", "effective_type"],
      label: "Type",
      render: (row) => {
        const description = textOf(row, "visit_type_description");
        const effective = textOf(row, "effective_type");
        return (
          <>
            <Lead>{description ?? "—"}</Lead>
            {effective && effective !== description ? <Sub>{`Counted as ${effective}`}</Sub> : null}
          </>
        );
      },
      width: "14%",
    },
    {
      id: "with",
      keys: selfScope ? ["double_name", "triple_flag"] : ["agent_name", "double_name", "triple_flag"],
      label: selfScope ? "Double visit with" : "Rep · double with",
      render: (row) => {
        const double = textOf(row, "double_name");
        const triple = textOf(row, "triple_flag");
        const tripleLine = triple ? <Sub>{`Triple · ${triple}`}</Sub> : null;
        if (selfScope) {
          return double || triple ? (
            <>
              {double ? <Lead>{double}</Lead> : null}
              {tripleLine}
            </>
          ) : (
            DASH
          );
        }
        return (
          <>
            <Lead>{textOf(row, "agent_name") ?? "—"}</Lead>
            {double ? <Sub>{`with ${double}`}</Sub> : null}
            {tripleLine}
          </>
        );
      },
      width: "16%",
    },
    {
      id: "where",
      keys: ["geo_brick", "geo_area", "crm_region_name"],
      label: "Where",
      render: whereCell,
      width: "14%",
    },
    {
      id: "comment",
      keys: ["comment"],
      label: "Comment",
      render: commentCell,
      width: "18%",
    },
  ];
}

/** The phone card's title, meta line and status for one row — a person or a place, never an id. */
function portalCardHeader(dataset: CrmMasterData["dataset"], row: CrmMasterRow): { meta: ReactNode; status?: ReactNode; title: ReactNode } {
  if (dataset === "checkins") {
    return {
      meta: textOf(row, "check_date") ? formatVendorLocal(row.check_date) : undefined,
      title: textOf(row, "contact_name") ?? "Check-in",
    };
  }
  if (dataset === "vacations") {
    const from = dateOf(row, "from_date");
    const to = dateOf(row, "to_date");
    return {
      meta: from && to && from !== to ? `${from} to ${to}` : (from ?? to ?? undefined),
      title: textOf(row, "visit_type_description") ?? "Leave",
    };
  }
  if (dataset === "triple_visits") {
    return { meta: dateOf(row, "visit_date") ?? undefined, title: textOf(row, "contact_name") ?? "Triple visit" };
  }
  return {
    meta: visitDayText(row) ?? undefined,
    status: <VisitTimeCell source={row.visit_time_source} value={row.visit_time} wrap />,
    title: textOf(row, "contact_name") ?? textOf(row, "visit_type_description") ?? "Visit",
  };
}

const ALL_FIELDS_BUTTON =
  "inline-flex min-h-10 items-center gap-1 border px-2.5 py-1 text-phx-xs font-bold transition md:min-h-8";

function AllFieldsButton({
  count,
  detailId,
  isOpen,
  onToggle,
}: {
  count: number;
  /** The id of the row's opened panel, when it is a table-row panel. */
  detailId?: string;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      {...(detailId ? rowDetailToggleProps(detailId, isOpen) : { "aria-expanded": isOpen })}
      className={`${ALL_FIELDS_BUTTON} ${
        isOpen ? "border-orange-400 bg-orange-50 text-orange-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"
      }`}
      onClick={onToggle}
      type="button"
    >
      {isOpen ? "Hide fields" : `All fields (${count})`}
    </button>
  );
}

function PortalMasterRecords({
  data,
  expanded,
  onToggle,
  selfScope,
}: {
  data: CrmMasterData;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  selfScope: boolean;
}) {
  const columns = portalColumnsFor(data.dataset, selfScope);
  const shown = new Set(columns.flatMap((column) => column.keys));
  // Every column the merged ones do not already show — ids and coordinates included, raw JSON never.
  const rest = data.columns.filter((col) => !shown.has(col.key));
  const restFields = (row: CrmMasterRow) => rest.map((col) => ({ label: col.label, value: masterCell(col, row) }));

  return (
    <>
      {/* Phones: one card per record, titled by the person or place it is about. */}
      <div className="divide-y divide-slate-100 border border-slate-200 bg-white md:hidden">
        {data.rows.map((row: CrmMasterRow) => {
          const isHoliday = typeof row.national_holiday === "string" && row.national_holiday.length > 0;
          const header = portalCardHeader(data.dataset, row);
          const isOpen = expanded.has(row.id);
          const fields = columns
            .filter((column) => !column.inCardHeader)
            .flatMap((column) => {
              const value = column.card ? column.card(row) : column.render(row);
              return value === null || value === undefined || value === ""
                ? []
                : [{ label: column.cardLabel ?? column.label, value }];
            });
          return (
            <PortalRecordCard
              accent={isHoliday ? "amber" : "slate"}
              className={isHoliday ? "bg-amber-100/70" : undefined}
              key={row.id}
              meta={header.meta}
              status={header.status}
              title={header.title}
            >
              {fields.length > 0 ? <PortalRecordFields fields={fields} /> : null}
              {rest.length > 0 ? (
                <div className="mt-3">
                  <AllFieldsButton count={rest.length} isOpen={isOpen} onToggle={() => onToggle(row.id)} />
                </div>
              ) : null}
              {isOpen && rest.length > 0 ? (
                <div className="mt-2">
                  <PortalRecordFields fields={restFields(row)} />
                </div>
              ) : null}
            </PortalRecordCard>
          );
        })}
      </div>

      {/* From md: a fitted table. table-fixed + colgroup, every cell wraps, nothing scrolls sideways. */}
      <table
        className="hidden w-full table-fixed border-collapse border border-slate-200 bg-white text-left text-xs md:table"
        data-portal-desktop-table
      >
        <colgroup>
          {columns.map((column) => (
            <col key={column.id} style={{ width: column.width }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th className="px-3 py-2 font-semibold" key={column.id} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row: CrmMasterRow) => {
            const isHoliday = typeof row.national_holiday === "string" && row.national_holiday.length > 0;
            const isOpen = expanded.has(row.id);
            return (
              <PortalMasterRow
                columns={columns}
                isHoliday={isHoliday}
                isOpen={isOpen}
                key={row.id}
                onToggle={() => onToggle(row.id)}
                restCount={rest.length}
                restFields={isOpen ? restFields(row) : []}
                row={row}
              />
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function PortalMasterRow({
  columns,
  isHoliday,
  isOpen,
  onToggle,
  restCount,
  restFields,
  row,
}: {
  columns: readonly PortalColumn[];
  isHoliday: boolean;
  isOpen: boolean;
  onToggle: () => void;
  restCount: number;
  restFields: Array<{ label: ReactNode; value: ReactNode }>;
  row: CrmMasterRow;
}) {
  return (
    <>
      <tr className={`align-top text-slate-700 ${isHoliday ? "bg-amber-100/70" : "hover:bg-orange-50/40"}`}>
        {columns.map((column, index) => (
          <td className="break-words px-3 py-2" key={column.id}>
            {column.render(row)}
            {/* The row's expander rides in its first cell, where the eye starts the row. */}
            {index === 0 && restCount > 0 ? (
              <span className="mt-2 block">
                <AllFieldsButton
                  count={restCount}
                  detailId={`master-fields-${row.id}`}
                  isOpen={isOpen}
                  onToggle={onToggle}
                />
              </span>
            ) : null}
          </td>
        ))}
      </tr>
      {isOpen && restFields.length > 0 ? (
        <TableRowDetail colSpan={columns.length} id={`master-fields-${row.id}`}>
          <PortalRecordFields fields={restFields} />
        </TableRowDetail>
      ) : null}
    </>
  );
}

const FILTER_FIELD = "flex flex-col gap-1 text-phx-xs font-semibold uppercase tracking-wide text-slate-500";
const FILTER_INPUT = cn(phxFieldClassName, "px-2 py-1.5");

export function CrmMasterTable({
  data,
  // Defaults keep the admin page byte-for-byte unchanged; the portal page overrides both.
  exportPath = "/api/admin/crm/master-export",
  // The Mapping filter selects agent_mapped/agent_unmapped rows — a Super-Admin data-governance tool.
  // `agent_unmapped` is agent_hr_id IS NULL, which can never be in a scoped allow-set, so a scoped
  // viewer would always get zero. Hidden for the portal (the server also forces it off, so this is
  // only the UX half).
  showMappingFilter = true,
  surface = "admin",
  selfScope = false,
}: {
  data: CrmMasterData;
  exportPath?: string;
  showMappingFilter?: boolean;
  /**
   * `portal` (set ONLY by app/employee-portals/crm/page.tsx) draws the fitted table and person-titled
   * cards above, wraps the export/pager row, and speaks to a field seat rather than an administrator.
   * `admin` (the default) is the raw dataset explorer, unchanged.
   */
  surface?: "admin" | "portal";
  /**
   * A medical rep reading his own rows (portal only). The Line and Hired filters can only ever match
   * himself, so they are not offered, and the search hint names what he would actually search for.
   */
  selfScope?: boolean;
}) {
  const portal = surface === "portal";
  const hideTeamFilters = portal && selfScope;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const isCheckins = data.dataset === "checkins";
  // Which filter controls this tab may render. Single source of truth shared with the server (see
  // CRM_MASTER_SUPPORTED_FILTERS): the AM/PM, Visit Type and Mapping controls used to render on the
  // computed tabs (Vacations, Triple Visits), which filter rows in memory and never look at those
  // values — so the control accepted a choice, the chip claimed it was applied, and the result set
  // was unchanged. Gate on the map, never on a per-tab boolean re-derived here.
  const supports = (key: CrmMasterFilterKey) => crmMasterSupportsFilter(data.dataset, key);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [searchText, setSearchText] = useState(data.search ?? "");
  const [fromText, setFromText] = useState(data.dateFrom ?? "");
  const [toText, setToText] = useState(data.dateTo ?? "");
  const [visitTypeText, setVisitTypeText] = useState(data.visitType ?? "");
  const [ampmValue, setAmpmValue] = useState<CrmMasterAmpm>(data.ampm);
  const [mappingValue, setMappingValue] = useState<CrmMasterMappingStatus>(data.mappingStatus);
  const [lineValue, setLineValue] = useState(data.line ?? "");
  const [hireFromText, setHireFromText] = useState(data.hireFrom ?? "");
  const [hireToText, setHireToText] = useState(data.hireTo ?? "");
  const [minDurationText, setMinDurationText] = useState(data.minDuration != null ? String(data.minDuration) : "");
  const [halfDaysOnly, setHalfDaysOnly] = useState(data.halfDaysOnly);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Navigation responsiveness: a pending transition dims the table while filters/pagination/page
  // size round-trip to the server (tab switching itself is now CrmTabBar's own concern).
  const [isPending, startTransition] = useTransition();

  // Synced top horizontal scrollbar: a thin bar directly above the table whose scroll position
  // mirrors the table body's, so wide columns can be panned without scrolling to the bottom.
  const topRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [scrollWidth, setScrollWidth] = useState(0);
  const syncLock = useRef(false);

  useEffect(() => {
    // The portal draws a fitted table with no scroll box, so there is nothing to mirror.
    if (portal) return;
    // Width of the scrolling content = the widest of the table element and its scroll container. The
    // table reflows WIDER well after first paint (nowrap columns, RTL Arabic text, web fonts loading a
    // second or two later), and a single early read captures a too-small width → the top scrollbar goes
    // missing. The component remounts on every navigation (page key), so scrollWidth starts at 0 here;
    // we GROW it to the widest value seen and keep it (no shrink-back flicker). Re-measure aggressively
    // for a few seconds + on font load + via a ResizeObserver so a late reflow is always caught.
    const measure = () => {
      const width = Math.max(tableRef.current?.scrollWidth ?? 0, bodyRef.current?.scrollWidth ?? 0);
      setScrollWidth((prev) => (width > prev ? width : prev));
    };
    measure();
    const interval = setInterval(measure, 250);
    const stop = setTimeout(() => clearInterval(interval), 3000);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (observer && tableRef.current) observer.observe(tableRef.current);
    if (observer && bodyRef.current) observer.observe(bodyRef.current);
    if (typeof document !== "undefined" && document.fonts && document.fonts.ready) {
      void document.fonts.ready.then(measure);
    }
    window.addEventListener("resize", measure);
    return () => {
      clearInterval(interval);
      clearTimeout(stop);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [data.rows, data.columns, data.dataset, portal]);

  function mirrorScroll(from: "top" | "body") {
    if (syncLock.current) return;
    syncLock.current = true;
    const source = from === "top" ? topRef.current : bodyRef.current;
    const target = from === "top" ? bodyRef.current : topRef.current;
    if (source && target) target.scrollLeft = source.scrollLeft;
    requestAnimationFrame(() => {
      syncLock.current = false;
    });
  }

  const totalPages = Math.max(1, Math.ceil(data.totalCount / data.pageSize));
  const rangeStart = data.totalCount === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const rangeEnd = Math.min(data.page * data.pageSize, data.totalCount);

  function navigate(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  }

  function applyFilters() {
    navigate({
      // Agent HR ID is intentionally NOT its own control any more — the Search box now covers agent
      // AND double HR IDs (see the server `or` expression). A legacy `agentHrId` URL param is left
      // untouched here and shown as a removable chip.
      ampm: ampmValue === "all" ? null : ampmValue,
      dateFrom: fromText || null,
      dateTo: toText || null,
      halfDaysOnly: halfDaysOnly ? "1" : null,
      hireFrom: hireFromText || null,
      hireTo: hireToText || null,
      line: lineValue || null,
      mappingStatus: mappingValue === "all" ? null : mappingValue,
      minDuration: minDurationText.trim() || null,
      page: null,
      search: searchText || null,
      visitType: visitTypeText || null,
    });
  }

  function resetFilters() {
    setSearchText("");
    setFromText("");
    setToText("");
    setVisitTypeText("");
    setAmpmValue("all");
    setMappingValue("all");
    setLineValue("");
    setHireFromText("");
    setHireToText("");
    setMinDurationText("");
    setHalfDaysOnly(false);
    navigate({
      agentHrId: null,
      ampm: null,
      dateFrom: null,
      dateTo: null,
      halfDaysOnly: null,
      hireFrom: null,
      hireTo: null,
      line: null,
      mappingStatus: null,
      minDuration: null,
      page: null,
      search: null,
      visitType: null,
    });
  }

  // Remove one active filter (from its chip). The table remounts on navigation (page.tsx keys on the
  // URL-derived inputs), so the local input state re-seeds automatically — no need to reset it here.
  function clearFilters(keys: string[]) {
    const next: Record<string, string | null> = { page: null };
    for (const key of keys) next[key] = null;
    navigate(next);
  }

  // The active-filter chips, derived from the APPLIED values (data.*), not the local input state.
  const activeChips: Array<{ id: string; label: string; keys: string[] }> = [];
  if (data.search) activeChips.push({ id: "search", label: `Search: "${data.search}"`, keys: ["search"] });
  if (data.dateFrom || data.dateTo)
    activeChips.push({ id: "date", label: `Date: ${data.dateFrom ?? "…"} → ${data.dateTo ?? "…"}`, keys: ["dateFrom", "dateTo"] });
  if (data.agentHrId) activeChips.push({ id: "agentHrId", label: `Agent HR ID: ${data.agentHrId}`, keys: ["agentHrId"] });
  if (data.line) activeChips.push({ id: "line", label: `Line: ${data.line}`, keys: ["line"] });
  if (data.hireFrom || data.hireTo)
    activeChips.push({ id: "hire", label: `Hired: ${data.hireFrom ?? "…"} → ${data.hireTo ?? "…"}`, keys: ["hireFrom", "hireTo"] });
  if (data.ampm !== "all") activeChips.push({ id: "ampm", label: `AM/PM: ${data.ampm}`, keys: ["ampm"] });
  if (data.visitType) activeChips.push({ id: "visitType", label: `Visit Type: ${data.visitType}`, keys: ["visitType"] });
  if (data.mappingStatus !== "all")
    activeChips.push({
      id: "mappingStatus",
      label: `Mapping: ${data.mappingStatus === "agent_mapped" ? "Agent mapped" : "Agent unmapped"}`,
      keys: ["mappingStatus"],
    });
  if (data.minDuration != null)
    activeChips.push({ id: "minDuration", label: `Min duration: ${data.minDuration}d`, keys: ["minDuration"] });
  if (data.halfDaysOnly) activeChips.push({ id: "halfDaysOnly", label: "Half-days only", keys: ["halfDaysOnly"] });

  function toggleRaw(id: string) {
    setExpanded((prev) => {
      const nextSet = new Set(prev);
      if (nextSet.has(id)) nextSet.delete(id);
      else nextSet.add(id);
      return nextSet;
    });
  }

  // Export the FULL filtered result of the current tab — every matching row, no cap. A single GET
  // streams a server-built XLSX straight to a download: the workbook is generated row-by-row on the
  // server (flat memory, any sheet size), so it can't OOM/time out the way the old path did (it
  // fetched every row as JSON then POSTed it back to be styled in one in-memory pass, which hung
  // past ~20k rows and surfaced to the user as "Export failed"). The blob lives only in the user's
  // own browser, never on the 1Gi server.
  async function handleExport() {
    if (exportBusy || data.totalCount === 0) return;
    setExportBusy(true);
    setExportError(null);
    try {
      const params = new URLSearchParams(searchParams.toString());
      params.set("dataset", data.dataset);
      params.delete("page");
      params.delete("pageSize");
      const response = await fetch(`${exportPath}?${params.toString()}`);
      if (!response.ok) {
        // The stream only starts after the server has passed auth + started the query, so a non-ok
        // response is always a JSON error body here — surface its message, not a bare status.
        let message = `Export failed (${response.status})`;
        try {
          const body = (await response.json()) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          // non-JSON body — keep the status-based message
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="(.+?)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? `crm-${data.dataset}-export.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("CRM master export failed:", error);
      setExportError(error instanceof Error ? error.message : "Export failed. Try again.");
    } finally {
      setExportBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Unified filter panel — one bar, one Apply/Reset, removable active-filter chips. The former
          separate "Agent HR ID" box is folded into Search, which now matches agent AND double HR IDs
          server-side, so a single field covers every identity lookup. */}
      <div className="space-y-3 border border-slate-200 bg-white p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          <label className={FILTER_FIELD}>
            From
            <input className={FILTER_INPUT} onChange={(event) => setFromText(event.target.value)} type="date" value={fromText} />
          </label>
          <label className={FILTER_FIELD}>
            To
            <input className={FILTER_INPUT} onChange={(event) => setToText(event.target.value)} type="date" value={toText} />
          </label>
          <label className={`${FILTER_FIELD} col-span-2`}>
            Search
            <div className="flex items-center gap-2 border border-slate-200 px-2 py-1.5 focus-within:border-orange-400">
              <Search aria-hidden="true" className="h-4 w-4 text-slate-400" />
              <input
                className={cn(phxFieldClassName, "w-full")}
                onChange={(event) => setSearchText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") applyFilters();
                }}
                placeholder={
                  portal
                    ? isCheckins
                      ? selfScope
                        ? "Doctor or address"
                        : "Doctor, address or HR ID"
                      : selfScope
                        ? "Doctor, partner or comment"
                        : "Rep, partner, doctor or comment"
                    : isCheckins
                      ? "Agent HR ID, contact, address…"
                      : "Agent, double, contact, customer, comment, HR ID…"
                }
                type="search"
                value={searchText}
              />
            </div>
          </label>
          {hideTeamFilters ? null : (
          <label className={FILTER_FIELD}>
            Line
            <select
              className={phxSelectClassName}
              onChange={(event) => setLineValue(event.target.value)}
              value={lineValue}
            >
              <option value="">All lines</option>
              {data.lineOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          )}
          {hideTeamFilters ? null : (
          <>
          <label className="flex flex-col gap-1 text-phx-xs font-semibold uppercase tracking-wide text-slate-500">
            Hired from
            <input
              className={phxFieldClassName}
              onChange={(event) => setHireFromText(event.target.value)}
              type="date"
              value={hireFromText}
            />
          </label>
          <label className="flex flex-col gap-1 text-phx-xs font-semibold uppercase tracking-wide text-slate-500">
            Hired to
            <input
              className={phxFieldClassName}
              onChange={(event) => setHireToText(event.target.value)}
              type="date"
              value={hireToText}
            />
          </label>
          </>
          )}
          {supports("ampm") ? (
            <label className="flex flex-col gap-1 text-phx-xs font-semibold uppercase tracking-wide text-slate-500">
              AM/PM
              <select
                className={phxSelectClassName}
                onChange={(event) => setAmpmValue(event.target.value as CrmMasterAmpm)}
                value={ampmValue}
              >
                <option value="all">All</option>
                <option value="AM">AM</option>
                <option value="PM">PM</option>
              </select>
            </label>
          ) : null}
          {supports("visitType") ? (
            <label className="flex flex-col gap-1 text-phx-xs font-semibold uppercase tracking-wide text-slate-500">
              Visit Type
              <select
                className={phxSelectClassName}
                onChange={(event) => setVisitTypeText(event.target.value)}
                value={visitTypeText}
              >
                <option value="">All types</option>
                {data.visitTypeOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {showMappingFilter && supports("mappingStatus") ? (
            <label className="flex flex-col gap-1 text-phx-xs font-semibold uppercase tracking-wide text-slate-500">
              Mapping
              <select
                className={phxSelectClassName}
                onChange={(event) => setMappingValue(event.target.value as CrmMasterMappingStatus)}
                value={mappingValue}
              >
                <option value="all">All</option>
                <option value="agent_mapped">Agent mapped</option>
                <option value="agent_unmapped">Agent unmapped</option>
              </select>
            </label>
          ) : null}
          {supports("minDuration") || supports("halfDaysOnly") ? (
            <>
              <label className="flex flex-col gap-1 text-phx-xs font-semibold uppercase tracking-wide text-slate-500">
                Min Duration (days)
                <input
                  className={cn(phxFieldClassName, "w-28")}
                  min="0"
                  onChange={(event) => setMinDurationText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") applyFilters();
                  }}
                  placeholder="e.g. 2"
                  step="0.5"
                  type="number"
                  value={minDurationText}
                />
              </label>
              <label className="flex items-center gap-2 pb-1.5 text-phx-xs font-semibold uppercase tracking-wide text-slate-500">
                <input
                  checked={halfDaysOnly}
                  className="h-4 w-4 accent-orange-600"
                  onChange={(event) => setHalfDaysOnly(event.target.checked)}
                  type="checkbox"
                />
                Half-days only
              </label>
            </>
          ) : null}
        </div>

        {/* Active-filter chips + one Apply / Reset for the whole panel. Chips are derived from the
            APPLIED filters (data.*) and each removes just its own filter. */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            {activeChips.length === 0 ? (
              <span className="text-xs text-slate-400">No filters applied</span>
            ) : (
              activeChips.map((chip) => (
                <button
                  className="inline-flex items-center gap-1 rounded-full border border-phx-warn-line bg-phx-warn-bg px-2.5 py-1 text-phx-xs font-semibold text-phx-warn transition hover:border-phx-warn-line hover:bg-phx-warn-bg"
                  key={chip.id}
                  onClick={() => clearFilters(chip.keys)}
                  title="Remove this filter"
                  type="button"
                >
                  {chip.label}
                  <X aria-hidden="true" className="h-3 w-3" />
                </button>
              ))
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50"
              onClick={resetFilters}
              type="button"
            >
              Reset
            </button>
            <button className="bg-orange-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-orange-700" onClick={applyFilters} type="button">
              Apply
            </button>
          </div>
        </div>
      </div>

      {/* Count + page size + pagination */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
        <p className={portal ? "flex min-w-0 flex-wrap items-center gap-2" : "flex items-center gap-2"}>
          <span>
            <span className="font-bold text-slate-900">{data.totalCount.toLocaleString("en-US")}</span> records
            {data.totalCount > 0 ? (
              <span className="text-slate-400"> · showing {rangeStart.toLocaleString("en-US")}–{rangeEnd.toLocaleString("en-US")}</span>
            ) : null}
          </span>
          {data.truncated ? (
            <span
              className="inline-flex items-center gap-1 font-semibold text-amber-600"
              title="This tab is computed in memory and hit its 60,000 source-row cap; some rows may be missing. Narrow the date range for a complete view."
            >
              ⚠ capped at 60,000 source rows — some may be missing
            </span>
          ) : null}
          {isPending ? (
            <span className="inline-flex items-center gap-1 font-semibold text-orange-600">
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> Updating…
            </span>
          ) : null}
          {exportError ? (
            <span className="inline-flex items-center gap-1 font-semibold text-rose-600" title={exportError}>
              <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5" /> Export failed — {exportError}
            </span>
          ) : null}
        </p>
        {/* The portal row WRAPS: Export, Rows and Prev · Page · Next need about 380px, and a 360–390px
            phone gives them 336–366px, so without a wrap the shell's overflow clip cut Next off. */}
        <div className={portal ? "flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end" : "flex items-center gap-3"}>
          <button
            className="inline-flex h-8 items-center gap-2 border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 transition enabled:hover:border-orange-300 enabled:hover:text-orange-700 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={exportBusy || data.totalCount === 0}
            onClick={handleExport}
            title={data.totalCount === 0 ? "Nothing to export" : "Export the full filtered result as XLSX"}
            type="button"
          >
            {exportBusy ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> : <Download aria-hidden="true" className="h-3.5 w-3.5" />}
            Export XLSX
          </button>
          <label className="flex items-center gap-1.5 text-slate-500">
            Rows
            <select
              className={phxSelectClassName}
              onChange={(event) => navigate({ page: null, pageSize: event.target.value })}
              value={data.pageSize}
            >
              {data.pageSizeOptions.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-2">
            <button
              className="inline-flex items-center gap-1 border border-slate-200 px-2 py-1 font-semibold text-slate-600 transition enabled:hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={data.page <= 1}
              onClick={() => navigate({ page: String(data.page - 1) })}
              type="button"
            >
              <ChevronLeft aria-hidden="true" className="h-4 w-4" />
              Prev
            </button>
            <span className="tabular-nums text-slate-500">
              Page {data.page.toLocaleString("en-US")} / {totalPages.toLocaleString("en-US")}
            </span>
            <button
              className="inline-flex items-center gap-1 border border-slate-200 px-2 py-1 font-semibold text-slate-600 transition enabled:hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={data.page >= totalPages}
              onClick={() => navigate({ page: String(data.page + 1) })}
              type="button"
            >
              Next
              <ChevronRight aria-hidden="true" className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Master table with a synced top scrollbar + sticky header. Dims during a pending navigation. */}
      <div className={isPending ? "pointer-events-none opacity-50 transition-opacity" : "transition-opacity"}>
      {!data.schemaReady ? (
        <div className="border border-slate-200 bg-white px-5 py-8 text-center text-sm text-slate-500">
          The iReports360 mirror is not set up yet — no CRM data to show.
        </div>
      ) : data.rows.length === 0 ? (
        <div className="border border-slate-200 bg-white px-5 py-8 text-center text-sm text-slate-500">
          No records match the current filters.
        </div>
      ) : portal ? (
        <PortalMasterRecords data={data} expanded={expanded} onToggle={toggleRaw} selfScope={selfScope} />
      ) : (
        <>
          {/* Mobile: one card per record — AGENTS.md §4. The desktop grid below is a genuine raw
              dataset explorer (runtime columns, synced dual scrollbars, sticky header), so the two
              halves are built differently but render every cell through the same masterCell(). */}
          <div className="divide-y divide-slate-100 border border-slate-200 bg-white md:hidden">
            {data.rows.map((row: CrmMasterRow) => (
              <RowCard
                columns={data.columns}
                isOpen={expanded.has(row.id)}
                key={row.id}
                onToggle={() => toggleRaw(row.id)}
                row={row}
              />
            ))}
          </div>
          <div className="hidden md:block">
            {/* Top horizontal scrollbar — directly above the header */}
            <div
              className="overflow-x-auto border border-b-0 border-slate-200 bg-white"
              onScroll={() => mirrorScroll("top")}
              ref={topRef}
            >
              <div style={{ height: 1, width: scrollWidth }} />
            </div>
            <div
              className="max-h-[65vh] overflow-auto border border-slate-200 bg-white"
              onScroll={() => mirrorScroll("body")}
              ref={bodyRef}
            >
              {/* `hidden md:block` on the wrapper is the gate that works in BOTH shells; the
                  data attribute adds the portal shell's own max-width:767px display:none on top
                  (enterprise-shell.tsx) and marks the tag itself as desktop-only.

                  `data-wide-report` is the OPT-OUT from the global portal-table wrap rule in
                  app/globals.css. Every other table wearing `data-portal-desktop-table` is
                  `table-fixed` and wraps to fit; this one is the raw 44-column mirror whose
                  sideways scroll the owner accepted on 2026-09-26 (that is what the synced top
                  scrollbar above is for). Without the opt-out the rule beat every
                  `whitespace-nowrap` below and the report rendered with 227px-tall headers of
                  vertical text over 525px-tall rows. */}
              <table
                className="w-full border-collapse text-left text-xs"
                data-portal-desktop-table
                data-wide-report
                ref={tableRef}
              >
                <thead className="sticky top-0 z-10">
                  <tr className="border-b border-slate-200 bg-slate-100 text-slate-500">
                    {data.columns.map((col) => (
                      <th className="whitespace-nowrap px-3 py-2 font-semibold" key={col.key} title={col.note ?? undefined}>
                        <span className={`inline-flex items-center gap-1 ${col.note ? "cursor-help" : ""}`}>
                          {col.label}
                          {col.note ? <Info aria-hidden="true" className="h-3 w-3 text-orange-400" /> : null}
                        </span>
                      </th>
                    ))}
                    <th className="whitespace-nowrap px-3 py-2 text-right font-semibold">Raw</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row: CrmMasterRow) => (
                    <RowGroup
                      columns={data.columns}
                      isOpen={expanded.has(row.id)}
                      key={row.id}
                      onToggle={() => toggleRaw(row.id)}
                      row={row}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
      </div>
    </div>
  );
}

function RowGroup({
  columns,
  isOpen,
  onToggle,
  row,
}: {
  columns: readonly CrmMasterColumn[];
  isOpen: boolean;
  onToggle: () => void;
  row: CrmMasterRow;
}) {
  // Vacations tab: tint rows that are a national/official holiday (the service sets `national_holiday`).
  const isNationalHoliday = typeof row.national_holiday === "string" && row.national_holiday.length > 0;
  return (
    <>
      <tr
        className={`border-b text-slate-700 ${
          isNationalHoliday ? "border-amber-200 bg-amber-100/70 hover:bg-amber-100" : "border-slate-100 hover:bg-orange-50/40"
        }`}
      >
        {columns.map((col) => (
          <td className="whitespace-nowrap px-3 py-2" key={col.key}>
            {masterCell(col, row)}
          </td>
        ))}
        <td className="whitespace-nowrap px-3 py-2 text-right">
          <div className="inline-flex items-center gap-1">
            <button
              {...rowDetailToggleProps(`master-json-${row.id}`, isOpen)}
              className={`inline-flex items-center gap-1 border px-2 py-1 text-phx-xs font-bold transition ${
                isOpen ? "border-orange-400 bg-orange-50 text-orange-700" : "border-slate-200 text-slate-500 hover:bg-slate-50"
              }`}
              onClick={onToggle}
              type="button"
            >
              <Braces aria-hidden="true" className="h-3.5 w-3.5" />
              {isOpen ? "Hide" : "JSON"}
            </button>
          </div>
        </td>
      </tr>
      {isOpen ? (
        <TableRowDetail className="p-0" colSpan={columns.length + 1} id={`master-json-${row.id}`}>
          <pre className="max-h-96 overflow-auto bg-slate-950 px-4 py-3 text-phx-xs leading-5 text-emerald-200">
            {JSON.stringify(row.raw_payload ?? {}, null, 2)}
          </pre>
        </TableRowDetail>
      ) : null}
    </>
  );
}

/** The mobile twin of RowGroup: the same record, the same cells, and the same JSON expander —
 * laid out as a card because a runtime-width table on a 375px screen is unreadable. The first
 * column becomes the card title (it is the identifying one on every dataset) and the rest become
 * label/value fields, so a dataset that gains a column gains a field here with no extra work. */
function RowCard({
  columns,
  isOpen,
  onToggle,
  row,
}: {
  columns: readonly CrmMasterColumn[];
  isOpen: boolean;
  onToggle: () => void;
  row: CrmMasterRow;
}) {
  // Same national-holiday tint the desktop row applies (the service sets `national_holiday`).
  const isNationalHoliday = typeof row.national_holiday === "string" && row.national_holiday.length > 0;
  const [first, ...rest] = columns;

  return (
    <PortalRecordCard
      accent={isNationalHoliday ? "amber" : "slate"}
      className={isNationalHoliday ? "bg-amber-100/70" : undefined}
      meta={first ? first.label : undefined}
      title={first ? masterCell(first, row) : `#${row.id}`}
    >
      {rest.length > 0 ? (
        <PortalRecordFields fields={rest.map((col) => ({ label: col.label, value: masterCell(col, row) }))} />
      ) : null}
      <div className="mt-3">
        <button
          aria-expanded={isOpen}
          className={`inline-flex items-center gap-1 border px-2 py-1 text-phx-xs font-bold transition ${
            isOpen ? "border-orange-400 bg-orange-50 text-orange-700" : "border-slate-200 text-slate-500 hover:bg-slate-50"
          }`}
          onClick={onToggle}
          type="button"
        >
          <Braces aria-hidden="true" className="h-3.5 w-3.5" />
          {isOpen ? "Hide" : "JSON"}
        </button>
      </div>
      {isOpen ? (
        <pre className="mt-2 max-h-96 overflow-auto bg-slate-950 px-3 py-2 text-phx-xs leading-5 text-emerald-200">
          {JSON.stringify(row.raw_payload ?? {}, null, 2)}
        </pre>
      ) : null}
    </PortalRecordCard>
  );
}
