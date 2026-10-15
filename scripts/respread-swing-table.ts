/**
 * List EVERY area's achievement for one line and month, before and after the read-time Office
 * respread, with the rep and district manager who held the area IN THAT MONTH.
 *
 * Why this and not `restate-area-month.ts` run 48 times. The respread moves Office credit BETWEEN
 * areas, so no single area's swing can be judged on its own: "is this area's figure wrong?" is
 * really "did the credit go to the rep whose own book earned it?", and that is only visible side by
 * side. One matrix load answers it for every area at once; 48 single-area runs would reload the
 * same matrix 48 times and still not show the comparison.
 *
 * The own-sales-only column is the one that matters. A large FALL with a weak own book is the rule
 * correcting an artefact (Down town, 19.4% own, 140.6% stored -> 45.6%); a large RISE with a strong
 * own book is the rule paying the right person (Cairo East 1, 92.4% own, 123.9% -> 223.8%). Neither
 * is a defect.
 *
 * Names come from the `au_v_*` organogram, never from `v_active_organogram` — that view is an
 * as-of-today ACTIVE projection, so a seat vacant TODAY disappears from it with no error and it
 * answered "nobody" for an area a resigned rep held all September.
 * `au_v_seat_occupancy_all` carries effective_from/effective_to, which is the only way to ask who
 * held a seat during a PAST month, and `au_v_line_area_map_all` is dated the same way, so both are
 * windowed on the period rather than read as-of-now.
 *
 * Read-only. It writes nothing.
 *
 * Usage (from a tree on origin/main; it reads the database .env.local points at, PRODUCTION):
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/respread-swing-table.ts [--line=CNS] [--period=2026-09] [--sort=swing|name|after]
 *
 * The line is matched on the engine's own label ("CNS", "Anti Infective", "Pedia") and a miss falls
 * back to the first line SILENTLY, so the line the engine answered with is checked against the one
 * asked for before any number is printed.
 */
import { loadClosingStoreSplit } from "@/lib/sales/closing-store-split-net";
import { loadMonthlyClosingPartsWithStoreSplit } from "@/lib/sales/monthly-closing-with-store-split";
import { OFFICE_RESPREAD_START_PERIOD, isOfficeRespreadPair } from "@/lib/sales/office-distributor";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "respread-swing-table",
  entry: import.meta.url,
  known: ["--line", "--period", "--sort"],
});

function flag(name: string, fallback: string): string {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const line = flag("line", "CNS");
const period = flag("period", "2026-09");
const sort = flag("sort", "swing");

const key = (value: string) => value.toLowerCase().replace(/\s+/g, "");
const money = (value: number) =>
  value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
const signed = (value: number) => (value >= 0 ? `+${money(value)}` : money(value));

type Row = {
  areaCode: string;
  areaName: string;
  regionName: string;
  rowTotal: {
    salesUnits: number;
    salesValue: number;
    targetValue: number | null;
    achievement: number | null;
  };
};

function areaRows(regions: { areas: Row[] }[]): Row[] {
  return regions.flatMap((region) => region.areas);
}

type Seat = { rep: string; dm: string; state: string; carriesTarget: boolean };

// Who held each area of this line DURING this month. Both organogram views are dated, so both are
// windowed on the period — reading either as-of-now answers a different question.
async function occupants(): Promise<Map<string, Seat>> {
  const supabase = getSupabaseAdmin();
  const lineCode = line.toLowerCase().replace(/\s+/g, "_");
  const monthStart = `${period}-01`;
  // The last day of THIS month, never a blind `-31` — Postgres rejects "2026-09-31" outright
  // ("date/time field value out of range"), so the whole listing fails on a 30-day month.
  const [year, month] = period.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

  const { data: areas, error: areaError } = await supabase
    .from("au_v_line_area_map_all")
    .select("area_code, rep_seat_id, dm_seat_id, area_state, carries_target, effective_from, effective_to")
    .eq("line_code", lineCode)
    .lte("effective_from", monthEnd);
  if (areaError) throw new Error(`reading the line/area map: ${areaError.message}`);
  const inMonth = (areas ?? []).filter((row) => !row.effective_to || String(row.effective_to) > monthStart);

  const seatIds = [
    ...new Set(
      inMonth.flatMap((row) => [row.rep_seat_id, row.dm_seat_id]).filter(Boolean) as string[],
    ),
  ];
  const { data: seats, error: seatError } = await supabase
    .from("au_v_seat_occupancy_all")
    .select("seat_id, occupant_canonical_hr_id, node_type, effective_from, effective_to")
    .in("seat_id", seatIds)
    .eq("node_type", "person")
    .lte("effective_from", monthEnd);
  if (seatError) throw new Error(`reading seat occupancy: ${seatError.message}`);

  // A seat is vacant for the month, or held by someone. When it is vacant, WHO LEFT AND WHEN is the
  // part he needs — an area at 128% with "vacant" against it reads like missing data until it says
  // the rep left in August.
  const held = new Map<string, string>();
  const left = new Map<string, { hrId: string; on: string }>();
  for (const seat of seats ?? []) {
    if (!seat.occupant_canonical_hr_id) continue;
    const seatId = String(seat.seat_id);
    const hrId = String(seat.occupant_canonical_hr_id).toUpperCase();
    if (!seat.effective_to || String(seat.effective_to) > monthStart) {
      held.set(seatId, hrId);
      continue;
    }
    const on = String(seat.effective_to);
    const seen = left.get(seatId);
    if (!seen || on > seen.on) left.set(seatId, { hrId, on });
  }

  const names = new Map<string, string>();
  const hrIds = [...new Set([...held.values(), ...[...left.values()].map((row) => row.hrId)])];
  for (let from = 0; from < hrIds.length; from += 200) {
    const { data: people, error: peopleError } = await supabase
      .from("employees")
      .select("hr_id, full_name")
      .in("hr_id", hrIds.slice(from, from + 200));
    if (peopleError) throw new Error(`reading employee names: ${peopleError.message}`);
    for (const person of people ?? []) {
      names.set(String(person.hr_id).toUpperCase(), String(person.full_name));
    }
  }

  const day = (value: string) =>
    new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  const whoHeld = (seatId: string | null): string => {
    if (!seatId) return "no rep seat";
    const hrId = held.get(seatId);
    if (hrId) return names.get(hrId) ?? hrId;
    const gone = left.get(seatId);
    if (gone) return `vacant — ${names.get(gone.hrId) ?? gone.hrId} left ${day(gone.on)}`;
    return "vacant";
  };

  const out = new Map<string, Seat>();
  for (const row of inMonth) {
    out.set(String(row.area_code), {
      rep: whoHeld(row.rep_seat_id ? String(row.rep_seat_id) : null),
      dm: whoHeld(row.dm_seat_id ? String(row.dm_seat_id) : null),
      state: String(row.area_state ?? ""),
      carriesTarget: row.carries_target === true,
    });
  }
  return out;
}

async function main(): Promise<void> {
  console.log(
    `${line.toUpperCase()} ${period} — every area's achievement before and after the read-time Office respread.`,
  );
  // The respread is a (line, period) pair, not a period — Office is a CNS-only channel (the owner's
  // rule of 2026-08-25, OFFICE_CHANNEL_LINES). Printing "RECOMPUTED on every read" over a Pedia or
  // Anti Infective listing would invite exactly the wrong reading of three identical columns.
  console.log(
    isOfficeRespreadPair(line, period)
      ? `Office respread starts ${OFFICE_RESPREAD_START_PERIOD}, so this month is RECOMPUTED on every read.`
      : period >= OFFICE_RESPREAD_START_PERIOD
        ? `${line.toUpperCase()} carries NO Office channel (CNS only), so there is nothing to respread: stored and live are the same figure by construction.`
        : `This month is before the respread window (${OFFICE_RESPREAD_START_PERIOD}), so it is read from the stored rows.`,
  );

  const [parts, split, who] = await Promise.all([
    loadMonthlyClosingPartsWithStoreSplit({ line, period }),
    loadClosingStoreSplit(line, period),
    occupants(),
  ]);

  if (key(String(parts.combined.line ?? "")) !== key(line) || parts.combined.period !== period) {
    throw new Error(
      `the engine answered ${parts.combined.line} ${parts.combined.period}, not ${line} ${period} — a line label that does not match falls back silently, so nothing is printed (available: ${parts.combined.availableLines.join(", ")})`,
    );
  }

  const net = new Map<string, { qty: number; value: number }>();
  let nationalNet = 0;
  let movedOut = 0;
  for (const [cellKey, cell] of split.officeNet) {
    const areaCode = cellKey.split("|")[0];
    const seen = net.get(areaCode) ?? { qty: 0, value: 0 };
    net.set(areaCode, { qty: seen.qty + cell.qty, value: seen.value + cell.value });
    nationalNet += cell.value;
  }
  for (const cell of net.values()) if (cell.value < 0) movedOut += cell.value;

  const combined = areaRows(parts.combined.regions as unknown as { areas: Row[] }[]);
  const office = new Map(
    areaRows((parts.office?.regions ?? []) as unknown as { areas: Row[] }[]).map((row) => [
      row.areaCode,
      row.rowTotal.salesValue,
    ]),
  );

  const rows = combined.map((area) => {
    const moved = net.get(area.areaCode)?.value ?? 0;
    const target = area.rowTotal.targetValue;
    const after = area.rowTotal.salesValue;
    const before = after - moved;
    const own = after - (office.get(area.areaCode) ?? 0);
    const seat = who.get(area.areaCode);
    const hasTarget = target !== null && target > 0;
    return {
      areaName: area.areaName,
      regionName: area.regionName,
      rep: seat?.rep ?? "—",
      dm: seat?.dm ?? "—",
      moved,
      target,
      achBefore: hasTarget ? before / (target as number) : null,
      achAfter: hasTarget ? after / (target as number) : null,
      achOwn: hasTarget ? own / (target as number) : null,
      swing: hasTarget ? moved / (target as number) : 0,
      hasTarget,
    };
  });

  if (sort === "name") rows.sort((a, b) => a.areaName.localeCompare(b.areaName));
  else if (sort === "after") rows.sort((a, b) => (b.achAfter ?? -1) - (a.achAfter ?? -1));
  else rows.sort((a, b) => Math.abs(b.swing) - Math.abs(a.swing));

  const head = ["area", "region", "rep in September", "own only", "stored", "live", "swing", "moved EGP"];
  const body = rows.map((row) => [
    row.areaName,
    row.regionName,
    row.rep,
    pct(row.achOwn),
    pct(row.achBefore),
    pct(row.achAfter),
    row.hasTarget ? `${row.swing >= 0 ? "+" : ""}${(row.swing * 100).toFixed(1)}` : "—",
    row.moved === 0 ? "—" : signed(row.moved),
  ]);
  const width = head.map((_, column) =>
    Math.max(head[column].length, ...body.map((cells) => cells[column].length)),
  );
  const render = (cells: string[]) =>
    cells
      .map((cell, column) => (column <= 2 ? cell.padEnd(width[column]) : cell.padStart(width[column])))
      .join("  ");
  console.log(`\n${render(head)}`);
  console.log(width.map((size) => "-".repeat(size)).join("  "));
  for (const cells of body) console.log(render(cells));

  const touched = rows.filter((row) => row.moved !== 0).length;
  const withTarget = rows.filter((row) => row.hasTarget).length;
  console.log(
    `\n${rows.length} areas, ${withTarget} carrying a target, ${touched} touched by the respread.`,
  );
  console.log(`Credit moved: ${money(movedOut)} EGP out, ${money(-movedOut)} EGP in.`);
  console.log(`National net: ${money(nationalNet)} EGP — it must be ~0.00, credit only moves.`);

  const crossed = rows.filter(
    (row) => row.achBefore !== null && row.achAfter !== null && row.achBefore >= 1 !== row.achAfter >= 1,
  );
  console.log(`\nAreas that cross 100% because of the respread: ${crossed.length}`);
  for (const row of crossed) {
    console.log(
      `  ${row.areaName} — ${row.rep}: ${pct(row.achBefore)} -> ${pct(row.achAfter)} (own ${pct(row.achOwn)})`,
    );
  }

  const national = parts.combined.grandTotal?.rowTotal;
  if (national) {
    console.log(
      `\nNational ${line.toUpperCase()} ${period}: ${money(national.salesValue)} EGP sales, achievement ${pct(national.achievement)} — unchanged by the respread.`,
    );
  }
}

await main();
