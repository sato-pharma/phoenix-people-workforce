import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Two asks of the owner's, 7 November 2026:
//   1. When HR passes a candidate at the 1st interview and confirms the line and the area, "the manager
//      of this area must receive in-app, telegram and email … the managers must be informed in all
//      ways", plus a banner on his portal home. His answers: the area's DSM on that line, or the line's
//      NSM where the area has no real DSM; a PASS only.
//   2. "I set up the time for the interview as a phone call. Make me able to change this time."

import { mrSeatUnderRsm, pickMrAreaManagers, type MrOrgSeat } from "../src/lib/recruitment/mr-hiring/area-manager.ts";
import { resolveNotificationPolicy } from "../src/lib/notifications/policy.ts";
import {
  MR_AREA_MANAGER_CHANNELS,
  MR_CANDIDATE_FOR_YOUR_AREA_EVENT,
  mrAreaCandidateMessage,
} from "../src/lib/recruitment/mr-hiring/notify.ts";
import { mrHiringStage, mrReschedulableBooking, type MrBookingFact, type MrCandidateFacts } from "../src/lib/recruitment/mr-hiring/stage.ts";
import { stripComments } from "./support/comment-strip.ts";

const codeOnly = (path: string) => stripComments(readFileSync(path, "utf8"));

function seat(seatId: string, tier: string, parentSeatId: string | null, occupantHrIds: string[], pseudo = false): MrOrgSeat {
  return { occupantHrIds, parentSeatId, pseudo, seatId, tier };
}

const NOW = new Date("2026-11-12T12:00:00.000Z");

function facts(bookings: MrBookingFact[]): MrCandidateFacts {
  return {
    bookings,
    candidateId: "11111111-1111-4111-8111-111111111111",
    offer: null,
    onOfficialLine: true,
    pediaAreaUnderRsm: false,
    receivedAt: "2026-11-08T08:00:00.000Z",
    recommendations: [],
    results: [],
    status: "new",
  };
}

function phoneCall(id: string, startsAt: string): MrBookingFact {
  return {
    durationMinutes: 30,
    id,
    interviewerHrId: "T-1",
    interviewerName: "Talent Acquisition",
    location: null,
    outcome: null,
    panelistHrIds: [],
    platform: "phone",
    round: "hr_first",
    startsAt,
    zoomJoinUrl: null,
  };
}

export function runRecruitmentMrHiringAreaNoticeTests() {
  // ── Who is told: the area's DSM, or the line's NSM where there is no real DSM ──────────────────
  const tree = new Map<string, MrOrgSeat>([
    ["NSM-CNS", seat("NSM-CNS", "NSM", null, ["N-1"])],
    ["RSM-1", seat("RSM-1", "RSM", "NSM-CNS", ["R-1"])],
    ["DM-REAL", seat("DM-REAL", "DM", "RSM-1", ["D-1"])],
    ["DM-HANDOVER", seat("DM-HANDOVER", "DM", "NSM-CNS", ["D-2", "D-3"])],
    ["DM-OTHERS", seat("DM-OTHERS", "DM", "RSM-1", ["D-9"], true)],
    ["DM-VACANT", seat("DM-VACANT", "DM", "NSM-CNS", [])],
    ["DM-ORPHAN", seat("DM-ORPHAN", "DM", "GONE", [], true)],
  ]);
  assert.deepEqual(pickMrAreaManagers("DM-REAL", tree), { hrIds: ["D-1"], seat: "dsm" }, "an area with a real DSM tells its DSM");
  assert.deepEqual(pickMrAreaManagers("DM-HANDOVER", tree), { hrIds: ["D-2", "D-3"], seat: "dsm" }, "a handover seat tells both occupants");
  assert.deepEqual(
    pickMrAreaManagers("DM-OTHERS", tree),
    { hrIds: ["N-1"], seat: "nsm" },
    "an area of the Others bucket has no real DSM — the line's NSM is told, past the RSM",
  );
  assert.deepEqual(pickMrAreaManagers("DM-VACANT", tree), { hrIds: ["N-1"], seat: "nsm" }, "a vacant district seat climbs to the NSM");
  assert.equal(pickMrAreaManagers("DM-ORPHAN", tree), null, "a seat whose parent is unknown finds nobody, never a guess");
  assert.equal(pickMrAreaManagers("NOT-A-SEAT", tree), null, "an unknown seat finds nobody");

  // The RSM interview's region test (owner, 7 Nov 2026): a district seat under an occupied RSM seat.
  assert.equal(mrSeatUnderRsm("DM-REAL", tree), true, "a district under the RSM is in his region");
  assert.equal(mrSeatUnderRsm("DM-OTHERS", tree), true, "so is the Others bucket hung under him");
  assert.equal(mrSeatUnderRsm("DM-HANDOVER", tree), false, "a district directly under the NSM is not");
  assert.equal(mrSeatUnderRsm("DM-ORPHAN", tree), false, "a seat whose parent is unknown is not, never a guess");
  assert.equal(mrSeatUnderRsm("NOT-A-SEAT", tree), false, "nor an unknown seat");
  const vacantRsm = new Map(tree);
  vacantRsm.set("RSM-1", seat("RSM-1", "RSM", "NSM-CNS", []));
  assert.equal(mrSeatUnderRsm("DM-REAL", vacantRsm), false, "a vacant RSM seat is no regional manager");

  // ── Every way there is: the bell, push, Telegram AND email, on its own policy row ───────────────
  for (const channel of ["in_app", "push", "telegram", "email"]) {
    assert.ok((MR_AREA_MANAGER_CHANNELS as readonly string[]).includes(channel), `the area manager's notice asks for ${channel}`);
  }
  const policy = resolveNotificationPolicy({ eventType: MR_CANDIDATE_FOR_YOUR_AREA_EVENT, module: "recruitment" });
  for (const channel of ["in_app", "telegram", "email"]) {
    assert.ok(policy.channels.includes(channel as never), `recruitment.${MR_CANDIDATE_FOR_YOUR_AREA_EVENT} allows ${channel}`);
  }

  // ── The wording: the name, the area, the line — never the CV or the salary ─────────────────────
  const forDsm = mrAreaCandidateMessage({ areaName: "Nasr City", candidateName: "Dr Karim Fathy", lineLabel: "CNS", seat: "dsm" });
  assert.match(forDsm, /Dr Karim Fathy passed HR's 1st interview for your area: Nasr City, CNS line/, "the DSM reads his own area");
  const forNsm = mrAreaCandidateMessage({ areaName: "Nasr City", candidateName: "Dr Karim Fathy", lineLabel: "CNS", seat: "nsm" });
  assert.match(forNsm, /an area with no DSM on your line: Nasr City/, "the NSM reads why it came to him");
  assert.doesNotMatch(forDsm + forNsm, /salary|EGP/i, "no money in the notice");

  // ── A pass at the 1st interview, after the reply — and only then ───────────────────────────────
  const record = codeOnly("src/lib/recruitment/mr-hiring/record.ts");
  assert.match(
    record,
    /input\.step === "hr_first" && input\.result === "pass" && input\.confirmedArea && input\.confirmedLine/,
    "only HR's pass at the 1st interview with a confirmed area and line tells the manager",
  );
  assert.match(record, /afterResponse\("mr-area-manager-notice"/, "the notice runs after the reply, never before it");

  // ── The banner: on the portal home, under its own Suspense, dismissed by his own hand only ───────
  const home = codeOnly("app/employee-portals/page.tsx");
  assert.match(home, /<Suspense fallback=\{null\}>\s*<MrAreaNoticeBanner hrId=\{access\.hrId\} \/>/, "the banner sits on the portal home under its own Suspense");
  const notices = codeOnly("src/lib/recruitment/mr-hiring/area-notices.ts");
  assert.match(notices, /\.eq\("id", id\)\s*\.eq\("manager_hr_id", manager\)/, "Got it stamps the caller's own notice only");
  const seen = codeOnly("app/api/recruitment/mr-hiring/area-notices/[noticeId]/seen/route.ts");
  assert.match(seen, /assertSameOriginMutation/, "the dismissal refuses a cross-site post");
  assert.match(seen, /assertPermission\(access, "employee_profile", "read"\)/, "and asks the permission before writing");

  // ── "Make me able to change this time" ─────────────────────────────────────────────────────────
  const upcoming = mrHiringStage(facts([phoneCall("call-1", "2026-11-13T08:00:00.000Z")]), NOW);
  assert.equal(mrReschedulableBooking(upcoming)?.id, "call-1", "a booked phone call can be moved");
  assert.equal(mrReschedulableBooking(upcoming, "call-1")?.platform, "phone", "and is found by its own id");
  assert.equal(mrReschedulableBooking(upcoming, "someone-else"), null, "another booking's id is refused");
  const missed = mrHiringStage(facts([phoneCall("call-2", "2026-11-12T09:00:00.000Z")]), NOW);
  assert.equal(mrReschedulableBooking(missed)?.id, "call-2", "a call whose time passed with no result is moved, not failed");
  const decided = mrHiringStage(
    {
      ...facts([phoneCall("call-3", "2026-11-12T09:00:00.000Z")]),
      results: [
        { bookingId: null, byHrId: "B-10", byName: null, comment: "ok", confirmedArea: null, confirmedLine: null, createdAt: "2026-11-08T09:00:00.000Z", decidedWithoutDsm: false, id: "r-1", rating: null, result: "pass", step: "hr_screening" },
        { bookingId: "call-3", byHrId: "B-10", byName: null, comment: "ok", confirmedArea: "Nasr City", confirmedLine: "cns", createdAt: "2026-11-12T10:00:00.000Z", decidedWithoutDsm: false, id: "r-2", rating: null, result: "pass", step: "hr_first" },
      ],
    },
    NOW,
  );
  assert.equal(mrReschedulableBooking(decided, "call-3"), null, "an interview whose result is in is never moved");
  const route = codeOnly("app/api/recruitment/mr-hiring/[candidateId]/book/route.ts");
  assert.match(route, /export async function PATCH/, "the booking route takes the change of time");
}
