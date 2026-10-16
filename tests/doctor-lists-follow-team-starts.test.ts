import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripSqlComments } from "./support/comment-strip.ts";
import { lastDefinerRaw, liveFunctionBody } from "./support/sql-definer.ts";

// A doctor list follows ITS OWN TEAM'S Phoenix CRM start, not one global cutover date.
//
// WHY THIS IS PINNED. Delta (1) has been counted from Phoenix CRM since 3 October (owner, 2026-10-02),
// and the list machinery never learned about it — both halves still asked the GLOBAL
// `crm_cutover.cutover_date`, which is NULL on production and which a per-team start never sets. The two
// halves then failed in OPPOSITE directions, which is why one migration fixes both:
//
//   * crm_contact_list_change_apply FAILED CLOSED — `if v_cutover is null or v_today < v_cutover then
//     raise`. With the date unset it refused EVERY change for everyone. Measured on production
//     2026-10-04: crm_contact_list_changes held 0 rows and never held one.
//   * crm_contact_master_refresh FAILED OPEN — `coalesce(cairo_today < cutover_date, true)` is TRUE when
//     the date is NULL, so the hourly rebuild kept running the vendor passes for a started team.
//
// Lifting only the refusal hands a manager a change the next hourly run silently undoes; fixing only the
// rebuild leaves the feature dead. CI never sees the database, so this reads the migration's own text.
//
// Rehearsed on staging 2026-10-04 (same shape as production: 3 team starts, 17 started reps). The break
// test that matters ran BOTH cases in ONE refresh: a removal for B-158, whose team started, stayed
// removed (0 open rows), while the same run re-opened the identical removal for B-15, whose team has
// not (1 open row). A guard that merely disabled the pass would have left B-15's removed too.

const MIGRATION = "supabase/migrations/20261004120000_doctor_lists_follow_each_team_start.sql";
/** The migration that re-emitted the apply function to neutralise ONE WORD of its refusal (2026-10-06).
 *  It is NOT the last definer any more — 20261007200000 is — so the live body comes from
 *  liveFunctionBody(), and this path is read only to prove that re-emission changed nothing else. */
const NEUTRAL_MIGRATION = "supabase/migrations/20261006185533_crm_contact_list_refusal_neutral.sql";

/** The started-rep test, as every assignment pass must spell it: `not (` the rep's hr id is in the started
 *  keys, or his row carries no hr id and his agent id is in the started ids `)`. It used to be an anti-join
 *  against the temp table, which no join method could hash (an OR of two conditions) — a nested loop of
 *  12,142 open assignments by 56 started reps, 1.2 s a run (20261016233000). The reps are read into two
 *  arrays once; the test is the same two conditions. */
const STARTED_GUARD =
  /not \(\s*\(nullif\(btrim\((\w)\.agent_hr_id\), ''\) is not null and lower\(btrim\(\1\.agent_hr_id\)\) = any \(v_started_keys\)\)\s*or \(nullif\(btrim\(\1\.agent_hr_id\), ''\) is null and \1\.agent_crm_id is not null\s*and \1\.agent_crm_id = any \(v_started_crm_ids\)\)\s*\)/;

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** One exported TypeScript function, from its signature to the next top-level export. */
function tsBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

/** One `create or replace function` statement, from its header to its `$function$;` terminator. */
function functionBody(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} must be redefined by ${MIGRATION}`);
  const end = sql.indexOf("$function$;", start);
  assert.ok(end > start, `${name} must be closed with $function$;`);
  return sql.slice(start, end + "$function$;".length);
}

/**
 * The four assignment passes, split on the statement each one starts with. They are the only places a
 * started rep's list can be discarded, closed, touched or re-opened.
 */
function assignmentPasses(refresh: string): Record<string, string> {
  const marks: Array<[string, string]> = [
    ["discard", "delete from public.crm_contact_assignments a"],
    ["close", "update public.crm_contact_assignments a\n     set effective_to = greatest("],
    ["touch", "update public.crm_contact_assignments a\n     set last_seen_on = greatest("],
    ["open", "insert into public.crm_contact_assignments (\n    contact_crm_id, agent_crm_id, agent_hr_id, list_type, grade, effective_from, last_seen_on\n  )"],
  ];
  const found = marks.map(([name, needle]) => {
    const at = refresh.indexOf(needle);
    assert.ok(at >= 0, `the ${name} pass must still be one statement starting "${needle.slice(0, 48)}…"`);
    return [name, at] as const;
  });
  const ordered = [...found].sort((a, b) => a[1] - b[1]);
  const out: Record<string, string> = {};
  for (let i = 0; i < ordered.length; i += 1) {
    const [name, at] = ordered[i];
    const next = i + 1 < ordered.length ? ordered[i + 1][1] : refresh.length;
    out[name] = refresh.slice(at, next);
  }
  return out;
}

export function runDoctorListsFollowTeamStartsTests() {
  const sql = stripSqlComments(read(MIGRATION));

  // ── 1. Both halves move together, in one migration ────────────────────────────────────────────
  // THIS migration's own two bodies, which is what section 6 measures. Everything after section 1 reads
  // the LIVE definers instead: a pin naming a path keeps reading that file after a later migration has
  // replaced the function, so it stays green while the database does the opposite of what it asserts.
  // Both halves have been redefined since — the apply function by 20261006185533, both of them by
  // 20261007200000 — so a pin left on MIGRATION would now be asserting about SQL nothing runs.
  const applyHere = functionBody(sql, "crm_contact_list_change_apply");
  const refreshHere = functionBody(sql, "crm_contact_master_refresh");
  assert.ok(
    applyHere.length > 0 && refreshHere.length > 0,
    "one migration redefines both halves of the list machinery",
  );

  const apply = liveFunctionBody("crm_contact_list_change_apply");
  const refresh = liveFunctionBody("crm_contact_master_refresh");

  // ── 2. The apply half no longer refuses on an unset global date ───────────────────────────────
  // The door it asks is the DOCTOR-LIST door (20261015215500), which is the started teams plus the
  // vendor-less reps — section 9 pins what that door is and that the visits door is untouched.
  assert.match(
    apply,
    /from public\.phoenix_crm_doctor_list_reps\(\) s/,
    "the apply function asks whose doctor list Phoenix owns, not only the global cutover date",
  );
  assert.doesNotMatch(
    apply,
    /if v_cutover is null or v_today < v_cutover then/,
    "the refusal that fired for EVERYONE while cutover_date was null must be gone — that is the whole defect",
  );
  assert.match(
    apply,
    /v_phoenix_owns := exists \(/,
    "the switch is one named boolean, so a reader can see both paths at once",
  );
  assert.match(
    apply,
    /or \(v_cutover is not null and v_today >= v_cutover\)/,
    "a global cutover date, if it is ever set, is still a second path and not dropped",
  );
  // The refusal itself, as this migration shipped it. Its WORDING was replaced on 2026-10-06 by
  // NEUTRAL_MIGRATION ("their team", not "his team") and is checked there — what matters here is that a
  // rep whose team has not started is refused at all, and told why.
  assert.match(
    apply,
    /team has not started in Phoenix CRM yet/,
    "a rep whose team has not started is still refused, and the message says why",
  );
  // The window test must match the TypeScript rule: inclusive of the start, exclusive of the stop.
  assert.match(
    apply,
    /v_today >= s\.counted_from\s*\n\s*and \(s\.counted_until is null or v_today < s\.counted_until\)/,
    "the window is inclusive of counted_from and exclusive of counted_until, as startedWindowCovers is",
  );

  // ── 3. ALL FOUR assignment passes skip a started rep ──────────────────────────────────────────
  // The INSERT is the one that matters most: a doctor a manager removed has no open row, so without a
  // guard `not exists (... o.effective_to is null ...)` is TRUE and the vendor re-opens him the next
  // hour. That is the "re-open a removed doctor the next morning" the original migration warned of.
  const passes = assignmentPasses(refresh);
  for (const name of ["discard", "close", "touch", "open"]) {
    assert.match(
      passes[name],
      STARTED_GUARD,
      `the ${name} pass must skip a rep whose team has started — without it the vendor still owns his list`,
    );
  }
  // Contact IDENTITY stays global, deliberately — name, speciality, phone and address are keyed by
  // contact_crm_id, not by rep, so a started team's doctors are the same doctors. Guarding this pass
  // would strand them at today's spelling for ever. This is checked BEFORE the count below: the count
  // also catches a wrongly-guarded identity pass, but it reports "not exactly four passes", which does
  // not tell the next reader WHICH pass was wrong.
  const identityStart = refresh.indexOf("insert into public.crm_contacts as c (");
  assert.ok(identityStart > 0, "the contact identity pass must still be there");
  const identity = refresh.slice(identityStart, refresh.indexOf("get diagnostics v_list_contacts", identityStart));
  assert.doesNotMatch(
    identity,
    /crm_refresh_started_reps/,
    "the contact identity pass is NOT per-rep — guarding it would freeze a started team's doctors' details",
  );

  // The started set is created once and read ONCE, into the two arrays (`drop table` is the other mention);
  // every test below reads the arrays, never the table again — the table read per row was the 1.2 s.
  assert.equal(
    (refresh.match(/pg_temp\.crm_refresh_started_reps/g) ?? []).length,
    2,
    "the started set is created once and read once, into the arrays the five tests use",
  );
  assert.equal(
    (refresh.match(/= any \(v_started_keys\)/g) ?? []).length,
    5,
    "the frozen count and the four passes each test the hr id against the started keys",
  );
  assert.equal(
    (refresh.match(/= any \(v_started_crm_ids\)/g) ?? []).length,
    5,
    "the frozen count and the four passes each fall back to the agent id against the started ids",
  );

  // The open pass reads the VENDOR mirror, so its guard keys on that alias, not on the assignment row.
  assert.match(
    passes.open,
    /lower\(btrim\(m\.agent_hr_id\)\) = any \(v_started_keys\)/,
    "the open pass keys its guard on the vendor mirror's own agent, which is the row it would insert",
  );

  // ── 4. The HR id decides, with the CRM id only as a fallback ──────────────────────────────────
  // Same precedence as startedWindowCovers: production has 0 open rows without an agent_hr_id, so the
  // crm_id leg is belt-and-braces — but a guard that keyed on crm_id FIRST would mis-handle a rep whose
  // employees.crm_id is blank, and that rep's whole list would stay the vendor's in silence.
  assert.match(
    refresh,
    /nullif\(btrim\(a\.agent_hr_id\), ''\) is not null and lower\(btrim\(a\.agent_hr_id\)\) = any \(v_started_keys\)/,
    "the HR id is tried first",
  );
  assert.match(
    refresh,
    /nullif\(btrim\(a\.agent_hr_id\), ''\) is null and a\.agent_crm_id is not null/,
    "the CRM id is used only when the row carries no HR id",
  );

  // ── 5. The run leaves a trace of what it froze ────────────────────────────────────────────────
  // A pass that silently does less is the shape that hid a dead sheet token for 59 days.
  for (const key of ["startedRepsFrozen", "assignmentsFrozen"]) {
    assert.match(refresh, new RegExp(`'${key}',`), `the refresh reports ${key}, so a freeze is never silent`);
  }
  assert.match(
    refresh,
    /select count\(\*\) into v_assignments_frozen/,
    "the frozen count is measured against the table, not inferred from the started-rep count",
  );

  // ── 6. It changes no number today, and touches nothing it should not ──────────────────────────
  // The migration replaces two function bodies. It must not carry a data statement of its own: a
  // started rep's 1,997 open rows stay open, so every doctor-list screen reads the same list today.
  // Measured OUTSIDE both function bodies. Inside them a `delete from public.crm_contact_assignments`
  // (the discard pass) and `drop table if exists pg_temp.…` are the pre-existing, correct shape — an
  // earlier version of this assertion matched those and failed, which is what it is guarding against.
  const outsideFunctions = sql.replace(applyHere, "").replace(refreshHere, "");
  assert.doesNotMatch(
    outsideFunctions,
    /\b(delete from|truncate|alter table|drop (table|function|view))\b/i,
    "at its top level the migration writes no rows and drops nothing — it replaces two function bodies",
  );
  // What IS left outside the bodies is only the two `comment on function` statements.
  assert.equal(
    (outsideFunctions.match(/\bcomment on function\b/g) ?? []).length,
    2,
    "outside the two function bodies the migration carries only its two comment statements",
  );
  assert.doesNotMatch(sql, /salary|deduction|payroll/i, "the migration touches no pay table");
  assert.doesNotMatch(
    refresh,
    /security definer/,
    "the refresh keeps the caller's rights, as it had before",
  );

  // ── 7. The accompanying comments say which rule is live ───────────────────────────────────────
  assert.match(
    lastDefinerRaw(/create or replace function public\.crm_contact_master_refresh\(/, "crm_contact_master_refresh"),
    /comment on function public\.crm_contact_master_refresh\(boolean\) is/,
    "the refresh carries a comment, so psql \\df+ states the rule",
  );
  assert.match(
    lastDefinerRaw(/create or replace function public\.crm_contact_list_change_apply\(/, "crm_contact_list_change_apply"),
    /comment on function public\.crm_contact_list_change_apply\(uuid, text, text\) is/,
    "the apply function carries a comment too",
  );

  // ── 8. The TYPESCRIPT half asks the SAME rule, per rep (owner, 2026-10-06) ────────────────────
  // The migration above taught the DATABASE. The service kept asking the GLOBAL cutover date on its
  // own, in `assertInForce`, so with that date NULL on production every change was refused BEFORE the
  // database was ever reached: the SFE Manager's direct edit — his rule since 2026-09-14, and carried
  // by the apply function since 2026-10-04 — could not be made at all. Measured 2026-10-06, two days
  // after this migration shipped: crm_contact_list_changes still held 0 rows, while 18 people on
  // started teams held 1,997 open assignment rows the vendor refresh was already freezing for them.
  const rules = read("src/lib/crm/contact-lists/rules.ts");
  const service = read("src/lib/crm/contact-lists/service.ts");

  // The two paths, in the same order as v_phoenix_owns: his team's start first, the global date second.
  assert.match(
    rules,
    /startedWindowCovers\(ownership\.windows, ownership\.rep, ownership\.cairoToday\) \|\|[\s\S]{0,20}contactListChangesInForce\(ownership\.cutover, ownership\.cairoToday\)/,
    "the TypeScript rule is the team's start OR a global cutover date — the same two paths as the SQL",
  );
  assert.doesNotMatch(
    service,
    /assertInForce/,
    "the global-date-only gate is gone from the service; every caller asks the per-rep rule instead",
  );

  // The refusal is the DATABASE'S OWN SENTENCE, byte for byte, so a screen can never explain a refusal
  // differently from the raise that produced it.
  // Read from the LIVE definer — the body the database runs — never from a migration whose text a later
  // one replaced. `neutralApply` below is the 2026-10-06 re-emission, kept only to prove that changing
  // the one word changed nothing else.
  const neutralApply = functionBody(stripSqlComments(read(NEUTRAL_MIGRATION)), "crm_contact_list_change_apply");
  const sentence = /"(Doctor lists for this rep still come from iReports360[^"]*)"/.exec(rules);
  assert.ok(sentence, "rules.ts must carry the team-not-started message");
  assert.ok(
    apply.includes(sentence[1]),
    "the message the screen shows is the one crm_contact_list_change_apply raises, verbatim",
  );
  // Nothing this app shows anybody assumes its subject is a man (owner, 2026-10-05). The guard that
  // pins that reads TypeScript, so it cannot see a sentence raised by a database function — and this one
  // reaches the editor as a conflict message the moment a drop is refused.
  // Built with `new RegExp` over a string on purpose: as a regex literal this assertion was DEAD. The
  // patch that wrote it passed a word-boundary escape through a tool that RESOLVED it, so the file held
  // a literal backspace byte and the pattern matched nothing — a check that can never fail, wearing
  // the shape of one that guards a sentence a person reads. A control character does not show in a diff.
  assert.doesNotMatch(
    apply,
    new RegExp("\\bhis\\b"),
    "the refusal the editor reads is neutral, like every other sentence this app shows",
  );
  // And it changed ONE WORD: the rest of the body is 20261004120000's, so re-emitting it to fix the
  // wording cannot have quietly reverted the team-start rule itself.
  assert.equal(
    neutralApply.replace("their team has not started", "his team has not started"),
    applyHere,
    "the 2026-10-06 re-emission is 20261004120000's body, byte for byte, apart from the one word",
  );

  // The gate reads both halves of the ownership and asks about the rep it was handed.
  assert.match(
    service,
    /doctorListRefusal\(\{ \.\.\.\(await listOwnership\(\)\), rep: ownershipRep\(rep\) \}\)/,
    "the service's gate applies the shared rule rather than re-deriving one",
  );

  // Every WRITE path asks, and asks about the rep whose list is changing — never about the viewer.
  // The ordering matters as much as the presence: the check needs his row, so a version that ran before
  // the row was resolved could only have asked a global question.
  assert.match(
    tsBody(service, "requestContactListChange"),
    /requireActiveSelf\(access, directory\)[\s\S]*assertPhoenixOwnsList\(rep\)/,
    "a rep's own request is judged on HIS team, after his row is resolved",
  );
  assert.match(
    tsBody(service, "applyContactListChangeDirectly"),
    /isAgentInScope\(scope, rep\.hrId\)[\s\S]*assertPhoenixOwnsList\(rep\)/,
    "the SFE Manager's direct edit is judged on the rep he picked, after the scope check",
  );
  assert.match(
    tsBody(service, "decideContactListChange"),
    /assertPhoenixOwnsList\(\{ crmId: repRow\?\.crmId \?\? null, hrId: record\.repHrId \}\)/,
    "a manager's approval is judged on the REP on the change, not on the manager",
  );

  // Both READ paths follow, or the screen offers a change the write path then refuses.
  assert.match(
    tsBody(service, "getContactListView"),
    /if \(shownRep\) view\.inForce = doctorListOwnedByPhoenix\(/,
    "the page narrows inForce to the shown rep once his row is known",
  );
  assert.match(
    tsBody(service, "getContactListAvailability"),
    /viewer\.canRequest && !doctorListOwnedByPhoenix\(/,
    "a rep is not linked to a page that would refuse every change he could make there",
  );
  // The picker still lists every rep in scope — reading a not-yet-started list is allowed — but it says
  // which ones cannot be changed, so the editor never meets the refusal by surprise.
  assert.match(
    service,
    /listOpen: doctorListOwnedByPhoenix\(\{ \.\.\.ownership, rep: ownershipRep\(row\) \}\)/,
    "each rep option carries whether his list is open",
  );
  assert.match(
    read("src/components/employee-portal/contact-list-workspace.tsx"),
    /option\.listOpen \? null :/,
    "the picker marks a rep whose list is not open yet",
  );

  // ── 9. A REP WITH NO IREPORTS360 ACCOUNT GETS HIS PHOENIX LIST (owner, 2026-10-15) ────────────
  // Shahd Mohamed Elsayed Ghoneim (PD-0026) had an EMPTY droplist: 112 real Phoenix customers on her
  // seat since 11 October, no iReports360 account at all, and a team that has not started — so the four
  // vendor passes could not key on her and the fifth pass did not cover her. Nine more October hires
  // were in the same state, 1,223 built list rows between them, invisible on every list screen. The
  // hand-over is driven by the LIST: a rep with no Phoenix list keeps his vendor list (section 1), and a
  // rep with no VENDOR list gets his Phoenix list without waiting for his team.
  const listOnly = liveFunctionBody("phoenix_crm_list_only_reps");
  const door = liveFunctionBody("phoenix_crm_doctor_list_reps");

  // The door is the UNION of the two, in that order — a started rep's own TEAM date must win, because
  // his list was usually built before his team started and the earlier date would backdate his periods.
  assert.match(
    door,
    /from public\.phoenix_crm_started_team_reps\(\) s\s*\n\s*union all\s*\n[\s\S]*from public\.phoenix_crm_list_only_reps\(\) l/,
    "the doctor-list door is every started team's people plus the vendor-less reps",
  );
  // Both halves return the SAME six columns in the same order, which is the only reason the union is
  // legal at all — and the only reason every reader of the door can keep its one row shape.
  const SHAPE = "returns table (seat_id text, hr_id text, hr_key text, agent_crm_id bigint, counted_from date, counted_until date)";
  for (const [body, label] of [[listOnly, "phoenix_crm_list_only_reps"], [door, "phoenix_crm_doctor_list_reps"]] as Array<[string, string]>) {
    assert.ok(body.includes(SHAPE), `${label} returns the started door's own six columns, in its order`);
  }

  // All four conditions, or the rule reaches someone it must not. The last one is the subtle one:
  // returning a started rep here too would offer the fifth pass a second, EARLIER window.
  for (const [pattern, why] of [
    [/e\.crm_id is null or e\.crm_id !~ '\^\[0-9\]\+\$'/, "no numeric iReports360 account id"],
    [/nullif\(btrim\(e\.crm_username\), ''\) is null/, "no iReports360 username either"],
    [/a\.source = 'ireports360'/, "and no open vendor assignment row, whatever the identity columns say"],
    [/from public\.phoenix_crm_started_team_reps\(\) s\s*\n\s*where s\.hr_key = lower\(btrim\(o\.occupant_hr_id\)\)/, "a started rep is excluded — he is in the other half, with his team's date"],
  ] as Array<[RegExp, string]>) {
    assert.match(listOnly, pattern, `the list-only set requires: ${why}`);
  }
  // Never before the list existed, and never before he took the seat.
  assert.match(
    listOnly,
    /greatest\(o\.effective_from, l\.list_built_on\)/,
    "his Phoenix periods open on the later of the day he took the seat and the day his list was built",
  );
  assert.match(
    listOnly,
    /min\(\(c\.created_at at time zone 'Africa\/Cairo'\)::date\)/,
    "the list's build day is read in Cairo, like every other day in this machinery",
  );
  assert.match(listOnly, /where not c\.is_test/, "test customers are not a list");

  // Both new functions are SECURITY DEFINER, so the anon key must not reach them.
  const doorMigration = lastDefinerRaw(
    /create or replace function public\.phoenix_crm_doctor_list_reps\(/,
    "phoenix_crm_doctor_list_reps",
  );
  for (const fn of ["phoenix_crm_list_only_reps", "phoenix_crm_doctor_list_reps"]) {
    assert.ok(
      doorMigration.includes(`revoke execute on function public.${fn}() from public, anon, authenticated;`),
      `${fn} revokes EXECUTE from PUBLIC — anon and authenticated inherit it otherwise`,
    );
    assert.ok(
      doorMigration.includes(`grant execute on function public.${fn}() to service_role;`),
      `${fn} re-grants service_role, which the revoke above strips from a default ACL`,
    );
  }

  // 🔴 THE VISITS DOOR IS UNTOUCHED, AND THAT IS THE POINT. Everything that decides whether somebody
  // WORKED — the four unified views, field-work compliance and its payroll-deduction recommendation, the
  // CRM no-activity / DSM no-record / holiday-bridge connectors, the attendance day maps, the KPI
  // boards, Early Birds — still asks `phoenix_crm_started_team_reps`, so a team's counting source moves
  // only on the owner's own Start click. This migration moves the DOCTOR LIST and nothing else.
  assert.doesNotMatch(
    stripSqlComments(doorMigration),
    /create or replace (function public\.phoenix_crm_started_team_(reps|seats)|view public\.crm_(visits|plan_entries|checkins)_unified)\b/,
    "the door migration redefines neither the started-team functions nor any unified view",
  );
  const startedReps = read("src/lib/crm/phoenix-started-reps.ts");
  assert.match(
    startedReps,
    /export const PHOENIX_CRM_DOCTOR_LIST_REPS_RPC = "phoenix_crm_doctor_list_reps"/,
    "the TypeScript side names the doctor-list RPC",
  );
  assert.match(
    read("src/lib/crm/contact-lists/service.ts"),
    /loadDoctorListRepWindows\(\), getCrmCutoverSetting\(\)/,
    "the doctor-list service reads the doctor-list door, so the screen and the database agree",
  );
  for (const reader of [
    "src/lib/crm/rep-day.ts",
    "src/lib/crm/kpis-board.ts",
    "src/lib/crm/call-rate-service.ts",
  ]) {
    assert.match(
      read(reader),
      /loadStartedRepWindows\(\)/,
      `${reader} still reads the STARTED windows — the doctor-list door must never reach a reader about work`,
    );
    assert.doesNotMatch(
      read(reader),
      /loadDoctorListRepWindows/,
      `${reader} must not read the doctor-list door — it would count a vendor-less rep's days as Phoenix's`,
    );
  }
  // Early Birds stopped asking the started windows on 2026-10-16 (Phoenix wins the DAY: its clock follows the
  // rep-day's own Phoenix visit) — it must still never read the doctor-list door.
  assert.doesNotMatch(
    read("src/lib/early-birds/collect.ts"),
    /loadDoctorListRepWindows/,
    "early-birds/collect.ts must not read the doctor-list door — it would count a vendor-less rep's days as Phoenix's",
  );
}
