"use client";

/**
 * Phoenix CRM — the Visit report's visits, one row each, with every chosen field one tap away.
 *
 * Seven merged columns on a desktop and a card on a phone, drawn once per layout; nothing scrolls
 * sideways. A row opens to show every field that was chosen, grouped under its category — the same values
 * the workbook holds. A blank is a dash and never a zero.
 */

import { Fragment, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { cairoClock, countText, dayLabel } from "@/components/phoenix-crm/format";
import { formatVisitReportValue } from "@/components/phoenix-crm/visit-report/visit-report-format";
import {
  CrmBlock,
  CrmButton,
  CrmCard,
  CrmCardsOnPhone,
  CrmEmpty,
  CrmPanel,
  CrmPill,
  CrmShowMore,
  CrmTable,
  crmTdClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import { TableRowDetail, rowDetailToggleProps } from "@/components/ui/table-row-detail";
import { formatDistance } from "@/lib/phoenix-crm/geo";
import {
  VISIT_REPORT_CATEGORIES,
  type VisitReportField,
  type VisitReportRow,
} from "@/lib/phoenix-crm/visit-report-fields";

const PAGE = 50;

/** What the row's own cells already print, so its opened panel never says it a second time. */
const SHOWN_BY_THE_ROW: ReadonlySet<string> = new Set([
  "visitDate",
  "savedAt",
  "repName",
  "customerName",
  "listType",
  "visitType",
  "plannedOrNot",
  "placeLabel",
  "distanceFromPlace",
  "locationFlag",
]);

function Detail({ fields, row }: { fields: ReadonlyArray<VisitReportField>; row: VisitReportRow }) {
  return (
    <div className="grid gap-4">
      {VISIT_REPORT_CATEGORIES.map((category) => {
        const inCategory = fields.filter((field) => field.category === category.id && !SHOWN_BY_THE_ROW.has(field.key));
        if (inCategory.length === 0) return null;
        return (
          <section className="min-w-0" key={category.id}>
            <h4 className="mb-2 text-phx-sm font-black uppercase tracking-[0.14em] text-orange-600">{category.label}</h4>
            <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {inCategory.map((field) => {
                const text = formatVisitReportValue(field, row.values[field.key]);
                return (
                  <div className="min-w-0 border border-slate-100 bg-slate-50 px-2.5 py-2" key={field.key}>
                    <dt className="break-words text-phx-sm font-black uppercase tracking-[0.12em] text-slate-400">{field.label}</dt>
                    <dd className="mt-0.5 min-w-0 whitespace-pre-line break-words text-xs font-bold text-slate-800">{text}</dd>
                  </div>
                );
              })}
            </dl>
          </section>
        );
      })}
    </div>
  );
}

function positionText(row: VisitReportRow): string {
  return row.distanceMeters === null ? "—" : formatDistance(row.distanceMeters);
}

function FlagPill({ row }: { row: VisitReportRow }) {
  if (!row.locationFlag) return null;
  const tone = row.locationFlag === "Far from the place" ? "warn" : row.locationFlag === "At the place" ? "good" : "neutral";
  return <CrmPill tone={tone}>{row.locationFlag}</CrmPill>;
}

export function VisitReportTable({
  fields,
  highlightId,
  rows,
}: {
  fields: ReadonlyArray<VisitReportField>;
  highlightId: string | null;
  rows: ReadonlyArray<VisitReportRow>;
}) {
  const [shown, setShown] = useState(PAGE);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [seenHighlight, setSeenHighlight] = useState<string | null>(null);
  // A pin picked on the map opens its own visit here. Adjusted while rendering rather than in an effect,
  // so the row is already on screen when the scroll below looks for it.
  if (highlightId !== seenHighlight) {
    setSeenHighlight(highlightId);
    if (highlightId) {
      const index = rows.findIndex((row) => row.visitId === highlightId);
      if (index >= 0) {
        setShown((current) => Math.max(current, index + 1));
        setOpen((current) => new Set(current).add(highlightId));
      }
    }
  }
  useEffect(() => {
    if (!highlightId) return;
    document.getElementById(`visit-row-${highlightId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightId]);
  const visible = useMemo(() => rows.slice(0, shown), [rows, shown]);
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (rows.length === 0) {
    return (
      <CrmPanel eyebrow="Visits" title="No visits in this period">
        <CrmEmpty message="No visit was saved for this choice between these days. Widen the period or choose another rep." title="Nothing to show" />
      </CrmPanel>
    );
  }

  return (
    <CrmPanel
      description="Open a visit to read every field you chose. The Excel file holds the same visits and fields."
      eyebrow="Visits"
      title={`${countText(rows.length)} visit${rows.length === 1 ? "" : "s"}`}
    >
      <CrmBlock className="px-0 sm:px-0">
        <CrmCardsOnPhone>
          {visible.map((row) => {
            const isOpen = open.has(row.visitId);
            return (
              <CrmCard
                accent={row.visitId === highlightId ? "border-l-orange-500" : "border-l-slate-300"}
                actions={
                  <CrmButton onClick={() => toggle(row.visitId)} size="sm">
                    {isOpen ? "Hide details" : "Show details"}
                  </CrmButton>
                }
                key={row.visitId}
                meta={`${dayLabel(row.visitDate)}, ${cairoClock(row.savedAtIso)} · ${row.repName}`}
                status={
                  <>
                    <CrmPill tone={row.planned ? "good" : "warn"}>{row.planned ? "Planned" : "Unplanned"}</CrmPill>
                    <FlagPill row={row} />
                  </>
                }
                title={row.customerName}
              >
                <p className="break-words text-xs font-semibold text-slate-600">
                  {[row.visitType, row.placeLabel, row.distanceMeters === null ? null : positionText(row)].filter(Boolean).join(" · ")}
                </p>
                {isOpen ? (
                  <div className="mt-3">
                    <Detail fields={fields} row={row} />
                  </div>
                ) : null}
              </CrmCard>
            );
          })}
        </CrmCardsOnPhone>

        <CrmTable columns={["12%", "14%", "20%", "14%", "16%", "16%", "8%"]}>
          <thead>
            <tr>
              <th className={crmThClassName}>When</th>
              <th className={crmThClassName}>Who</th>
              <th className={crmThClassName}>Customer</th>
              <th className={crmThClassName}>Visit</th>
              <th className={crmThClassName}>Place</th>
              <th className={crmThClassName}>Position</th>
              <th className={crmThClassName}>Details</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const isOpen = open.has(row.visitId);
              return (
                <Fragment key={row.visitId}>
                  <tr
                    className={row.visitId === highlightId ? "bg-orange-50/60" : "odd:bg-white even:bg-slate-50/50"}
                    id={`visit-row-${row.visitId}`}
                  >
                    <td className={crmTdClassName}>
                      {dayLabel(row.visitDate)}
                      <span className="block text-xs font-medium text-slate-500">{cairoClock(row.savedAtIso)}</span>
                    </td>
                    <td className={crmTdClassName}>{row.repName}</td>
                    <td className={crmTdClassName}>
                      {row.customerName}
                      {row.listType ? <span className="block text-xs font-medium text-slate-500">{row.listType}</span> : null}
                    </td>
                    <td className={crmTdClassName}>
                      {row.visitType || "—"}
                      <span className="mt-1 block">
                        <CrmPill tone={row.planned ? "good" : "warn"}>{row.planned ? "Planned" : "Unplanned"}</CrmPill>
                      </span>
                    </td>
                    <td className={crmTdClassName}>{row.placeLabel ?? "—"}</td>
                    <td className={crmTdClassName}>
                      {positionText(row)}
                      <span className="mt-1 block">
                        <FlagPill row={row} />
                      </span>
                    </td>
                    <td className={crmTdClassName}>
                      <CrmButton {...rowDetailToggleProps(`visit-detail-${row.visitId}`, isOpen)} onClick={() => toggle(row.visitId)} size="sm">
                        {isOpen ? <ChevronUp aria-hidden className="h-4 w-4" /> : <ChevronDown aria-hidden className="h-4 w-4" />}
                        <span className="sr-only">{isOpen ? "Hide details" : "Show details"}</span>
                      </CrmButton>
                    </td>
                  </tr>
                  {isOpen ? (
                    <TableRowDetail colSpan={7} id={`visit-detail-${row.visitId}`}>
                      <Detail fields={fields} row={row} />
                    </TableRowDetail>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </CrmTable>

        {rows.length > shown ? (
          <div className="px-4 pt-3 sm:px-5">
            <CrmShowMore left={rows.length - shown} onMore={() => setShown((current) => current + PAGE)} page={PAGE} />
          </div>
        ) : null}
      </CrmBlock>
    </CrmPanel>
  );
}
