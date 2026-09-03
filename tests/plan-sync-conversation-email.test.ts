import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { HR_SEAT_ROLES, resolveConversationAudience } from "../src/lib/conversations/notify.ts";
import { isDeductionsReadActor } from "../src/lib/deductions/permissions.ts";
import { enforceCandidateAssignedEmailBlock } from "../src/lib/notifications/recruitment-candidate-assigned-channel-guard.ts";
import { enforceRecruitmentCvEmailBlock } from "../src/lib/notifications/recruitment-cv-channel-guard.ts";
import { planDayFingerprint } from "../src/lib/weekly-planning/service.ts";

// Two owner rulings from 2026-09-03, pinned:
//
//  1. A submitted WEEKLY plan wins over the covering MONTHLY plan, which is rewritten to match and
//     the change flagged. Before this the two cadences could assert different things about the same
//     day with nothing reconciling them: measured in production at 9 disagreeing days out of the 26
//     shared ones, including a monthly plan claiming Office on three days the weekly plan called
//     Vacation.
//
//  2. Every conversation in the system emails "the submitter, CC the sender". Only the plan thread
//     emailed anybody at all, and it addressed each participant privately, so the cc line was empty
//     on all five plan-comment emails production had ever sent.

const servicePath = new URL("../src/lib/weekly-planning/service.ts", import.meta.url);
const service = readFileSync(servicePath, "utf8");
const deductionsComments = readFileSync(new URL("../src/lib/deductions/comments.ts", import.meta.url), "utf8");
const conversationNotify = readFileSync(new URL("../src/lib/conversations/notify.ts", import.meta.url), "utf8");
const deductionsPage = readFileSync(new URL("../app/(admin)/admin/deductions/page.tsx", import.meta.url), "utf8");

export function runPlanSyncConversationEmailTests() {
  // -------------------------------------------------------------------------
  // The addressing rule itself.
  // -------------------------------------------------------------------------

  // To the submitter, CC the sender. The submitter leads notifyKeys because the email envelope is
  // attached to the primary recipient, and the primary IS the To.
  const basic = resolveConversationAudience({
    authorHrId: "A-12",
    participantHrIds: ["A-7", "A-12", "A-30"],
    submitterHrId: "A-7",
  });
  assert.equal(basic.notifyKeys[0], "A-7", "the submitter must be the To, and therefore first");
  assert.ok(basic.ccKeys.includes("A-12"), "the sender must be CC'd — this is the owner's rule verbatim");
  assert.ok(!basic.ccKeys.includes("A-7"), "the submitter is the To and must not also appear in the cc");
  assert.ok(
    !basic.notifyKeys.includes("A-12"),
    "the author gets the emailed copy but no in-app ping about their own message",
  );
  assert.ok(basic.notifyKeys.includes("A-30"), "other participants still get the in-app notification");
  assert.ok(basic.ccKeys.includes("A-30"), "other participants are copied on the same email");

  // The author writing on their own thread. "CC the sender" means the sender receives the copy, so
  // collapsing To and CC onto one person is correct rather than a case to suppress.
  const selfAuthored = resolveConversationAudience({
    authorHrId: "A-7",
    participantHrIds: ["A-7", "A-30"],
    submitterHrId: "A-7",
  });
  assert.equal(selfAuthored.notifyKeys[0], "A-7");
  assert.ok(!selfAuthored.ccKeys.includes("A-7"), "the To is never duplicated into its own cc");
  assert.ok(selfAuthored.ccKeys.includes("A-30"));

  // HR ids are stored mixed-case in this database. One person written two ways must resolve to one
  // recipient, or the same human is both the To and a cc and receives the mail twice.
  const mixedCase = resolveConversationAudience({
    authorHrId: "a-12",
    participantHrIds: ["a-7", "A-12"],
    submitterHrId: "A-7",
  });
  assert.equal(mixedCase.notifyKeys.length, 1, "a-7 and A-7 are one person, not two recipients");
  assert.ok(!mixedCase.ccKeys.includes(mixedCase.notifyKeys[0]), "case must not smuggle the To into the cc");

  // A thread whose owner is unknown must not silently address the mail to nobody.
  const ownerless = resolveConversationAudience({
    authorHrId: "A-12",
    participantHrIds: [null, "", "A-30"],
    submitterHrId: null,
  });
  assert.ok(!ownerless.notifyKeys.includes(""), "a blank HR id is never a recipient");
  assert.ok(!ownerless.ccKeys.includes(""), "a blank HR id is never copied");

  // -------------------------------------------------------------------------
  // What a planned day claims, for the weekly-vs-monthly comparison.
  // -------------------------------------------------------------------------

  const officeDay = [{
    activity_title: "Office",
    activity_type: "Office",
    area: null,
    end_time: null,
    location_text: null,
    start_time: null,
  }];
  const vacationDay = [{
    activity_title: "Vacation",
    activity_type: "Vacation",
    area: null,
    end_time: null,
    location_text: null,
    start_time: null,
  }];
  // The exact real-world disagreement this feature exists for: A-7's monthly plan said Office on
  // 12-14 July while his weekly plan said Vacation.
  assert.notEqual(
    planDayFingerprint(officeDay),
    planDayFingerprint(vacationDay),
    "Office and Vacation on the same day must read as a conflict",
  );
  assert.equal(planDayFingerprint(officeDay), planDayFingerprint(officeDay), "an unchanged day must not be flagged");

  // An AM row and a PM row are two different claims on one date and must not collapse into each
  // other — otherwise a half-day swap would reconcile as "no change".
  const amRow = { activity_title: "Field", activity_type: "Field", area: null, end_time: "13:00", location_text: null, start_time: "09:00" };
  const pmRow = { activity_title: "Field", activity_type: "Field", area: null, end_time: "17:00", location_text: null, start_time: "13:00" };
  assert.notEqual(planDayFingerprint([amRow]), planDayFingerprint([pmRow]), "AM and PM are distinct claims");
  // Row ORDER within a day is not a change — the print is sorted, so a re-ordered save is not a
  // spurious conflict that would rewrite an approved month for nothing.
  assert.equal(
    planDayFingerprint([amRow, pmRow]),
    planDayFingerprint([pmRow, amRow]),
    "row order within a day must not register as a change",
  );

  // -------------------------------------------------------------------------
  // Wiring pins. Substring checks, never byte offsets: a fixed window false-fails
  // the moment anything above it in the file shifts.
  // -------------------------------------------------------------------------

  // All three submit paths (create, edit, revise-a-closed-plan) must run the reconciliation. The
  // whole point of the afterPlanSubmitted funnel is that it cannot be wired into two of the three.
  const submitCalls = service.match(/await afterPlanSubmitted\(access, await loadPlanRow\(/g) ?? [];
  assert.equal(submitCalls.length, 3, "every submit path must route through afterPlanSubmitted");
  assert.ok(
    !/await notifyPlanSubmitted\(await loadPlanRow\(/.test(service),
    "no submit path may still call notifyPlanSubmitted directly and skip the monthly reconciliation",
  );
  assert.ok(
    /async function afterPlanSubmitted[\s\S]{0,400}reconcileMonthlyFromWeekly/.test(service),
    "afterPlanSubmitted must actually reconcile, not merely notify",
  );

  // The reconciliation may only rewrite a month that is still editable. phx_weekly_plan_replace_items
  // refuses any other status, and an approved monthly plan is a document somebody signed — rewriting
  // its rows underneath the approval would destroy the audit trail the approval exists to create.
  assert.ok(
    /reconcileMonthlyFromWeekly[\s\S]*?if \(canEditEmployeePlanStatus\(monthly\.status\)\)/.test(service),
    "the monthly rewrite must be gated on the plan still being editable",
  );

  // The week is clipped to its overlap with the month. A Saturday-anchored Field Force week straddles
  // a month boundary several times a year, and replacing the whole week's span inside one month would
  // delete the neighbouring month's own days.
  assert.ok(
    /const inWindow = \(date: string\) => date >= from && date <= to;/.test(service),
    "the reconciliation must act on the week/month overlap, not the whole week",
  );

  // A straddling week belongs to BOTH months, so both are reconciled. Picking one - which is what
  // reading `live[0]` off an unordered query does - leaves the other month holding exactly the
  // contradiction this feature exists to end, and picks which one arbitrarily.
  assert.ok(
    /for \(const monthly of live\) \{[\s\S]{0,200}reconcileOneMonth\(access, weeklyPlan, monthly\)/.test(service),
    "every month the week overlaps must be reconciled, not the first row the query returned",
  );
  assert.ok(
    !/const monthly = live\[0\]/.test(service),
    "the reconciliation must not pick one arbitrary month out of an overlapping pair",
  );

  // The missing direction: a WEEKLY plan now seeds from the covering monthly plan. Both monthly plans
  // ever submitted were written before any weekly plan existed, so the pre-existing weekly-to-monthly
  // sourcing had nothing to read and the two drifted.
  assert.ok(
    /loadMonthlySourcedItems\(employee\.hrId, start, end\)/.test(service),
    "the weekly editor must seed from the covering monthly plan",
  );
  assert.ok(
    /source: "monthly" as const[\s\S]{0,160}locked: false/.test(service),
    "monthly-sourced rows stay editable — the week is where a month gets refined",
  );

  // One addressed email per comment, not one private email per participant.
  assert.ok(
    /async function notifyPlanComment[\s\S]*?emailCcRecipients: Array\.from\(ccKeys\)/.test(service),
    "a plan comment must CC the rest of the thread instead of mailing each participant alone",
  );
  assert.ok(
    !/const truncatedBody = comment\.body/.test(service),
    "the comment body is emailed in full — the owner's standing rule bans truncating text with an ellipsis",
  );

  // Returning a plan is a conversation too, and the owner named it explicitly alongside the threads.
  assert.ok(
    /async function notifyEmployeeReturnedOrRejected[\s\S]*?emailCcRecipients: actorHrId/.test(service),
    "a returned or rejected plan must CC whoever returned it",
  );

  // -------------------------------------------------------------------------
  // The two recruitment email blocks must not swallow a candidate CONVERSATION.
  // -------------------------------------------------------------------------
  //
  // Both guards strip email from the recruitment module, and both are owner rules that stand: a
  // "new CV received" notice and a candidate PUSH to a hiring manager are never emailed. A comment
  // is neither — it is a conversation, which the owner asked on 2026-09-03 to be emailed
  // everywhere. The boundary is the eventType, and it is one careless edit wide: widening either
  // guard to `module: "recruitment"` would mute this feature entirely and silently, since a
  // stripped channel raises nothing.
  const commentChannels = ["in_app", "email", "telegram", "push"] as const;
  assert.ok(
    enforceRecruitmentCvEmailBlock(commentChannels, "recruitment", "candidate_comment").includes("email"),
    "the new-CV email block must not reach a candidate comment — a conversation is not an arrival notice",
  );
  assert.ok(
    enforceCandidateAssignedEmailBlock(commentChannels, "recruitment", "candidate_comment").includes("email"),
    "the candidate-push email block must not reach a candidate comment — a conversation is not a push",
  );
  // -------------------------------------------------------------------------
  // Deductions: the one thread with a single side, so its audience was decided.
  // -------------------------------------------------------------------------
  //
  // assertEmployeeCanCommentOnCandidate means only the employee can ever write here, so the row
  // names no counterparty. The owner was asked and answered on 2026-09-03: "HR gets the deductions
  // comment." Nothing was sent before that - a disputed deduction went into a table nobody watched.
  assert.ok(
    /await notifyDeductionsComment\(/.test(deductionsComments),
    "an employee's comment on their own deduction must reach HR",
  );
  assert.ok(
    /notifyHrConversationMessage\([\s\S]*?module: "deductions"/.test(deductionsComments),
    "the deductions thread must use the shared HR conversation path, not its own recipient list",
  );

  // HR is resolved by APP ROLE, never by job title. The owner's rule is that an HR seat is composed
  // from a function catalogue and never named after a job title - and production proves the cost:
  // weekly-planning's hrAcknowledgementRecipients matches job_title ilike '%HR Manager%' /
  // '%Admin HR%', and BOTH return zero employees, so its HR leg reaches Super Admins alone.
  assert.deepEqual(
    [...HR_SEAT_ROLES],
    ["HR Advisory", "HR Operations"],
    "the HR audience is the two HR seats, resolved by role",
  );
  assert.ok(
    /\.from\("app_auth_users"\)[\s\S]{0,200}\.in\("role", \[\.\.\.HR_SEAT_ROLES\]\)/.test(conversationNotify),
    "the HR audience must be read from the role column, never matched on a job title",
  );
  // The QUERY form, not the word: the prose above deliberately names the job_title filter it is
  // warning against, and a pin that cannot tell a comment from a query would forbid explaining why.
  assert.ok(
    !/job_title\.ilike|\.select\([^)]*job_title/.test(conversationNotify),
    "no conversation audience may be resolved by job title - titles drift, the role is the gate",
  );
  // An unstaffed HR function must lose the mailbox, not the message.
  assert.ok(
    /resolveHrAudience[\s\S]*?\.eq\("role", "Super Admin"\)/.test(conversationNotify),
    "an empty HR audience must fall back to Super Admin rather than drop the comment",
  );
  // The employee is named, not numbered - the owner's standing rule, in chat and UI alike.
  assert.ok(
    /subjectLabel: authorName \?\? "an employee"/.test(deductionsComments),
    "HR must be told which PERSON commented, never their HR id",
  );

  // THE LINK IN THAT MAIL HAS TO OPEN. This is the pin that closes the loop the feature opened:
  // a notification is an actionUrl and a body, and wiring an audience to a page that redirects them
  // produces a mail that reads as a bug rather than as a message. HR Operations was in exactly that
  // state on the day the mail was written - offered the row on deductions:read, refused by the
  // page's hard-coded role set - and the owner closed it: "yes give HR access to the deductions
  // screen."
  //
  // Both halves are asserted, because either alone is the offered-but-closed shape. The page is the
  // door; isDeductionsReadActor is the data behind it, checked separately by every company-wide
  // read route, so passing the door with the gate closed renders a screen whose every panel 403s.
  assert.ok(
    /actionUrl: "\/admin\/deductions"/.test(deductionsComments),
    "the deductions comment must link to the unified deductions screen",
  );
  assert.ok(
    /const VIEW_ROLES = new Set\(\[[^\]]*"HR Operations"/.test(deductionsPage),
    "the deductions page must admit HR Operations - it is mailed the comment, so its link must open",
  );
  assert.ok(
    isDeductionsReadActor({ role: "HR Operations" }),
    "HR Operations must pass the module read gate too, or the page opens and every panel 403s",
  );
  // HR Advisory is mailed the same comment and cannot open the screen. That is deliberate and the
  // owner was told so - payroll appears nowhere in the HR Business Partner job description - and it
  // is pinned so a later session does not "fix" the asymmetry in either direction by accident. What
  // makes it safe is the body: the message carries the comment IN FULL, asserted above.
  assert.ok(
    !isDeductionsReadActor({ role: "HR Advisory" }),
    "HR Advisory must NOT read the company's deductions - she is mailed the comment, not the ledger",
  );
  // That BOTH seats stay on this conversation - an employee disputing a deduction is an employee
  // concern, and engagement is hrbp 2 - is already pinned by the HR_SEAT_ROLES deepEqual above.
  // Repeating it here would be an assertion that can never fire on its own, which is the shape this
  // suite exists to avoid.

  // The guards themselves still do their job, so this pin cannot pass by having neutered them.
  assert.ok(
    !enforceRecruitmentCvEmailBlock(commentChannels, "recruitment", "recruitment_inbound_cv").includes("email"),
    "the new-CV email block must still block the notice it exists for",
  );
  assert.ok(
    !enforceCandidateAssignedEmailBlock(commentChannels, "recruitment", "candidate_assigned").includes("email"),
    "the candidate-push email block must still block the push it exists for",
  );
}
