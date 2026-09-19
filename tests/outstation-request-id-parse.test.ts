import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseOutstationRequestId } from "../src/lib/outstation/request-id.ts";
import { outstationRequestIdFromTripId } from "../src/lib/outstation/expense-approval-decisions.ts";

/** Every route.ts under a dynamic `[…]` segment of the two outstation API trees. */
function outstationDynamicRoutes(): string[] {
  const found: string[] = [];
  for (const root of ["app/api/outstation", "app/api/admin/outstation"]) {
    for (const entry of readdirSync(root, { recursive: true }) as string[]) {
      const file = path.posix.join(root, entry.split(path.sep).join("/"));
      if (file.endsWith("/route.ts") && /\/\[[^/\]]+\]\//.test(file)) found.push(file);
    }
  }
  return found.sort();
}

// The one `[id]` route that is NOT a numeric outstation id: a payroll expense report is keyed by
// its own string id, so it keeps its own "missing_report" check.
const STRING_ID_ROUTES = new Set(["app/api/admin/outstation/expenses/reports/[id]/route.ts"]);

export function runOutstationRequestIdParseTests() {
  // ── The parser: a positive safe integer in plain digits, nothing else (audit F-29) ──────────
  for (const [raw, expected] of [
    ["1", 1],
    ["48", 48],
    ["0048", 48],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    [7, 7],
  ] as const) {
    assert.equal(parseOutstationRequestId(raw), expected, `${JSON.stringify(raw)} is the request id ${expected}`);
  }
  // Every one of these passed the old `Number.isFinite(Number(rawId))` check.
  for (const raw of ["1.5", "1e2", "0x10", "-3", "+3", "", " 4", "4 ", "0", "Infinity", "9007199254740993", 1.5, -1, 0]) {
    assert.equal(
      parseOutstationRequestId(raw),
      null,
      `${JSON.stringify(raw)} is not a request id — Number.isFinite let it through to the database`,
    );
  }
  for (const raw of [null, undefined, {}, [], true]) {
    assert.equal(parseOutstationRequestId(raw), null, `${String(raw)} is not a request id`);
  }

  // The trip-id parser shares the rule rather than keeping its own copy.
  assert.equal(outstationRequestIdFromTripId("OUTSTATION-48"), 48);
  assert.equal(outstationRequestIdFromTripId("OUTSTATION-1.5"), null, "a trip id suffix obeys the same rule");
  assert.equal(outstationRequestIdFromTripId("OUTSTATION-1e2"), null, "a trip id suffix obeys the same rule");

  // ── Every outstation `[id]` route parses through it ─────────────────────────────────────────
  const routes = outstationDynamicRoutes();
  // Vacuity guard: if the trees move or the walk breaks, the sweep below would pass on nothing.
  assert.ok(routes.length >= 12, `expected at least 12 dynamic outstation routes, found ${routes.length}`);
  assert.ok(
    routes.includes("app/api/admin/outstation/[id]/route.ts"),
    "the walk must reach the admin decision route — it is reading the wrong tree",
  );

  for (const file of routes) {
    if (STRING_ID_ROUTES.has(file)) continue;
    const source = readFileSync(file, "utf8");
    assert.match(
      source,
      /import \{ parseOutstationRequestId \} from "@\/lib\/outstation\/request-id";/,
      `${file} must parse its id with parseOutstationRequestId`,
    );
    assert.doesNotMatch(
      source,
      /Number\(rawId\)|Number\.isFinite\((id|requestId)\)/,
      `${file} must not accept any finite Number() as an id — 1.5, 1e2 and "" all pass that`,
    );
  }
}
