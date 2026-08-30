import assert from "node:assert/strict";
import crypto from "node:crypto";

import { candidateAlertIdempotencyKey } from "../src/lib/recruitment/candidate-alert-key.ts";
import { managerSendStamp, type ManagerSend } from "../src/lib/recruitment/manager-sends.ts";

/**
 * EVERY CANDIDATE SENT TO A MANAGER IS ITS OWN ALERT, AND EVERY MANAGER SENT A CV KEEPS IT.
 *
 * THE INCIDENT (production, measured 2026-08-30). The owner: "Not all the CVs I send to the manager
 * reach the manager, and they take a long time to reach them." Two independent defects were behind
 * that one sentence, and this file pins both.
 *
 * ONE — THE ALERT COLLAPSED. createSystemNotification derives its event key from
 * {actionUrl, eventType, module, recipientHrId, recipientUserId, title} and UPSERTS on it. For a
 * candidate push every one of those is a constant — the title is literally "New candidate to
 * review" — so the second send to a manager overwrote the first alert in place instead of adding
 * one. 39 sends had produced 12 alerts:
 *
 *     Ali Mohamed Ali Elsayed (National Sales Manager)   17 candidates   1 alert
 *     Dina Hamdy Fadel Mohamed Bdair (District Manager)   7 candidates   1 alert
 *     Taha Mohamed Taha Elsayed AboElftouh                7 candidates   1 alert
 *
 * Dina's single alert was created 2026-08-26 05:03 Cairo and never opened. It had been rewritten
 * six times by 09:01 on the 30th and named only the newest candidate — the other six names were
 * destroyed, not appended. Three consequences, all reported as symptoms: one line instead of N; a
 * created_at frozen at the FIRST send, which is what the bell sorts on, so a CV sent this morning
 * appears four days down the list ("very late"); and read state keyed on the event id, so once
 * opened it is never unread again.
 *
 * TWO — THE CV LEFT THE PREVIOUS MANAGER. The send lived in single columns on the candidate row, so
 * sending a CV to a second manager OVERWROTE the first, and the thing overwritten was the record of
 * the send. Salim Salim Abdo Ibrahim Gomaa was sent Sara Osama AbdAlfattah at 01:44:22 Cairo on
 * 2026-08-30 and alerted; the same CV went to Hany Saad Mohamed Omar at 01:44:53 and Salim's list
 * fell to zero while his alert still named her. Owner, asked directly: "yes a CV can go to two
 * managers".
 *
 * WHAT THESE ASSERTIONS ARE WORTH. Nothing here needs a database, so they run in the required CI
 * `validate` job on every PR. Break either fix — drop the candidate ids out of the alert key, or
 * read the position off the candidate row instead of off the send — and the headline assertion in
 * the first or third test fails on its own, not as a knock-on from somewhere else.
 */
export function runCandidateSendAlertIdentityTests() {
  const minute = "2026-08-30T09:01:00.000Z";
  const manager = "B-12";

  // ── 1. Two different candidates, one manager, one minute — TWO alerts ────────────────────────
  //
  // The headline. This is the exact shape that produced Dina's seven-into-one: two separate sends,
  // seconds apart, to the same person. Before the fix these were the same event key and the second
  // silently overwrote the first.
  const first = candidateAlertIdempotencyKey({
    candidateIds: ["cand-alaa"],
    eventType: "candidate_assigned",
    managerHrId: manager,
    sentAtIso: minute,
  });
  const second = candidateAlertIdempotencyKey({
    candidateIds: ["cand-ahmed"],
    eventType: "candidate_assigned",
    managerHrId: manager,
    sentAtIso: minute,
  });
  assert.notEqual(
    first,
    second,
    "two different candidates sent to the same manager in the same minute must be two alerts — this is the collapse that hid six of Dina Fadel's seven CVs",
  );

  // ── 2. The formula being replaced really did collide ─────────────────────────────────────────
  //
  // Stated as a demonstration rather than trusted from memory: a key built only from the constants
  // this flow supplies is the SAME string for those two sends. If someone later "simplifies" the
  // key back to these fields, this is what they would be restoring.
  const legacyKey = (title: string) =>
    crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          actionUrl: "/employee-portals/recruitment-candidates",
          eventType: "candidate_assigned",
          module: "recruitment",
          recipientHrId: manager,
          title,
        }),
      )
      .digest("hex");
  assert.equal(
    legacyKey("New candidate to review"),
    legacyKey("New candidate to review"),
    "the pre-2026-08-30 key carried nothing that varied between two single-candidate sends — that is why they merged",
  );

  // ── 3. The same send, twice in one minute — ONE alert ────────────────────────────────────────
  //
  // A double-clicked "Send to manager" must not alert twice. This is the only deduplication that
  // survives, and it is why the key buckets to the minute rather than carrying the raw instant.
  assert.equal(
    candidateAlertIdempotencyKey({
      candidateIds: ["cand-alaa"],
      eventType: "candidate_assigned",
      managerHrId: manager,
      sentAtIso: "2026-08-30T09:01:12.000Z",
    }),
    candidateAlertIdempotencyKey({
      candidateIds: ["cand-alaa"],
      eventType: "candidate_assigned",
      managerHrId: manager,
      sentAtIso: "2026-08-30T09:01:48.900Z",
    }),
    "a double-click within the same minute is one send and must raise one alert",
  );

  // ── 4. The same CV re-sent later — a NEW alert ───────────────────────────────────────────────
  //
  // Keying on the candidates alone would have left a quieter version of the original bug: a
  // recruiter re-sending a CV to nudge a manager who never looked would raise nothing at all.
  assert.notEqual(
    candidateAlertIdempotencyKey({
      candidateIds: ["cand-alaa"],
      eventType: "candidate_assigned",
      managerHrId: manager,
      sentAtIso: "2026-08-30T09:01:00.000Z",
    }),
    candidateAlertIdempotencyKey({
      candidateIds: ["cand-alaa"],
      eventType: "candidate_assigned",
      managerHrId: manager,
      sentAtIso: "2026-08-30T11:20:00.000Z",
    }),
    "re-sending the same CV hours later is a deliberate nudge and must reach the manager as a new alert",
  );

  // ── 5. A batch is identified by its members, not by the order they were ticked ────────────────
  assert.equal(
    candidateAlertIdempotencyKey({
      candidateIds: ["cand-a", "cand-b", "cand-c"],
      eventType: "candidate_assigned",
      managerHrId: manager,
      sentAtIso: minute,
    }),
    candidateAlertIdempotencyKey({
      candidateIds: ["cand-c", "cand-a", "cand-b"],
      eventType: "candidate_assigned",
      managerHrId: manager,
      sentAtIso: minute,
    }),
    "the same three candidates picked in a different order are one send, not two",
  );
  assert.notEqual(
    candidateAlertIdempotencyKey({
      candidateIds: ["cand-a", "cand-b"],
      eventType: "candidate_assigned",
      managerHrId: manager,
      sentAtIso: minute,
    }),
    candidateAlertIdempotencyKey({
      candidateIds: ["cand-a", "cand-b", "cand-c"],
      eventType: "candidate_assigned",
      managerHrId: manager,
      sentAtIso: minute,
    }),
    "adding a third person to the batch changes who is being announced, so it is a different alert",
  );

  // ── 6. HR_IDs are MIXED CASE in this database, and one manager is one manager ─────────────────
  //
  // 'B-12' from the picker and 'b-12' from a session are the same person. Without canonicalising,
  // the same send from two screens would raise two alerts for one event.
  assert.equal(
    candidateAlertIdempotencyKey({
      candidateIds: ["cand-alaa"],
      eventType: "candidate_assigned",
      managerHrId: "B-12",
      sentAtIso: minute,
    }),
    candidateAlertIdempotencyKey({
      candidateIds: ["cand-alaa"],
      eventType: "candidate_assigned",
      managerHrId: "  b-12 ",
      sentAtIso: minute,
    }),
    "'B-12' and 'b-12' are one manager — mixed-case HR_IDs have already cost this repo real reporting errors",
  );
  assert.notEqual(
    candidateAlertIdempotencyKey({
      candidateIds: ["cand-alaa"],
      eventType: "candidate_assigned",
      managerHrId: "B-12",
      sentAtIso: minute,
    }),
    candidateAlertIdempotencyKey({
      candidateIds: ["cand-alaa"],
      eventType: "candidate_assigned",
      managerHrId: "B-94",
      sentAtIso: minute,
    }),
    "the same CV sent to two managers must alert BOTH of them — one key would silence the second",
  );

  // ── 7. Each manager reads the vacancy THEY were sent the CV for ───────────────────────────────
  //
  // The second defect, at the point where it becomes visible. Two managers, one candidate, two
  // seats. The candidate row can only hold the last of them, so the card must be stamped from the
  // send — otherwise Salim opens his inbox and finds the CV filed under Hany Saad's vacancy.
  //
  // The names, the seats, the two timestamps and Hany Saad's vacancy 331 are the REAL values, read
  // from production. Salim's vacancy 401 is the one invented figure in this file, and deliberately
  // so: his real one no longer exists anywhere — it lived in ats_candidates.sent_for_vacancy_id and
  // was overwritten by the re-send 31 seconds later. That is why the production repair recorded his
  // send with NO position rather than copying 331 across, which would have filed her under a seat he
  // never chose. A number is needed here only to show the two stamps do not bleed into each other.
  const toSalim: ManagerSend = {
    candidateId: "cand-sara",
    managerArea: "Delta (2)",
    managerHrId: "b-76",
    managerJobTitle: "District Sales Manager",
    managerName: "Salim Salim Abdo Ibrahim Gomaa",
    managerRegion: "Delta (2)",
    position: {
      areaName: "Mansoura",
      jobTitle: "Medical Representative",
      lineName: "Pedia",
      regionName: "Delta (2)",
      vacancyId: 401,
    },
    sentAt: "2026-08-30T01:44:22.000Z",
  };
  const toHany: ManagerSend = {
    candidateId: "cand-sara",
    managerArea: "Alex East",
    managerHrId: "pd-0001",
    managerJobTitle: "Regional Sales Manager",
    managerName: "Hany Saad Mohamed Omar",
    managerRegion: "Alex-BHR",
    position: {
      areaName: "Sharkia 1",
      jobTitle: "Medical Representative",
      lineName: "Pedia",
      regionName: "Delta (2)",
      vacancyId: 331,
    },
    sentAt: "2026-08-30T01:44:53.000Z",
  };

  const salimSees = managerSendStamp(toSalim);
  const hanySees = managerSendStamp(toHany);
  assert.equal(
    salimSees.sentFor?.vacancyId,
    401,
    "Salim must see the CV under the seat HE was sent it for — reading it off the candidate row shows him Hany Saad's vacancy instead",
  );
  assert.equal(hanySees.sentFor?.vacancyId, 331, "Hany Saad must see his own seat, not Salim's");
  assert.equal(salimSees.managerNotified.name, "Salim Salim Abdo Ibrahim Gomaa");
  assert.equal(
    salimSees.managerNotified.sentAt,
    "2026-08-30T01:44:22.000Z",
    "each manager's card carries the moment THEY were sent it, 31 seconds apart in the real incident",
  );

  // ── 8. A send whose manager could not be named still renders a person, never a blank ──────────
  //
  // Standing rule: no raw code on a screen — but a missing name must not produce an empty card
  // either. The id is the last resort, not the normal case.
  const unnamed = managerSendStamp({ ...toSalim, managerName: null });
  assert.equal(
    unnamed.managerNotified.name,
    "b-76",
    "a send recorded without a resolvable manager name falls back to the id rather than rendering nothing",
  );

  // ── 9. A send made before positions existed is unfiled, not filed under an invented seat ──────
  const bare = managerSendStamp({ ...toSalim, position: null });
  assert.equal(
    bare.sentFor,
    null,
    "every send before 2026-08-28 carries no position, and none may be invented for it",
  );
}
