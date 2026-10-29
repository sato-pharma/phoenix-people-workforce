"use client";

import { ChevronRight } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import {
  buildClosingFamilySummary,
  pivotClosingSummaryByFamily,
} from "@/lib/sales/closing-family-summary";
import { formatPercent } from "@/lib/sales/format";
import type { MonthlyClosingMatrix } from "@/lib/sales/monthly-distributor-import";

// ─────────────────────────────────────────────────────────────────────────────
// THE CLOSING SUMMARY THAT FITS — families down, opened one at a time.
//
// Ships BESIDE the full matrix, never instead of it. The matrix is areas × PRODUCTS × six metrics
// and cannot fit a screen (CNS measures ~9,600px against a 1,144px container — 29px per product if
// forced), so it keeps its scroll and its role as the auditor's detail view. This view answers the
// question a screen CAN answer: how did each family do, and where.
//
// IT STARTS COLLAPSED — owner's instruction, 2026-09-09. The earlier shape put every area of every
// region on screen at once, which is a page of rows before the reader has said what he is looking
// for. The screen now opens on one row per family plus the grand total; opening a family reveals its
// regions, and opening a region reveals that region's areas. Three levels, each one a click.
//
// IT FITS BY CONSTRUCTION, not by tuning. The table is `w-full table-fixed` with a `<colgroup>` of
// PERCENTAGES, so its width is the container's width at every depth — there is no min-width floor to
// overflow and no horizontal scroller to hide one. Depth is carried by indent inside the first
// column, never by extra columns, so opening everything cannot widen the table by a pixel. It also
// means the column count is three whatever the line's family count is, where the earlier shape gave
// CNS a column per family. Long names WRAP, which the golden rule permits; nothing is cut short,
// which it forbids.
//
// EVERY NUMBER IS THE MATRIX'S OWN. The tree is a pivot of the folded summary — a family's total is
// the matrix's grand-total row, a region's is that region's subtotal row, an area's is its own row.
// Nothing is re-added here, so this view cannot drift from the matrix beside it.
//
// Mobile gets cards, never this table — the admin shell rule: desktop shows full tables, mobile
// never does. The cards carry the same three levels and the same collapsed default.
// ─────────────────────────────────────────────────────────────────────────────

const EGP = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function money(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return EGP.format(value);
}

/**
 * Achievement reads as a dash when there is no target — never 0%, which would look like failure.
 *
 * THE SCALING IS NOT THIS FILE'S TO DO. `formatPercent` is the repo's one percent formatter and it
 * NAMES its unit, which is the whole reason it exists: `{ input: "ratio" }` multiplies by 100,
 * `{ input: "percent" }` does not. This component used to keep a private `Intl.NumberFormat` and
 * append a bare "%" to whatever it was handed — no unit anywhere — and that is what let the
 * matrix's RATIO print as "0.1%" on the Grand total row while the PERCENT family rows above it
 * read correctly (#4989). Everything this view renders is already a percent, so it says so, once,
 * here. The matrix table beside it calls the same formatter with `{ input: "ratio" }`, so the two
 * now round and print identically as well as agreeing on the number.
 */
function achievement(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return formatPercent(value, { digits: 1, input: "percent" });
}

/** One key space for both levels, so a family and a region inside it can never collide. */
function regionKey(family: string, regionCode: string): string {
  return `${family} ▸ ${regionCode}`;
}

function toggled(open: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(open);
  if (!next.delete(key)) next.add(key);
  return next;
}

const headBase =
  "px-2 py-2 align-bottom text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500";
const headCell = `${headBase} text-left`;
const headNum = `${headBase} text-right`;
const bodyCell = "px-2 py-2 align-top text-sm text-slate-700 break-words";
const numCell = `${bodyCell} text-right tabular-nums`;

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      aria-hidden="true"
      className={`mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? "rotate-90" : ""}`}
    />
  );
}

/** A disclosure row's label: the chevron, then the name, indented to its depth. */
function Disclosure({
  indent,
  label,
  onToggle,
  open,
}: {
  indent: string;
  label: string;
  onToggle: () => void;
  open: boolean;
}) {
  return (
    <button
      aria-expanded={open}
      className={`flex w-full items-start gap-1.5 text-left ${indent}`}
      onClick={onToggle}
      type="button"
    >
      <Chevron open={open} />
      <span className="break-words">{label}</span>
    </button>
  );
}

export function ClosingSummaryFits({ matrix }: { matrix: MonthlyClosingMatrix }) {
  const summary = useMemo(() => buildClosingFamilySummary(matrix), [matrix]);
  const tree = useMemo(() => pivotClosingSummaryByFamily(summary), [summary]);
  const [openFamilies, setOpenFamilies] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [openRegions, setOpenRegions] = useState<ReadonlySet<string>>(() => new Set<string>());

  const anyOpen = openFamilies.size > 0 || openRegions.size > 0;

  function toggleFamily(family: string) {
    setOpenFamilies((open) => toggled(open, family));
  }

  function toggleRegion(family: string, regionCode: string) {
    setOpenRegions((open) => toggled(open, regionKey(family, regionCode)));
  }

  /** The escape hatch to the everything-at-once view, and the way back out of it. */
  function toggleAll() {
    if (anyOpen) {
      setOpenFamilies(new Set<string>());
      setOpenRegions(new Set<string>());
      return;
    }
    setOpenFamilies(new Set(tree.map((node) => node.family)));
    setOpenRegions(
      new Set(
        tree.flatMap((node) =>
          node.regions.map((region) => regionKey(node.family, region.regionCode)),
        ),
      ),
    );
  }

  if (summary.families.length === 0) return null;

  // Name, value, achievement. Percentages, so the table can never be wider than what holds it —
  // and the count is fixed at three whatever the line's family count turns out to be.
  const namePct = 56;
  const valuePct = 24;
  const achievementPct = 20;

  return (
    <section className="border-t border-phx-line">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 md:px-5">
        <div>
          <h3 className="text-sm font-bold text-[#0B0B0B]">Summary — by family</h3>
          <p className="pb-3 pt-1 text-xs text-slate-500">
            The same closing at family grain. Open a family to see its regions, and a region to see
            its areas. The full product detail is the matrix below, which is unchanged.
          </p>
        </div>
        <button
          className="shrink-0 border border-phx-line bg-white px-3 py-1.5 text-xs font-bold text-[#0B0B0B] transition hover:border-phx-accent hover:text-phx-accent"
          onClick={toggleAll}
          type="button"
        >
          {anyOpen ? "Collapse all" : "Expand all"}
        </button>
      </div>

      {/* Desktop: the fitting table. Three columns at every depth, no horizontal scroller. */}
      <div className="hidden md:block px-4 pb-4 md:px-5">
        <table className="w-full table-fixed border-collapse">
          <colgroup>
            <col style={{ width: `${namePct}%` }} />
            <col style={{ width: `${valuePct}%` }} />
            <col style={{ width: `${achievementPct}%` }} />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50/70">
              <th className={headCell}>Family</th>
              <th className={headNum}>Value</th>
              <th className={headNum}>Achievement</th>
            </tr>
          </thead>
          <tbody>
            {tree.map((node) => {
              const familyOpen = openFamilies.has(node.family);
              return (
                <Fragment key={node.family}>
                  <tr className="bg-slate-100/70">
                    <td className={`${bodyCell} font-bold text-[#0B0B0B]`}>
                      <Disclosure
                        indent=""
                        label={node.family}
                        onToggle={() => toggleFamily(node.family)}
                        open={familyOpen}
                      />
                    </td>
                    <td className={`${numCell} font-bold text-[#0B0B0B]`}>{money(node.total.value)}</td>
                    <td className={`${numCell} font-semibold`}>{achievement(node.total.achievement)}</td>
                  </tr>
                  {familyOpen
                    ? node.regions.map((region) => {
                        const key = regionKey(node.family, region.regionCode);
                        const regionOpen = openRegions.has(key);
                        return (
                          <Fragment key={key}>
                            <tr className="bg-slate-50">
                              <td className={`${bodyCell} font-semibold text-[#0B0B0B]`}>
                                <Disclosure
                                  indent="pl-5"
                                  label={region.regionName}
                                  onToggle={() => toggleRegion(node.family, region.regionCode)}
                                  open={regionOpen}
                                />
                              </td>
                              <td className={`${numCell} font-semibold text-[#0B0B0B]`}>
                                {money(region.cell.value)}
                              </td>
                              <td className={numCell}>{achievement(region.cell.achievement)}</td>
                            </tr>
                            {regionOpen
                              ? region.areas.map((area) => (
                                  <tr key={`${key} ▸ ${area.areaCode}`}>
                                    <td className={bodyCell}>
                                      <span className="block pl-10 font-medium text-[#0B0B0B]">
                                        {area.areaName}
                                      </span>
                                    </td>
                                    <td className={numCell}>{money(area.cell.value)}</td>
                                    <td className={numCell}>{achievement(area.cell.achievement)}</td>
                                  </tr>
                                ))
                              : null}
                          </Fragment>
                        );
                      })
                    : null}
                </Fragment>
              );
            })}
            <tr className="bg-[#0B0B0B]">
              <td className={`${bodyCell} font-bold text-white`}>Grand total</td>
              <td className={`${numCell} font-bold text-white`}>
                {money(summary.grandTotal.total.salesValue)}
              </td>
              <td className={`${numCell} font-bold text-white`}>
                {achievement(summary.grandTotal.achievementPct)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Mobile: cards. The admin shell never shows a full table on a phone. Same three levels. */}
      <div className="space-y-2 px-4 pb-4 md:hidden">
        {tree.map((node) => {
          const familyOpen = openFamilies.has(node.family);
          return (
            <div className="border border-phx-line bg-white" key={node.family}>
              <button
                aria-expanded={familyOpen}
                className="flex w-full items-start justify-between gap-2 p-3 text-left"
                onClick={() => toggleFamily(node.family)}
                type="button"
              >
                <span className="flex items-start gap-1.5">
                  <Chevron open={familyOpen} />
                  <span className="break-words text-sm font-bold text-[#0B0B0B]">{node.family}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-bold tabular-nums text-[#0B0B0B]">
                    {money(node.total.value)}
                  </span>
                  <span className="block text-phx-2xs tabular-nums text-slate-500">
                    {achievement(node.total.achievement)}
                  </span>
                </span>
              </button>
              {familyOpen ? (
                <div className="border-t border-phx-line">
                  {node.regions.map((region) => {
                    const key = regionKey(node.family, region.regionCode);
                    const regionOpen = openRegions.has(key);
                    return (
                      <div className="border-b border-slate-100 last:border-b-0" key={key}>
                        <button
                          aria-expanded={regionOpen}
                          className="flex w-full items-start justify-between gap-2 px-3 py-2 text-left"
                          onClick={() => toggleRegion(node.family, region.regionCode)}
                          type="button"
                        >
                          <span className="flex items-start gap-1.5">
                            <Chevron open={regionOpen} />
                            <span className="break-words text-xs font-semibold text-[#0B0B0B]">
                              {region.regionName}
                            </span>
                          </span>
                          <span className="shrink-0 text-right">
                            <span className="block text-xs font-semibold tabular-nums text-[#0B0B0B]">
                              {money(region.cell.value)}
                            </span>
                            <span className="block text-phx-2xs tabular-nums text-slate-500">
                              {achievement(region.cell.achievement)}
                            </span>
                          </span>
                        </button>
                        {regionOpen ? (
                          <dl className="space-y-1 px-3 pb-2 pl-8">
                            {region.areas.map((area) => (
                              <div
                                className="flex flex-wrap items-baseline justify-between gap-2"
                                key={area.areaCode}
                              >
                                <dt className="break-words text-xs text-slate-500">{area.areaName}</dt>
                                <dd className="text-xs tabular-nums text-slate-700">
                                  {money(area.cell.value)} · {achievement(area.cell.achievement)}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
        <div className="border border-phx-line bg-[#0B0B0B] p-3 text-white">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-bold">Grand total</span>
            <span className="text-sm font-bold tabular-nums">
              {money(summary.grandTotal.total.salesValue)}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
