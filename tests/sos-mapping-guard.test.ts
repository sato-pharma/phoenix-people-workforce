import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAPPING_GUARD_AUDIENCE,
  MAPPING_GUARD_CHANNELS,
  MAPPING_GUARD_EVENT_TYPE,
  MAPPING_GUARD_URL,
  describeBatch,
  groupHoldsIntoBatches,
  type MappingGuardHold,
} from "../src/lib/sales/mapping-guard.ts";
import {
  DEFAULT_NOTIFICATION_ROLE_POLICIES,
  notificationRoleKeys,
} from "../src/lib/notifications/role-recipients.ts";
import {
  describeMonth,
  formatEgp,
  pickDistributorFacts,
  summarizeHoldSales,
  verdictForSuggestion,
  type HoldDistributorFact,
} from "../src/lib/sales/mapping-guard-hold-shape.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

const ROOT = process.cwd();
const MIGRATION = join(ROOT, "supabase/migrations/20260910230000_sos_mapping_guard.sql");
const PERMIT_FIX = join(ROOT, "supabase/migrations/20260911013000_sos_mapping_guard_permit_not_a_flag.sql");
const CONFIDENCE_FIX = join(ROOT, "supabase/migrations/20260913020000_sos_map_guard_decide_carries_confidence.sql");

/**
 * The hole that was live on production for twenty minutes on 2026-09-11.
 *
 * The first design gated its bypass on `phoenix.map_guard_bypass`, a SESSION SETTING, and claimed in
 * its own comment that only the release function could set it. That was an assumption, never an
 * enforcement: a GUC is something the caller asserts about ITSELF, so any connection able to write
 * the mapping table could switch the guard off for its own transaction. One did, moving 24 customers
 * straight through. All 24 crossed a region and three overwrote a mapping decision of the owner's,
 * so every one would have been held. The log then recorded each as "you approved it", asserting an
 * approval that never happened.
 *
 * Permission is now a PERMIT ROW naming this transaction, this table, this entity and the hold it
 * came from, in a table no role holds a grant on. These assertions exist so the flag cannot return,
 * in the trigger or in the log wording.
 */
function theBypassIsNotSomethingAWriterCanAssertAboutItself() {
  const fix = readFileSync(PERMIT_FIX, "utf8");

  assert.match(fix, /create table if not exists public\.sos_map_guard_permits/,
    "the release path must issue a permit row, not set a flag");
  assert.match(fix, /revoke all on public\.sos_map_guard_permits from service_role/,
    "service_role must be named explicitly — revoking PUBLIC alone leaves the point unmade");
  assert.match(fix, /where p\.txid = txid_current\(\) and p\.table_name = p_table and p\.entity_key = p_entity/,
    "a permit must be scoped to one transaction AND one entity, or it releases more than it was issued for");

  assert.doesNotMatch(fix, /current_setting\('phoenix\.map_guard_bypass'/,
    "reading the bypass flag is the defect; it must not appear in the replacement");
  assert.doesNotMatch(fix, /'you approved it'/,
    "the log said 'you approved it' for 24 changes nobody approved — it now names the hold instead");
  assert.match(fix, /format\('released by hold %s', v_permit\)/,
    "an applied change must name the hold that released it, so a forged release is visible afterwards");

  assert.match(fix, /It does not defend against the table owner, and nothing can/,
    "the migration must state what this does NOT buy, or the next reader over-trusts it again");
}

/**
 * A released ruling that lands at its OLD confidence does not bind.
 *
 * Until 2026-09-13 the release path copied brick, area, region, source and active out of the hold and
 * left confidence and mapped_by at their pre-hold values. An owner ruling binds only at confidence
 * 100, so 214 released rulings sat on the map at null/10/35/56, open to the next automatic remap,
 * until they were repaired by hand. These assertions pin the two columns into the customer-map
 * branch, and pin that the permit scoping around them survived the rewrite.
 */
function aReleasedRulingCarriesItsConfidenceAndAuthor() {
  const sql = readFileSync(CONFIDENCE_FIX, "utf8");
  const start = sql.indexOf("if h.table_name = 'source_of_sales_customer_map' then");
  const end = sql.indexOf("elsif h.table_name = 'source_of_sales_bricks' then");
  assert.ok(start >= 0 && end > start, "the customer-map branch must exist in the replacement");
  const branch = sql.slice(start, end);

  assert.match(branch, /confidence\s+= coalesce\(\(h\.after_json->>'confidence'\)::int, m\.confidence\)/,
    "the hold's confidence must reach the map, or an owner ruling lands below 100 and does not bind");
  assert.match(branch, /mapped_by\s+= coalesce\(h\.after_json->>'mapped_by', m\.mapped_by\)/,
    "the hold's mapped_by must reach the map, or a released batch is stamped unlike every direct write");

  assert.match(sql, /values \(txid_current\(\), h\.table_name, h\.entity_key, h\.id\)/,
    "the permit must stay scoped to this transaction, this table and this entity, naming its hold");
  assert.match(sql, /delete from public\.sos_map_guard_permits where txid = txid_current\(\);/,
    "the permit must be deleted after the write");
  assert.match(sql, /delete from public\.sos_map_guard_permits where issued_at < now\(\) - interval '1 hour';/,
    "stale permits must still be purged");
  assert.doesNotMatch(sql, /map_guard_bypass/, "the session-setting bypass must not return");
  assert.match(sql, /revoke execute on function public\.sos_map_guard_decide\(bigint, text, text\) from public, anon, authenticated;/);
}

function hold(overrides: Partial<MappingGuardHold> & { createdAt: string; writer: string }): MappingGuardHold {
  return {
    after: {},
    before: {},
    entityKey: "IS / 123456",
    id: 1,
    reasons: ["overwrites a mapping decision of yours"],
    tableName: "source_of_sales_customer_map",
    ...overrides,
  };
}

/**
 * The real shape of 2026-09-10: five separate runs against source_of_sales_customer_map, minutes
 * apart, 144 rows between them. The owner chose one message per batch precisely so that day would
 * have produced five messages rather than 144, and this is the assertion that pins it.
 */
function theDayHeAskedForTheGuard(): MappingGuardHold[] {
  const runs = [
    { at: "2026-09-10T18:05:00.000Z", rows: 4, writer: "script (direct database access)" },
    { at: "2026-09-10T19:12:00.000Z", rows: 15, writer: "script (direct database access)" },
    { at: "2026-09-10T20:31:00.000Z", rows: 3, writer: "script (direct database access)" },
    { at: "2026-09-10T21:02:00.000Z", rows: 2, writer: "script (direct database access)" },
    { at: "2026-09-10T22:18:00.000Z", rows: 9, writer: "script (direct database access)" },
  ];
  const holds: MappingGuardHold[] = [];
  let id = 1;
  for (const run of runs) {
    for (let i = 0; i < run.rows; i += 1) {
      holds.push(hold({
        createdAt: new Date(Date.parse(run.at) + i * 1_000).toISOString(),
        id: id++,
        writer: run.writer,
      }));
    }
  }
  return holds;
}

function batchingGroupsOneRunIntoOneMessage() {
  const batches = groupHoldsIntoBatches(theDayHeAskedForTheGuard());
  assert.equal(batches.length, 5, "five runs must produce five messages, not one per row");
  assert.deepEqual(batches.map((b) => b.holds.length), [4, 15, 3, 2, 9]);
}

function twoWritersNeverShareAMessage() {
  const batches = groupHoldsIntoBatches([
    hold({ createdAt: "2026-09-10T18:00:00.000Z", id: 1, writer: "b-10" }),
    hold({ createdAt: "2026-09-10T18:00:30.000Z", id: 2, writer: "postgres (direct database access)" }),
  ]);
  assert.equal(batches.length, 2, "one message naming one writer cannot describe another writer's change");
}

function aGapWiderThanTheWindowSplitsTheBatch() {
  const inside = groupHoldsIntoBatches([
    hold({ createdAt: "2026-09-10T18:00:00.000Z", id: 1, writer: "b-10" }),
    hold({ createdAt: "2026-09-10T18:09:00.000Z", id: 2, writer: "b-10" }),
  ]);
  assert.equal(inside.length, 1, "nine minutes apart is one run");

  const outside = groupHoldsIntoBatches([
    hold({ createdAt: "2026-09-10T18:00:00.000Z", id: 1, writer: "b-10" }),
    hold({ createdAt: "2026-09-10T18:11:00.000Z", id: 2, writer: "b-10" }),
  ]);
  assert.equal(outside.length, 2, "eleven minutes apart is two sittings");
}

/**
 * A region reason names both regions, so grouping on the raw string would print a summary as long
 * as the batch. The DETAIL still has to survive on the row itself.
 */
function regionReasonsAreSummarisedButNotLost() {
  const batch = groupHoldsIntoBatches([
    hold({ createdAt: "2026-09-10T18:00:00.000Z", id: 1, reasons: ["moves the customer from region GZ to OT"], writer: "b-10" }),
    hold({ createdAt: "2026-09-10T18:00:01.000Z", id: 2, reasons: ["moves the customer from region UE to D1"], writer: "b-10" }),
  ])[0];
  assert.deepEqual(batch.reasonCounts, [{ count: 2, reason: "moves the customer to another region" }]);
  const { message } = describeBatch(batch);
  assert.match(message, /from region GZ to OT/, "the row keeps the regions it actually names");
}

function theMessageSpeaksEnglishNotSchema() {
  const { message, title } = describeBatch(groupHoldsIntoBatches(theDayHeAskedForTheGuard())[1]);
  assert.match(title, /15 mapping changes are waiting for you/);
  assert.match(message, /15 customer mappings were about to be re-pointed/);
  assert.doesNotMatch(message, /source_of_sales|brick_id|area_code|_json/, "no table or column names reach him");
  assert.match(message, /Nothing has been changed/, "he must be told the map is unchanged");
}

/** Owner rule since 2026-07-25: operational alerts are in-app, Telegram and push. Never email. */
function theAlertNeverEmails() {
  assert.deepEqual([...MAPPING_GUARD_CHANNELS], ["in_app", "telegram", "push"]);
  assert.ok(!MAPPING_GUARD_CHANNELS.includes("email" as never), "email would double every alert onto his Telegram");
}

function theAudienceIsRegisteredAndIsSuperAdminAlone() {
  assert.ok(
    (notificationRoleKeys as readonly string[]).includes(MAPPING_GUARD_AUDIENCE),
    "an unregistered audience key resolves to nobody, and a guard nobody hears about holds writes in silence",
  );
  const policy = DEFAULT_NOTIFICATION_ROLE_POLICIES[MAPPING_GUARD_AUDIENCE];
  assert.deepEqual(policy.roles, ["Super Admin"], "releasing a hold is an owner decision by construction");
  assert.equal(policy.enabled, true);
}

/**
 * Adding an audience key means filling in every exhaustive Record built on it, and CI caught two
 * this branch had missed. `ignoreBuildErrors` lets a missing key compile, build and DEPLOY, so the
 * type is not the only guard worth having — this reads the registry at runtime.
 */
function everyAudienceKeyIsFullyRegistered() {
  const control = readFileSync(join(ROOT, "src/lib/notifications/email-control-center.ts"), "utf8");
  const modules = control.slice(control.indexOf("const ROLE_RECIPIENTS_MODULE"));
  for (const key of notificationRoleKeys) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(DEFAULT_NOTIFICATION_ROLE_POLICIES, key),
      `${key} has no default policy, so it would resolve to nobody`,
    );
    assert.match(modules.slice(0, 2000), new RegExp(`\\b${key}:`), `${key} is missing from the notification module map`);
  }
}

function theLinkGoesToTheScreenThatCanReleaseAHold() {
  assert.equal(MAPPING_GUARD_URL, "/sales/mapping-guard");
  assert.equal(MAPPING_GUARD_EVENT_TYPE, "sos_mapping_guard_held");
}

/**
 * The four clauses in the migration that carry the whole property. Matched as substrings rather
 * than by byte offset: a pinning test that slices a fixed window false-fails the moment anything
 * above it moves.
 */
function theMigrationKeepsItsLoadBearingClauses() {
  const sql = readFileSync(MIGRATION, "utf8");

  assert.match(
    sql,
    /v_reasons := array_append\(v_reasons, 'overwrites a mapping decision of yours'\)/,
    "array_append, never `|| 'literal'` — that spelling throws malformed array literal the first time a rule fires",
  );
  assert.doesNotMatch(
    sql,
    /v_reasons := v_reasons \|\| '/,
    "the bare-literal append is the bug staging caught; it must not come back",
  );
  assert.match(
    sql,
    /if v_bypass = 'on' then/,
    "the bypass is what separates an approval from a writer claiming to be the owner",
  );
  assert.match(
    sql,
    /perform set_config\('phoenix\.map_guard_bypass', 'on', true\)/,
    "the decide function is the only place that may set the bypass",
  );
  assert.match(
    sql,
    /-- Returning NULL leaves the row exactly as it was\./,
    "a hold must leave the row untouched, not write a partial change",
  );

  // The incoming source is self-asserted. The rule tests OLD.source only, and the scripts that
  // overwrote 15 of his rulings on 2026-09-10 all stamped themselves `owner-...`.
  assert.match(sql, /if old\.source ~ '\^\(owner-\|final-new-\)' or old\.source = 'sheet-verified' then/);
  assert.doesNotMatch(
    sql,
    /new\.source ~ '\^\(owner-/,
    "judging the INCOMING source held nothing at all when it was measured — the writer chooses that string",
  );

  // Without this the guard held 3,666 of 3,702 real edits in one day.
  assert.match(sql, /if not v_moves then/, "a change that moves nothing is not a mapping change");
}

/**
 * The review screen is where a hold is released, so its gate is the guard's own security boundary.
 * Server-side, on the page AND on the route: a hidden sidebar link is UX only.
 */
function theReviewScreenIsGatedOnTheServer() {
  const page = readFileSync(join(ROOT, "app/(admin)/sales/mapping-guard/page.tsx"), "utf8");
  assert.match(page, /await assertPermission\(accessContext, "sales", "import"\)/);
  assert.match(page, /accessContext\.role !== "Super Admin" && accessContext\.scope !== "system"/);

  const route = readFileSync(join(ROOT, "app/api/sales/mapping-guard/decide/route.ts"), "utf8");
  // The narrowing itself, and the permission it rests on, must still be in this file.
  assert.match(route, /await assertPermission\(access, "sales", "import"\)/);
  assert.match(route, /access\.role !== "Super Admin" && access\.scope !== "system"/);
  // Counted at the CALL SITES, not at the comparison. When the route learned to decide a whole
  // selection (2026-10-09) the check moved into one `assertOwnerAccess` both handlers await, and
  // counting the literal comparison then reads 1 for a route that gates twice — which is a pin
  // failing on an improvement. What must never drop below two is the number of handlers that gate.
  assert.match(route, /async function assertOwnerAccess\(request: Request\)/);
  const gates = route.match(/await assertOwnerAccess\(request\)/g) ?? [];
  assert.equal(gates.length, 2, "BOTH the read and the decide must gate, not just one");
  for (const handler of ["GET", "POST"]) {
    const opens = route.indexOf(`export async function ${handler}(request: Request)`);
    assert.ok(opens > 0, `${handler} must exist`);
    assert.match(
      route.slice(opens, opens + 300),
      /assertOwnerAccess\(request\)/,
      `${handler} must gate before it reads or writes anything`,
    );
  }
}

/** Owner's square-edge golden rule. tokens.css still defaults --phx-radius to 4px, so this is measured. */
function theScreenHasNoRoundedCorners() {
  const component = readFileSync(join(ROOT, "src/components/sales/mapping-guard-review.tsx"), "utf8");
  assert.doesNotMatch(component, /\brounded(-|\b)/, "no radius anywhere, including inherited from a sibling");
}

/** Owner's fits-the-screen golden rule: never a horizontal scroll, at desktop and at 375px. */
function theScreenFitsByConstruction() {
  const component = readFileSync(join(ROOT, "src/components/sales/mapping-guard-review.tsx"), "utf8");
  assert.match(component, /<table className="w-full table-fixed/, "a fixed table over percentages, not a scroller");
  assert.match(component, /<colgroup>/);
  assert.doesNotMatch(component, /overflow-x-auto|min-w-\[/, "overflow-x-auto over a min-width floor IS the bug, not the fix");
  assert.match(component, /md:hidden/, "mobile gets cards");
  assert.match(component, /hidden [^"]*md:block/, "the table is desktop only");
}

function theSidebarLinkMatchesTheGate() {
  const nav = readFileSync(join(ROOT, "src/config/system-navigation.ts"), "utf8");
  const entry = nav.slice(nav.indexOf('href: "/sales/mapping-guard"'));
  assert.ok(entry.length > 0, "the screen must be reachable — a page nobody can navigate to is a page nobody uses");

  /*
   * It has to sit in the array the Source of Sales hub actually renders.
   *
   * The first attempt put it in `salesAnalyticsPageItems`, which Ruling 11 deliberately unwired, so
   * the link existed and appeared nowhere. CI caught it, and nothing else would have: the page
   * answered fine by URL. Anchoring on the neighbouring entry is what makes this assertion about
   * being REACHABLE rather than merely about being written down somewhere.
   */
  const hub = nav.slice(nav.indexOf("export const sourceOfSalesPageItems"));
  const hubEnd = hub.indexOf("] as const satisfies");
  assert.ok(
    hub.slice(0, hubEnd).includes('href: "/sales/mapping-guard"'),
    "the entry must live in sourceOfSalesPageItems — salesAnalyticsPageItems is unwired by Ruling 11 and renders nowhere",
  );
  assert.match(
    entry.slice(0, 900),
    /excludedRoles: \["SFE Manager"\]/,
    "the link must not offer the screen to somebody the page will redirect",
  );
}


// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The lock, the money, the distributor's own file and the normalizer's suggestion — 2026-10-09.
//
// Owner, that night, after a district manager found a customer in her closing sheet and gone from
// the next download: "add the lock button and the money on each hold row", then "make me able to
// multi-select and take decision in the multi. And also add the normalizer to recommend and
// suggest", then "add the column that have the address that came with the distributor ... get the
// address, the brick, the government. Very important."
//
// 🔴 WHAT THESE PIN IS THAT A DECISION STICKS. Measured on production the same night: 3,242 holds
// had been allowed and 10 customer holds refused, and NOT ONE of the 186 then pending sat on a row
// an upload could not move again — because Allow wrote the upload's own `sheet-verified` and Keep as
// is wrote nothing to the mapping at all. Only confidence 100 is skipped by
// applyCustomerBrickCorrections. If one of these assertions can be deleted and the suite stays
// green, the screen is back to collecting answers the next monthly upload quietly overrules.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const LOCK_MIGRATION = join(ROOT, "supabase/migrations/20261009234500_sos_map_guard_lock_and_impact.sql");
const DECIDE_ROUTE = join(ROOT, "app/api/sales/mapping-guard/decide/route.ts");
const REVIEW_SCREEN = join(ROOT, "src/components/sales/mapping-guard-review.tsx");
const DETAIL_LOADER = join(ROOT, "src/lib/sales/mapping-guard-detail.ts");
const HOLD_SHAPE = join(ROOT, "src/lib/sales/mapping-guard-hold-shape.ts");
const GUARD_LIB = join(ROOT, "src/lib/sales/mapping-guard.ts");

function theLockStampsAConfidenceAnUploadCannotOverrule() {
  const sql = stripSqlComments(readFileSync(LOCK_MIGRATION, "utf8"));

  // Dropped, not replaced. `create or replace` with a fourth parameter creates a SECOND function,
  // and the 3-argument call already deployed then fails as "function is not unique" — on the one
  // screen whose whole job is taking his decision.
  assert.match(
    sql,
    /drop function if exists public\.sos_map_guard_decide_and_move_sales\(bigint, text, text\);/,
    "the 3-argument wrapper must be dropped, or the overload makes every decision fail as 'not unique'",
  );
  assert.match(
    sql,
    /p_lock\s+boolean default false/,
    "p_lock must default to false, so the 3-argument call in the deployed code keeps resolving until the deploy catches up",
  );
  assert.match(sql, /confidence = 100/, "the lock must stamp confidence 100 — the only value the monthly self-heal skips");
  assert.match(
    sql,
    /'owner-ruling-' \|\| to_char\(now\(\) at time zone 'Africa\/Cairo', 'YYYY-MM-DD'\)/,
    "the locked source must name him and the Cairo date, the way every ruling before it was stamped by hand",
  );
  assert.match(
    sql,
    /if p_lock and v_hold\.table_name = 'source_of_sales_customer_map' then/,
    "only a customer mapping carries a source and a confidence, so only it may be locked",
  );
  // The lock changes neither brick nor area, so sos_map_guard_customer returns early and logs
  // nothing. Without this insert, the one write that makes an answer permanent would be the only
  // mapping write in the system with no record of itself.
  assert.match(
    sql,
    /insert into public\.sos_map_change_log[\s\S]{0,400}you locked this mapping/,
    "a lock must write its own change-log row: the guard's own trigger cannot see it",
  );
  assert.match(
    sql,
    /select \* into v_hold from public\.sos_map_change_holds where id = p_hold_id;[\s\S]{0,400}v_result := public\.sos_map_guard_decide\(/,
    "the hold must be read BEFORE it is decided, or the row to lock can no longer be found",
  );
  assert.match(
    sql,
    /'locked', v_locked/,
    "the answer must say whether it locked, so the screen can tell him when nothing was made final",
  );
}

function theImpactReadsTheLinesItIsGivenAndTheRightValidationState() {
  const sql = stripSqlComments(readFileSync(LOCK_MIGRATION, "utf8"));

  assert.match(sql, /r\.official_line = any\(p_lines\)/, "the tracked lines must arrive as a parameter");
  // ATTRIBUTION_SPLIT_LINES is the one definition of which lines carry money. A copy in SQL is a
  // second definition that nothing keeps in step — and Head Office, which has no price at all,
  // would be one edit away from being added to it.
  assert.doesNotMatch(
    sql,
    /'(CNS|Pedia|Anti Infective|Head Office)'/,
    "no line may be named in this SQL: ATTRIBUTION_SPLIT_LINES is the only definition of which lines carry money",
  );
  assert.match(
    sql,
    /r\.validation_state = 'valid'/,
    "'validated' matches nothing and reads as a customer with no sales — the difference between 'nothing rides on this' and tens of thousands of pounds",
  );
  assert.match(
    sql,
    /group by h\.id, r\.invoice_period, r\.client_name, r\.client_address, r\.brick_id, b\.brick_name,\s+r\.area_name, r\.region_name/,
    "the filed facts must group by the filed VALUES, so two different addresses under one code stay two rows",
  );
  // 🔴 EVERY new or RECREATED security-definer function here must do BOTH halves. Revoking only
  // `anon, authenticated` is a no-op, because both inherit EXECUTE through PUBLIC — the recreated
  // decide function was executable by anon on production for the minutes between the apply and this
  // fix. And revoking PUBLIC on a default ACL strips service_role with it, which is the only role
  // the application ever calls as, so the re-grant is not optional either.
  for (const signature of [
    "public.sos_map_guard_decide_and_move_sales(bigint, text, text, boolean)",
    "public.sos_map_hold_sales_impact(bigint[], text[])",
    "public.sos_map_hold_distributor_facts(bigint[])",
  ]) {
    const escaped = signature.replace(/[.()[\]]/g, (char) => `\\${char}`);
    assert.match(
      sql,
      new RegExp(`revoke execute on function ${escaped}\\s*\\n?\\s*from public, anon, authenticated;`),
      `${signature} must revoke EXECUTE from PUBLIC itself, not just from anon and authenticated`,
    );
    assert.match(
      sql,
      new RegExp(`grant execute on function ${escaped}\\s*\\n?\\s*to service_role;`),
      `${signature} must re-grant service_role, which the PUBLIC revoke strips`,
    );
  }
  assert.doesNotMatch(
    sql,
    /revoke all on function/,
    "`revoke all` passes the migration check but hides which privilege was meant; name EXECUTE",
  );
  const loader = stripComments(readFileSync(DETAIL_LOADER, "utf8"));
  assert.match(
    loader,
    /p_lines: \[\.\.\.TRACKED_IMPACT_LINES\]/,
    "the loader must pass the tracked lines, or the function returns nothing and every hold reads as worth zero",
  );
  assert.match(loader, /ATTRIBUTION_SPLIT_LINES/, "and take them from the one definition, never a list of its own");
}

function aClosedMonthIsCountedAsRestated() {
  const impacts = summarizeHoldSales(
    [
      { holdId: 1, period: "2026-10", rowCount: 2, trackedValue: 100 },
      { holdId: 1, period: "2026-09", rowCount: 3, trackedValue: 51_754.72 },
      { holdId: 1, period: "2026-08", rowCount: 1, trackedValue: 10 },
      { holdId: 2, period: "2026-10", rowCount: 1, trackedValue: 7 },
    ],
    "2026-10",
  );

  const first = impacts.get(1);
  assert.ok(first, "hold 1 must have an impact");
  assert.equal(first.trackedValue, 51_864.72);
  assert.equal(first.rowCount, 6);
  assert.deepEqual(
    first.months.map((month) => month.period),
    ["2026-10", "2026-09", "2026-08"],
    "newest month first, so the row reads the way the sheet he downloads does",
  );
  // THE WHOLE POINT. The current month is still open; everything before it is a month a manager has
  // already downloaded, and releasing the hold re-points those rows to another area.
  assert.equal(first.restatedValue, 51_764.72);
  assert.deepEqual(first.restatedMonths.map((month) => month.period), ["2026-09", "2026-08"]);
  assert.equal(impacts.get(2)?.restatedValue, 0, "a customer that only sold this month restates nothing");
}

function aThirdAnswerIsNeverReadAsAgreement() {
  assert.equal(verdictForSuggestion("B209-1", "B209B-1", "B209-1"), "agrees-with-change");
  assert.equal(
    verdictForSuggestion("b209b-1", "B209B-1", "B209-1"),
    "agrees-with-mapping",
    "the comparison must ignore case: the map holds upper-case brick ids and a suggestion need not",
  );
  // Neither side of the hold. Allow and Keep as is are both wrong here — the most useful thing this
  // column can say, and the easiest to lose by folding it into "does not agree".
  assert.equal(verdictForSuggestion("B13-16", "B209B-1", "B209-1"), "third-answer");
  assert.equal(verdictForSuggestion("", "B209B-1", "B209-1"), "none");
}

function twoAddressesUnderOneCodeStayTwoRows() {
  const fact = (period: string, address: string, rows: number): HoldDistributorFact => ({
    filedAddress: address,
    filedArea: null,
    filedBrickId: null,
    filedBrickName: null,
    filedName: null,
    filedRegion: null,
    lastFiled: null,
    period,
    rowsFiled: rows,
  });

  const picked = pickDistributorFacts([
    fact("2026-07", "El Amria, Alexandria", 4),
    fact("2026-08", "El Amria, Alexandria", 2),
    fact("2026-09", "Tanta, Gharbia", 1),
  ]);

  assert.equal(picked.length, 2, "the same address filed twice is one fact; a different one is its own row");
  assert.equal(picked[0].filedAddress, "Tanta, Gharbia", "newest month first");
  assert.equal(picked[1].rowsFiled, 6, "the repeated address keeps the line count of every month it was filed in");
}

function theMoneyAndTheMonthsAreSpelledOut() {
  assert.equal(formatEgp(34_029.316), "34,029.32 EGP");
  assert.equal(formatEgp(Number.NaN), "0.00 EGP", "a missing figure must read as zero, never as NaN on his screen");
  assert.equal(describeMonth("2026-09"), "September 2026");
  assert.equal(describeMonth("not a period"), "not a period");
  // Standing rules: text wraps, it is never cut with an ellipsis — and a month name asked of the
  // reader's own ICU build renders "Sep" on one browser and "Sept" on another, which React throws
  // the whole server HTML away over (hydration #418).
  const screen = readFileSync(REVIEW_SCREEN, "utf8");
  assert.doesNotMatch(screen, /…/, "nothing on this screen may be shortened with an ellipsis");
  assert.doesNotMatch(
    screen,
    /toLocaleDateString|Intl\.DateTimeFormat/,
    "the client must not format a month or a date itself",
  );
  assert.doesNotMatch(stripComments(screen), /rounded/, "square edges: the screen must not pick up a radius");
}

function oneClickCannotCarryMoreThanTheRouteWillRecord() {
  const route = stripComments(readFileSync(DECIDE_ROUTE, "utf8"));

  assert.match(route, /MAX_HOLDS_PER_REQUEST = 60/, "the bulk ceiling must be explicit");
  assert.match(route, /holdIds\.length > MAX_HOLDS_PER_REQUEST/, "and enforced, not merely documented");
  assert.match(
    route,
    /Array\.isArray\(body\.holdIds\) \? body\.holdIds : \[body\.holdId\]/,
    "the single-hold body must keep working: a page already open when this deploys still sends holdId",
  );
  assert.match(route, /new Set\(requested\.map/, "the same hold sent twice must be decided once");
  assert.match(route, /lock = body\.lock === true/, "the lock must be explicit, never inferred");
  assert.match(route, /decideMappingHolds\(\{ actor: actorOf\(access\), decision, holdIds, lock \}\)/);
  assert.match(route, /failed: outcomes/, "the answers that did not land must be named back to him");
  assert.match(route, /access\.role !== "Super Admin"/, "the server is the boundary: the page narrowing to him is UX");

  // Each hold stands alone on purpose. One transaction would let a single P0001 — the target brick
  // switched off — roll back every answer taken before it in the same click.
  const lib = stripComments(readFileSync(GUARD_LIB, "utf8"));
  assert.match(
    lib,
    /for \(const holdId of input\.holdIds\) \{[\s\S]{0,200}try \{/,
    "the holds must be decided one by one, each failure recorded against its own hold",
  );
  assert.match(lib, /p_lock: input\.lock === true/, "the lock must reach the database function");
}

function theScreenCannotPullTheServerLoaderIntoTheBrowser() {
  const screen = stripComments(readFileSync(REVIEW_SCREEN, "utf8"));

  assert.match(
    screen,
    /from "@\/lib\/sales\/mapping-guard-hold-shape"/,
    "the client must take its types and its formatters from the shape module",
  );
  // mapping-guard-detail.ts reaches the Supabase admin client and the normalizer, which reach
  // node:crypto. Webpack refuses a Node builtin in a client bundle and the dev server then 500s
  // EVERY request — the same split src/lib/sales/weekly/product-units-shape.ts exists for.
  assert.doesNotMatch(
    screen,
    /mapping-guard-detail/,
    "the client component must never import the loader, not even for one formatter",
  );
  const shape = stripComments(readFileSync(HOLD_SHAPE, "utf8"));
  assert.doesNotMatch(
    shape,
    /@\/lib\/supabase|getSupabaseAdmin|from "node:/,
    "the shape module must stay client-safe",
  );
  // The loader must keep failing softly: a hold has to stay decidable when the suggestion pipeline,
  // the money or the filed addresses cannot be read — and before this migration is applied at all.
  const detail = stripComments(readFileSync(DETAIL_LOADER, "utf8"));
  // Each reading catches its OWN failure, by name, so one unreadable panel costs that panel and not
  // the decision. Counted by the logged event, because the shape of the catch has already changed
  // once: a `.catch()` hung on the query builder does not compile at all — Supabase's `.then()`
  // returns a PromiseLike, which has no `.catch` (TS2339, red on this PR's first run), and
  // `.then(ok, onError)` cannot see the error the `ok` handler throws for `result.error`.
  for (const event of [
    "mapping_guard_detail_map_failed",
    "mapping_guard_detail_impact_failed",
    "mapping_guard_detail_filed_failed",
    "mapping_guard_detail_distributors_failed",
    "mapping_guard_detail_suggest_failed",
  ]) {
    assert.match(detail, new RegExp(`event: "${event}"`), `${event} must be logged where it happens`);
  }
  assert.ok(
    (detail.match(/\} catch \(error\) \{/g) ?? []).length >= 4,
    "each reading must catch its own failure rather than taking the whole screen down with it",
  );
  assert.doesNotMatch(
    detail,
    /\)\s*\n?\s*\.catch\(/,
    "a .catch on a Supabase query builder does not compile: its then() returns a PromiseLike",
  );
  assert.match(
    detail,
    /suggestCustomerBricks\(unknowns, \{ ai: false \}\)/,
    "opening this screen must never spend money on the AI or hang waiting on a provider",
  );
}

function theLockIsOnByDefaultAndSaysWhatItDoes() {
  const screen = readFileSync(REVIEW_SCREEN, "utf8");
  const stripped = stripComments(screen);

  assert.match(stripped, /useState\(true\)/, "the lock must start ON: an unlocked answer does not survive the next upload");
  assert.match(
    screen,
    /Lock my answer so no upload can change it again/,
    "the checkbox must say what it does in his own words, not 'lock'",
  );
  assert.match(stripped, /checked=\{lock\}/);
  assert.match(
    stripped,
    /body: JSON\.stringify\(\{ decision, holdIds, lock \}\)/,
    "the lock must be sent with every decision, single or multiple",
  );
  assert.match(
    screen,
    /Nothing was locked, so an upload may propose the same move again/,
    "turning the lock off must be reported back, never silent",
  );
  // Both paths, the same two answers: the whole selection in one click, and any single row on its own.
  assert.match(stripped, /decide\(selectedIds, decision\)/, "the selection must be decidable in one click");
  assert.match(stripped, /decide\(\[hold\.id\], decision\)/, "a single row must still be decidable on its own");
  // One answer used to be one pharmacy, so the moved-sales notice read `brickMoves[0]`. A selection
  // can move several, and the file rebuild must fire if ANY of them left open-month files behind —
  // the alternative is a rebuild that silently skipped pharmacies the screen said it had moved.
  assert.doesNotMatch(stripped, /brickMoves\?\.\[0\]/, "never only the first move of a selection");
  assert.match(
    stripped,
    /if \(moves\.some\(\(\{ move \}\) => move\.pendingFiles > 0\)\) void rebuildMovedFiles\(\);/,
    "every moved pharmacy's files must be rebuilt, not the first one's",
  );
}

export async function runSosMappingGuardTests() {
  theReviewScreenIsGatedOnTheServer();
  theScreenHasNoRoundedCorners();
  theScreenFitsByConstruction();
  theSidebarLinkMatchesTheGate();
  everyAudienceKeyIsFullyRegistered();
  batchingGroupsOneRunIntoOneMessage();
  twoWritersNeverShareAMessage();
  aGapWiderThanTheWindowSplitsTheBatch();
  regionReasonsAreSummarisedButNotLost();
  theMessageSpeaksEnglishNotSchema();
  theAlertNeverEmails();
  theAudienceIsRegisteredAndIsSuperAdminAlone();
  theLinkGoesToTheScreenThatCanReleaseAHold();
  theMigrationKeepsItsLoadBearingClauses();
  theBypassIsNotSomethingAWriterCanAssertAboutItself();
  aReleasedRulingCarriesItsConfidenceAndAuthor();
  theLockStampsAConfidenceAnUploadCannotOverrule();
  theImpactReadsTheLinesItIsGivenAndTheRightValidationState();
  aClosedMonthIsCountedAsRestated();
  aThirdAnswerIsNeverReadAsAgreement();
  twoAddressesUnderOneCodeStayTwoRows();
  theMoneyAndTheMonthsAreSpelledOut();
  oneClickCannotCarryMoreThanTheRouteWillRecord();
  theScreenCannotPullTheServerLoaderIntoTheBrowser();
  theLockIsOnByDefaultAndSaysWhatItDoes();
}
