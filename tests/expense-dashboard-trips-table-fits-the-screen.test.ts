import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/**
 * The Expense Dashboard's trip ledger ("Detailed Trip Table"), pinned against the owner's
 * FITS-THE-SCREEN golden rule (AGENTS.md §4): never a horizontal scroll, always mobile AND desktop
 * friendly, and `overflow-x-auto` over a `min-width` floor IS the bug rather than the fix.
 *
 * It was exactly that: `<PortalDesktopTable minWidth="1160px">` — a `hidden overflow-x-auto
 * md:block` wrapper around twelve columns (TripID, Employee, Date, Type, From, To, Total, KM,
 * Status, Transport, Extra Tickets, Details), most of them `whitespace-nowrap`. Measured
 * 2026-09-21 in the browser as a District Manager on /employee-portals/expense-dashboard:
 *
 *     1280px viewport   table 1160px in a 1054px wrapper   main.scrollWidth 1157 vs 1096
 *      768px viewport   table 1160px in a  679px wrapper   main.scrollWidth 1156 vs  721
 *
 * Dropping the min-width alone still left main at 1121: the nowrap cells' own min-content was
 * wider than the box. The fix is table-fixed over a colgroup, twelve columns MERGED into seven —
 * Type under the trip ID, From over To, KM under Total, Transport and the extra-ticket count
 * under Status — and every value allowed to wrap. Nothing shrunk, nothing cut with an ellipsis.
 *
 * THE WIDTH THAT MATTERS IS 679px, NOT 1054: the desktop table shows from the `md` breakpoint, so
 * a 768px viewport is the narrowest box it must fit. Adding an eighth column takes the flexible
 * columns (trip ID, employee, route) below their longest words there. Merge into a column instead.
 *
 * The map card's decorative blurred circle (`absolute -right-16 -top-20`) was suspected too. It
 * is not a cause: hiding it moved main.scrollWidth by 0px, because its own parent and the card
 * both clip. Section 6 keeps that clipping in place.
 */

const DASHBOARD = "src/components/employee-portal/personal-expense-workload-dashboard.tsx";
const HEATMAP = "src/components/outstation/expense-heatmap-layer.tsx";

function classTokensOf(block: string) {
  const values = [
    ...[...block.matchAll(/className="([^"]*)"/g)].map((m) => m[1]),
    ...[...block.matchAll(/className=\{`([^`]*)`\}/g)].map((m) => m[1]),
  ];
  return new Set(values.flatMap((value) => value.split(/\s+/)).filter(Boolean));
}

export function runExpenseDashboardTripsTableFitsTheScreenTests() {
  const source = readFileSync(DASHBOARD, "utf8");

  // The desktop half of the trip ledger, between its own two markers. Anchored on JSX comments
  // rather than a byte window, so the rest of this 2,400-line file can move freely.
  const start = source.indexOf("{/* ---- Trip Ledger ---- */}");
  const end = source.indexOf("{/* Mobile / narrow tablet stacked cards");
  assert.ok(
    start >= 0 && end > start,
    `${DASHBOARD}: could not find the trip ledger between its "Trip Ledger" and "Mobile / narrow ` +
      `tablet stacked cards" markers — has the section been restructured?`,
  );
  const ledger = source.slice(start, end);
  const tokens = classTokensOf(ledger);

  // 1. No scrolling wrapper and no width floor. PortalDesktopTable IS that wrapper
  //    (`hidden overflow-x-auto md:block` + an inline min-width), so it may not come back here.
  assert.ok(
    !ledger.includes("<PortalDesktopTable") && !/minWidth=/.test(ledger),
    `${DASHBOARD}: the trip ledger is back inside PortalDesktopTable / a minWidth. That wrapper is ` +
      `"overflow-x-auto" over a min-width floor — the table measured 1160px in a 1054px box at a ` +
      `1280px viewport. Fit by MERGING columns instead.`,
  );
  assert.ok(
    !tokens.has("overflow-x-auto") && ![...tokens].some((token) => token.startsWith("min-w-[")),
    `${DASHBOARD}: the trip ledger carries "overflow-x-auto" or a "min-w-[…]" floor again.`,
  );

  // 2. The table is fixed-layout and full width.
  const table = ledger.match(/<table className="([^"]*)"/);
  assert.ok(table, `${DASHBOARD}: could not find the trip ledger's desktop <table>.`);
  const tableClasses = table[1].split(/\s+/);
  assert.ok(
    tableClasses.includes("table-fixed") && tableClasses.includes("w-full"),
    `${DASHBOARD}: the trip table is "${table[1]}" — it needs "w-full table-fixed". Without ` +
      `table-fixed the columns size to their content and the widest row decides the width again.`,
  );

  // 3. One <col> per header cell, seven of each. The percentages must leave room for the one auto
  //    column (the employee) and the fixed chevron column, or table-fixed widens the table past
  //    its box — table-fixed takes the LARGER of its width and the sum of its columns.
  const colgroup = ledger.match(/<colgroup>\s*((?:<col(?: className="[^"]*")? \/>\s*)+)<\/colgroup>/);
  assert.ok(colgroup, `${DASHBOARD}: the trip table has no <colgroup> of plain <col /> entries.`);
  const cols = [...colgroup[1].matchAll(/<col(?: className="([^"]*)")? \/>/g)].map((m) => m[1] ?? "");
  assert.equal(
    cols.length,
    7,
    `${DASHBOARD}: the colgroup declares ${cols.length} columns, expected 7. An eighth column takes ` +
      `the trip ID, employee and route below their longest words in the 679px box a 768px ` +
      `viewport leaves. Merge into an existing column rather than adding one.`,
  );
  const percentages = cols
    .map((value) => value.match(/^w-\[(\d+(?:\.\d+)?)%\]$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => Number(match[1]));
  const autoColumns = cols.filter((value) => value === "").length;
  assert.equal(autoColumns, 1, `${DASHBOARD}: expected exactly one auto <col /> (the employee column).`);
  const percentTotal = percentages.reduce((sum, width) => sum + width, 0);
  assert.ok(
    percentages.length === 5 && percentTotal <= 80,
    `${DASHBOARD}: the percentage columns ${JSON.stringify(percentages)} total ${percentTotal}%. ` +
      `They must stay at or under 80% so the auto employee column and the 2.5rem chevron column ` +
      `still fit; over that, table-fixed grows the table past its wrapper.`,
  );

  const thead = ledger.match(/<thead[^>]*>([\s\S]*?)<\/thead>/);
  assert.ok(thead, `${DASHBOARD}: could not find the trip table's <thead>.`);
  const headerCells = [...thead[1].matchAll(/<th\b/g)].length;
  assert.equal(
    headerCells,
    cols.length,
    `${DASHBOARD}: ${headerCells} header cells against ${cols.length} <col> entries. They must ` +
      `agree, or every column after the mismatch is sized by the wrong <col>.`,
  );

  // 4. Every full-width row spans exactly the seven columns: the empty state, the expanded detail
  //    row, and the footer (label + total cell + trailing span).
  const spans = [...ledger.matchAll(/colSpan=\{(\d+)\}/g)].map((m) => Number(m[1]));
  assert.deepEqual(
    spans,
    [7, 7, 4, 2],
    `${DASHBOARD}: the trip table's colSpans are ${JSON.stringify(spans)}; expected [7, 7, 4, 2] ` +
      `(empty row, expanded row, footer label, footer tail — the footer's total cell is the 5th). ` +
      `A stale 12 from the old layout would make those rows wider than the table.`,
  );

  // 5. Values wrap. Re-adding `whitespace-nowrap` to any cell is what kept main at 1121px even
  //    with the min-width gone; the one unbreakable token (the trip ID) needs "break-words".
  assert.ok(
    !tokens.has("whitespace-nowrap"),
    `${DASHBOARD}: "whitespace-nowrap" is back in the trip ledger. In a table-fixed cell it runs ` +
      `the value out of its own column — which no wrapper-level measurement shows you.`,
  );
  const tripIdLine = ledger.match(/<span className="([^"]*)">\s*\{trip\.tripId \|\| "—"\}\s*<\/span>/);
  assert.ok(tripIdLine, `${DASHBOARD}: could not find the desktop trip-ID line ({trip.tripId || "—"}).`);
  assert.ok(
    tripIdLine[1].split(/\s+/).includes("break-words"),
    `${DASHBOARD}: the trip-ID line is "${tripIdLine[1]}" — it lost "break-words".`,
  );

  // 6. The ellipsis ban, which wrapping does not weaken (AGENTS.md §4).
  for (const banned of ["truncate", "text-ellipsis"]) {
    assert.ok(!tokens.has(banned), `${DASHBOARD}: "${banned}" is in the trip ledger. Let it wrap.`);
  }

  // 7. Nothing was dropped in the merge: every column the old table showed still renders.
  for (const [what, needle] of [
    ["trip ID", "{trip.tripId || \"—\"}"],
    ["employee", "{trip.ownerName || \"Employee\"}"],
    ["type", "{trip.requestType || \"—\"}"],
    ["from", "{trip.fromCity || \"—\"}"],
    ["to", "{trip.toCity || \"—\"}"],
    ["total", "{formatMoney(trip.total)}"],
    ["km", "{formatKm(trip.km)}"],
    ["status", "<StatusPill category={category} />"],
    ["transport", "{trip.transportationType || \"—\"}"],
    ["extra tickets", "ticketCountsByRequestId?.[requestId]"],
  ] as const) {
    assert.ok(ledger.includes(needle), `${DASHBOARD}: the trip table no longer renders the ${what} (${needle}).`);
  }

  // 7b. The opened panel is the row's own (TableRowDetail), never a hand-written second row, and
  //     the row names the panel it controls. Filler is a dash, never "N/A".
  assert.ok(
    ledger.includes("<TableRowDetail") && ledger.includes("rowDetailToggleProps(") && !ledger.includes("N/A"),
    `${DASHBOARD}: the opened trip panel must be a TableRowDetail opened by a row carrying rowDetailToggleProps, with no "N/A" filler.`,
  );

  // 8. The map card's blurred circle stays clipped by its own parent, so it can never widen main.
  const heatmap = readFileSync(HEATMAP, "utf8");
  const circle = heatmap.indexOf("pointer-events-none absolute -right-16 -top-20");
  assert.ok(circle >= 0, `${HEATMAP}: could not find the decorative blurred circle.`);
  const openers = [...heatmap.slice(0, circle).matchAll(/<div\s+className="([^"]*)"/g)];
  const parentClasses = openers.at(-1)?.[1].split(/\s+/) ?? [];
  assert.ok(
    parentClasses.includes("relative") && parentClasses.includes("overflow-hidden"),
    `${HEATMAP}: the blurred circle's parent is "${parentClasses.join(" ")}" — it must stay ` +
      `"relative overflow-hidden". It sits 64px past its parent's right edge by design; only that ` +
      `clip keeps it from widening the page.`,
  );

  // Nothing on an Expenses or outstation screen is drawn below 11px ("raise the expenses and outstation screens'
  // fonts too", owner, 2026-11-09). Every .tsx under src/components/outstation is read, so a new screen is held to
  // it as well.
  let expenseScreens = 0;
  for (const entry of readdirSync("src/components/outstation", { recursive: true, encoding: "utf8" })) {
    if (!entry.endsWith(".tsx")) continue;
    const file = `src/components/outstation/${entry.replace(/\\/g, "/")}`;
    expenseScreens++;
    assert.ok(!/text-phx-(?:2xs|3xs|4xs)\b|text-\[(?:[1-9]|10)px\]/.test(readFileSync(file, "utf8")), `${file}: no text below 11px on an Expenses screen`);
  }
  assert.ok(expenseScreens >= 60, `the floor read every Expenses screen (${expenseScreens})`);
}
