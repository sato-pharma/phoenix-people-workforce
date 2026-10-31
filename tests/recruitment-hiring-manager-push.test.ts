import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  MANAGER_NOTIFIED_ACTION,
  notifyHiringManagerOfCandidate,
} from "../src/lib/recruitment/hiring-manager-notify.ts";

/**
 * Pushing a candidate to the hiring manager is the one thing the recruitment module exists to do,
 * and until 2026-08-15 it was invisible in both directions.
 *
 * Measured in production that day: 5 candidates had ever been assigned to a requisition, only 2
 * notifications had ever been sent, and the 3 silent failures — both of the owner's own attempts
 * among them — left no log, no row and no error, because createApplication wrapped the send in
 * `catch {}`. "It quietly did nothing" and "it worked" looked identical on screen.
 *
 * These assertions pin the three things that fixed it: a deliberate action, a failure that is
 * reported rather than discarded, and a recorded send the UI can read back after a reload.
 */

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

export async function runRecruitmentHiringManagerPushTests() {
  // ── The two "nothing to send" cases, behaviourally ─────────────────────────
  // Both return BEFORE any database or mail call, which is why they can be exercised directly.
  // They must be distinguishable from a failure: a requisition with no manager on the organogram
  // and a manager assigning to their own seat are both normal, and showing a red error for either
  // would train the recruiter to ignore real errors.
  assert.deepEqual(
    await notifyHiringManagerOfCandidate({
      actorHrId: "A-7",
      actorIsTheManager: false,
      applicationId: "application-1",
      candidateName: "Osama Ahmed",
      hiringManagerHrId: null,
      jobTitle: "District Sales Manager",
    }),
    { sent: false, reason: "no_hiring_manager" },
    "a requisition with no hiring manager is a skip with a reason, never a silent success",
  );

  assert.deepEqual(
    await notifyHiringManagerOfCandidate({
      actorHrId: "B-118",
      actorIsTheManager: true,
      applicationId: "application-1",
      candidateName: "Osama Ahmed",
      hiringManagerHrId: "B-118",
      jobTitle: "District Sales Manager",
    }),
    { sent: false, reason: "actor_is_the_manager" },
    "a manager assigning to their own seat is told nothing was sent, and why",
  );

  // ── The send itself must be recorded, and only after it succeeds ───────────
  const notify = read("src/lib/recruitment/hiring-manager-notify.ts");
  assert.equal(MANAGER_NOTIFIED_ACTION, "manager_notified");
  assert.match(
    notify,
    // Re-cut 2026-08-30. The `const sentAt` waypoint came out because that line moved ABOVE the
    // delivery in both functions, so a single instant can drive the alert key, the stamp and the
    // fan-out row. It was in any case only still matching here by accident: this regex runs against
    // the WHOLE file, so it was pairing the push's delivery with the OTHER function's `const sentAt`.
    // The property is what matters and is unchanged — the audit row follows the notification.
    /await createSystemNotification\([\s\S]*?writeApplicationEvent\(/,
    "the audit row must be written AFTER the notification, or history can claim a delivery that never happened",
  );
  assert.match(
    notify,
    /eventType: "candidate_assigned"/,
    "the push must ride the candidate_assigned notification event",
  );

  // The failure must reach the caller. This is the exact reversal of the old behaviour: nothing may
  // stand between the function opening and the delivery call that could catch and discard it.
  const notifyBody = notify.slice(notify.indexOf("export async function notifyHiringManagerOfCandidate"));
  assert.ok(
    notifyBody.includes("await createSystemNotification"),
    "notifyHiringManagerOfCandidate must still deliver via createSystemNotification",
  );
  const beforeDelivery = notifyBody.slice(0, notifyBody.indexOf("await createSystemNotification"));
  assert.doesNotMatch(
    beforeDelivery,
    /\btry\b/,
    "the delivery must not sit inside a try — a failed send has to reach the caller, not be swallowed",
  );

  // ── createApplication logs its failure instead of discarding it ────────────
  const applications = read("src/lib/recruitment/applications.ts");
  assert.match(
    applications,
    /catch \(notifyError\)[\s\S]{0,200}logError\(/,
    "a notification failure on application create must be LOGGED, so the silence is diagnosable",
  );
  // The defect itself: the notify call site used to be followed by `} catch {}`.
  assert.doesNotMatch(
    applications,
    /notifyHiringManagerOfCandidate\(\{[\s\S]{0,600}?\}\s*catch\s*\{\s*\}/,
    "the notify call must never be wrapped in an empty catch — that block is what hid 3 of 5 production sends",
  );
  assert.match(
    applications,
    /export async function sendCandidateToHiringManager/,
    "the deliberate, repeatable push must exist as its own service function",
  );

  // ── The recorded send is read back, so the confirmation survives a reload ──
  assert.match(
    applications,
    /managerNotified: notified\.get\(application\.id\) \?\? null/,
    "listApplications must carry the manager_notified stamp, or the UI can only show what it just did",
  );
  assert.match(
    applications,
    /\.eq\("action", MANAGER_NOTIFIED_ACTION\)/,
    "the stamp must be read from the manager_notified audit rows",
  );

  // ── The route exists and is gated like every other recruitment mutation ────
  const route = read("app/api/recruitment/applications/[id]/notify-manager/route.ts");
  assert.match(route, /const csrf = assertSameOriginMutation\(request\);\s*\n\s*if \(csrf\) return csrf;/, "the CSRF guard's return value must be checked, not discarded");
  assert.match(
    route,
    /requireRecruitmentAccess\(request, "recruitment", "update"\)/,
    "the push must require recruitment:update, the same permission as every other stage move",
  );
  assert.match(route, /sendCandidateToHiringManager\(access, id\)/, "the route must call the service, not re-implement it");

  // ── The button, and the on-screen answer to "has the manager been told?" ───
  const workspace = read("src/components/recruitment/recruitment-workspace.tsx");
  assert.match(workspace, /Send to manager/, "there must be a visible Send to manager button");
  assert.match(workspace, /Send again/, "a send that failed or needs repeating must be repeatable");
  assert.match(
    workspace,
    /notify-manager/,
    "the button must post to the notify-manager route",
  );
  assert.match(
    workspace,
    /application\.managerNotified/,
    "the pipeline must show whether the manager was told, not just offer the button",
  );
  // Cairo local time everywhere a moment is shown to a person — the owner's standing rule. Through
  // the shared cairoDateTime, which reads Cairo from the shipped offset table, never the reader's
  // engine (tests/react-418-hydration-safe-text.test.ts §4 (d4)).
  assert.match(
    workspace,
    /import \{[^}]*\bcairoDateTime\b[^}]*\} from "@\/lib\/format\/cairo-datetime";/,
    "the send time must be shown in Cairo local time, never raw UTC",
  );
  assert.match(
    workspace,
    /Sent to \$\{notified\.managerName\} on \$\{cairoDateTime\(notified\.sentAt\)\}/,
    "the pipeline's send time goes through the shared Cairo formatter",
  );

  // ── The SHORT path: candidate → manager, with no requisition in between ────
  //
  // Everything above fixes the push once an application exists. Measured in production on the same
  // day, that was the narrower half of the problem: 221 candidates in the pool and 214 of them had
  // never been shown to anybody, because reaching a manager meant first inventing a requisition with
  // a job title, line, area, seat and owner. None of that is needed to ask someone to read a CV.

  // The stamp lives on the candidate row, not in the application audit table, because there is no
  // application to hang it off.
  const migration = read("supabase/migrations/20260815180000_candidate_manager_push.sql");
  for (const column of ["manager_notified_hr_id", "manager_notified_name", "manager_notified_at"]) {
    assert.match(
      migration,
      new RegExp(`add column if not exists ${column}\\b`),
      `the candidate-level send needs ${column} — without all three the send cannot be read back`,
    );
  }
  assert.match(
    migration,
    /create index if not exists ats_candidates_manager_notified_hr_id_idx[\s\S]{0,200}where manager_notified_hr_id is not null/,
    "the index must be partial — 214 of 221 rows are null and do not belong in it",
  );

  // The send must be readable after a reload, exactly like the application-level one.
  const db = read("src/lib/recruitment/db.ts");
  assert.match(
    db,
    /managerNotified:\s*\n\s*textOrNull\(row\.manager_notified_hr_id\) && textOrNull\(row\.manager_notified_at\)/,
    "mapCandidate must read the stamp back, or the confirmation lives only in component state",
  );

  // The posted HR_ID is user input however the form was drawn: it is re-checked against the same
  // list the picker was rendered from, so a hand-crafted POST cannot notify an arbitrary employee.
  const candidates = read("src/lib/recruitment/candidates.ts");
  assert.match(
    candidates,
    /export async function sendCandidateToManager\(/,
    "the candidate-level push must exist as its own service function",
  );
  assert.match(
    candidates,
    /\(await listHiringManagerOptions\(\)\)\.find\(\(option\) => hrIdsMatch\(option\.hrId, managerHrId\)\)/,
    "the posted manager must be re-validated against the real manager list, never trusted from the request body",
  );

  // The stamp is written only after the manager has actually been told, and a failed WRITE is not
  // swallowed — swallowing it would recreate exactly the invisibility this work exists to end.
  const pushBody = notify.slice(
    notify.indexOf("export async function pushCandidateToManager"),
    notify.indexOf("export async function notifyHiringManagerOfCandidate"),
  );
  assert.ok(pushBody.includes("await createSystemNotification"), "the candidate push must deliver via createSystemNotification");
  assert.doesNotMatch(
    pushBody.slice(0, pushBody.indexOf("await createSystemNotification")),
    /\btry\b/,
    "nothing may catch the delivery — a failed send has to reach the recruiter who pressed the button",
  );
  // Re-cut 2026-08-27, and the reason matters more than the edit. This pin used to require the
  // literal `.update({ … manager_notified_at`, which stopped being the shape the moment the write
  // learned to fall back: it is now `.update(seatColumnsExist ? { ...identity, ...seat } :
  // identity)`, because the three seat columns are newer than this code path and an un-migrated
  // database answers PGRST204. The PROPERTY being pinned is unchanged and is the only thing that
  // matters — the stamp is written AFTER the manager has actually been told — so the pin asserts
  // that ordering and stops dictating the spelling of the object literal in between.
  //
  // Re-cut AGAIN 2026-08-30, and that note holds for a third time. The waypoint dropped this round
  // is `const sentAt`, which moved ABOVE the delivery. The pinned property is untouched — the stamp
  // still follows the notification — and the pin still discriminates, because there is exactly one
  // createSystemNotification in this body, so moving the stamp ahead of it leaves nothing to match.
  assert.match(
    pushBody,
    /await createSystemNotification\([\s\S]*?manager_notified_at/,
    "the stamp must be written AFTER the notification, or the row can claim a send that never happened",
  );
  // The move itself is worth pinning, because ONE instant now drives three things: the alert's
  // idempotency key, the legacy stamp, and the row in ats_candidate_manager_sends. Read it after the
  // delivery instead and the key is minted from a possibly different minute than the stamp, so a
  // double-click could raise two alerts while recording one send — the mirror image of the collapse
  // that hid six of Dina Fadel's seven CVs.
  assert.match(
    pushBody,
    /const sentAt[\s\S]*?await createSystemNotification\(/,
    "sentAt must be read BEFORE the delivery — the alert key, the stamp and the fan-out row all use it and have to agree",
  );
  // Re-cut 2026-08-28, and the note above about pinning a PROPERTY rather than a spelling applies
  // to this pair too — it just took a second change to prove it. These asserted the two literal
  // lines of a TWO-branch write (`attempt.error` / `retry.error`). The position columns arrive in
  // their own migration, separate from the seat columns, so a database can have one and not the
  // other and the write now falls through THREE tiers in a loop; there is no `retry` any more.
  // Behaviour is unchanged and is what these lines still hold: a write that never succeeded throws,
  // and only a missing column is allowed to narrow what is written.
  assert.match(
    pushBody,
    /if \(!written\) throw lastError;/,
    "a failed stamp write must throw — it is the only record of the send",
  );
  assert.match(
    pushBody,
    /if \(!isMissingSeatColumn\(attempt\.error\)\) break;/,
    "and only a MISSING COLUMN may narrow the write — any other failure has to reach the caller",
  );
  assert.doesNotMatch(
    pushBody,
    /catch\s*(\([^)]*\))?\s*\{\s*\}/,
    "nothing around the stamp may swallow an error — an empty catch is the exact defect this module was built to end",
  );

  // Only real managers are offered, and only current employees.
  assert.match(
    notify,
    /\.eq\("employment_status", "Active"\)/,
    "a leaver must never appear in the picker",
  );

  // The route, gated like every other recruitment mutation.
  const candidateRoute = read("app/api/recruitment/candidates/[id]/notify-manager/route.ts");
  assert.match(
    candidateRoute,
    /const csrf = assertSameOriginMutation\(request\);\s*\n\s*if \(csrf\) return csrf;/,
    "the CSRF guard's return value must be checked, not discarded",
  );
  assert.match(
    candidateRoute,
    /requireRecruitmentAccess\(request, "recruitment", "update"\)/,
    "the candidate push must require recruitment:update, the same permission as every other send",
  );
  assert.match(
    candidateRoute,
    /if \(!managerHrId\) \{[\s\S]{0,200}status: 400/,
    "a POST with no manager chosen must be refused, not silently accepted",
  );

  // The control itself, and the on-screen answer to "has anyone been told about this person?".
  assert.match(
    workspace,
    /\/api\/recruitment\/candidates\/\$\{candidate\.id\}\/notify-manager/,
    "the candidate row must post to the candidate-level notify-manager route",
  );
  assert.match(
    workspace,
    /const notified = candidate\.managerNotified;/,
    "the candidate row must read its own recorded send, not just offer the button",
  );
  // The flat `<select>` this replaced was pinned by its placeholder text. It is now the screening
  // queue's grouped picker, shared verbatim, so the pin is on the thing that actually matters: a
  // picker mounted PER ROW and addressed to that row's candidate. The panel id carries the
  // candidate id because the pool can have a row's panel and the bulk bar's panel open at once, and
  // two portals sharing one id is two panels claiming one listbox.
  assert.match(
    workspace,
    /<ManagerPicker/,
    "the manager picker must be on the candidate row itself, where the CV lands",
  );
  assert.match(
    workspace,
    /panelId=\{`pool-manager-\$\{candidate\.id\}`\}/,
    "each row's picker must be its own panel, not one shared across the pool",
  );
  assert.match(
    workspace,
    /Sent to \{notified\.name\} on \{cairoDateTime\(notified\.sentAt\)\}/,
    "the send must read back by the manager's NAME in Cairo time — never an HR_ID, never raw UTC",
  );
}
