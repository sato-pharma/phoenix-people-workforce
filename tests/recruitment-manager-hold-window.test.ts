import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isBatchActor } from "../src/lib/recruitment/batch-actor.ts";
import {
  assembleSentCandidates,
  buildHoldReturnDigest,
  buildHoldReturnNote,
  classifyExpiredHolds,
  MANAGER_HOLD_RETURN_ACTOR,
  MANAGER_HOLD_RETURN_STATUS,
  type ExpiredHold,
  type SentCandidateRecord,
} from "../src/lib/recruitment/manager-hold-return.ts";
import {
  folderHoldAnchor,
  isWithinFolderHold,
  isWithinManagerHold,
  MANAGER_HOLD_DAYS,
  managerHoldCutoff,
  managerHoldCutoffIso,
  managerHoldDaysHeld,
  managerHoldExpiresAt,
} from "../src/lib/recruitment/manager-hold-window.ts";

/**
 * "Collect all old CVs from the manager's accounts and make it stay in their account maximum 45
 *  days. Then collect it back to the admin. Never a CV stay at a district manager account or any
 *  manager account more than 45 days." — the owner, 2026-10-06.
 *
 * Three things are pinned, because each can fail on its own while the other two stay green:
 *
 *   1. THE RULE — one number, one comparison. Every query that applies it asks `column >= cutoff` and
 *      the function asks `at >= cutoff`, so a CV the database keeps and a CV the code keeps are the
 *      same CV to the millisecond. A date that cannot be read fails CLOSED.
 *   2. EVERY ROUTE A CV REACHES A MANAGER BY APPLIES IT — the pushed list, the gate that opens a
 *      pushed CV, the team picker's count, the team gate, the district folders and the gate behind
 *      them. A route that forgot it is a CV a manager can still read on day 46, and nothing on screen
 *      would say so. The report path must NOT apply it (a CV that aged out was still received).
 *   3. THE DAILY RETURN — a CV goes back to the desk only when EVERY manager holding it is past 45
 *      days, as `shortlisted`, under an `ops:` actor, before the stale-send job reads the status.
 */

const NOW = new Date("2026-10-06T10:00:00.000Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

/** The text of one exported function, from its `export` line to the next top-level `export`. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = source.indexOf("\nexport ", start + 10);
  return source.slice(start, next === -1 ? undefined : next);
}

function record(
  id: string,
  sends: Array<{ days: number; hrId?: string; name?: string | null }>,
  status: string | null = "sent_to_manager",
): SentCandidateRecord {
  return {
    fullName: `Candidate ${id}`,
    id,
    sends: sends.map((send, index) => ({
      managerHrId: send.hrId ?? `B-${index + 10}`,
      managerName: send.name === undefined ? `Manager ${index + 1}` : send.name,
      sentAt: ago(send.days * DAY),
    })),
    status,
  };
}

export function runRecruitmentManagerHoldWindowTests() {
  // ── 1. The rule ──────────────────────────────────────────────────────────────────────────────
  assert.equal(MANAGER_HOLD_DAYS, 45, "the owner's number, 2026-10-06 — raising it needs him to say so");
  assert.equal(
    managerHoldCutoff(NOW).getTime(),
    NOW.getTime() - 45 * DAY,
    "the cutoff is exactly 45 days before now",
  );
  assert.equal(managerHoldCutoffIso(NOW), new Date(NOW.getTime() - 45 * DAY).toISOString());

  assert.equal(isWithinManagerHold(ago(0), NOW), true, "sent just now is inside");
  assert.equal(isWithinManagerHold(ago(44 * DAY + 23 * HOUR), NOW), true, "44 days 23 hours is inside");
  assert.equal(
    isWithinManagerHold(ago(45 * DAY), NOW),
    true,
    "exactly on the cutoff is inside — the SAME `>=` every database filter uses, so the two never disagree at the boundary",
  );
  assert.equal(isWithinManagerHold(ago(45 * DAY + 1), NOW), false, "one millisecond past 45 days is out");
  assert.equal(isWithinManagerHold(ago(200 * DAY), NOW), false, "a CV from July is out");
  assert.equal(isWithinManagerHold(ago(-HOUR), NOW), true, "a stamp slightly in the future (clock skew) is not an old CV");

  for (const unreadable of [null, undefined, "", "   ", "not a date", "2026-13-45"]) {
    assert.equal(
      isWithinManagerHold(unreadable as string | null | undefined, NOW),
      false,
      `${JSON.stringify(unreadable)} must FAIL CLOSED — "never more than 45 days" cannot be promised about a CV whose age is unknown`,
    );
  }

  assert.equal(managerHoldExpiresAt(ago(10 * DAY)), new Date(NOW.getTime() - 10 * DAY + 45 * DAY).toISOString());
  assert.equal(managerHoldExpiresAt("garbage"), null);
  assert.equal(managerHoldDaysHeld(ago(44 * DAY + 23 * HOUR), NOW), 44, "held days are FLOORED: 44d 23h is not 45");
  assert.equal(managerHoldDaysHeld(ago(45 * DAY), NOW), 45);
  assert.equal(managerHoldDaysHeld(null, NOW), 0);

  // ── The folder clock: the LATER of arrival and the applicant's last declaration ───────────────
  assert.equal(
    folderHoldAnchor({ createdAt: ago(100 * DAY), preferencesDeclaredAt: ago(3 * DAY) }),
    ago(3 * DAY),
    "an applicant who came back and re-declared their area re-applied — the later date is the anchor",
  );
  assert.equal(folderHoldAnchor({ createdAt: ago(3 * DAY), preferencesDeclaredAt: ago(100 * DAY) }), ago(3 * DAY));
  assert.equal(folderHoldAnchor({ createdAt: ago(7 * DAY), preferencesDeclaredAt: null }), ago(7 * DAY));
  assert.equal(folderHoldAnchor({ createdAt: "", preferencesDeclaredAt: undefined }), null);
  assert.equal(isWithinFolderHold({ createdAt: ago(46 * DAY), preferencesDeclaredAt: null }, NOW), false, "arrived 46 days ago, never re-declared: out of every folder");
  assert.equal(isWithinFolderHold({ createdAt: ago(46 * DAY), preferencesDeclaredAt: ago(2 * DAY) }, NOW), true, "…unless the applicant updated their answers inside the window");
  assert.equal(isWithinFolderHold({ createdAt: ago(10 * DAY) }, NOW), true);
  assert.equal(isWithinFolderHold({}, NOW), false, "no date at all fails closed");

  // ── 2. Every route a CV reaches a manager by applies the window ───────────────────────────────
  const sends = read("../src/lib/recruitment/manager-sends.ts");
  const listSends = functionBody(sends, "listSendsForManager");
  const gateSend = functionBody(sends, "isCandidateSentToManager");
  assert.ok(
    listSends.includes('query.gte("sent_at", managerHoldCutoffIso(now))') &&
      listSends.includes("managerHoldsFolders(managerHrId)"),
    "the manager's pushed list must drop a send older than 45 days — unless he holds folders (owner, 2026-10-16)",
  );
  assert.ok(
    gateSend.includes('query.gte("sent_at", managerHoldCutoffIso(now))') &&
      gateSend.includes("managerHoldsFolders(managerHrId)"),
    "…and the gate behind it must answer with the SAME cutoff and the SAME exemption, or a CV off his list can still be opened by id",
  );
  for (const history of ["listSendsForCandidate", "listLatestSendByCandidate"]) {
    assert.ok(
      !functionBody(sends, history).includes("managerHoldCutoffIso"),
      `${history} is HISTORY (the timeline and the screening queue) — an expired send must stay on the trail`,
    );
  }

  const candidates = read("../src/lib/recruitment/candidates.ts");
  const inbox = functionBody(candidates, "listCandidatesSentToManager");
  assert.ok(
    /\.in\("manager_notified_hr_id", keys\)[\s\S]*?managerHoldsFolders\(managerHrId\)[\s\S]*?\.gte\("manager_notified_at", managerHoldCutoffIso\(now\)\)[\s\S]*?\.order\("manager_notified_at"/.test(inbox),
    "the single-manager stamp (the second source of the pushed list) must be cut at 45 days too, for everyone but a folder holder",
  );
  assert.ok(inbox.includes("listSendsForManager(managerHrId, now)"), "both sources read the same instant");

  const view = read("../src/lib/recruitment/hiring-manager-view.ts");
  assert.match(
    view,
    /hrIdsMatch\(String\(stamped\), access\.hrId\) &&\s*\(isWithinManagerHold\(String\(row\?\.manager_notified_at[\s\S]*?managerHoldsFolders\(access\.hrId\)/,
    "the file gate's stamp check must expire with the list, and carry the same folder-holder exemption",
  );

  const team = read("../src/lib/recruitment/hiring-manager-team.ts");
  assert.match(
    team,
    /\.in\("manager_notified_hr_id", chunk\)[\s\S]*?!holders\.has\(key\) && !isWithinManagerHold\(String\(row\.manager_notified_at/,
    "the team picker's count must equal what the list behind it shows",
  );
  assert.match(
    team,
    /if \(!isWithinManagerHold\(String\(row\?\.manager_notified_at[\s\S]*?managerHoldsFolders\(String\(stamped\)\)/,
    "the team gate must expire with the push it reads",
  );

  const folders = read("../src/lib/recruitment/district-manager-folders-db.ts");
  // Since 2026-10-16 the folders are filled by the manager's sends, so the 45 days are applied where
  // the sends are read — `listSendsForManager` (asserted above) — and not to a candidate row.
  const forManager = functionBody(folders, "listDistrictBoardsForManager");
  assert.ok(
    forManager.includes("await listSendsForManager(managerHrId)"),
    "the manager-scoped folder loader reads his sends through the one function that drops a send past 45 days",
  );
  assert.ok(
    functionBody(folders, "loadAllDistrictBoards").includes("listAllManagerSends()"),
    "the whole-company report path must NOT apply the window — a CV that aged out of a manager's account was still received",
  );
  assert.ok(
    !functionBody(folders, "districtBoardsHoldingCandidate").includes("isWithinManagerHold"),
    "a board exists only for a manager who holds folders, and a folder holder has no window (owner, 2026-10-16)",
  );

  const engagement = read("../src/lib/recruitment/manager-cv-engagement.ts");
  assert.ok(
    !engagement.includes("manager-hold-window"),
    "the engagement report counts everything a manager RECEIVED, expired or not — a CV he sat on for 45 days unopened is the signal it exists to show, exactly as a returned CV still counts",
  );

  // ── 3. The daily return ───────────────────────────────────────────────────────────────────────
  const oneManagerExpired = record("c1", [{ days: 46 }]);
  const twoManagersOneFresh = record("c2", [{ days: 60 }, { days: 5 }]);
  const twoManagersBothExpired = record("c3", [{ days: 46 }, { days: 90 }]);
  const alreadyDecided = record("c4", [{ days: 80 }], "shortlisted");
  const noReadableDate: SentCandidateRecord = {
    fullName: "Candidate c5",
    id: "c5",
    sends: [{ managerHrId: "B-10", managerName: "Manager", sentAt: "unknown" }],
    status: "sent_to_manager",
  };
  const noSendsAtAll = record("c6", []);
  const onTheBoundary = record("c7", [{ days: 45 }]);

  const expired = classifyExpiredHolds(
    [oneManagerExpired, twoManagersOneFresh, twoManagersBothExpired, alreadyDecided, noReadableDate, noSendsAtAll, onTheBoundary],
    NOW,
  );
  assert.deepEqual(
    expired.map((item) => item.candidateId),
    ["c1", "c3"],
    "only a CV past 45 days with EVERY manager that holds it goes back: not one with a fresh second manager, not one already decided, not one whose age is unreadable, not one exactly on the boundary",
  );
  assert.deepEqual(
    expired[1].holds.map((hold) => hold.daysHeld),
    [90, 46],
    "holds are listed oldest first, each with its whole days held",
  );
  // A manager who holds folders is never past his window (owner, 2026-10-16: "lift it").
  const folderHolder = record("f1", [{ days: 90, hrId: "B-12" }]);
  assert.deepEqual(
    classifyExpiredHolds([folderHolder], NOW, new Set(["b-12"])).map((item) => item.candidateId),
    [],
    "a 90-day-old CV held by a folder holder stays",
  );
  assert.deepEqual(
    classifyExpiredHolds([folderHolder], NOW).map((item) => item.candidateId),
    ["f1"],
    "…and the same CV goes back when the holder is not exempt",
  );
  assert.equal(
    classifyExpiredHolds([record("x", [{ days: 46 }], " sent_to_manager ")], NOW).length,
    1,
    "the status is read through normalizeCandidateStatus, not by string equality",
  );

  // Assembly: the table and the legacy stamp, deduplicated per manager, the NEWER date winning.
  const assembled = assembleSentCandidates(
    [
      {
        full_name: "Alice",
        id: "a1",
        manager_notified_at: ago(50 * DAY),
        manager_notified_hr_id: "b-12",
        manager_notified_name: "Dr Bee",
        status: "sent_to_manager",
      },
      {
        full_name: "Bella",
        id: "a2",
        manager_notified_at: ago(50 * DAY),
        manager_notified_hr_id: "B-20",
        manager_notified_name: "Dr Cee",
        status: "sent_to_manager",
      },
    ],
    [{ candidate_id: "a1", manager_hr_id: "B-12", manager_name: "Dr Bee", sent_at: ago(10 * DAY) }],
  );
  assert.equal(assembled[0].sends.length, 1, "b-12 and B-12 are one manager — HR ids are mixed case in this database");
  assert.equal(assembled[0].sends[0].sentAt, ago(10 * DAY), "the re-send in the table beats the stale legacy stamp");
  assert.equal(
    classifyExpiredHolds(assembled, NOW).map((item) => item.candidateId).join(","),
    "a2",
    "a re-sent CV stays; a CV known only by an old legacy stamp goes back",
  );

  // The note and the digest speak in names, in full.
  const note = buildHoldReturnNote(expired[0]);
  assert.ok(note.includes("45 days") && note.includes("Manager 1"), "the note says how long and with whom");
  const crowd: ExpiredHold = {
    candidateId: "crowd",
    fullName: "Crowded",
    holds: Array.from({ length: 40 }, (_, index) => ({
      daysHeld: 50,
      managerHrId: `B-${100 + index}`,
      managerName: `A Manager With A Rather Long Name Number ${index}`,
      sentAt: ago(50 * DAY),
    })),
  };
  assert.ok(buildHoldReturnNote(crowd).length <= 300, "a note never exceeds the 300 characters the column refuses past");
  assert.ok(!buildHoldReturnNote(crowd).includes("…"), "…and is never cut with an ellipsis — it falls back to a shorter sentence");

  const digest = buildHoldReturnDigest([
    { candidateId: "c1", fullName: "Alice Adams", holds: [{ daysHeld: 46, managerHrId: "B-12", managerName: "Dr Bee", sentAt: ago(46 * DAY) }] },
    {
      candidateId: "c3",
      fullName: "Carla Cole",
      holds: [
        { daysHeld: 90, managerHrId: "B-12", managerName: "Dr Bee", sentAt: ago(90 * DAY) },
        { daysHeld: 46, managerHrId: "B-30", managerName: null, sentAt: ago(46 * DAY) },
      ],
    },
  ]);
  assert.equal(digest.title, "2 CVs came back from managers after 45 days");
  for (const expectedText of ["Alice Adams", "Carla Cole", "Dr Bee", "Unnamed manager"]) {
    assert.ok(digest.message.includes(expectedText), `the digest names "${expectedText}" in full`);
  }
  assert.ok(!/\bB-\d+/.test(digest.message), "never a raw HR id in a message a person reads");
  assert.ok(!digest.message.includes("…") && !digest.message.includes("..."), "nothing summarised away behind an ellipsis");

  // Who the event names, and where it goes back to.
  assert.equal(isBatchActor(MANAGER_HOLD_RETURN_ACTOR), true, "an `ops:` actor, so throughput reports never count it as a person's decision");
  assert.equal(MANAGER_HOLD_RETURN_STATUS, "shortlisted", "back to the desk as shortlisted — never `new`, which would feed the triage backlog alarm");

  const returnSource = read("../src/lib/recruitment/manager-hold-return.ts");
  assert.ok(
    returnSource.includes("returnSentCvToShortlist(recruitmentDb(), {") &&
      read("../src/lib/recruitment/manager-recall-status.ts").includes('.eq("status", "sent_to_manager")'),
    "the status move is CONDITIONAL — a manager's answer a minute ago must not be overwritten by a nightly sweep",
  );
  assert.ok(
    returnSource.includes("statusActorHrId: null") && returnSource.includes("eventActorHrId: MANAGER_HOLD_RETURN_ACTOR"),
    "the actor lives on the event row, never on the candidate",
  );
  assert.ok(
    !returnSource.includes('from "@/lib/recruitment/candidates"'),
    "it must not import the person's-click path (updateCandidateStatus), which refuses sent_to_manager → shortlisted on purpose",
  );
  assert.ok(returnSource.includes("channels: [...STALE_SEND_CHANNELS]"), "in-app, Telegram and push only");
  assert.ok(!/channels:[^\n]*"email"/.test(returnSource), "never email — an automated daily job");

  const daily = read("../src/lib/recruitment/notifications.ts");
  const returnAt = daily.indexOf("await runManagerHoldReturn()");
  const staleAt = daily.indexOf("await runStaleSendCheck()");
  assert.ok(returnAt > 0 && staleAt > 0, "both jobs run in the daily recruitment pass");
  assert.ok(
    returnAt < staleAt,
    "the return runs BEFORE the stale-send check, or that check nudges a manager about a CV the return just took back",
  );

  // ── What a manager is told ────────────────────────────────────────────────────────────────────
  // The folders screen no longer promises a limit (owner, 2026-10-16); the list of other CVs sent to him
  // still tells a manager about the 45 days, from the one constant.
  assert.ok(
    !read("../src/components/employee-portal/district-folders-section.tsx").includes("MANAGER_HOLD_DAYS"),
    "a folder holder is not held to 45 days, so his folders screen must not say he is",
  );
  assert.ok(
    read("../src/components/employee-portal/recruitment-candidates-portal.tsx").includes("MANAGER_HOLD_DAYS"),
    "a CV sent to a manager who holds no folders still goes back after 45 days, and the screen says so from the one constant",
  );
}
