import assert from "node:assert/strict";

import {
  API_REACHABILITY_BACKLOG,
  API_REACHABILITY_BACKLOG_SIZE,
  API_REACHABILITY_GAP_KINDS,
  apiReverseGuardRecordedRoutes,
} from "./api-reachability-backlog";
import { measureApiCallers, type ApiAuthMode } from "./support/api-caller-census";

/**
 * THE API REVERSE GUARD — a route handler that serves perfectly and that nothing calls.
 *
 * tests/navigation-granted-but-unreachable.test.ts asks this of pages: *which page can a role open
 * that no surface links to?* This asks it of the 1,061 API handlers, and the two fail the same
 * silent way. A forward failure is loud — you click and bounce, you fetch and 404. A reverse failure
 * ships green, deploys cleanly, passes every permission test and is asked for by nobody.
 *
 * Nothing else in this repository could have found these. src/lib/security/access-registry.ts
 * declares every route and CI forces it to stay complete, so it answers *is this route accounted
 * for?* and structurally cannot answer *does anything call it?* — a handler whose caller was deleted
 * keeps its row, its permission and its green check. tests/access-registry-coverage.test.ts closed
 * the other direction in #5481 (a registry pattern naming a route that does not exist); this closes
 * the one left.
 *
 * ## Identity, not a ceiling
 *
 * The live census must equal tests/api-reachability-backlog.ts exactly. A new uncalled handler fails
 * here; a handler that gains a caller also fails here, until its stale row is deleted in the same
 * change. A ceiling would let those two cancel out silently, which is the failure mode the
 * navigation guard had to be upgraded out of.
 *
 * ## Why the external auth modes are excluded mechanically rather than recorded
 *
 * A route whose declared `authMode` is `cron-secret`, `webhook-secret`, `machine-token` or
 * `public-token` is called from outside this repository by definition — the production scheduler at
 * cron-job.org, a provider's webhook, the attendance agent, a share link in somebody's inbox — so
 * having no in-repo caller is its correct state. Recording 26 of those would be noise, and a backlog
 * that is mostly noise stops being read. Only `session` routes are recorded: only a session route
 * needs a browser, and a browser needs a line of code. This mirrors the navigation guard exempting
 * redirect-only stubs mechanically instead of listing them.
 *
 * The floors below exist because this exclusion is load-bearing in both directions. If the authMode
 * reader broke and answered `session` for everything, the identity assertion would blow up with 29
 * surprise routes; if it answered `unknown` for everything, the recorded 40 would vanish and
 * identity would blow up the other way. Either way it fails loudly rather than passing by measuring
 * nothing — which is the one outcome a guard must never have.
 */
export async function runApiGrantedButUncalledTests() {
  const census = measureApiCallers();
  const rows = census.rows;

  const verdictCount = (verdict: string) => rows.filter((row) => row.verdict === verdict).length;
  const uncalled = rows.filter((row) => row.verdict === "no-caller");
  const external = uncalled.filter((row) => row.authMode !== "session" && row.authMode !== "unknown");
  const sessionUncalled = uncalled.filter((row) => row.authMode === "session");

  const byMode = new Map<ApiAuthMode, number>();
  for (const row of uncalled) byMode.set(row.authMode, (byMode.get(row.authMode) ?? 0) + 1);

  console.log(
    [
      `API reverse guard — ${rows.length} route handlers:`,
      `      ${verdictCount("called")} called by a line that names them`,
      `      ${verdictCount("built-url")} reached by a URL built at runtime`,
      `      ${uncalled.length} reached by nothing (${external.length} external by declaration, ` +
        `${sessionUncalled.length} session)`,
      `      uncalled by declared mode: ${[...byMode]
        .sort((a, b) => b[1] - a[1])
        .map(([mode, count]) => `${mode} ${count}`)
        .join(", ")}`,
      `      read ${census.sourceFileCount} source files, ${census.referenceCount} path literals, ` +
        `${census.registryPatternCount} registry patterns`,
    ].join("\n"),
  );

  // ── anti-vacuity: every input this verdict rests on must be non-trivial ─────────────────────
  // Measured 2026-10-08. Floors sit below the real numbers so ordinary growth does not trip them,
  // and far enough above zero that a reader returning nothing cannot pass. A sweep that silently
  // stopped finding path literals would otherwise report every route in the system as an orphan,
  // or — worse, because it is the quiet direction — a sweep that stopped finding ROUTES would
  // report a clean bill of health on an empty measurement.
  assert.ok(rows.length >= 900, `expected 900+ route handlers, read ${rows.length} (1,061)`);
  assert.ok(
    census.sourceFileCount >= 3000,
    `expected 3,000+ source files in the sweep, read ${census.sourceFileCount} (5,195) — a collapse ` +
      `here silently reclassifies called routes as orphans`,
  );
  assert.ok(
    census.referenceCount >= 1000,
    `expected 1,000+ api path literals, read ${census.referenceCount} (1,638)`,
  );
  assert.ok(
    census.registryPatternCount >= 600,
    `expected 600+ access-registry patterns for the authMode lookup, read ${census.registryPatternCount} (812)`,
  );
  assert.ok(
    verdictCount("called") >= 700,
    `expected 700+ routes resolved to an exact call site, got ${verdictCount("called")} (857)`,
  );
  assert.ok(
    verdictCount("built-url") >= 50,
    `expected 50+ routes reached only by a URL built at runtime, got ${verdictCount("built-url")} (138) ` +
      "— this bucket is what keeps callers that build their tail at runtime out of the backlog, so a " +
      "collapse here floods it with false findings",
  );
  // The mechanical exclusion must still be excluding something, or it has stopped being load-bearing
  // and every external-caller route is about to arrive as a surprise finding.
  assert.ok(
    external.length >= 15,
    `expected 15+ uncalled routes to be external by declaration, got ${external.length} (26: 23 ` +
      `cron-secret, 2 public-token, 1 machine-token on 2026-10-08) — if the authMode reader broke, ` +
      `fix it rather than lowering this`,
  );
  assert.equal(
    uncalled.filter((row) => row.authMode === "unknown").length,
    0,
    `every uncalled route must resolve to a declared authMode — an 'unknown' means the registry ` +
      `pattern reader stopped matching, which silently moves routes between the recorded and the ` +
      `mechanically-excluded set`,
  );

  // ── the backlog must itself be well-formed ──────────────────────────────────────────────────
  assert.equal(
    API_REACHABILITY_BACKLOG_SIZE,
    new Set(apiReverseGuardRecordedRoutes()).size,
    "the backlog holds a duplicate route row",
  );
  for (const gap of API_REACHABILITY_BACKLOG) {
    assert.ok(
      API_REACHABILITY_GAP_KINDS.includes(gap.kind),
      `${gap.route} carries an unknown kind ${gap.kind}`,
    );
    assert.ok(
      gap.reason.length >= 60,
      `${gap.route} needs a reason a reader can go and check, not "${gap.reason}"`,
    );
    assert.match(gap.recorded, /^\d{4}-\d{2}-\d{2}$/, `${gap.route} has no recorded date`);
  }

  // ── identity: the live uncalled set must equal exactly what the backlog records ──────────────
  const liveRoutes = sessionUncalled.map((row) => row.route).sort();
  const recorded = [...apiReverseGuardRecordedRoutes()].sort();
  const newlyUncalled = liveRoutes.filter((route) => !recorded.includes(route));
  const nowCalled = recorded.filter((route) => !liveRoutes.includes(route));

  assert.deepEqual(
    liveRoutes,
    recorded,
    `the API reverse guard's live uncalled set no longer matches the recorded backlog.\n` +
      (newlyUncalled.length
        ? `A session-auth handler that serves, is permissioned, and that NOTHING in this repository ` +
          `calls — the finding this guard exists for. Either wire a caller, or record why it has ` +
          `none in tests/api-reachability-backlog.ts:\n  ${newlyUncalled.join("\n  ")}\n` +
          `(If it IS called and the sweep cannot see it, that is a gap in ` +
          `tests/support/api-caller-census.ts — its header lists the seven call shapes that have ` +
          `already fooled it. Teach the census, do not record a route that works.)\n`
        : "") +
      (nowCalled.length
        ? `No longer uncalled — good news, a handler gained a caller or was removed. Delete each ` +
          `stale row from tests/api-reachability-backlog.ts:\n  ${nowCalled.join("\n  ")}\n`
        : ""),
  );
}
