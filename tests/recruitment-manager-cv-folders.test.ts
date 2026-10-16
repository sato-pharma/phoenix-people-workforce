import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  boardsForManager,
  districtReturnSuppressionKey,
  type DistrictSeatRow,
} from "../src/lib/recruitment/district-manager-folders.ts";
import { foldersToOffer } from "../src/lib/recruitment/folder-choice.ts";
import { folderHolderKeys } from "../src/lib/recruitment/folder-holders.ts";
import {
  chooseFolderForPush,
  fillShelvesFromSends,
  isReminderHour,
  isSendUnseen,
  isWithinReminderWindow,
  managerFolderShelves,
  OTHER_CVS_FOLDER_LABEL,
  REMINDER_MAX_DAYS,
  reminderHourBucket,
  summarizeManagerFolders,
  unseenIdsOnBoards,
  unseenSendsByManager,
  type FolderSend,
} from "../src/lib/recruitment/manager-cv-folders.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * "No more managers receive CVs automatic. Every manager has an empty folder for every area in his
 *  region, based on the organogram. The TA or admin pushes a CV whenever needed and can any time get
 *  it back. When the CV reaches the managers there is no restriction ... a small row in their overview
 *  holding folders of the CVs ... the folder pumps notifications and never stops until the CV is
 *  seen."  — the owner, 2026-10-16.
 *
 * THE RISK THIS SUITE EXISTS FOR is a folder that fills itself again. Before this change a sweep of
 * the whole CV pool decided who "should" receive each applicant, so a manager's folder held CVs nobody
 * had sent him. Every assertion about the shelves therefore starts from EMPTY, and the source pins
 * below refuse the placement rule coming back into the loader.
 */

function seat(fields: Partial<DistrictSeatRow>): DistrictSeatRow {
  return { is_vacant: false, ...fields };
}

const ROWS: DistrictSeatRow[] = [
  seat({ seat_id: "ceo", seat_tier: "CEO", occupant_hr_id: "C-1", seat_display_label: "CEO" }),
  seat({ seat_id: "nsm", parent_seat_id: "ceo", seat_tier: "NSM", occupant_hr_id: "N-1", line_name: "CNS", seat_display_label: "CNS NSM" }),
  seat({ seat_id: "rsm", parent_seat_id: "nsm", seat_tier: "RSM", occupant_hr_id: "R-1", line_name: "CNS", region_name: "Cairo Region", seat_display_label: "CNS Cairo RSM" }),
  seat({ seat_id: "dm-cairo", parent_seat_id: "rsm", seat_tier: "DM", occupant_hr_id: "D-1", line_name: "CNS", region_name: "Cairo", seat_display_label: "CNS Cairo DM" }),
  seat({ seat_id: "dm-cairo-1", parent_seat_id: "dm-cairo", seat_tier: "REP", area_name: "Nasr City" }),
  seat({ seat_id: "dm-cairo-2", parent_seat_id: "dm-cairo", seat_tier: "REP", area_name: "Heliopolis" }),
  seat({ seat_id: "dm-delta", parent_seat_id: "nsm", seat_tier: "DM", occupant_hr_id: "D-2", line_name: "CNS", region_name: "Delta", seat_display_label: "CNS Delta DM" }),
  seat({ seat_id: "dm-delta-1", parent_seat_id: "dm-delta", seat_tier: "REP", area_name: "Tanta" }),
];

type Cv = { id: string; managerNotified?: { sentAt: string } | null };

const cv = (id: string, sentAt?: string): Cv => ({ id, managerNotified: sentAt ? { sentAt } : null });

const send = (candidateId: string, managerHrId: string, sentAt: string, folderArea: string | null): FolderSend => ({
  candidateId,
  folderArea,
  managerHrId,
  sentAt,
});

const names = (folderList: { areaName: string }[]) => folderList.map((folder) => folder.areaName);

export function runRecruitmentManagerCvFoldersTests(): void {
  // ── 1 · THE SHELVES START EMPTY, ONE FOLDER PER AREA, STRAIGHT OFF THE ORGANOGRAM ───────────────
  const shelves = managerFolderShelves<Cv>(ROWS);
  {
    const dm = boardsForManager(shelves, "D-1");
    assert.equal(dm.length, 1, "a district manager holds one board");
    assert.deepEqual(
      new Set(names(dm[0].folders)),
      new Set(["Nasr City", "Heliopolis", OTHER_CVS_FOLDER_LABEL]),
      "his own areas plus the one catch-all, and nothing else",
    );
    assert.ok(
      shelves.every((board) => board.candidateCount === 0 && board.folders.every((folder) => folder.candidates.length === 0)),
      "every shelf starts EMPTY — nothing is delivered automatically",
    );

    const regional = boardsForManager(shelves, "R-1");
    assert.deepEqual(
      new Set(names(regional[0].folders)),
      new Set(["Nasr City", "Heliopolis", OTHER_CVS_FOLDER_LABEL]),
      "a regional manager holds every area beneath him",
    );

    const national = boardsForManager(shelves, "N-1");
    assert.deepEqual(
      new Set(names(national[0].folders)),
      new Set(["Nasr City", "Heliopolis", "Tanta", OTHER_CVS_FOLDER_LABEL]),
      "a national manager holds the areas of both districts, merged into one board",
    );

    assert.deepEqual(boardsForManager(shelves, "C-1"), [], "the CEO holds no folders");
    assert.deepEqual(boardsForManager(shelves, "x-99"), [], "a person with no seat holds none");
    assert.deepEqual(boardsForManager(shelves, "d-1").map((board) => board.seatId), ["dm-cairo"], "matched the way every HR id is, case aside");
  }

  // ── 2 · A CV IS IN A FOLDER BECAUSE IT WAS SENT, AND ONLY THEN ──────────────────────────────────
  {
    const candidates = new Map<string, Cv>([
      ["a", cv("a")],
      ["b", cv("b")],
      ["c", cv("c")],
      ["unsent", cv("unsent")],
    ]);
    const boards = fillShelvesFromSends({
      candidates,
      sends: [
        send("a", "D-1", "2026-10-10T09:00:00.000Z", "Nasr City"),
        send("b", "D-1", "2026-10-12T09:00:00.000Z", "Nasr City"),
        send("c", "D-1", "2026-10-11T09:00:00.000Z", "Atlantis"),
        send("a", "H-9", "2026-10-11T09:00:00.000Z", "Nasr City"),
      ],
      shelves,
    });
    const dm = boardsForManager(boards, "D-1")[0];
    const folder = (name: string) => dm.folders.find((entry) => entry.areaName === name)!;
    assert.deepEqual(folder("Nasr City").candidates.map((entry) => entry.id), ["b", "a"], "newest send first");
    assert.deepEqual(folder(OTHER_CVS_FOLDER_LABEL).candidates.map((entry) => entry.id), ["c"], "an area that is none of his goes to Other CVs");
    assert.deepEqual(folder("Heliopolis").candidates, [], "a folder nobody sent into stays empty");
    assert.equal(dm.candidateCount, 3, "the board counts what is filed");
    assert.ok(
      boards.flatMap((board) => board.folders).every((entry) => entry.candidates.every((held) => held.id !== "unsent")),
      "a CV nobody sent to anyone is in no folder, whatever its area",
    );
    assert.ok(
      boards.every((board) => board.managerHrId !== "H-9"),
      "a manager with no shelf (head office) is not filed anywhere — those CVs stay on Sent to you",
    );
    assert.equal(shelves[0].candidateCount, 0, "the shelves passed in are not touched");
  }

  // ── 3 · WHICH FOLDER A PUSH GOES TO ────────────────────────────────────────────────────────────
  {
    const dm = boardsForManager(shelves, "D-1");
    assert.equal(chooseFolderForPush({ boards: dm, requested: "heliopolis", positionArea: "Nasr City" }), "Heliopolis", "the recruiter's own choice wins, whatever its case");
    assert.equal(chooseFolderForPush({ boards: dm, positionArea: "Nasr City" }), "Nasr City", "else the area of the position it was sent for");
    assert.equal(
      chooseFolderForPush({ boards: dm, candidate: { preferencesDeclaredAt: "2026-10-01T00:00:00.000Z", preferredAreaName: "Heliopolis" } }),
      "Heliopolis",
      "else the area the applicant declared",
    );
    assert.equal(
      chooseFolderForPush({ boards: dm, candidate: { preferencesDeclaredAt: null, preferredAreaName: "Heliopolis" } }),
      null,
      "an area the applicant never declared is not evidence",
    );
    assert.equal(chooseFolderForPush({ boards: dm, requested: "Atlantis", positionArea: "Atlantis" }), null, "never an invented folder");
    assert.equal(chooseFolderForPush({ boards: [], requested: "Nasr City" }), null, "no shelf, no folder");
  }

  // ── 4 · SEEN MEANS OPENED SINCE IT WAS SENT ────────────────────────────────────────────────────
  {
    assert.equal(isSendUnseen("2026-10-10T09:00:00Z", undefined), true, "never opened");
    assert.equal(isSendUnseen("2026-10-10T09:00:00Z", "2026-10-10T08:00:00Z"), true, "opened BEFORE it was re-sent: asked again");
    assert.equal(isSendUnseen("2026-10-10T09:00:00Z", "2026-10-10T09:00:00Z"), false, "opened at the send instant counts");
    assert.equal(isSendUnseen("2026-10-10T09:00:00Z", "2026-10-11T09:00:00Z"), false, "opened afterwards");
    assert.equal(isSendUnseen("2026-10-10T09:00:00Z", "not a date"), true, "an unreadable open proves nothing");

    const boards = fillShelvesFromSends({
      candidates: new Map([
        ["a", cv("a", "2026-10-10T09:00:00.000Z")],
        ["b", cv("b", "2026-10-12T09:00:00.000Z")],
      ]),
      sends: [send("a", "D-1", "2026-10-10T09:00:00.000Z", "Nasr City"), send("b", "D-1", "2026-10-12T09:00:00.000Z", "Heliopolis")],
      shelves,
    });
    const dm = boardsForManager(boards, "D-1");
    const lastSeen = (id: string) => (id === "a" ? "2026-10-11T00:00:00.000Z" : undefined);
    assert.deepEqual(unseenIdsOnBoards(dm, lastSeen), ["b"], "only the CV never opened is unseen");

    const summary = summarizeManagerFolders(dm, (id) => id === "b");
    assert.equal(summary.totalFolders, 3, "three folders on the shelf");
    assert.equal(summary.emptyFolders, 1, "Other CVs is empty and only counted");
    assert.equal(summary.totalCandidates, 2);
    assert.equal(summary.unseenCandidates, 1);
    assert.deepEqual(summary.chips.map((chip) => `${chip.name}:${chip.count}:${chip.unseen}`), ["Heliopolis:1:1", "Nasr City:1:0"], "folders with something, the unopened one first; empty folders are not listed");
  }

  // ── 5 · THE REMINDERS: WHO, WHEN, AND AS WHAT ──────────────────────────────────────────────────
  {
    const sends: FolderSend[] = [
      send("a", "D-1", "2026-10-10T09:00:00.000Z", "Nasr City"),
      send("b", "d-1", "2026-10-12T09:00:00.000Z", "Heliopolis"),
      send("a", "N-1", "2026-10-10T09:00:00.000Z", "Nasr City"),
    ];
    const lastSeenByKey = new Map<string, string>([[districtReturnSuppressionKey("D-1", "a"), "2026-10-11T00:00:00.000Z"]]);
    const grouped = unseenSendsByManager({ lastSeenByKey, sends });
    assert.deepEqual(grouped.get("d-1")?.candidateIds, ["b"], "a CV he opened drops out; the one he did not stays, across both spellings of his id");
    assert.deepEqual(grouped.get("n-1")?.candidateIds, ["a"], "each manager is reminded of his own sends");
    assert.equal(grouped.size, 2);

    const none = unseenSendsByManager({
      lastSeenByKey: new Map([
        [districtReturnSuppressionKey("D-1", "a"), "2026-10-11T00:00:00.000Z"],
        [districtReturnSuppressionKey("D-1", "b"), "2026-10-13T00:00:00.000Z"],
      ]),
      sends: sends.slice(0, 2),
    });
    assert.equal(none.size, 0, "once everything is opened the reminders stop — the folder falls silent");

    // January, so Cairo is UTC+2 whatever the daylight rule is.
    assert.equal(isReminderHour(new Date("2026-01-15T06:00:00Z")), true, "08:00 Cairo is the first reminder hour");
    assert.equal(isReminderHour(new Date("2026-01-15T05:59:00Z")), false, "07:59 Cairo is still night");
    assert.equal(isReminderHour(new Date("2026-01-15T19:59:00Z")), true, "21:59 Cairo is still the working day");
    assert.equal(isReminderHour(new Date("2026-01-15T20:00:00Z")), false, "22:00 Cairo is night");

    // The nag ends seven days after the send; the CV itself stays in the folder.
    const now = new Date("2026-10-17T10:00:00Z");
    assert.equal(REMINDER_MAX_DAYS, 7, "the owner capped the reminder at 7 days");
    assert.equal(isWithinReminderWindow("2026-10-10T10:00:01Z", now), true, "a send one second short of 7 days still reminds");
    assert.equal(isWithinReminderWindow("2026-10-10T10:00:00Z", now), false, "a send exactly 7 days old no longer reminds");
    assert.equal(isWithinReminderWindow("2026-08-30T10:00:00Z", now), false, "a six-week-old send does not remind");
    assert.equal(isWithinReminderWindow("not a date", now), false, "a send with no readable time is not reminded");
    assert.equal(isReminderHour(new Date("2026-01-15T22:30:00Z")), false, "midnight is night");
    assert.equal(reminderHourBucket(new Date("2026-10-16T08:41:27.123Z")), "2026-10-16T08:00:00.000Z", "one identity per hour");
  }

  // ── 6 · THE WIRING: WHAT THE ROUTES, THE JOB AND THE SCREENS MUST KEEP DOING ───────────────────
  {
    const read = (path: string) => stripComments(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"));

    // The loader keeps no placement rule, so nothing can be delivered by a sweep of the pool again.
    const loader = read("../src/lib/recruitment/district-manager-folders-db.ts");
    const engagement = read("../src/lib/recruitment/manager-cv-engagement.ts");
    for (const [label, source] of [["the folder loader", loader], ["the engagement report", engagement]] as const) {
      assert.ok(!source.includes("placeCandidatesInDistrictFolders"), `${label} must not place CVs by a rule — a folder holds only what a person sent`);
    }
    assert.ok(!loader.includes('.from("ats_candidates")') || loader.includes('.in("id", batch)'), "the loader reads candidates only by the ids of sends, never the pool");

    // A manager's Return deletes his own send, so a re-push by Talent Acquisition brings it back.
    const returnRoute = read("../app/api/recruitment/candidates/[id]/district-return/route.ts");
    assert.ok(returnRoute.includes("deleteManagerSend(id, access.hrId)"), "returning a CV takes it out of his folder by deleting his send");

    // Taking a CV back.
    const recall = read("../src/lib/recruitment/manager-recall.ts");
    assert.ok(recall.includes("deleteManagerSend(candidate.id, input.managerHrId)"), "the recall deletes the send");
    assert.ok(recall.includes('"shortlisted"'), "and returns a CV nobody holds to the shortlist");
    assert.ok(/remaining\.length === 0 && normalizeCandidateStatus\(candidate\.status\) === "sent_to_manager"/.test(recall), "only when nobody else holds it");
    const recallRoute = read("../app/api/recruitment/candidates/[id]/recall-from-manager/route.ts");
    assert.ok(recallRoute.includes('requireRecruitmentAccess(request, "recruitment", "update")'), "only the recruiting seats take a CV back");
    assert.ok(recallRoute.includes("assertSameOriginMutation(request)"), "a mutation answers the same-origin check");
    assert.ok(recallRoute.includes("recallCandidateFromManager("), "and goes through the one recall function");

    // A manager hides a CV that reached him: his own hold ends, in one press, with no reason.
    const hideRoute = read("../app/api/recruitment/hiring-manager/candidates/[candidateId]/hide/route.ts");
    assert.ok(hideRoute.includes('requireRecruitmentAccess(request, "hiring_interviews", "update")'), "a manager holds the grant the hide needs");
    assert.ok(hideRoute.includes("isCandidateSentToCaller(access, candidateId)"), "and only a CV that was sent to him can be hidden");
    assert.ok(hideRoute.includes("hideCandidateFromManager(access, candidateId)") && !hideRoute.includes("readJsonObject"), "the manager is the session's, never a posted id");
    assert.ok(recall.includes("managerHrId: access.hrId"), "the hide recalls the CALLER's own hold");
    assert.ok(read("../src/lib/security/access-registry.ts").includes('pattern: "/api/recruitment/hiring-manager/candidates/*/hide"'), "the hide route is declared in the access registry");
    const portal = read("../src/components/employee-portal/recruitment-candidates-portal.tsx");
    assert.ok(portal.includes("/hiring-manager/candidates/${candidate.id}/hide"), "the manager's card posts to the hide route");

    // The folder choice rides on the send.
    for (const path of [
      "../app/api/recruitment/candidates/[id]/notify-manager/route.ts",
      "../app/api/recruitment/candidates/notify-manager/route.ts",
    ]) {
      assert.ok(read(path).includes("str(body.folderArea)"), `${path} passes the folder the recruiter chose`);
    }

    // A manager is told about a CV that reaches him without a restriction.
    const fileRoute = read("../app/api/recruitment/hiring-manager/candidates/[candidateId]/files/[fileId]/route.ts");
    assert.ok(fileRoute.includes("isCandidateSentToCaller(access, candidateId)"), "the file itself is served for a CV sent to the caller");

    // The reminder job.
    const reminders = read("../src/lib/recruitment/manager-cv-reminders.ts");
    assert.ok(reminders.includes('channels: ["in_app", "telegram", "push"]'), "in-app, Telegram and push — never email");
    assert.ok(!/channels:[^\]]*"email"/.test(reminders), "no email channel is ever named");
    assert.ok(reminders.includes("isReminderHour(now)"), "it waits through the night");
    assert.ok(reminders.includes("reminderHourBucket(now)") && reminders.includes('eventType: "candidate_reminder"'), "a new reminder row every hour, not an overwrite of the last one");
    assert.ok(reminders.includes("boardsForManager(shelves, send.managerHrId).length > 0"), "only a manager who holds folders is reminded");
    assert.ok(reminders.includes("listAllManagerSends({ now, withinHold: true })"), "the 45 days are applied to everyone except a manager who holds folders");
    assert.ok(reminders.includes("isWithinReminderWindow(send.sentAt, now)"), "a send older than the cap is not reminded");
    assert.ok(reminders.includes("if (dryRun) continue;"), "a dry run sends nothing");

    const cron = read("../app/api/cron/recruitment-manager-cv-reminders/route.ts");
    assert.ok(cron.includes('assertCronAuthorized(request, "cron/recruitment-manager-cv-reminders")'), "the cron route checks the secret");
    assert.ok(cron.includes('withDeadMansSwitch("phoenix-recruitment-manager-cv-reminders"'), "and reports its heartbeat");
    const schedule = readFileSync(fileURLToPath(new URL("../src/lib/observability/job-schedule.ts", import.meta.url)), "utf8");
    assert.ok(/"phoenix-recruitment-manager-cv-reminders", kind: "cron", schedule: "41 \* \* \* \*"/.test(schedule), "declared hourly on :41");
    const sync = readFileSync(fileURLToPath(new URL("../scripts/cronjob-sync.mjs", import.meta.url)), "utf8");
    assert.ok(/"recruitment-manager-cv-reminders": \{[\s\S]{0,900}?minutes: \[41\]/.test(sync), "and to the scheduler on the same minute");

    // The 45-day window does not apply to a manager who holds folders (owner, 2026-10-16: "lift it").
    assert.deepEqual(
      [...folderHolderKeys(ROWS)].sort(),
      ["d-1", "d-2", "n-1", "r-1"],
      "the folder holders are the district, regional and national sales managers — the CEO holds none",
    );
    assert.deepEqual([...folderHolderKeys([])], [], "an unreadable organogram reads as nobody, so the 45 days still apply");
    const returnRunner = read("../src/lib/recruitment/manager-hold-return.ts");
    assert.ok(
      returnRunner.includes("if (seatRows.length === 0) return { notified: false, ok: true, returned: 0 };") &&
        returnRunner.includes("folderHolderKeys(seatRows)"),
      "the daily return skips folder holders, and does nothing at all when the organogram cannot be read",
    );

    // The folder choice in the send dialogs (owner, 2026-10-16): offered for exactly one manager who
    // holds folders, always ending in "Other CVs", and never for several managers or for none.
    const withShelf = [
      { folders: ["Nasr City", "Heliopolis"], hrId: "D-1" },
      { folders: [], hrId: "H-1" },
      { hrId: "H-2" },
    ];
    assert.deepEqual(foldersToOffer(withShelf, ["D-1"]), ["Nasr City", "Heliopolis", OTHER_CVS_FOLDER_LABEL]);
    assert.deepEqual(foldersToOffer(withShelf, ["D-1", "H-1"]), [], "several managers have no single shelf");
    assert.deepEqual(foldersToOffer(withShelf, []), [], "nobody chosen, nothing offered");
    assert.deepEqual(foldersToOffer(withShelf, ["H-1"]), [], "a manager with no folders is offered none");
    assert.deepEqual(foldersToOffer(withShelf, ["H-2"]), [], "…and an option with no folders field is the same");
    const workspace = read("../src/components/recruitment/recruitment-workspace.tsx");
    assert.ok(
      workspace.includes("...(chosenFolder ? { folderArea: chosenFolder } : {})") &&
        workspace.includes("...(bulkChosenFolder ? { folderArea: bulkChosenFolder } : {})"),
      "the single and the bulk send both post the chosen folder, and post nothing when the system is to choose",
    );
    assert.ok(
      read("../src/lib/recruitment/hiring-manager-notify.ts").includes("boardsForManager(shelves, hrId)"),
      "the manager list carries each manager's folders, read from the organogram",
    );

    // The overview row.
    const snapshot = read("../src/lib/employee-portal/home-snapshot.ts");
    assert.ok(snapshot.includes('new Set(["District Manager", "Regional Manager", "National Sales Manager"])'), "the row is for the three sales-manager seats");
    for (const centre of ["dsm", "rm", "nsm"]) {
      const source = read(`../src/components/employee-portal/dashboards/${centre}-command-center.tsx`);
      assert.ok(source.includes("<ManagerCvFoldersRow summary={snapshot.cvFolders} />"), `the ${centre} overview carries the CV folders row`);
    }
    const row = read("../src/components/employee-portal/dashboards/manager-cv-folders-row.tsx");
    assert.ok(row.includes("if (!summary || summary.totalFolders === 0) return null;"), "a manager with no shelf sees no row at all");
    assert.ok(row.includes("nav-badge-alarm"), "an unopened CV pulses on its folder");
  }
}
