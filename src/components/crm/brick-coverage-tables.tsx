"use client";


import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { SortableTh, TableSearchInput } from "@/components/ui/sortable-table";
import { useSortableTable } from "@/components/ui/use-sortable-table";
import type {
  BrickCoverageBlindSpot,
  BrickCoverageRepRow,
  BrickCoverageUnmeasured,
} from "@/lib/crm/brick-coverage";
import type { CoverageFilterVacancy } from "@/lib/crm/coverage-filters";

// Client half of the Brick Coverage board: the three sortable tables. Styling copies the Doctor
// Coverage / CEO table vocabulary verbatim (ceo-dv-table.tsx) — flat borders, slate-900 header
// rows, emerald/amber/rose tones, the same inline coverage bar. Never a one-off look.
//
// The other source was doctor-coverage-tables.tsx, deleted on 2026-09-02 as unreachable code after
// the owner retired its board on 2026-08-28. This file holds that vocabulary now.
//
// Every export below feeds the ORIGINAL `rows` prop, never the hook's filtered `table.rows` — the
// sortable-table hook's own contract, so a search box left filled cannot silently truncate a file.
//
// All four tables are desktop-only, with a card list under md — AGENTS.md §4, and the
// same PortalResponsiveDataList the rest of the CRM module moved to on 2026-08-21. The widest of
// them is ~1,040px, so on a 375px phone the pre-split version was a sideways scroll inside a
// container that gave no hint it could scroll. Card and desktop row both read their tone from the
// one `toneOf`, so the two halves cannot disagree about where 50% and 80% sit.

const THEAD = "px-3 py-2.5 text-phx-sm font-black uppercase tracking-[0.12em] text-white";

/** Shared with the rep table's bar: 80+ good, 50+ watch, below that a real gap. */
function toneOf(pctValue: number): { accent: "amber" | "emerald" | "rose"; bar: string; text: string } {
  if (pctValue >= 80) return { accent: "emerald", bar: "bg-emerald-500", text: "text-emerald-700" };
  if (pctValue >= 50) return { accent: "amber", bar: "bg-amber-400", text: "text-amber-700" };
  return { accent: "rose", bar: "bg-rose-400", text: "text-rose-700" };
}

function CoverageBar({ value }: { value: number }) {
  const tone = toneOf(value);
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1 w-16 bg-slate-100">
        <div className={`h-full ${tone.bar}`} style={{ width: `${Math.max(2, value)}%` }} />
      </div>
      <span className={`w-10 shrink-0 text-right font-black ${tone.text}`}>{value}%</span>
    </div>
  );
}

const REP_COLS = [
  { accessor: (r: BrickCoverageRepRow) => r.repName, defaultDir: "asc" as const, key: "repName", type: "string" as const },
  { accessor: (r: BrickCoverageRepRow) => r.line, key: "line", type: "string" as const },
  { accessor: (r: BrickCoverageRepRow) => r.salesCoveragePct, key: "salesCoveragePct", type: "number" as const },
  { accessor: (r: BrickCoverageRepRow) => r.unitsInTerritory, key: "unitsInTerritory", type: "number" as const },
  { accessor: (r: BrickCoverageRepRow) => r.bricksWithSales, key: "bricksWithSales", type: "number" as const },
  { accessor: (r: BrickCoverageRepRow) => r.brickCoveragePct, key: "brickCoveragePct", type: "number" as const },
  { accessor: (r: BrickCoverageRepRow) => r.offTerritoryBricks, key: "offTerritoryBricks", type: "number" as const },
  { accessor: (r: BrickCoverageRepRow) => r.checkins, key: "checkins", type: "number" as const },
];

/**
 * Where a rep row goes when you click it: his own contact list on Doctor Coverage, for the same
 * month — every doctor and account he owns, with grades, who he has seen and who he has not.
 *
 * The two boards answer different halves of one question ("is he covering the bricks that sell?"
 * and "who exactly is he not seeing?"), so the brick row links into the answer rather than growing
 * a second copy of that table here.
 *
 * The `hr:` prefix is the conversion between the two boards' rep-key conventions: this board keys
 * reps by bare `canonicalHrIdKey`, Doctor Coverage by `hr:<lowercased id>`. See `repsMatching` in
 * coverage-filters.ts — the same seam, in the other direction.
 */
// RETIRED 2026-08-28: contactListHref() built the drill-through into /admin/doctor-coverage, which
// the owner withdrew along with Rep Doctor Lists. The rep name is plain text until the replacement
// board ships and this board can point at it again.

export function BrickCoverageRepTable({
  monthLabel,
  rows,
}: {
  month: string;
  monthLabel: string;
  rows: BrickCoverageRepRow[];
}) {
  const table = useSortableTable(rows, {
    columns: REP_COLS,
    initialSort: { dir: "asc", key: "salesCoveragePct" },
    searchAccessors: [(r) => r.repName, (r) => r.line, (r) => r.areaNames],
  });

  // Project to scalars before exporting. `ExportRow` is Record<string, string | number | null |
  // undefined>, and BrickCoverageRepRow carries `hasGpsFeed: boolean`, which is not assignable —
  // so the whole row type is rejected. Spreading the row would only re-introduce it; naming the
  // columns explicitly is also what doctor-coverage-tables.tsx did before it was deleted, and it
  // keeps the sheet's
  // columns and this list from drifting apart. `hasGpsFeed` is deliberately absent rather than
  // coerced: every row in this table has a feed by construction (a rep without one is held out in
  // `unmeasured`), so a column that is always TRUE would only invite the reader to doubt it.
  const exportRows = rows.map((row) => ({
    areaNames: row.areaNames,
    brickCoveragePct: row.brickCoveragePct,
    bricksCovered: row.bricksCovered,
    bricksWithSales: row.bricksWithSales,
    checkins: row.checkins,
    line: row.line,
    offTerritoryBricks: row.offTerritoryBricks,
    repName: row.repName,
    salesCoveragePct: row.salesCoveragePct,
    unitsCovered: row.unitsCovered,
    unitsInTerritory: row.unitsInTerritory,
  }));

  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TableSearchInput onChange={table.setQuery} onClear={table.clearQuery} placeholder="Search rep, line or area…" value={table.query} />
        <ExportXlsxButton
          columns={[
            { key: "repName", label: "Rep", width: 34 },
            { key: "line", label: "Line", width: 16 },
            { key: "areaNames", label: "Territory", width: 34 },
            { key: "salesCoveragePct", label: "Sales covered %", numeric: true },
            { key: "unitsCovered", label: "Units in bricks visited", numeric: true },
            { key: "unitsInTerritory", label: "Units in territory", numeric: true },
            { key: "bricksCovered", label: "Bricks visited", numeric: true },
            { key: "bricksWithSales", label: "Bricks with sales", numeric: true },
            { key: "brickCoveragePct", label: "Bricks covered %", numeric: true },
            { key: "offTerritoryBricks", label: "Bricks visited outside territory", numeric: true },
            { key: "checkins", label: "Check-ins", numeric: true },
          ]}
          rows={exportRows}
          sheetName="Brick coverage"
          subtitle={`${monthLabel} · GPS check-ins snapped to nearest brick centre`}
          title="Rep brick coverage"
        />
      </div>
      <PortalResponsiveDataList
        empty={
          <p className="px-3 py-6 text-center text-xs text-slate-400">
            No rep has both a territory and a GPS check-in in this month.
          </p>
        }
        getKey={(row) => row.repKey}
        items={table.rows}
        renderCard={(row) => (
          <PortalRecordCard
            accent={toneOf(row.salesCoveragePct).accent}
            meta={`${row.line} · ${row.areaNames}`}
            status={
              <span className={`text-sm font-black ${toneOf(row.salesCoveragePct).text}`}>{row.salesCoveragePct}%</span>
            }
            title={row.repName}
          >
            <PortalRecordFields
              fields={[
                { label: "Units in territory", value: row.unitsInTerritory.toLocaleString() },
                { label: "Bricks selling", value: `${row.bricksCovered} / ${row.bricksWithSales}` },
                {
                  label: "Bricks covered",
                  value: <span className={toneOf(row.brickCoveragePct).text}>{row.brickCoveragePct}%</span>,
                },
                {
                  label: "Outside territory",
                  value: (
                    <span className={row.offTerritoryBricks > 0 ? "text-amber-700" : "text-slate-400"}>
                      {row.offTerritoryBricks}
                    </span>
                  ),
                },
                { label: "Check-ins", value: row.checkins.toLocaleString() },
              ]}
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable
            className="text-xs"
            cols={
              <colgroup>
                <col className="w-[18%]" />
                <col className="w-[11%]" />
                <col className="w-[16%]" />
                <col className="w-[14%]" />
                <col className="w-[13%]" />
                <col className="w-[10%]" />
                <col className="w-[9%]" />
                <col className="w-[9%]" />
              </colgroup>
            }
          >
            <thead>
              <tr className="bg-slate-900 text-left">
                <SortableTh className={THEAD} label="Rep" onSort={table.toggleSort} sort={table.sort} sortKey="repName" />
                <SortableTh className={THEAD} label="Line" onSort={table.toggleSort} sort={table.sort} sortKey="line" />
                <SortableTh align="right" className={`${THEAD} text-right`} label="Sales covered" onSort={table.toggleSort} sort={table.sort} sortKey="salesCoveragePct" />
                <SortableTh align="right" className={`${THEAD} text-right`} label="Units in territory" onSort={table.toggleSort} sort={table.sort} sortKey="unitsInTerritory" />
                <SortableTh align="right" className={`${THEAD} text-right`} label="Bricks selling" onSort={table.toggleSort} sort={table.sort} sortKey="bricksWithSales" />
                <SortableTh align="right" className={`${THEAD} text-right`} label="Bricks covered" onSort={table.toggleSort} sort={table.sort} sortKey="brickCoveragePct" />
                <SortableTh align="right" className={`${THEAD} text-right text-amber-300`} label="Outside" onSort={table.toggleSort} sort={table.sort} sortKey="offTerritoryBricks" />
                <SortableTh align="right" className={`${THEAD} text-right`} label="Check-ins" onSort={table.toggleSort} sort={table.sort} sortKey="checkins" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.rows.map((row) => (
                <tr className="bg-white hover:bg-slate-50" key={row.repKey}>
                  <td className="break-words px-3 py-2 font-semibold text-slate-900">
                    {row.repName}
                    <span className="ml-2 text-phx-sm font-normal text-slate-400">{row.areaNames}</span>
                  </td>
                  <td className="break-words px-3 py-2 text-slate-600">{row.line}</td>
                  <td className="px-3 py-2">
                    <CoverageBar value={row.salesCoveragePct} />
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-900">{row.unitsInTerritory.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right text-slate-600">
                    {row.bricksCovered} / {row.bricksWithSales}
                  </td>
                  <td className={`px-3 py-2 text-right font-bold ${toneOf(row.brickCoveragePct).text}`}>{row.brickCoveragePct}%</td>
                  <td className={`px-3 py-2 text-right font-bold ${row.offTerritoryBricks > 0 ? "text-amber-700" : "text-slate-400"}`}>
                    {row.offTerritoryBricks}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-600">{row.checkins.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </div>
  );
}

const SPOT_COLS = [
  { accessor: (r: BrickCoverageBlindSpot) => r.units, key: "units", type: "number" as const },
  { accessor: (r: BrickCoverageBlindSpot) => r.repName, defaultDir: "asc" as const, key: "repName", type: "string" as const },
  { accessor: (r: BrickCoverageBlindSpot) => r.brickName, defaultDir: "asc" as const, key: "brickName", type: "string" as const },
  { accessor: (r: BrickCoverageBlindSpot) => r.areaName, defaultDir: "asc" as const, key: "areaName", type: "string" as const },
  { accessor: (r: BrickCoverageBlindSpot) => r.pctOfRepSales, key: "pctOfRepSales", type: "number" as const },
];

export function BrickCoverageBlindSpotTable({ monthLabel, rows }: { monthLabel: string; rows: BrickCoverageBlindSpot[] }) {
  const table = useSortableTable(rows, {
    columns: SPOT_COLS,
    initialSort: { dir: "desc", key: "units" },
    searchAccessors: [(r) => r.repName, (r) => r.brickName, (r) => r.areaName, (r) => r.line],
  });

  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TableSearchInput onChange={table.setQuery} onClear={table.clearQuery} placeholder="Search rep, brick or area…" value={table.query} />
        <ExportXlsxButton
          columns={[
            { key: "repName", label: "Rep", width: 34 },
            { key: "line", label: "Line", width: 16 },
            { key: "brickName", label: "Brick never visited", width: 28 },
            { key: "areaName", label: "Area", width: 24 },
            { key: "units", label: "Units sold there", numeric: true },
            { key: "pctOfRepSales", label: "% of their sales", numeric: true },
          ]}
          rows={rows}
          sheetName="Blind spots"
          subtitle={`${monthLabel} · bricks that sold where the rep never checked in`}
          title="Brick coverage blind spots"
        />
      </div>
      <PortalResponsiveDataList
        empty={
          <p className="px-3 py-6 text-center text-xs text-slate-400">
            Every selling brick in scope was visited this month.
          </p>
        }
        getKey={(row, index) => `${row.repKey}-${row.brickName}-${index}`}
        items={table.rows}
        renderCard={(row) => (
          <PortalRecordCard
            accent={row.pctOfRepSales >= 25 ? "rose" : "slate"}
            meta={`${row.repName} · ${row.line} · ${row.areaName}`}
            status={<span className="text-sm font-black text-slate-900">{row.units.toLocaleString()}</span>}
            title={row.brickName}
          >
            <PortalRecordFields
              fields={[
                { label: "Units sold there", value: row.units.toLocaleString() },
                {
                  label: "Of their sales",
                  value: (
                    <span className={row.pctOfRepSales >= 25 ? "text-rose-700" : "text-slate-600"}>
                      {row.pctOfRepSales}%
                    </span>
                  ),
                },
              ]}
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable
            className="text-xs"
            cols={
              <colgroup>
                <col className="w-[24%]" />
                <col className="w-[26%]" />
                <col className="w-[22%]" />
                <col className="w-[14%]" />
                <col className="w-[14%]" />
              </colgroup>
            }
          >
            <thead>
              <tr className="bg-slate-900 text-left">
                <SortableTh className={THEAD} label="Rep" onSort={table.toggleSort} sort={table.sort} sortKey="repName" />
                <SortableTh className={THEAD} label="Brick never visited" onSort={table.toggleSort} sort={table.sort} sortKey="brickName" />
                <SortableTh className={THEAD} label="Area" onSort={table.toggleSort} sort={table.sort} sortKey="areaName" />
                <SortableTh align="right" className={`${THEAD} text-right`} label="Units sold" onSort={table.toggleSort} sort={table.sort} sortKey="units" />
                <SortableTh align="right" className={`${THEAD} text-right text-rose-300`} label="Of their sales" onSort={table.toggleSort} sort={table.sort} sortKey="pctOfRepSales" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.rows.map((row, index) => (
                <tr className="bg-white hover:bg-slate-50" key={`${row.repKey}-${row.brickName}-${index}`}>
                  <td className="break-words px-3 py-2 font-semibold text-slate-900">
                    {row.repName}
                    <span className="ml-2 text-phx-sm font-normal text-slate-400">{row.line}</span>
                  </td>
                  <td className="break-words px-3 py-2 font-semibold text-slate-900">{row.brickName}</td>
                  <td className="break-words px-3 py-2 text-slate-600">{row.areaName}</td>
                  <td className="px-3 py-2 text-right font-bold text-slate-900">{row.units.toLocaleString()}</td>
                  <td className={`px-3 py-2 text-right font-black ${row.pctOfRepSales >= 25 ? "text-rose-700" : "text-slate-600"}`}>
                    {row.pctOfRepSales}%
                  </td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </div>
  );
}

/**
 * Reps the board refuses to score. This table is not a nicety — without it a rep whose check-in
 * feed simply stopped would either vanish from the page or, far worse, appear at 0% coverage. It
 * names them, says why, and keeps them out of every total above.
 */
export function BrickCoverageUnmeasuredTable({ rows }: { month: string; rows: BrickCoverageUnmeasured[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="p-5">
      <PortalResponsiveDataList
        empty={null}
        getKey={(row) => row.repKey}
        items={rows}
        renderCard={(row) => (
          <PortalRecordCard
            accent="amber"
            meta={`${row.line} · ${row.areaNames}`}
            title={row.repName}
          >
            <PortalRecordFields
              fields={[{ label: "Why not scored", value: <span className="text-amber-700">{row.reason}</span> }]}
            />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable
            className="text-xs"
            cols={
              <colgroup>
                <col className="w-[24%]" />
                <col className="w-[16%]" />
                <col className="w-[26%]" />
                <col className="w-[34%]" />
              </colgroup>
            }
          >
            <thead>
              <tr className="bg-slate-900 text-left">
                <th className={THEAD}>Rep</th>
                <th className={THEAD}>Line</th>
                <th className={THEAD}>Territory</th>
                <th className={THEAD}>Why not scored</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr className="bg-white hover:bg-slate-50" key={row.repKey}>
                  <td className="break-words px-3 py-2 font-semibold text-slate-900">
                    {row.repName}
                  </td>
                  <td className="break-words px-3 py-2 text-slate-600">{row.line}</td>
                  <td className="break-words px-3 py-2 text-slate-600">{row.areaNames}</td>
                  <td className="break-words px-3 py-2 text-amber-700">{row.reason}</td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </div>
  );
}

/**
 * Territories carrying a sales target with an empty seat.
 *
 * The sibling of the unscored-reps table above, and there for the same reason: without it these
 * would simply be absent — they are kept out of every total AND out of the filters, because
 * scoring an empty seat at 0% blames a rep who does not exist. Absent is indistinguishable from
 * covered, so they are named instead.
 */
export function BrickCoverageVacancyTable({ rows }: { rows: CoverageFilterVacancy[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="p-5">
      <PortalResponsiveDataList
        empty={null}
        getKey={(row) => `${row.lineCode}:${row.areaCode}:${row.seatId}`}
        items={rows}
        renderCard={(row) => (
          <PortalRecordCard accent="slate" meta={row.lineName} title={row.areaName}>
            <PortalRecordFields fields={[{ label: "Region", value: row.regionName }]} />
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable
            className="text-xs"
            cols={
              <colgroup>
                <col className="w-[40%]" />
                <col className="w-[30%]" />
                <col className="w-[30%]" />
              </colgroup>
            }
          >
            <thead>
              <tr className="bg-slate-900 text-left">
                <th className={THEAD}>Territory</th>
                <th className={THEAD}>Line</th>
                <th className={THEAD}>Region</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr className="bg-white hover:bg-slate-50" key={`${row.lineCode}:${row.areaCode}:${row.seatId}`}>
                  <td className="break-words px-3 py-2 font-semibold text-slate-900">{row.areaName}</td>
                  <td className="break-words px-3 py-2 text-slate-600">{row.lineName}</td>
                  <td className="break-words px-3 py-2 text-slate-600">{row.regionName}</td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </div>
  );
}
