"use client";

import { Fragment } from "react";

import { buildClosingFamilySummary, type ClosingFamilyCell } from "@/lib/sales/closing-family-summary";
import type { MonthlyClosingMatrix } from "@/lib/sales/monthly-distributor-import";

// ─────────────────────────────────────────────────────────────────────────────
// THE CLOSING SUMMARY THAT FITS — one number per area per family.
//
// Ships BESIDE the full matrix, never instead of it. The matrix is areas × PRODUCTS × six metrics
// and cannot fit a screen (CNS measures ~9,600px against a 1,144px container — 29px per product if
// forced), so it keeps its scroll and its role as the auditor's detail view. This view answers the
// question a screen CAN answer: how did each area do, by family, against target.
//
// IT FITS BY CONSTRUCTION, not by tuning. The table is `w-full table-fixed` with a `<colgroup>` of
// PERCENTAGES, so its width is the container's width whatever the family count — there is no
// min-width floor to overflow and no `overflow-x-auto` to hide one. Long names WRAP, which the
// golden rule permits; nothing is truncated, which it forbids.
//
// Mobile gets cards, never this table — the admin shell rule: desktop shows full tables, mobile
// never does.
// ─────────────────────────────────────────────────────────────────────────────

const EGP = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const PCT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

function money(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return EGP.format(value);
}

/** Achievement reads as a dash when there is no target — never 0%, which would look like failure. */
function achievement(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${PCT.format(value)}%`;
}

const headCell =
  "px-2 py-2 text-left align-bottom text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500";
const bodyCell = "px-2 py-2 align-top text-sm text-slate-700 break-words";
const numCell = `${bodyCell} tabular-nums`;

function FamilyFigures({ cell }: { cell: ClosingFamilyCell }) {
  return (
    <>
      <span className="block font-semibold text-[#0B0B0B]">{money(cell.value)}</span>
      <span className="block text-phx-2xs text-slate-500">{achievement(cell.achievement)}</span>
    </>
  );
}

export function ClosingSummaryFits({ matrix }: { matrix: MonthlyClosingMatrix }) {
  const summary = buildClosingFamilySummary(matrix);
  if (summary.families.length === 0) return null;

  // One column for the area name, one for the total, the rest split evenly between families.
  // Percentages, so the table can never be wider than what holds it.
  const areaPct = 22;
  const totalPct = 14;
  const familyPct = (100 - areaPct - totalPct) / summary.families.length;

  return (
    <section className="border-t border-phx-line">
      <div className="px-4 pt-4 md:px-5">
        <h3 className="text-sm font-bold text-[#0B0B0B]">Summary — by family</h3>
        <p className="pb-3 pt-1 text-xs text-slate-500">
          The same closing at family grain, so a whole line fits one screen. Value on top,
          achievement beneath. The full product detail is the matrix below, which is unchanged.
        </p>
      </div>

      {/* Desktop: the fitting table. No min-width, no horizontal scroll container. */}
      <div className="hidden md:block px-4 pb-4 md:px-5">
        <table className="w-full table-fixed border-separate border-spacing-0">
          <colgroup>
            <col style={{ width: `${areaPct}%` }} />
            {summary.families.map((family) => (
              <col key={family} style={{ width: `${familyPct}%` }} />
            ))}
            <col style={{ width: `${totalPct}%` }} />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/70">
              <th className={headCell}>Area</th>
              {summary.families.map((family) => (
                <th className={headCell} key={family}>{family}</th>
              ))}
              <th className={headCell}>Total</th>
            </tr>
          </thead>
          <tbody>
            {summary.regions.map((region) => (
              <Fragment key={region.regionCode}>
                <tr className="bg-slate-100/70">
                  <td className={`${bodyCell} font-bold text-[#0B0B0B]`} colSpan={summary.families.length + 2}>
                    {region.regionName}
                  </td>
                </tr>
                {region.areas.map((area) => (
                  <tr key={`${region.regionCode}-${area.areaCode}`}>
                    <td className={bodyCell}>
                      <span className="block font-semibold text-[#0B0B0B]">{area.areaName}</span>
                      <span className="block text-phx-2xs text-slate-500">{area.areaCode}</span>
                    </td>
                    {area.byFamily.map((cell) => (
                      <td className={numCell} key={cell.family}><FamilyFigures cell={cell} /></td>
                    ))}
                    <td className={`${numCell} font-bold`}>
                      <span className="block text-[#0B0B0B]">{money(area.total.salesValue)}</span>
                      <span className="block text-phx-2xs font-normal text-slate-500">
                        {achievement(area.total.achievement)}
                      </span>
                    </td>
                  </tr>
                ))}
                <tr className="bg-slate-50">
                  <td className={`${bodyCell} font-bold text-[#0B0B0B]`}>{region.regionName} total</td>
                  {region.subtotal.byFamily.map((cell) => (
                    <td className={`${numCell} font-semibold`} key={cell.family}><FamilyFigures cell={cell} /></td>
                  ))}
                  <td className={`${numCell} font-bold`}>
                    <span className="block text-[#0B0B0B]">{money(region.subtotal.total.salesValue)}</span>
                    <span className="block text-phx-2xs font-normal text-slate-500">
                      {achievement(region.subtotal.total.achievement)}
                    </span>
                  </td>
                </tr>
              </Fragment>
            ))}
            <tr className="bg-[#0B0B0B]">
              <td className={`${bodyCell} font-bold text-white`}>Grand total</td>
              {summary.grandTotal.byFamily.map((cell) => (
                <td className={`${numCell} font-bold text-white`} key={cell.family}>
                  <span className="block">{money(cell.value)}</span>
                  <span className="block text-phx-2xs font-normal text-slate-300">{achievement(cell.achievement)}</span>
                </td>
              ))}
              <td className={`${numCell} font-bold text-white`}>
                <span className="block">{money(summary.grandTotal.total.salesValue)}</span>
                <span className="block text-phx-2xs font-normal text-slate-300">
                  {achievement(summary.grandTotal.total.achievement)}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Mobile: cards. The admin shell never shows a full table on a phone. */}
      <div className="space-y-3 px-4 pb-4 md:hidden">
        {summary.regions.map((region) => (
          <div key={region.regionCode}>
            <p className="pb-1.5 text-xs font-bold uppercase tracking-[0.12em] text-slate-500">
              {region.regionName}
            </p>
            <div className="space-y-2">
              {region.areas.map((area) => (
                <div className="border border-phx-line bg-white p-3" key={`${region.regionCode}-${area.areaCode}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-bold text-[#0B0B0B] break-words">{area.areaName}</span>
                    <span className="text-sm font-bold tabular-nums text-[#0B0B0B]">
                      {money(area.total.salesValue)}
                    </span>
                  </div>
                  <dl className="mt-2 space-y-1">
                    {area.byFamily.map((cell) => (
                      <div className="flex flex-wrap items-baseline justify-between gap-2" key={cell.family}>
                        <dt className="text-xs text-slate-500 break-words">{cell.family}</dt>
                        <dd className="text-xs tabular-nums text-slate-700">
                          {money(cell.value)} · {achievement(cell.achievement)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="border border-phx-line bg-[#0B0B0B] p-3 text-white">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-bold">Grand total</span>
            <span className="text-sm font-bold tabular-nums">{money(summary.grandTotal.total.salesValue)}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
