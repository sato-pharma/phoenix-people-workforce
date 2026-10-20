import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { permissionMatrix, phoenixRoles, scopeForRole, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import { MARKETING_OVERSIGHT_LINE_ROLES } from "../src/lib/sales/access-scope.ts";
import {
  decideClosingDetailsPeriod,
  readsUnpublishedClosings,
  unpublishedClosingMessage,
} from "../src/lib/sales/closing-details-publication-gate.ts";
import { stripComments } from "./support/comment-strip.ts";

// A MONTH REACHES A PORTAL VIEWER ONLY ONCE THE OWNER PUBLISHES IT.
//
// The portal Monthly Closing SCREEN kept that rule; the two APIs behind the same tab did not. Found
// 2026-09-16 while adding Medical Rep to the tab: GET /api/sales/monthly-closing/details opened any
// VALIDATED month for a scoped viewer — and, asked for no month, the newest one, which is usually
// the month still being uploaded — and the scoped branch of POST /api/sales/monthly-closing/export
// downloaded that month's rows with HTTP 200, inside the newest PUBLISHED month's targets.
//
// This test pins all three halves:
//   1. the decision itself, executed: a named unpublished month is REFUSED in plain words, never
//      swapped; no month named opens the newest PUBLISHED month;
//   2. who is gated: everyone but the readers the export's full-workbook branch admits, checked
//      against that branch's own disjunction so the two cannot drift;
//   3. that both routes actually run the gate before a single row is read.

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
}

/** Comment-stripped, so prose describing the gate can never satisfy a pin on the code. */
function code(source: string): string {
  return stripComments(source);
}

export function runClosingDetailsPublicationGateTests() {
  // ── 1. The decision, EXECUTED ────────────────────────────────────────────────────────────────
  // Newest first, exactly as listPublishedPeriodsForLine returns them. September 2026 is validated
  // and still being uploaded; nobody has published it.
  const published = ["2026-08", "2026-07"];

  const september = decideClosingDetailsPeriod({ line: "Pedia", requestedPeriod: "2026-09", publishedPeriods: published });
  assert.equal(
    september.allowed,
    false,
    "a scoped viewer naming an UNPUBLISHED month must be REFUSED — this is the hole: the Details API "
      + "opened any validated month, so every Medical Rep, District, Regional and National Sales Manager, "
      + "Product and Group Product Manager could read a month before the owner released it",
  );
  assert.equal(
    september.allowed ? "" : september.error,
    "The Pedia Monthly Closing for September 2026 has not been published yet, so its details cannot be opened or exported.",
    "the refusal names the line and the month in plain words",
  );
  assert.ok(
    !(september.allowed ? "" : september.error).includes("2026-09"),
    "names, never codes — the viewer reads September 2026, not 2026-09",
  );
  assert.equal(
    decideClosingDetailsPeriod({ line: "Pedia", requestedPeriod: " 2026-09 ", publishedPeriods: published }).allowed,
    false,
    "padding the month must not slip past the gate",
  );

  assert.deepEqual(
    decideClosingDetailsPeriod({ line: "CNS", requestedPeriod: "2026-07", publishedPeriods: published }),
    { allowed: true, period: "2026-07" },
    "an OLDER published month opens as named — never swapped for the newest",
  );
  assert.deepEqual(
    decideClosingDetailsPeriod({ line: "CNS", requestedPeriod: "2026-08", publishedPeriods: published }),
    { allowed: true, period: "2026-08" },
    "a published month opens",
  );

  for (const requestedPeriod of [null, undefined, "", "   "]) {
    assert.deepEqual(
      decideClosingDetailsPeriod({ line: "Anti Infective", requestedPeriod, publishedPeriods: published }),
      { allowed: true, period: "2026-08" },
      `no month named (${JSON.stringify(requestedPeriod)}) opens the newest PUBLISHED month — the standalone `
        + "Details page asks exactly this on first load, and it used to receive the newest VALIDATED one",
    );
  }

  assert.deepEqual(
    decideClosingDetailsPeriod({ line: "Pedia", requestedPeriod: null, publishedPeriods: [] }),
    { allowed: true, period: null },
    "a line with nothing published opens no month at all — an empty answer, never a draft",
  );
  assert.equal(
    decideClosingDetailsPeriod({ line: "Pedia", requestedPeriod: "2026-08", publishedPeriods: [] }).allowed,
    false,
    "and naming a month on a line with nothing published is refused",
  );

  assert.deepEqual(
    decideClosingDetailsPeriod({ line: null, requestedPeriod: "2026-09", publishedPeriods: [] }),
    { allowed: true, period: null },
    "no line to open is not a publication question: no month is opened, and the details service answers "
      + "'outside your access' instead of a misleading 'not published'",
  );

  for (const garbage of ["2026-13", "latest", "<b>2026-09</b>"]) {
    const refused = decideClosingDetailsPeriod({ line: "Pedia", requestedPeriod: garbage, publishedPeriods: published });
    assert.equal(refused.allowed, false, `an unrecognised month (${garbage}) is refused, never defaulted`);
    assert.equal(
      refused.allowed ? "" : refused.error,
      "That month's Pedia Monthly Closing has not been published yet, so its details cannot be opened or exported.",
      `an unrecognised month (${garbage}) is not echoed back to the viewer`,
    );
  }
  assert.equal(
    unpublishedClosingMessage("CNS", "2026-01"),
    "The CNS Monthly Closing for January 2026 has not been published yet, so its details cannot be opened or exported.",
  );

  // ── 2. Who is gated ──────────────────────────────────────────────────────────────────────────
  // The full-scope readers keep every validated month: Finance Manager "including periods that were
  // never published" (owner, 2026-08-10); the Marketing Manager's full workbook is bounded by her own
  // line scope instead.
  for (const role of ["Super Admin", "SFE Manager", "CEO", "Finance Manager", "Marketing Manager"] as const) {
    assert.equal(
      readsUnpublishedClosings({ role, scope: scopeForRole(role) }),
      true,
      `${role} keeps every validated month, published or not — this fix must not narrow that role`,
    );
  }
  assert.equal(
    readsUnpublishedClosings({ role: "Employee", scope: "system" }),
    true,
    "a system-scope actor reads every month, exactly as the export route's full-workbook branch admits it",
  );

  // The scoped portal viewers the owner named, plus the legacy DM alias and the bare Employee seat —
  // both hold sales:read, so both must be gated.
  const gatedRoles: PhoenixRole[] = [
    "Medical Rep",
    "District Manager",
    "Manager",
    "Regional Manager",
    "National Sales Manager",
    "Product Manager",
    "Group Product Manager",
    "Employee",
  ];
  for (const role of gatedRoles) {
    assert.equal(
      readsUnpublishedClosings({ role, scope: scopeForRole(role) }),
      false,
      `${role} must see PUBLISHED months only — the rule the portal Monthly Closing screen already keeps`,
    );
  }

  // FAIL CLOSED: every role that can read sales at all, other than the full-scope readers, is gated —
  // so a role granted sales:read tomorrow does not quietly inherit unpublished months.
  const fullScopeReaders = new Set<string>(["Super Admin", "SFE Manager", "CEO", "Finance Manager", ...MARKETING_OVERSIGHT_LINE_ROLES]);
  for (const role of phoenixRoles) {
    if (!(permissionMatrix[role]?.sales ?? []).includes("read")) continue;
    assert.equal(
      readsUnpublishedClosings({ role, scope: scopeForRole(role) === "system" ? "company" : scopeForRole(role) }),
      fullScopeReaders.has(role),
      `${role} holds sales:read — it reads unpublished months only if the owner put it in the full-scope set`,
    );
  }

  // DRIFT GUARD. The export route's full-workbook disjunction and readsUnpublishedClosings must admit
  // exactly the same readers, or the Details tab and the Export button disagree about who may open an
  // unpublished month. Every term of that `if` is read and accounted for.
  const exportRoute = code(read("app/api/sales/monthly-closing/export/route.ts"));
  const disjunctionAt = exportRoute.indexOf('if (access.role === "Super Admin" || access.scope === "system"');
  assert.ok(disjunctionAt > 0, "the export route's full-workbook disjunction is still where it was");
  const disjunction = exportRoute.slice(disjunctionAt + "if (".length, exportRoute.indexOf(") {", disjunctionAt));
  const branchRoles = new Set<string>();
  for (const term of disjunction.split("||").map((part) => part.trim())) {
    const role = /^access\.role === "([^"]+)"$/.exec(term)?.[1];
    if (role) {
      branchRoles.add(role);
    } else if (term === 'access.scope === "system"') {
      assert.equal(readsUnpublishedClosings({ role: "Employee", scope: "system" }), true, "system scope is admitted in both");
    } else if (term === "marketingOversight !== null") {
      assert.match(
        exportRoute,
        /const marketingOversight = MARKETING_OVERSIGHT_LINE_ROLES\.has\(access\.role\)/,
        "marketingOversight is still keyed on MARKETING_OVERSIGHT_LINE_ROLES — the set readsUnpublishedClosings reads",
      );
      for (const role of MARKETING_OVERSIGHT_LINE_ROLES) branchRoles.add(role);
    } else {
      assert.fail(
        `the full-workbook disjunction gained a term this gate does not understand: ${term}. Decide whether `
          + "those readers keep unpublished months, then teach readsUnpublishedClosings and this test together",
      );
    }
  }
  for (const role of phoenixRoles) {
    assert.equal(
      readsUnpublishedClosings({ role, scope: scopeForRole(role) === "system" ? "company" : scopeForRole(role) }),
      branchRoles.has(role),
      `${role}: the Details gate and the export's full-workbook branch disagree about unpublished months`,
    );
  }

  // ── 3. Both routes run the gate, before a single row is read ─────────────────────────────────
  const detailsRoute = code(read("app/api/sales/monthly-closing/details/route.ts"));
  const detailsGateAt = detailsRoute.indexOf("gateClosingDetailsPeriod(");
  assert.ok(
    detailsGateAt > 0,
    "the Details route must run the publication gate — without it a scoped viewer opens any validated month",
  );
  assert.ok(
    detailsGateAt < detailsRoute.indexOf("loadMonthlyClosingDetails("),
    "the Details route must run the gate BEFORE it reads the rows",
  );
  assert.match(
    detailsRoute,
    /gateClosingDetailsPeriod\(\{ access, line, requestedPeriod, availableLines, includeConfidential \}\)/,
    "the gate is given the same line, lines and confidential flag the row read gets, so both resolve one line",
  );
  assert.match(
    detailsRoute,
    /if \(gate\.kind === "refused"\) \{\s*return NextResponse\.json\(\{ success: false, error: gate\.error \}, \{ status: 403 \}\);/,
    "a refused month answers 403 with the plain-words reason",
  );
  assert.match(
    detailsRoute,
    /period: gate\.kind === "published" \? gate\.period : period,/,
    "a gated viewer's rows come from the month the gate chose — the newest published when none was named",
  );
  assert.match(
    detailsRoute,
    /availablePeriods: gate\.kind === "published" \? gate\.publishedPeriods : availablePeriods,/,
    "a gated viewer's month picker offers published months only",
  );

  const fullBranchReturnAt = exportRoute.indexOf("return fileResponse(buffer, await resolveClosingFileName({", disjunctionAt);
  assert.ok(fullBranchReturnAt > disjunctionAt, "the full-workbook branch still returns its own file");
  const exportGateAt = exportRoute.indexOf("gateClosingDetailsPeriod(");
  assert.ok(
    exportGateAt > fullBranchReturnAt,
    "the export route must gate its SCOPED branch — and only that one: every reader the full-workbook branch "
      + "admits keeps unpublished months",
  );
  assert.equal(
    exportRoute.indexOf("gateClosingDetailsPeriod(", exportGateAt + 1),
    -1,
    "one gate in the export route",
  );
  const scopedLoadAt = exportRoute.indexOf("loadMonthlyClosingDetails(", fullBranchReturnAt);
  assert.ok(
    exportGateAt < scopedLoadAt,
    "the scoped export must run the gate BEFORE it reads the rows — without it an unpublished month's sales "
      + "download with HTTP 200, inside the newest published month's products, targets and Office grid",
  );
  const exportGate = exportRoute.slice(exportGateAt, scopedLoadAt);
  assert.match(exportGate, /line: body\.line \?\? null,/, "the export gate checks the line the row read is given");
  assert.match(exportGate, /requestedPeriod: body\.period \?\? null,/, "the export gate checks the month the row read is given");
  assert.match(
    exportGate,
    /if \(gate\.kind === "refused"\) \{\s*return NextResponse\.json\(\{ success: false, error: gate\.error \}, \{ status: 403 \}\);/,
    "an unpublished month's export answers 403 with the plain-words reason, never a workbook",
  );

  // The gate checks the line the rows would ACTUALLY come from. loadMonthlyClosingDetails swaps a line
  // outside the viewer's scope for the first line inside it, so checking the NAMED line would let a
  // request name a published line and receive an unpublished one.
  const gateModule = code(read("src/lib/sales/closing-details-publication-gate.ts"));
  assert.match(
    gateModule,
    /const \{ line \} = await loadMonthlyClosingDetails\(\{[^}]*period: null,[^}]*\}\);/,
    "the gate resolves the line through the details service itself, asked for no month so no row is read",
  );
  assert.match(gateModule, /listPublishedPeriodsForLine\(line\)/, "published months are read for the RESOLVED line");
  assert.ok(
    !/listPublishedPeriodsForLine\(input\./.test(gateModule),
    "published months must never be read for the line the request merely NAMED",
  );
  assert.ok(
    gateModule.indexOf("if (readsUnpublishedClosings(input.access))") < gateModule.indexOf("loadMonthlyClosingDetails("),
    "a full-scope reader passes before any lookup, so their Details and export are untouched",
  );
  assert.ok(!gateModule.includes("revealSource"), "the gate's line lookup never asks for El Qema's real rows");
}
