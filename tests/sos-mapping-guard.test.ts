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

const ROOT = process.cwd();
const MIGRATION = join(ROOT, "supabase/migrations/20260910230000_sos_mapping_guard.sql");
const PERMIT_FIX = join(ROOT, "supabase/migrations/20260911013000_sos_mapping_guard_permit_not_a_flag.sql");

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
  const gates = route.match(/access\.role !== "Super Admin" && access\.scope !== "system"/g) ?? [];
  assert.equal(gates.length, 2, "BOTH the read and the decide must narrow to Super Admin, not just one");
  const permissions = route.match(/await assertPermission\(access, "sales", "import"\)/g) ?? [];
  assert.equal(permissions.length, 2, "every handler asserts before it acts");
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
}
