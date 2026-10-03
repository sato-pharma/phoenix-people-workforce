import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  enforcePhoenixCrmEmailBlock,
  enforcePhoenixCrmPushBlock,
  phoenixCrmBlocksTelegramFallback,
  phoenixCrmChannels,
  PHOENIX_CRM_EMAIL_EVENT_TYPES,
  PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES,
} from "../src/lib/notifications/phoenix-crm-channel-guard.ts";
import { PLAN_EDIT_EXPIRY_ACTOR_HR_ID } from "../src/lib/phoenix-crm/plan-edit-rules.ts";
import { UNPLANNED_FIRST_STATUSES } from "../src/lib/phoenix-crm/unplanned-rules.ts";

/**
 * Phoenix CRM — the six approval-notice defects the 2026-10-02 audit found, the day before Delta (1)
 * went live. Every visit by a rep whose week was not sent is off-plan, so the SFE queue starts
 * filling from the first morning; each of these would have misreported within days.
 *
 *   1. NO BADGE FOR OFF-PLAN VISITS. `overview.waitingForYou` carried no off-plan count, so the
 *      module chooser's card, the tab bar and the "open on Team" choice summed the other four and
 *      left out the ONE item that counts in nothing until it is decided.
 *   2. THE SFE MANAGER WAS NEVER TOLD. A visit that STARTS at his step (a vacant manager chain)
 *      told nobody, on a stale comment that said there was "no hr id to address"; a visit a manager
 *      PASSED ON told only the rep, who read "it counts once SFE approves it too".
 *   3. THE DIGEST COULD REACH THE PHONE. The owner's 06:55 digest is in-app and Telegram only, and
 *      asking for those two channels was not enough: the Telegram-failure re-send asks for
 *      ["email", "in_app", "push"] and only the email was being stripped.
 *   4. TWO READS WERE UNPAGED. `seatsWithRealActivity` and `loadUnplannedRows` both relied on a
 *      PostgREST read that stops at max_rows = 1000 with no error and no marker.
 *   5. EDIT REQUESTS NEVER EXPIRED. `status = 'expired'` was written only when somebody DECIDED a
 *      request, and nobody decides one whose week has gone.
 *   6. A DEPARTED ROLE-HOLDER STAYED A RECIPIENT. `resolveHrIdsForRole` asked only the login's
 *      `is_active`, which lags `employees.employment_status`.
 */

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
}

/** One function's text in the comment-free migration, from its header to its closing `$$;`. */
function functionSql(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${name} is in the migration`);
  const end = sql.indexOf("$$;", start);
  assert.ok(end > start, `${name} is closed`);
  return sql.slice(start, end);
}

const MIGRATION = "supabase/migrations/20261002220047_phoenix_crm_activity_and_plan_edit_expiry.sql";

export function runPhoenixCrmApprovalNoticeTests() {
  // ── 1. The off-plan visits are counted, and counted at the viewer's OWN step ───────────────────
  {
    const overview = source("src/lib/phoenix-crm/server/overview.ts");
    assert.match(overview, /offPlanVisits: number;/, "the overview carries an off-plan count");
    assert.match(
      overview,
      /offPlanVisits: managerUnplanned \+ sfeUnplanned,/,
      "and it is the two steps this viewer may decide, added — never every waiting visit in his scope",
    );
    // The steps are exactly the two `canDecideUnplannedVisit` allows: the manager step on the
    // territories he REVIEWS, the SFE step across the SFE Manager's scope. Reading the count from a
    // wider set than the gate would badge a manager for a decision he cannot take.
    assert.match(
      overview,
      /countUnplannedVisits\(reviewSeatIds === null \? UNPLANNED_FIRST_STATUSES : \["manager_pending"\], waitingIsTest, reviewSeatIds\)/,
      "the manager step counts manager_pending on the territories he reviews",
    );
    assert.match(
      overview,
      /sfeSeatIds\.length === 0 \? 0 : countUnplannedVisits\(\["sfe_pending"\], false, sfeSeatIds\)/,
      "the SFE step counts sfe_pending across his scope, REAL entries only",
    );
    assert.deepEqual(
      [...UNPLANNED_FIRST_STATUSES],
      ["manager_pending", "sfe_pending"],
      "the Super Admin's test count holds both steps, as his list-request count does",
    );
    // A head count, never a row read: this runs on every Phoenix CRM page open.
    assert.match(overview, /\.select\("visit_id", \{ count: "exact", head: true \}\)/, "it is a head count");
    // 🔴 No week filter, unlike the plan edits: a waiting off-plan visit does not expire with its
    // week. The visit happened, and it counts in nothing until somebody decides it, however late.
    const counter = overview.slice(overview.indexOf("async function countUnplannedVisits("), overview.indexOf("async function telegramConnectedOrNull("));
    assert.equal(/week_start/.test(counter), false, "a waiting off-plan visit never expires, so no week is filtered");
  }

  // ── 1b. …and every place that SUMS those counts takes it ──────────────────────────────────────
  {
    const chooser = source("src/components/phoenix-crm/module-chooser.tsx");
    assert.match(chooser, /overview\.waitingForYou\.offPlanVisits \+/, "the module chooser's Team card counts it");
    const app = source("src/components/phoenix-crm/phoenix-crm-app.tsx");
    // Two sums, and they are different questions: `decisions` picks the tab the page OPENS on, and
    // `waitingCount` is the number on the Team tab. Both left it out.
    assert.equal(
      (app.match(/waitingForYou\.offPlanVisits/g) ?? []).length,
      2,
      "both the opening-tab decision and the tab bar's count take it",
    );
    assert.match(app, /if \(tabs\.team && !viewer\.isRep && decisions > 0\) return "team";/, "the opening tab still reads `decisions`");
    // The one sum that was always right: inside Team, the sentence that names what waits.
    const team = source("src/components/phoenix-crm/team-tab.tsx");
    assert.match(team, /unplanned: summary\.unplannedWaitingForYou,/, "teamWaitingLine named it correctly all along");
  }

  // ── 2. The SFE Manager is told when a visit reaches HIS step ───────────────────────────────────
  {
    const notify = source("src/lib/phoenix-crm/server/notifications.ts");
    const raised = notify.slice(notify.indexOf('if (notice.kind === "unplanned_visit_raised")'), notify.indexOf('if (notice.kind === "unplanned_visit_decided")'));
    assert.match(
      raised,
      /const recipients = reviewer \? \[reviewer\.hrId\] : await sfeManagerHrIds\(\);/,
      "a territory whose manager chain is vacant starts at SFE, so the SFE Managers are the ones told",
    );
    assert.equal(/if \(!reviewer\) return null;/.test(raised), false, "🔴 the old silent return is gone — that WAS the defect");
    assert.match(raised, /if \(recipients\.length === 0\) return null;/, "nobody holding the role still tells nobody, and the resolver logs it");

    // 🔴 The end marker is searched FROM the branch's own start: `loadPeopleNames([notice.deciderHrId])`
    // appears in earlier branches too, and a bare indexOf found one of those and sliced an EMPTY
    // string — which every `assert.match` below then failed on, saying the code was missing when it
    // was the test that could not see it.
    const decidedAt = notify.indexOf('if (notice.kind === "unplanned_visit_decided")');
    assert.ok(decidedAt > 0, "the decided branch is there to read");
    const decided = notify.slice(decidedAt, notify.indexOf("const names = await loadPeopleNames([notice.deciderHrId]);", decidedAt));
    assert.match(decided, /if \(notice\.status === "sfe_pending"\) \{/, "a visit the manager passed on now tells SFE");
    assert.match(decided, /const sfe = await sfeManagerHrIds\(\);/, "the same people the plan edit's SFE step reaches");
    assert.match(decided, /eventType: "unplanned_visit_waiting",/, "under the event type that already means 'this waits for you'");
    assert.match(decided, /notice\.clarification/, "carrying the reason he wrote, which is what SFE is asked to judge");

    // The key is per visit per STEP, and the two branches write the SAME key for the SFE step, so a
    // visit tells SFE once whether it started there or a manager passed it on.
    assert.match(
      raised,
      /idempotencyKey: `\$\{phoenixCrmVisitNoticeKeyPrefix\(notice\.visitId\)\}\$\{reviewer \? "raised" : "sfe_pending"\}`,/,
      "the raised branch keys on the step it STARTS at — `raised` for the manager, `sfe_pending` for a vacant chain",
    );
    assert.match(
      decided,
      /idempotencyKey: `\$\{phoenixCrmVisitNoticeKeyPrefix\(notice\.visitId\)\}sfe_pending`,/,
      "and a visit passed on writes that very same key, so neither path can tell SFE twice",
    );
    // 🔴 VERSION-FREE, unlike the rep's copy one line above it, which is per version per status: the
    // SFE step is reached once in a visit's life, so a key that moved with the version could tell him
    // again about a visit he is already looking at.
    assert.match(decided, /idempotencyKey: `\$\{phoenixCrmVisitNoticeKeyPrefix\(notice\.visitId\)\}v\$\{notice\.version\}:\$\{notice\.status\}`,/);
    assert.match(decided, /metadata: \{ visitId: notice\.visitId \},/, "the SFE copy carries the visit id, so the bell clears it once the visit is decided");

    // The notice still names no channel of its own — the guard's allowlist answers for every one.
    assert.equal(/"email"/.test(notify), false, "the Phoenix CRM notifier never asks for email itself");
    assert.equal(
      PHOENIX_CRM_EMAIL_EVENT_TYPES.includes("unplanned_visit_waiting"),
      false,
      "and this notice is NOT one of the five the owner put on email: in-app, Telegram and the phone",
    );
  }

  // ── 3. The 06:55 digest cannot reach the phone, by the front door or the back ──────────────────
  {
    assert.deepEqual(
      [...PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES].sort(),
      // `day_start_seen` joined them on 2026-10-03: the SFE Manager's copy of a rep's "I started
      // working". The district manager's copy (`day_start_confirmed`) emails; the SFE's cannot, because
      // this notice repeats EVERY WORKING DAY and he reads every line — about 74 a morning at full
      // rollout. Both axes are shut here, so the Telegram-failure fallback cannot mail him either.
      ["crm_daily_digest", "day_start_seen", "plan_edit_expired"],
      "the notices he has called in-app-and-Telegram-only: the 06:55 digest, the plan-edit expiry, and the SFE's copy of a rep's day start",
    );
    // Behaviour, not source: the re-send's own channel list, filtered.
    assert.deepEqual(
      enforcePhoenixCrmPushBlock(enforcePhoenixCrmEmailBlock(["email", "in_app", "push"], "phoenix_crm", "crm_daily_digest"), "phoenix_crm", "crm_daily_digest"),
      ["in_app"],
      "the Telegram fallback's email AND push are both stripped for the digest",
    );
    assert.deepEqual(
      enforcePhoenixCrmPushBlock(["in_app", "telegram", "push"], "phoenix_crm", "plan_reminder"),
      ["in_app", "telegram", "push"],
      "every other Phoenix CRM notice keeps the phone (owner, 2026-10-02)",
    );
    assert.deepEqual(
      enforcePhoenixCrmPushBlock(["in_app", "push"], "payroll", "crm_daily_digest"),
      ["in_app", "push"],
      "and the block is keyed on the module, so it cannot reach another module's notice",
    );
    // The fallback is SKIPPED rather than merely stripped: with both added channels banned it could
    // only re-deliver the in-app copy the first send already made — a second bell row every morning
    // Telegram fails, which for an unlinked manager is every morning.
    assert.equal(phoenixCrmBlocksTelegramFallback("phoenix_crm", "crm_daily_digest"), true);
    assert.equal(phoenixCrmBlocksTelegramFallback("phoenix_crm", "plan_reminder"), false, "a notice that can still reach the phone keeps its fallback");
    assert.equal(phoenixCrmBlocksTelegramFallback("hr", "crm_daily_digest"), false, "another module's notice is never touched");

    const system = source("src/lib/notifications/system.ts");
    assert.match(system, /return enforcePhoenixCrmPushBlock\(\w+, input\.module, input\.eventType\);/, "the chain ends on the push block");
    assert.equal(
      (system.match(/!phoenixCrmBlocksTelegramFallback\(input\.module, input\.eventType\)/g) ?? []).length,
      2,
      "both in-send fallbacks are gated — the permanent-failure branch and the retryable one",
    );
    assert.match(
      system,
      /if \(phoenixCrmBlocksTelegramFallback\(input\.telegram\.module, input\.telegram\.eventType\)\) return;/,
      "and so is the retry worker's exhaustion fallback, which reads the same two fields off the stored payload",
    );
  }

  // ── 4. Both reads are bounded ──────────────────────────────────────────────────────────────────
  {
    const digest = source("src/lib/phoenix-crm/server/daily-digest.ts");
    assert.match(
      digest,
      /callPhoenixCrm<unknown>\("phoenix_crm_seats_with_activity", \{ p: \{ seat_ids: part \} \}\)/,
      "the started-territory gate asks the database per seat instead of reading every row",
    );
    assert.equal(/\.from\("phoenix_crm_visits"\)/.test(digest), false, "it no longer selects seat_id out of the six tables");
    assert.match(digest, /chunk\(\[\.\.\.seatIds\], 200\)/, "still chunked, so the ANSWER cannot approach the row cap either");

    const sql = source(MIGRATION);
    const activity = functionSql(sql, "phoenix_crm_seats_with_activity");
    for (const table of [
      "phoenix_crm_visits",
      "phoenix_crm_places",
      "phoenix_crm_plans",
      "phoenix_crm_monthly_plans",
      "phoenix_crm_day_activities",
      "phoenix_crm_list_requests",
    ]) {
      assert.match(activity, new RegExp(`exists \\(select 1 from public\\.${table} t where t\\.seat_id = asked\\.seat_id and t\\.is_test = false\\)`), `${table} answers, real rows only`);
    }
    assert.equal(
      (activity.match(/is_test = false/g) ?? []).length,
      6,
      "🔴 every one of the six filters is_test — a Super Admin's try-out must never switch a real manager's 06:55 message on",
    );

    const unplanned = source("src/lib/phoenix-crm/server/unplanned.ts");
    assert.match(unplanned, /const UNPLANNED_PAGE = 1000;/, "the SFE queue is paged at PostgREST's own max_rows");
    assert.match(unplanned, /\.order\("visit_id", \{ ascending: true \}\)/, "keyset on the primary key");
    assert.match(unplanned, /if \(after\) query = query\.gt\("visit_id", after\);/, "each page continues from the last key");
    assert.match(unplanned, /if \(page\.length < UNPLANNED_PAGE\) break;/, "a SHORT page is the end — a full one is never assumed to be");
    assert.equal(/\.range\(/.test(unplanned), false, "never an offset, which a decision landing mid-read would shift rows across");
  }

  // ── 5. A request to edit a week that has passed is closed, daily ───────────────────────────────
  {
    const sql = source(MIGRATION);
    const expiry = functionSql(sql, "phoenix_crm_expire_plan_edit_requests");
    // 🔴 THE SELECTION IS IN SQL, AND THAT IS THE SAFETY PROPERTY. The decide function APPLIES the
    // stage's decision whenever the week has not passed, so a caller choosing rows against its own
    // clock — a day out across midnight — would approve a live request as the system, or at the HR
    // step reopen a week nobody asked about. One transaction, one transaction timestamp, so only the
    // expiry branch can be reached.
    assert.match(expiry, /v_today date := \(now\(\) at time zone 'Africa\/Cairo'\)::date;/, "it reads the Cairo day the decide function reads");
    assert.match(expiry, /and r\.week_start \+ 5 < v_today/, "and selects on the same expression the expiry branch tests");
    assert.match(expiry, /v_result := public\.phoenix_crm_decide_plan_edit_request\(/, "it writes nothing itself — the existing function is the only writer");
    assert.match(expiry, /'expected_version', v_row\.version,/, "each row carries its own version, so a concurrent decision is a conflict, not an overwrite");
    assert.match(expiry, /when others then\s*\n\s*v_failed := v_failed \+ 1;/, "one row that cannot be closed does not cost the rest");
    assert.match(expiry, /if v_result ->> 'status' = 'expired' then/, "and only a row that really expired is reported closed");
    assert.match(expiry, /'actor_role', 'System',/, "the actor is the system, never a person");

    // SECURITY DEFINER with the grants CI requires: revoked from PUBLIC (which also strips
    // service_role on a default ACL) and then re-granted to service_role alone.
    for (const fn of ["phoenix_crm_seats_with_activity", "phoenix_crm_expire_plan_edit_requests"]) {
      assert.match(sql, new RegExp(`revoke execute on function public\\.${fn}\\(jsonb\\) from public, anon, authenticated;`), `${fn} is revoked from the browser roles`);
      assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\(jsonb\\) to service_role;`), `${fn} is re-granted to service_role`);
    }

    const pass = source("src/lib/phoenix-crm/server/plan-edit-expiry.ts");
    assert.equal(PLAN_EDIT_EXPIRY_ACTOR_HR_ID, "SYSTEM", "nobody decided an expiry, and no HR id may claim it");
    assert.match(pass, /p: \{ actor_hr_id: PLAN_EDIT_EXPIRY_ACTOR_HR_ID \}/, "the pass hands the database that marker");
    // 🔴 IN-APP AND TELEGRAM, NEVER EMAIL AND NEVER THE PHONE — the owner's own answer when asked
    // directly, 2026-10-02. The other four steps of a plan edit DO email (his 2026-10-01 ruling), and
    // the difference is the point: those are steps a PERSON took, while this is a week running out,
    // closed in a batch — the unprompted-bulk mail he has ruled out standing.
    assert.equal(
      PHOENIX_CRM_EMAIL_EVENT_TYPES.includes("plan_edit_expired"),
      false,
      "🔴 the expiry left the emailing list — it is the one plan-edit step no person takes",
    );
    assert.ok(PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES.includes("plan_edit_expired"), "and his “only” is enforced on the phone too");
    assert.deepEqual(phoenixCrmChannels("plan_edit_expired"), ["in_app", "telegram"], "so the notice asks for exactly those two, at the call site as well as in the guard");
    assert.deepEqual(
      enforcePhoenixCrmPushBlock(enforcePhoenixCrmEmailBlock(["email", "in_app", "push"], "phoenix_crm", "plan_edit_expired"), "phoenix_crm", "plan_edit_expired"),
      ["in_app"],
      "and the Telegram fallback cannot put it back on either",
    );
    // The four that remain are untouched: a person's own step still emails.
    for (const step of ["plan_edit_waiting", "plan_edit_moved_on", "plan_edit_refused", "plan_edit_reopened"]) {
      assert.ok(PHOENIX_CRM_EMAIL_EVENT_TYPES.includes(step), `${step} keeps its email — a person took that step`);
    }
    // The pass tells people whenever it closes something; the channels are not its choice to make.
    assert.match(pass, /if \(closed\.length > 0\) \{/, "every closed request is announced");
    assert.match(pass, /status: "expired",/, "under the status whose channels the guard owns");
    assert.equal(/channels/.test(pass), false, "the pass names no channel of its own");

    const route = source("app/api/cron/phoenix-crm-plan-reminder/route.ts");
    assert.match(route, /planEdits = await runPhoenixCrmPlanEditExpiry\(\);/, "the cron runs it daily");
    // It must run OUTSIDE the reminder, which returns early on every day that is not a reminder day.
    assert.ok(
      route.indexOf("runPhoenixCrmPlanEditExpiry()") < route.indexOf("withDeadMansSwitch("),
      "the expiry runs before the reminder, so it is not inside the reminder's early return",
    );
    assert.match(route, /step: "plan_edit_expiry"/, "its own failure is logged");
    assert.match(route, /success: true, \.\.\.result, planEdits/, "and reported, so a quiet run reads as a quiet run");
  }

  // ── 6. A departed role-holder is not a recipient, and an empty office is logged ────────────────
  {
    const resolver = source("src/lib/notifications/role-recipients.ts");
    const fn = resolver.slice(resolver.indexOf("export async function resolveHrIdsForRole("), resolver.indexOf("export async function resolveNotificationPersonRecipients("));
    assert.match(fn, /await withoutDepartedHrIds\(hrIds, warningLabel, warnings\)/, "the login's is_active is not the whole answer");
    assert.match(fn, /event: "role_recipients_empty"/, "an office nobody holds is logged — a notice that reached no one looks like one nobody sent");
    const helper = resolver.slice(
      resolver.indexOf("async function withoutDepartedHrIds("),
      resolver.indexOf("export async function resolveNotificationPersonRecipients("),
    );
    assert.match(helper, /isTerminalEmploymentStatus\(employee\.employment_status\)/, "it reads the employee record, which is what lags the login");
    assert.match(helper, /return hrIds;/, "and FAILS OPEN: an unreadable employees read drops nobody");

    // The Phoenix CRM SFE step rides the same resolver, so the fix reaches it and the off-plan
    // notices added above.
    const notify = source("src/lib/phoenix-crm/server/notifications.ts");
    assert.match(notify, /resolveHrIdsForRole\("SFE Manager", "Phoenix CRM — SFE Managers"\)/, "the SFE step is read from the accounts");
    assert.match(notify, /hrIds\.filter\(\(hrId\) => !hrId\.startsWith\("TEST-"\)\)/, "and a test account's TEST- id is never a real person to tell");
  }

  console.log("phoenix-crm approval notices: OK");
}
