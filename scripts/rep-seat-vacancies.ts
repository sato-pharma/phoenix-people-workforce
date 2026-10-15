/**
 * Every area's rep seat on the three tracked lines, with the vacancies named and priced.
 *
 * The staffing question and the sales question are one question here: an area that carries a target
 * still divides its sales by that target whether or not anybody is in post, so a line's achievement
 * carries its vacancies. This prints, per area and line, who holds the rep seat TODAY — and where
 * nobody does, who left and when, plus the month's value and target sitting under the empty seat.
 *
 * Four states, which must not be collapsed into one. The organogram NAMES them in `area_state`, so
 * they are read rather than inferred:
 *   · `occupied`            — a rep is in post. The name is printed.
 *   · `vacant_will_hire`    — the seat exists, carries a target, and nobody is in it. THE gap.
 *   · `other_line_specific` — no rep seat on this line; another line's rep covers the area, and
 *                             `staffed_in_line_code` says which. Carries no target. Not a gap.
 *   · `other_permanent`     — no rep seat on this line, permanently. No target. Not a gap.
 * Counting the last two as vacancies would invent about ten gaps per line that nobody has; counting
 * them as staffed would hide the seats that are genuinely empty.
 *
 * Read as of TODAY, because the question is who is missing now. That is why an area can read vacant
 * here and still carry a rep in a September report: the dated organogram (`au_v_line_area_map_all` +
 * `au_v_seat_occupancy_all`) is the only source that can tell those apart. `v_active_organogram` is
 * an as-of-today ACTIVE projection, so a vacant seat disappears from it entirely and it cannot
 * answer this at all (owner, 2026-10-10 — "drop the v-organo").
 *
 * Money comes from the Monthly Closing engine, the one source of truth for a sales figure AND the
 * target it is divided by, so CNS carries the read-time Office respread exactly as a manager sees it.
 *
 * Read-only. It writes nothing.
 *
 * Usage (from a tree on origin/main; it reads the database .env.local points at, PRODUCTION):
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/rep-seat-vacancies.ts [--period=2026-09] [--asOf=2026-10-10]
 */
import { loadMonthlyClosingPartsWithStoreSplit } from "@/lib/sales/monthly-closing-with-store-split";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "rep-seat-vacancies",
  entry: import.meta.url,
  known: ["--period", "--asOf"],
});

function flag(name: string, fallback: string): string {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const LINES = [
  { label: "CNS", code: "cns" },
  { label: "Pedia", code: "pedia" },
  { label: "Anti Infective", code: "anti_infective" },
] as const;

const period = flag("period", "2026-09");
// Cairo local, not UTC: at 02:00 Cairo `toISOString()` still reads YESTERDAY, which would ask
// the organogram a day-old question and could show a seat someone left that evening as held.
const asOf = flag(
  "asOf",
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", dateStyle: "short" }).format(
    new Date(),
  ),
);

const key = (value: string) => value.toLowerCase().replace(/\s+/g, "");
const money = (value: number) =>
  value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
const day = (value: string) =>
  new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
const lineName = (code: string) =>
  LINES.find((line) => line.code === code)?.label ??
  code.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

type Seat = {
  areaCode: string;
  areaName: string;
  carriesTarget: boolean;
  coveredBy: string[];
  holder: string | null;
  lastHolder: string | null;
  leftOn: string | null;
  regionCode: string;
  state: string;
};

async function seatsForLine(lineCode: string): Promise<Map<string, Seat>> {
  const supabase = getSupabaseAdmin();
  const { data: areas, error: areaError } = await supabase
    .from("au_v_line_area_map_all")
    .select(
      "area_code, area_name, operational_region_code, area_state, rep_seat_id, staffed_in_line_code, carries_target, effective_from, effective_to",
    )
    .eq("line_code", lineCode)
    .lte("effective_from", asOf);
  if (areaError) throw new Error(`reading the ${lineCode} line/area map: ${areaError.message}`);
  // Half-open window: a row ending today has already ended.
  const live = (areas ?? []).filter((row) => !row.effective_to || String(row.effective_to) > asOf);

  const seatIds = [...new Set(live.map((row) => row.rep_seat_id).filter(Boolean) as string[])];
  const { data: seats, error: seatError } = await supabase
    .from("au_v_seat_occupancy_all")
    .select("seat_id, occupant_canonical_hr_id, node_type, effective_from, effective_to")
    .in("seat_id", seatIds)
    .eq("node_type", "person")
    .lte("effective_from", asOf);
  if (seatError) throw new Error(`reading ${lineCode} seat occupancy: ${seatError.message}`);

  const held = new Map<string, string>();
  const left = new Map<string, { hrId: string; on: string }>();
  for (const seat of seats ?? []) {
    if (!seat.occupant_canonical_hr_id) continue;
    const seatId = String(seat.seat_id);
    const hrId = String(seat.occupant_canonical_hr_id).toUpperCase();
    if (!seat.effective_to || String(seat.effective_to) > asOf) {
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

  const out = new Map<string, Seat>();
  for (const row of live) {
    const seatId = row.rep_seat_id ? String(row.rep_seat_id) : null;
    const hrId = seatId ? held.get(seatId) : undefined;
    const gone = seatId ? left.get(seatId) : undefined;
    out.set(String(row.area_code), {
      areaCode: String(row.area_code),
      areaName: String(row.area_name ?? row.area_code ?? ""),
      carriesTarget: row.carries_target === true,
      coveredBy: String(row.staffed_in_line_code ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map(lineName),
      holder: hrId ? (names.get(hrId) ?? hrId) : null,
      lastHolder: gone ? (names.get(gone.hrId) ?? gone.hrId) : null,
      leftOn: gone?.on ?? null,
      regionCode: String(row.operational_region_code ?? ""),
      state: String(row.area_state ?? ""),
    });
  }
  return out;
}

/** A rep is in post. Everything else is either a gap or a deliberate no-seat. */
function inPost(seat: Seat | undefined): boolean {
  return Boolean(seat?.holder);
}

/** The seat exists for this line and nobody is in it — the staffing gap. */
function isGap(seat: Seat | undefined): boolean {
  if (!seat || seat.holder) return false;
  return seat.state === "vacant_will_hire" || seat.state === "occupied";
}

function seatLabel(seat: Seat | undefined): string {
  if (!seat) return "not in this line's map";
  if (seat.holder) return seat.holder;
  // "left the seat", not "left": Behira 2's and Alex East's last Anti Infective reps are both in
  // post on another line today, so a bare "left" would read as a resignation it was not.
  const who = seat.lastHolder
    ? `${seat.lastHolder} left the seat ${seat.leftOn ? day(seat.leftOn) : "on a date not recorded"}`
    : "never filled";
  if (seat.state === "vacant_will_hire") return `VACANT — ${who}`;
  // `occupied` with nobody in the seat is the organogram contradicting itself; say so rather than
  // printing a blank or a name that is not there.
  if (seat.state === "occupied") return `VACANT (map still says occupied) — ${who}`;
  if (seat.state === "other_line_specific") {
    return seat.coveredBy.length > 0
      ? `no seat — covered by ${seat.coveredBy.join(" + ")}`
      : "no seat — covered by another line";
  }
  if (seat.state === "other_permanent") return "no seat — not staffed on this line";
  return `no seat — ${seat.state || "state not recorded"}`;
}

function table(head: string[], body: string[][], leftColumns: number): void {
  if (body.length === 0) {
    console.log("  (none)");
    return;
  }
  const width = head.map((_, column) =>
    Math.max(head[column].length, ...body.map((cells) => cells[column].length)),
  );
  const render = (cells: string[]) =>
    cells
      .map((cell, column) =>
        column < leftColumns ? cell.padEnd(width[column]) : cell.padStart(width[column]),
      )
      .join("  ");
  console.log(render(head));
  console.log(width.map((size) => "-".repeat(size)).join("  "));
  for (const cells of body) console.log(render(cells));
}

type Cell = { sales: number; target: number | null };

async function main(): Promise<void> {
  console.log(
    `Rep seats as of ${day(asOf)} — CNS, Pedia and Anti Infective, priced on the ${period} closing.`,
  );
  console.log(
    "A seat that exists with nobody in it is VACANT. An area with no rep seat on a line is not a gap: it is either covered by another line's rep or permanently not staffed on that line, and it carries no target.",
  );

  const byLine = new Map<string, Map<string, Seat>>();
  const moneyByLine = new Map<string, Map<string, Cell>>();
  for (const line of LINES) {
    const [seats, parts] = await Promise.all([
      seatsForLine(line.code),
      loadMonthlyClosingPartsWithStoreSplit({ line: line.label, period }),
    ]);
    // A line label the loader does not recognise falls back to the FIRST line silently, with the
    // right period and no error — so the answer is checked before a number is printed.
    if (
      key(String(parts.combined.line ?? "")) !== key(line.label) ||
      parts.combined.period !== period
    ) {
      throw new Error(
        `the engine answered ${parts.combined.line} ${parts.combined.period}, not ${line.label} ${period} — a line label that does not match falls back silently`,
      );
    }
    byLine.set(line.label, seats);
    const cells = new Map<string, Cell>();
    for (const region of parts.combined.regions as unknown as {
      areas: { areaCode: string; rowTotal: { salesValue: number; targetValue: number | null } }[];
    }[]) {
      for (const area of region.areas) {
        cells.set(area.areaCode, {
          sales: area.rowTotal.salesValue,
          target: area.rowTotal.targetValue,
        });
      }
    }
    moneyByLine.set(line.label, cells);
  }

  const areaCodes = [
    ...new Set(LINES.flatMap((line) => [...(byLine.get(line.label)?.keys() ?? [])])),
  ];
  const seatOf = (code: string, label: string) => byLine.get(label)?.get(code);
  const cellOf = (code: string, label: string) => moneyByLine.get(label)?.get(code);
  // An area's operational region is per LINE — Ismailia is "Others" to CNS and Delta 3 to Anti
  // Infective — so a cross-line row takes the region from a line that actually gives it a seat.
  const areaOf = (code: string) => {
    const rows = LINES.map((line) => seatOf(code, line.label)).filter(Boolean) as Seat[];
    return rows.find((seat) => seat.state === "occupied" || seat.state === "vacant_will_hire") ?? rows[0];
  };
  const areaName = (code: string) => areaOf(code)?.areaName || code;
  const salesAcross = (code: string) =>
    LINES.reduce((sum, line) => sum + (cellOf(code, line.label)?.sales ?? 0), 0);
  const targetAcross = (code: string) =>
    LINES.reduce((sum, line) => sum + (cellOf(code, line.label)?.target ?? 0), 0);

  // ── The strict answer: no rep in post on ANY of the three lines ───────────────────────────────
  const noRepAnywhere = areaCodes.filter((code) =>
    LINES.every((line) => !inPost(seatOf(code, line.label))),
  );
  const withAGap = noRepAnywhere.filter((code) =>
    LINES.some((line) => isGap(seatOf(code, line.label))),
  );
  const noSeatAtAll = noRepAnywhere.filter(
    (code) => !LINES.some((line) => isGap(seatOf(code, line.label))),
  );

  console.log(
    `\n${noRepAnywhere.length} of ${areaCodes.length} areas have NO REP IN POST on any of the three lines.`,
  );
  console.log(
    `${withAGap.length} of them hold at least one EMPTY SEAT (a real gap); the other ${noSeatAtAll.length} have no rep seat on any line at all.`,
  );

  console.log(`\nEmpty on every line that has a seat — the real gaps`);
  table(
    [
      "area",
      "region",
      ...LINES.map((line) => line.label),
      `${period} sales EGP`,
      "target EGP",
      "achievement",
    ],
    withAGap
      .map((code) => ({
        sales: salesAcross(code),
        cells: [
          areaName(code),
          areaOf(code)?.regionCode ?? "",
          ...LINES.map((line) => seatLabel(seatOf(code, line.label))),
          money(salesAcross(code)),
          targetAcross(code) > 0 ? money(targetAcross(code)) : "—",
          targetAcross(code) > 0 ? pct(salesAcross(code) / targetAcross(code)) : "—",
        ],
      }))
      .sort((a, b) => b.sales - a.sales)
      .map((row) => row.cells),
    5,
  );

  console.log(`\nNo rep seat on any line — not a staffing gap, and they carry no target`);
  table(
    ["area", "region", "how they are covered", `${period} sales EGP`],
    noSeatAtAll
      .map((code) => {
        const covered = [
          ...new Set(LINES.flatMap((line) => seatOf(code, line.label)?.coveredBy ?? [])),
        ];
        return {
          sales: salesAcross(code),
          cells: [
            areaName(code),
            areaOf(code)?.regionCode ?? "",
            covered.length > 0 ? `covered by ${covered.join(" + ")}` : "not staffed on any line",
            money(salesAcross(code)),
          ],
        };
      })
      .sort((a, b) => b.sales - a.sales)
      .map((row) => row.cells),
    3,
  );

  // ── Every empty seat, line by line, with the money under it ─────────────────────────────────
  for (const line of LINES) {
    const gaps = areaCodes.filter((code) => isGap(seatOf(code, line.label)));
    const sales = gaps.reduce((sum, code) => sum + (cellOf(code, line.label)?.sales ?? 0), 0);
    const target = gaps.reduce((sum, code) => sum + (cellOf(code, line.label)?.target ?? 0), 0);
    console.log(`\n${line.label.toUpperCase()} — ${gaps.length} empty rep seat(s)`);
    table(
      ["area", "region", "who left, and when", `${period} sales EGP`, "target EGP", "achievement"],
      gaps
        .map((code) => {
          const seat = seatOf(code, line.label);
          const cell = cellOf(code, line.label);
          const areaTarget = cell?.target ?? 0;
          return {
            sales: cell?.sales ?? 0,
            cells: [
              seat?.areaName ?? code,
              seat?.regionCode ?? "",
              seat?.lastHolder
                ? `${seat.lastHolder} — ${seat.leftOn ? day(seat.leftOn) : "date not recorded"}`
                : "never filled",
              money(cell?.sales ?? 0),
              areaTarget > 0 ? money(areaTarget) : "—",
              areaTarget > 0 ? pct((cell?.sales ?? 0) / areaTarget) : "—",
            ],
          };
        })
        .sort((a, b) => b.sales - a.sales)
        .map((row) => row.cells),
      3,
    );
    console.log(
      `  the empty seats carry ${money(sales)} EGP against ${target > 0 ? `${money(target)} EGP = ${pct(sales / target)}` : "no target"}.`,
    );
  }

  // ── Per line, how the areas break down ──────────────────────────────────────────────────────
  console.log(`\nHow each line's areas break down, as of ${day(asOf)}`);
  table(
    [
      "line",
      "areas",
      "rep in post",
      "EMPTY seat",
      "covered by another line",
      "not staffed",
      "vacant share of the line's target",
    ],
    LINES.map((line) => {
      const seats = [...(byLine.get(line.label)?.values() ?? [])];
      const gaps = seats.filter((seat) => isGap(seat));
      const vacantTarget = gaps.reduce(
        (sum, seat) => sum + (cellOf(seat.areaCode, line.label)?.target ?? 0),
        0,
      );
      const lineTarget = [...(moneyByLine.get(line.label)?.values() ?? [])].reduce(
        (sum, cell) => sum + (cell.target ?? 0),
        0,
      );
      return [
        line.label,
        String(seats.length),
        String(seats.filter((seat) => inPost(seat)).length),
        String(gaps.length),
        String(seats.filter((seat) => seat.state === "other_line_specific").length),
        String(seats.filter((seat) => seat.state === "other_permanent").length),
        lineTarget > 0 ? pct(vacantTarget / lineTarget) : "—",
      ];
    }),
    1,
  );

  // ── The whole map, for the areas that are not fully staffed ─────────────────────────────────
  const notFullyStaffed = areaCodes.filter((code) =>
    LINES.some((line) => !inPost(seatOf(code, line.label))),
  );
  console.log(
    `\nAll ${notFullyStaffed.length} areas that are not staffed on all three lines (of ${areaCodes.length})`,
  );
  table(
    ["area", "region", ...LINES.map((line) => line.label)],
    notFullyStaffed
      .map((code) => ({
        name: areaName(code),
        cells: [
          areaName(code),
          areaOf(code)?.regionCode ?? "",
          ...LINES.map((line) => seatLabel(seatOf(code, line.label))),
        ],
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((row) => row.cells),
    5,
  );

  const fully = areaCodes.length - notFullyStaffed.length;
  console.log(
    `\n${fully} area(s) have a rep in post on all three lines; ${areaCodes.length - fully} do not.`,
  );
}

await main();
