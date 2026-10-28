import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Per-rep counters (spec E1) — the deterrence half of the Direct Orders design.
//
// Everything else built for this module makes a phantom pharmacy hard to CREATE. These counters
// make the PATTERN visible: who keeps parking orders on pharmacies the master has never heard of,
// who lets them rot until the 14-day clock kills them, and who is shown the customer they meant and
// files "it is new" anyway.
//
// Supabase-bound, so this pins the properties that would fail quietly rather than loudly:
// the scope rule is borrowed not re-implemented, the sort surfaces money rather than alphabet, and
// an empty table says so in words instead of rendering as a zero.
// ─────────────────────────────────────────────────────────────────────────────

export function runDirectOrderRepCountersTests() {
  const source = readFileSync(new URL("../src/lib/direct-orders/rep-counters.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
  const registry = readFileSync(new URL("../src/lib/security/access-registry.ts", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/direct-orders/rep-counters/route.ts", import.meta.url), "utf8");

  // ── THE HEADLINE: scope is borrowed, never re-implemented ────────────────────────────────
  // A second copy of a visibility rule is precisely how `reverse` became reachable by every rep in
  // the company (audit C6.2 / F5). If these counters grow their own subtree logic, a manager will
  // eventually see numbers for people who are not theirs — silently, because a counter table has no
  // way to look wrong.
  assert.match(
    source,
    /import \{\s*resolveDirectOrderReportScope,\s*resolveVisibleRequesterHrIds,\s*\} from "@\/lib\/direct-orders\/service"/,
    "the counters must borrow BOTH scope helpers from the service — never re-derive who reports to whom",
  );
  assert.match(
    service,
    /export async function resolveVisibleRequesterHrIds\(/,
    "resolveVisibleRequesterHrIds must stay exported; the counters depend on the one definition",
  );
  assert.doesNotMatch(
    source,
    /managerHrId|children\.set|getEmployeeDirectory/,
    "SECOND COPY OF THE SUBTREE RULE: the counters must not walk the org chart themselves",
  );

  // Company-wide only for the `all` scope; everyone else is filtered to their visible set.
  assert.match(
    source,
    /const companyWide = scope === "all";\s*\n\s*const visible = companyWide \? null : await resolveVisibleRequesterHrIds\(access\);/,
    "only the `all` scope may skip the filter — every other viewer is restricted to their subtree",
  );
  assert.match(
    source,
    /if \(!inScope\(hrId\)\) continue;/,
    "every counted row must pass the scope filter",
  );

  // ── Read-only: this computes, it never writes ────────────────────────────────────────────
  // A deterrence number that can be edited is not a deterrence number.
  for (const forbidden of [".insert(", ".update(", ".delete(", ".upsert("]) {
    assert.ok(
      !source.includes(forbidden),
      `the counters must never write (${forbidden} found) — a number someone can edit deters nobody`,
    );
  }

  // ── Sorted by money, not alphabet ────────────────────────────────────────────────────────
  //
  // This used to pin `b.heldValue - a.heldValue`. On 2026-08-05 twelve pharmacies were
  // rejected and every held value went to zero, so that sort silently degraded to alphabetical at
  // exactly the moment the table was most worth reading. "Money at risk" now means parked PLUS
  // rejected, and the second assertion below stops that definition quietly narrowing again.
  assert.match(
    source,
    /atRisk\(b\) - atRisk\(a\) \|\|[\s\S]{0,180}?b\.matchedExisting - a\.matchedExisting/,
    "worst first: value at risk, then matched-existing. Alphabetical order buries what this table exists to surface",
  );
  assert.match(
    source,
    /const atRisk = \(r: DirectOrderRepCounters\) => r\.heldValue \+ r\.ordersRejectedValue;/,
    "money at risk must include orders on rejected pharmacies, or a fully cleaned-up module sorts as if nothing ever happened",
  );

  // ── Empty must speak ─────────────────────────────────────────────────────────────────────
  // Today's own lesson: "zero validation requests" read as reps ignoring the process, when in fact
  // they had never been shown a button. An empty table that renders as a zero repeats that mistake.
  assert.match(source, /emptyReason: string \| null/, "the result must carry a reason it is empty");
  assert.match(
    source,
    /emptyReason = companyWide[\s\S]{0,240}?Nobody in your team/,
    "the empty message must differ for a company-wide viewer and a scoped one — they mean different things",
  );

  // ── The deterrence signal is actually counted ────────────────────────────────────────────
  assert.match(
    source,
    /if \(String\(row\.status\) === "matched_existing"\) rep\.matchedExisting \+= 1;/,
    "matched_existing is THE signal: the rep swore it was new and it existed all along",
  );
  assert.match(
    source,
    /if \(row\.suggestions_refused === true\) rep\.suggestionsRefused \+= 1;/,
    "refused suggestions must be counted — Phoenix showed the match and the rep proceeded anyway",
  );

  // ── Names, never raw codes (owner's standing rule) ───────────────────────────────────────
  assert.match(
    source,
    /\(unknown — \$\{hrId\}\)/,
    "an unresolvable rep must be flagged as unknown, not silently shown as a bare HR id dressed up as a name",
  );

  // ── The route must be declared, and must be read-only ────────────────────────────────────
  // A route missing from the access registry fails CI — but stating it here names WHY it matters.
  assert.match(
    registry,
    /pattern: "\/api\/direct-orders\/rep-counters", permission: \{ resource: "direct_orders", action: "read" \}/,
    "the endpoint must be declared in the access registry with a read permission",
  );
  assert.doesNotMatch(route, /export async function (POST|PATCH|PUT|DELETE)/, "the counters endpoint must be GET-only");

  // ── The page must be REACHABLE ───────────────────────────────────────────────────────────
  // This is the exact bug fixed in #1762: PharmacyValidationCapture existed, worked, and was
  // rendered on a route no rep could reach. The symptom was silence — zero submissions — which read
  // as people ignoring the feature. A counters page with no nav entry fails the same way.
  const nav = readFileSync(new URL("../src/config/system-navigation.ts", import.meta.url), "utf8");
  assert.match(
    nav,
    /href: "\/admin\/direct-orders\/rep-counters"/,
    "UNREACHABLE PAGE: the counters page must have a navigation entry, or nobody will ever open it",
  );
  // Wider than the Super-Admin-only desks on purpose: the managers who can ACT on these numbers
  // must be able to see them, and the service already scopes each viewer to their own subtree.
  const navEntry = nav.slice(nav.indexOf('href: "/admin/direct-orders/rep-counters"'));
  const rolesLine = navEntry.slice(0, navEntry.indexOf("},"));
  for (const role of ["District Manager", "Regional Manager", "National Sales Manager", "CEO"]) {
    assert.ok(
      rolesLine.includes(`"${role}"`),
      `${role} must be able to open the counters page — the numbers are useless to whoever cannot see them`,
    );
  }

  // ── Owner's UI rules ─────────────────────────────────────────────────────────────────────
  const ui = readFileSync(
    new URL("../src/components/direct-orders/rep-counters-table.tsx", import.meta.url),
    "utf8",
  );
  // Desktop tables, mobile cards — never a table on a phone.
  assert.match(ui, /<PortalDesktopTable/, "the full table must be desktop-only (PortalDesktopTable shows from md up)");
  assert.match(ui, /<PortalResponsiveDataList/, "mobile must get cards, never the table");
  assert.match(ui, /<colgroup>/, "the table is table-fixed with a colgroup, so it fits the screen");
  assert.doesNotMatch(ui, /overflow-x-auto|min-w-\[|whitespace-nowrap/, "no sideways scroll, no nowrap cell");
  // No truncation, no wrapping.
  assert.doesNotMatch(ui, /truncate|text-ellipsis|line-clamp/, "the owner's rule: never truncate with an ellipsis");
  // An empty result must explain itself rather than render as a row of zeros.
  assert.match(
    ui,
    /if \(emptyReason\) \{/,
    "an empty result must render its reason in words, not an empty grid that looks like a zero",
  );
}
