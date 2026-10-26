import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { scopeForRole, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import type { ReturnedCvManagerGroup } from "../src/lib/recruitment/district-returns.ts";
import type { OfferRecord } from "../src/lib/offers/types.ts";
import type { ManagerCvEngagementReport } from "../src/lib/recruitment/manager-cv-engagement.ts";
import {
  assertApplicationVisible,
  assertCandidateVisible,
  assertCandidatesVisible,
  assertInterviewBookingVisible,
  assertInterviewRequestVisible,
  candidateHiddenFrom,
  fenceApplies,
  fenceCandidateIds,
  fenceCandidatesReceivedCount,
  fenceHrDashboardSources,
  fenceInterviewBookings,
  fenceInterviewRequest,
  fenceInterviewRequests,
  fenceRowsByCandidate,
  fenceRowsByInterviewBooking,
  hiddenInboxConversationIds,
  hiddenPeopleFromRows,
  isHrArchivedApplicant,
  isHrTitledInterview,
  withoutHiddenEngagementCandidates,
  withoutHiddenRequestItems,
  withoutHiddenReturnedCvs,
  type FencePersonRow,
} from "../src/lib/recruitment/workspace/fence.ts";
import { personVisibleToViewer, workspaceViewer } from "../src/lib/recruitment/workspace/role-tabs.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * THE TALENT ACQUISITION FENCE (owner, 2026-10-20). The Talent Acquisition seat (`HR Resourcing`)
 * never sees an HR applicant — the people applying for her manager's seat (HR Section Head) or her
 * own (Talent Acquisition). The fence is round a PERSON: a placement in either HR tab, or their own
 * reply naming an HR role (`declared_role_family`, Needs placing included), hides the whole record on
 * every screen. Hidden reads as "not found", never as "forbidden".
 *
 * Pinned here: (1) the decision itself, for her and for the viewers who see everyone; (2) that the
 * fence costs nobody else a query; (3) a walk over EVERY boundary that hands a candidate to a viewer —
 * delete the fence call from any one of them and this test goes red.
 */

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");
const code = (relative: string) => stripComments(read(relative));

const viewerFor = (role: PhoenixRole) => ({ role, scope: scopeForRole(role) });
const TALENT_ACQUISITION = viewerFor("HR Resourcing");
const SUPER_ADMIN = viewerFor("Super Admin");
const CEO = viewerFor("CEO");

const HR_PLACED = "11111111-1111-4111-8111-111111111111";
const DECLARED_HR_UNPLACED = "22222222-2222-4222-8222-222222222222";
const MEDICAL_REP = "33333333-3333-4333-8333-333333333333";
const TA_PLACED = "44444444-4444-4444-8444-444444444444";
const DECLARED_TA = "55555555-5555-4555-8555-555555555555";
const UNPLACED_UNKNOWN = "66666666-6666-4666-8666-666666666666";

const PEOPLE: FencePersonRow[] = [
  { ats_candidate_placements: [{ role_tab: "hr_section_head" }], declared_role_family: null, id: HR_PLACED },
  // The retired Human Resources tap fits no tab, so this person waits in Needs placing — still hidden.
  { ats_candidate_placements: [], declared_role_family: "human_resources", id: DECLARED_HR_UNPLACED },
  { ats_candidate_placements: [{ role_tab: "medical_rep" }], declared_role_family: "medical_rep", id: MEDICAL_REP },
  { ats_candidate_placements: [{ role_tab: "medical_rep" }, { role_tab: "talent_acquisition" }], declared_role_family: null, id: TA_PLACED },
  { ats_candidate_placements: null, declared_role_family: "talent_acquisition", id: DECLARED_TA },
  { ats_candidate_placements: null, declared_role_family: null, id: UNPLACED_UNKNOWN },
];

function runDecisionTests() {
  const ta = workspaceViewer(TALENT_ACQUISITION);
  assert.equal(ta.hidesHrPeople, true, "the Talent Acquisition seat is the one fenced viewer");
  assert.equal(fenceApplies(TALENT_ACQUISITION), true);

  const hiddenFromTa = hiddenPeopleFromRows(ta, PEOPLE);
  assert.ok(hiddenFromTa.has(HR_PLACED), "TA never sees a person placed in HR Section Head");
  assert.ok(hiddenFromTa.has(DECLARED_HR_UNPLACED), "TA never sees a declared Human Resources applicant, even in Needs placing");
  assert.ok(hiddenFromTa.has(TA_PLACED), "one HR placement hides the person, whatever else they are placed in");
  assert.ok(hiddenFromTa.has(DECLARED_TA), "a careers-form Talent Acquisition application is hidden before it is placed");
  assert.ok(!hiddenFromTa.has(MEDICAL_REP), "TA sees a Medical Rep applicant");
  assert.ok(!hiddenFromTa.has(UNPLACED_UNKNOWN), "a person whose role is not known yet is not an HR applicant");
  assert.equal(hiddenFromTa.size, 4);

  // The same rule, asked one person at a time — the role-tabs contract the SQL filter mirrors.
  assert.equal(personVisibleToViewer(ta, { declaredRoleFamily: null, placementTabs: ["hr_section_head"] }), false);
  assert.equal(personVisibleToViewer(ta, { declaredRoleFamily: "human_resources", placementTabs: [] }), false);
  assert.equal(personVisibleToViewer(ta, { declaredRoleFamily: "medical_rep", placementTabs: ["medical_rep"] }), true);

  for (const [name, access] of [
    ["Super Admin", SUPER_ADMIN],
    ["CEO", CEO],
  ] as const) {
    const viewer = workspaceViewer(access);
    assert.equal(viewer.hidesHrPeople, false, `${name} sees everyone`);
    assert.equal(fenceApplies(access), false, `${name} is never fenced`);
    assert.equal(hiddenPeopleFromRows(viewer, PEOPLE).size, 0, `${name} sees every HR applicant`);
  }
  // A system-scope session holding the seat is the platform, not her: it sees everyone.
  assert.equal(fenceApplies({ role: "HR Resourcing", scope: "system" }), false);
  assert.equal(fenceApplies(null), false);
  assert.equal(fenceApplies(undefined), false);
}

function runSideRuleTests() {
  // Someone booked from outside Recruitment, or kept in the CV Archive, has no record of their own:
  // the role they applied for names them.
  assert.equal(isHrTitledInterview("HR Section Head"), true);
  assert.equal(isHrTitledInterview("Talent Acquisition Specialist"), true);
  assert.equal(isHrTitledInterview("Human Resources"), true);
  assert.equal(isHrTitledInterview("Medical Representative"), false);
  assert.equal(isHrTitledInterview(null), false);
  assert.equal(isHrArchivedApplicant({ folder_path: ["WhatsApp 01098500699", "Medical Representative", "Upper Egypt"], job_title: "Human Resources" }), true);
  assert.equal(isHrArchivedApplicant({ folder_path: ["WhatsApp 01098500699", "Human Resources"], job_title: null }), true);
  assert.equal(isHrArchivedApplicant({ folder_path: ["WhatsApp 01098500699", "District Manager", "Delta"], job_title: "District Manager" }), false);

  // A chat is hidden by its linked person, or — nobody linked yet — by the HR role its number tapped.
  const chats = hiddenInboxConversationIds(
    [
      { candidateId: HR_PLACED, contactWaId: "201000000001", id: "chat-hr-person" },
      { candidateId: null, contactWaId: "201000000002", id: "chat-hr-tap" },
      { candidateId: MEDICAL_REP, contactWaId: "201000000003", id: "chat-rep" },
      { candidateId: null, contactWaId: null, id: "chat-nobody" },
    ],
    new Set([HR_PLACED]),
    new Set(["201000000002"]),
  );
  assert.deepEqual([...chats].sort(), ["chat-hr-person", "chat-hr-tap"]);

  // Counts are taken again off what stays — a hidden person is neither listed nor counted.
  const report: ManagerCvEngagementReport = {
    rows: [
      engagementRow("M-1", [
        { answered: true, candidateId: HR_PLACED, opened: true },
        { answered: false, candidateId: MEDICAL_REP, opened: false },
      ]),
      engagementRow("M-2", [{ answered: false, candidateId: DECLARED_TA, opened: true }]),
      engagementRow("M-3", []),
    ],
    scoped: false,
    totals: { answered: 1, managers: 3, notOpened: 1, opened: 2, received: 3 },
  };
  const fenced = withoutHiddenEngagementCandidates(report, new Set([HR_PLACED, DECLARED_TA]));
  assert.deepEqual(
    fenced.rows.map((row) => [row.managerHrId, row.received, row.opened, row.notOpened, row.answered]),
    [
      ["M-1", 1, 0, 1, 0],
      ["M-3", 0, 0, 0, 0],
    ],
    "the manager the fence emptied leaves; one who had nothing stays as he was",
  );
  assert.deepEqual(fenced.totals, { answered: 0, managers: 2, notOpened: 1, opened: 0, received: 1 });
  assert.equal(withoutHiddenEngagementCandidates(report, new Set()), report, "nothing hidden, nothing rebuilt");
  // A CV two managers hold stays ONE CV in the fenced totals, exactly as on the unfenced screen.
  const sharedFenced = withoutHiddenEngagementCandidates(
    {
      rows: [
        engagementRow("M-1", [
          { answered: true, candidateId: MEDICAL_REP, opened: false },
          { answered: false, candidateId: HR_PLACED, opened: false },
        ]),
        engagementRow("M-2", [{ answered: true, candidateId: MEDICAL_REP, opened: true }]),
      ],
      scoped: false,
      totals: { answered: 2, managers: 2, notOpened: 2, opened: 1, received: 3 },
    },
    new Set([HR_PLACED]),
  );
  assert.deepEqual(
    sharedFenced.totals,
    { answered: 1, managers: 2, notOpened: 0, opened: 1, received: 1 },
    "the fenced tiles count each CV once",
  );

  const queue: ReturnedCvManagerGroup[] = [
    {
      managerHrId: "M-1",
      managerName: "Manager One",
      reasons: [
        { items: [returned(HR_PLACED), returned(MEDICAL_REP)], reasonCode: "other", reasonLabel: "Other" },
        { items: [returned(DECLARED_TA)], reasonCode: "other", reasonLabel: "Other" },
      ],
      total: 3,
    },
    { managerHrId: "M-2", managerName: "Manager Two", reasons: [{ items: [returned(TA_PLACED)], reasonCode: "other", reasonLabel: "Other" }], total: 1 },
  ];
  const fencedQueue = withoutHiddenReturnedCvs(queue, new Set([HR_PLACED, DECLARED_TA, TA_PLACED]));
  assert.equal(fencedQueue.length, 1, "a manager whose every return was an HR applicant leaves the queue");
  assert.equal(fencedQueue[0]!.total, 1);
  assert.equal(fencedQueue[0]!.reasons.length, 1, "an emptied reason leaves its manager's pile");

  // An interview request: the HR applicant's CV leaves, someone from outside stays, and the waiting
  // count is taken again. A request only about HR applicants leaves; one with no CVs stays as it was.
  const requests = [
    requestOf("mixed", [
      { booked: false, candidateId: HR_PLACED },
      { booked: true, candidateId: MEDICAL_REP },
      { booked: false, candidateId: null },
    ]),
    requestOf("only-hr", [{ booked: false, candidateId: DECLARED_TA }]),
    requestOf("empty", []),
    requestOf("untouched", [{ booked: false, candidateId: MEDICAL_REP }]),
  ];
  const fencedRequests = withoutHiddenRequestItems(requests, new Set([HR_PLACED, DECLARED_TA]));
  assert.deepEqual(
    fencedRequests.map((request) => [request.id, request.items.length, request.pendingItemCount]),
    [
      ["mixed", 2, 1],
      ["empty", 0, 0],
      ["untouched", 1, 1],
    ],
  );
  assert.equal(fencedRequests[2], requests[3], "a request the fence did not touch is handed back as it was");
  assert.deepEqual(withoutHiddenRequestItems(requests, new Set()), requests, "nothing hidden, nothing rebuilt");
}

function requestOf(id: string, items: Array<{ candidateId: string | null; booked: boolean }>) {
  return { id, items, pendingItemCount: items.filter((item) => !item.booked).length };
}

function engagementRow(
  managerHrId: string,
  candidates: Array<{ candidateId: string; opened: boolean; answered: boolean }>,
): ManagerCvEngagementReport["rows"][number] {
  const opened = candidates.filter((candidate) => candidate.opened).length;
  return {
    answered: candidates.filter((candidate) => candidate.answered).length,
    candidates: candidates.map((candidate) => ({ ...candidate, area: null, arrivedAt: null, candidateName: null })),
    employmentStatusLabel: null,
    inactive: false,
    lastWorkingDate: null,
    managerArea: null,
    managerHrId,
    managerJobTitle: null,
    managerLine: null,
    managerName: null,
    notOpened: candidates.length - opened,
    opened,
    received: candidates.length,
  } as ManagerCvEngagementReport["rows"][number];
}

function returned(candidateId: string): ReturnedCvManagerGroup["reasons"][number]["items"][number] {
  return {
    areaName: null,
    candidateId,
    candidateName: null,
    lineName: null,
    reasonCode: "other",
    reasonLabel: "Other",
    reasonNote: null,
    regionName: null,
    returnedAt: "2026-10-20T08:00:00.000Z",
    returnId: `return-${candidateId}`,
    seatLabel: null,
  };
}

/**
 * IT COSTS EVERYONE ELSE NOTHING. These calls run with no database behind them: a viewer the fence
 * does not apply to, and a fenced call with nothing to look up, must return before any read.
 */
async function runNoQueryTests() {
  const ids = [HR_PLACED, MEDICAL_REP, "not-a-uuid"];
  for (const access of [SUPER_ADMIN, CEO]) {
    assert.deepEqual([...(await fenceCandidateIds(access, ids))].sort(), [...ids].sort(), "every id comes back, unread");
    assert.deepEqual(await fenceRowsByCandidate(access, [{ id: HR_PLACED }], (row) => row.id), [{ id: HR_PLACED }]);
    assert.equal(await candidateHiddenFrom(access, HR_PLACED), false);
    await assertCandidateVisible(access, "not-a-uuid");
    await assertCandidatesVisible(access, ids);
    await assertApplicationVisible(access, "not-a-uuid");
    await assertInterviewBookingVisible(access, "not-a-uuid");
    await assertInterviewRequestVisible(access, "not-a-uuid");
    const bookings = [{ candidateId: HR_PLACED, jobTitle: null }, { candidateId: null, jobTitle: "Talent Acquisition Specialist" }];
    assert.deepEqual(await fenceInterviewBookings(access, bookings), bookings, "every interview comes back, unread");
    const asked = [requestOf("r", [{ booked: false, candidateId: HR_PLACED }])];
    assert.deepEqual(await fenceInterviewRequests(access, asked), asked);
    assert.equal(await fenceInterviewRequest(access, asked[0]!), asked[0]);
    assert.deepEqual(await fenceRowsByInterviewBooking(access, [{ bookingId: HR_PLACED }], (row) => row.bookingId), [{ bookingId: HR_PLACED }]);
  }
  // For her, a request with no Recruitment candidate on it needs no read: someone from outside stays.
  const outsiders = [requestOf("outside", [{ booked: false, candidateId: null }])];
  assert.deepEqual(await fenceInterviewRequests(TALENT_ACQUISITION, outsiders), outsiders);
  assert.deepEqual(await fenceRowsByInterviewBooking(TALENT_ACQUISITION, [], () => null), []);
  await assert.rejects(assertInterviewRequestVisible(TALENT_ACQUISITION, "not-a-uuid"), (error: unknown) => (error as { status?: number }).status === 404);
  await assert.rejects(assertInterviewBookingVisible(TALENT_ACQUISITION, "not-a-uuid"), (error: unknown) => (error as { status?: number }).status === 404);

  // The HR dashboards: her "CVs received" figure and the names on her tasks. Free for everyone else.
  const october = { fromIso: "2026-10-01", toIso: "2026-10-31" };
  const offers = ["HR Section Head", "Medical Representative", "Talent Acquisition Specialist"].map(
    (title, index) => ({ candidateName: `Person ${index}`, id: `offer-${index}`, status: "sent", title }) as unknown as OfferRecord,
  );
  for (const access of [SUPER_ADMIN, CEO]) {
    assert.equal(await fenceCandidatesReceivedCount(access, october, 7), 7, "the figure comes back as counted, unread");
    const sources = { offers: [...offers] };
    await fenceHrDashboardSources(access, sources);
    assert.deepEqual(sources.offers, offers, "every offer stays for a seat the fence does not apply to");
  }
  // For her, an offer for an HR job leaves the task list — it carries no candidate record, so its title
  // names the person. With no recruitment source loaded there is nobody to look up, so nothing is read.
  const hers = { offers: [...offers] };
  await fenceHrDashboardSources(TALENT_ACQUISITION, hers);
  assert.deepEqual(hers.offers.map((offer) => offer.title), ["Medical Representative"]);
  // For her, an id that cannot exist answers exactly like a hidden one — 404, before any read.
  assert.equal(await candidateHiddenFrom(TALENT_ACQUISITION, "not-a-uuid"), true);
  await assert.rejects(
    assertCandidateVisible(TALENT_ACQUISITION, "not-a-uuid"),
    (error: unknown) => (error as { status?: number }).status === 404 && /not found/i.test(String((error as Error).message)),
    "hidden reads as not found, never forbidden",
  );
  await assert.rejects(assertApplicationVisible(TALENT_ACQUISITION, ""), (error: unknown) => (error as { status?: number }).status === 404);
  assert.equal((await fenceCandidateIds(TALENT_ACQUISITION, [])).size, 0);
}

/** The source half of "costs nothing": every fence function asks `fenceApplies` before its first read. */
function runEarlyReturnPins() {
  const fence = code("src/lib/recruitment/workspace/fence.ts");
  const earlyReturning = [
    "fenceCandidateIds",
    "fenceRowsByCandidate",
    "candidateHiddenFrom",
    "assertCandidatesVisible",
    "assertApplicationVisible",
    "assertCandidateFileVisible",
    "assertInterviewBookingVisible",
    "assertInterviewRequestItemVisible",
    "fenceInterviewBookings",
    "fenceRowsByInterviewBooking",
    "fenceInterviewRequests",
    "fenceInterviewRequest",
    "assertInterviewRequestVisible",
    "inboxConversationsHiddenFrom",
    "fenceDistrictBoards",
    "fenceReturnedCvQueue",
    "fenceManagerEngagementReport",
    "fenceHrDashboardSources",
    "fenceCandidatesReceivedCount",
  ];
  for (const name of earlyReturning) {
    // By whole name, so `fenceInterviewRequest` is never found inside `fenceInterviewRequests`.
    const start = fence.search(new RegExp(`export async function ${name}\\b`));
    assert.ok(start >= 0, `fence.ts exports ${name}`);
    const gate = fence.indexOf("fenceApplies(access)", start);
    assert.ok(gate > start, `${name} asks fenceApplies`);
    assert.match(fence.slice(gate - 5, gate + 80), /if \(!fenceApplies\(access\)[^\n]*\) return\b/, `${name} returns at once for a viewer it does not apply to`);
    const head = fence.slice(start, gate);
    for (const work of ["await ", "recruitmentDb(", "readPeople("]) {
      assert.ok(!head.includes(work), `${name} does nothing (${work.trim()}) before asking fenceApplies`);
    }
  }
  const assertVisible = fence.slice(fence.indexOf("export async function assertCandidateVisible"), fence.indexOf("export async function assertCandidatesVisible"));
  assert.ok(assertVisible.includes("candidateHiddenFrom(") && !assertVisible.includes("recruitmentDb("), "assertCandidateVisible rides on candidateHiddenFrom's early return");
  assert.match(fence, /return Boolean\(access\) && workspaceViewer\(access as FenceViewer\)\.hidesHrPeople;/, "WHETHER to fence is the contract's own flag");

  // ONE batched read for many people, placements embedded — never one query per id.
  const readPeople = fence.slice(fence.indexOf("async function readPeople("), fence.indexOf("export async function fenceCandidateIds"));
  assert.ok(readPeople.includes("chunkIds(") && readPeople.includes('.in("id", batch)'), "the people are read in batches");
  assert.ok(readPeople.includes('"id, declared_role_family, ats_candidate_placements(role_tab)"'), "declared role and placements come in the same read");
  assert.ok(!readPeople.includes('.eq("id"'), "never one read per person");
  assert.ok(readPeople.includes("if (error) throw error;"), "a fence that cannot read fails closed");
}

/**
 * EVERY BOUNDARY THAT HANDS A CANDIDATE TO A VIEWER, and the fence call it must keep. A count is a
 * minimum: a route with two handlers carries the call twice. Never inside the shared readers — intake,
 * merge and extraction must see everyone — so the pin is on the route or page, never the reader.
 */
const BOUNDARIES: Array<[file: string, calls: Record<string, number>]> = [
  // Candidates — the list, one person, and every sub-route.
  ["app/api/recruitment/candidates/route.ts", { fenceCandidateIds: 1 }],
  ["app/api/recruitment/candidates/[id]/route.ts", { assertCandidateVisible: 3 }],
  ["app/api/recruitment/candidates/[id]/timeline/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/candidates/[id]/notes/route.ts", { assertCandidateVisible: 2 }],
  ["app/api/recruitment/candidates/[id]/files/route.ts", { assertCandidateVisible: 2 }],
  ["app/api/recruitment/candidates/[id]/background/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/candidates/[id]/application/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/candidates/[id]/cv-extract/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/candidates/[id]/status/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/candidates/[id]/merge/route.ts", { assertCandidateVisible: 2 }],
  ["app/api/recruitment/candidates/[id]/notify-manager/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/candidates/[id]/whatsapp-answer/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/candidates/[id]/whatsapp-reply/route.ts", { assertCandidateVisible: 2 }],
  ["app/api/recruitment/candidates/[id]/folder/route.ts", { assertCandidateVisible: 2 }],
  ["app/api/recruitment/candidates/[id]/rating/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/candidates/[id]/seen/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/candidates/[id]/offer-letter/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/candidates/[id]/recall-from-manager/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/candidates/[id]/district-return/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/candidates/[id]/attach-requisition/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/candidates/[id]/rejection-message/route.ts", { assertCandidateVisible: 2 }],
  ["app/api/recruitment/candidates/[id]/ask-again/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/candidates/[id]/placement/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/candidates/[id]/answers/route.ts", { assertCandidateVisible: 2 }],
  ["app/api/recruitment/candidates/[id]/call-result/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/candidates/[id]/reject/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/workspace/cv/[candidateId]/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/candidates/[id]/archive/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/candidates/ask-again/route.ts", { assertCandidatesVisible: 1 }],
  ["app/api/recruitment/candidates/bulk-reject/route.ts", { assertCandidatesVisible: 1 }],
  ["app/api/recruitment/candidates/bulk-status/route.ts", { assertCandidatesVisible: 1 }],
  ["app/api/recruitment/candidates/notify-manager/route.ts", { assertCandidatesVisible: 1 }],
  ["app/api/recruitment/candidates/revert-status/route.ts", { assertCandidatesVisible: 1 }],
  ["app/api/recruitment/candidates/contact-review/route.ts", { assertCandidatesVisible: 1, fenceRowsByCandidate: 1 }],
  ["app/api/recruitment/candidates/file-declared/route.ts", { fenceRowsByCandidate: 1 }],
  ["app/api/recruitment/candidates/cv-search/route.ts", { fenceCandidateIds: 1 }],
  // CV look-up, folders and files.
  ["app/api/recruitment/cv-lookup/route.ts", { fenceCandidateIds: 1 }],
  ["app/api/recruitment/cv-lookup/[id]/application/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/cv-folders/route.ts", { fenceCandidateIds: 1 }],
  ["app/api/recruitment/cv-folders/[id]/items/route.ts", { assertCandidatesVisible: 2 }],
  ["app/api/recruitment/cv-folders/return-to-pool/route.ts", { assertCandidatesVisible: 1 }],
  ["app/api/recruitment/files/[id]/download/route.ts", { assertCandidateFileVisible: 1 }],
  // Applications, the seat picker and the selection board.
  ["app/api/recruitment/applications/route.ts", { assertCandidateVisible: 1, fenceRowsByCandidate: 1 }],
  ["app/api/recruitment/applications/hireable/route.ts", { fenceRowsByCandidate: 1 }],
  ["app/api/recruitment/applications/[id]/route.ts", { assertApplicationVisible: 2 }],
  ["app/api/recruitment/applications/[id]/attribute-source/route.ts", { assertApplicationVisible: 1 }],
  ["app/api/recruitment/applications/[id]/convert/route.ts", { assertApplicationVisible: 1 }],
  ["app/api/recruitment/applications/[id]/hire-draft/route.ts", { assertApplicationVisible: 1 }],
  ["app/api/recruitment/applications/[id]/interviews/route.ts", { assertApplicationVisible: 2 }],
  ["app/api/recruitment/applications/[id]/notify-manager/route.ts", { assertApplicationVisible: 1 }],
  ["app/api/recruitment/applications/[id]/offer/route.ts", { assertApplicationVisible: 2 }],
  ["app/api/recruitment/applications/[id]/offer-letter/route.ts", { assertApplicationVisible: 1 }],
  ["app/api/recruitment/applications/[id]/screening/route.ts", { assertApplicationVisible: 1 }],
  ["app/api/recruitment/applications/[id]/workflow/route.ts", { assertApplicationVisible: 1 }],
  ["app/api/recruitment/requisitions/[id]/selection-board/route.ts", { fenceRowsByCandidate: 1 }],
  // The interview calendar's candidate routes, request CVs and export.
  ["app/api/recruitment/interview-calendar/candidates/search/route.ts", { fenceCandidateIds: 1 }],
  ["app/api/recruitment/interview-calendar/candidates/[candidateId]/files/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/interview-calendar/candidates/[candidateId]/files/[fileId]/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/interview-calendar/candidates/[candidateId]/application/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/interview-calendar/bookings/[id]/cv/route.ts", { assertInterviewBookingVisible: 2 }],
  ["app/api/recruitment/interview-calendar/requests/[id]/items/[itemId]/cv/route.ts", { assertInterviewRequestItemVisible: 1 }],
  ["app/api/recruitment/interview-calendar/export/route.ts", { fenceInterviewBookings: 1 }],
  // The calendar itself: an HR applicant's interview is not on her week, day, prompt or Zoom pop-up,
  // and every door that opens one booking by its id answers as if it were not there.
  ["app/api/recruitment/interview-calendar/bookings/route.ts", { assertCandidateVisible: 1, fenceInterviewBookings: 4 }],
  ["app/api/recruitment/interview-calendar/bookings/[id]/route.ts", { assertInterviewBookingVisible: 3 }],
  ["app/api/recruitment/interview-calendar/bookings/[id]/comments/route.ts", { assertInterviewBookingVisible: 1 }],
  ["app/api/recruitment/interview-calendar/bookings/[id]/confirmation/route.ts", { assertInterviewBookingVisible: 1 }],
  ["app/api/recruitment/interview-calendar/bookings/[id]/insights/route.ts", { assertInterviewBookingVisible: 1 }],
  ["app/api/recruitment/interview-calendar/bookings/[id]/invitation/route.ts", { assertInterviewBookingVisible: 1 }],
  ["app/api/recruitment/interview-calendar/bookings/[id]/invitations/route.ts", { assertInterviewBookingVisible: 2 }],
  ["app/api/recruitment/interview-calendar/bookings/[id]/outcome/route.ts", { assertInterviewBookingVisible: 1 }],
  ["app/api/recruitment/interview-calendar/bookings/[id]/polls/route.ts", { assertInterviewBookingVisible: 2 }],
  ["app/api/recruitment/interview-calendar/bookings/[id]/scorecard/route.ts", { assertInterviewBookingVisible: 1 }],
  ["app/api/recruitment/interview-calendar/bookings/[id]/zoom/route.ts", { assertInterviewBookingVisible: 1 }],
  ["app/api/recruitment/interview-calendar/sessions/[id]/route.ts", { fenceInterviewBookings: 1 }],
  ["app/api/recruitment/interview-calendar/zoom-due/route.ts", { fenceRowsByInterviewBooking: 1 }],
  // Interview requests: her CVs leave every request, and a request only about HR applicants leaves.
  ["app/api/recruitment/interview-calendar/requests/route.ts", { assertCandidatesVisible: 1, fenceInterviewRequests: 2 }],
  ["app/api/recruitment/interview-calendar/requests/[id]/route.ts", { assertInterviewRequestVisible: 1, fenceInterviewRequest: 2 }],
  ["app/api/recruitment/interview-calendar/requests/[id]/schedule/route.ts", { assertInterviewRequestItemVisible: 1, fenceInterviewRequest: 1 }],
  // The "My Candidates" routes — she holds hiring_interviews, so a CV pushed to her reaches these.
  ["app/api/recruitment/hiring-manager/applications/route.ts", { fenceRowsByCandidate: 1 }],
  ["app/api/recruitment/hiring-manager/applications/[id]/interviews/route.ts", { assertApplicationVisible: 2 }],
  ["app/api/recruitment/hiring-manager/applications/[id]/workflow/route.ts", { assertApplicationVisible: 1 }],
  ["app/api/recruitment/hiring-manager/candidates/route.ts", { fenceRowsByCandidate: 1 }],
  ["app/api/recruitment/hiring-manager/candidates/[candidateId]/call/route.ts", { assertCandidateVisible: 2 }],
  ["app/api/recruitment/hiring-manager/candidates/[candidateId]/comments/route.ts", { assertCandidateVisible: 2 }],
  ["app/api/recruitment/hiring-manager/candidates/[candidateId]/decision/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/hiring-manager/candidates/[candidateId]/files/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/hiring-manager/candidates/[candidateId]/files/[fileId]/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/hiring-manager/candidates/[candidateId]/folder/route.ts", { assertCandidateVisible: 2 }],
  ["app/api/recruitment/hiring-manager/candidates/[candidateId]/hide/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/hiring-manager/interviews/[id]/route.ts", { assertApplicationVisible: 1 }],
  // Manager CV Engagement, its files and its export.
  ["app/api/recruitment/manager-engagement/candidates/[candidateId]/files/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/manager-engagement/candidates/[candidateId]/files/[fileId]/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/manager-engagement/export/route.ts", { fenceManagerEngagementReport: 1 }],
  // WhatsApp templates aimed at a candidate.
  ["app/api/recruitment/whatsapp-templates/route.ts", { assertCandidateVisible: 1 }],
  ["app/api/recruitment/whatsapp-templates/send/route.ts", { candidateHiddenFrom: 1 }],
  // The CV-lifecycle sheet feed, fenced by whoever made the link.
  ["app/api/share/cv-lifecycle/[token]/feed/route.ts", { fenceCvLifecycleFeed: 1 }],
  // The WhatsApp Inbox, one chat and one message at a time.
  ["app/api/whatsapp-inbox/conversations/[id]/route.ts", { assertInboxConversationVisibleTo: 1 }],
  ["app/api/whatsapp-inbox/conversations/[id]/read/route.ts", { assertInboxConversationVisibleTo: 1 }],
  ["app/api/whatsapp-inbox/conversations/[id]/messages/route.ts", { assertInboxConversationVisibleTo: 1 }],
  ["app/api/whatsapp-inbox/conversations/[id]/link/route.ts", { assertCandidateVisible: 1, assertInboxConversationVisibleTo: 1 }],
  ["app/api/whatsapp-inbox/media/[messageId]/route.ts", { assertInboxMessageVisibleTo: 1 }],
  ["app/api/whatsapp-inbox/messages/[messageId]/save-to-candidate/route.ts", { assertCandidateVisible: 1, assertInboxMessageVisibleTo: 1 }],
  ["app/api/whatsapp-inbox/people/route.ts", { assertInboxConversationVisibleTo: 1, fenceCandidateIds: 1 }],
  // Pages.
  ["app/(admin)/recruitment/candidate/[id]/page.tsx", { candidateHiddenFrom: 1 }],
  ["app/employee-portals/recruitment/candidate/[id]/page.tsx", { candidateHiddenFrom: 1 }],
  ["app/print/candidate-record/[id]/page.tsx", { candidateHiddenFrom: 1 }],
  ["app/print/candidate-application/[id]/page.tsx", { candidateHiddenFrom: 1 }],
  ["app/(admin)/recruitment/candidates/page.tsx", { fenceDistrictBoards: 1, fenceRowsByCandidate: 2 }],
  ["app/employee-portals/recruitment-candidates/page.tsx", { fenceDistrictBoards: 1, fenceRowsByCandidate: 2 }],
  ["app/(admin)/recruitment/returned-cvs/page.tsx", { fenceReturnedCvQueue: 1 }],
  ["app/(admin)/recruitment/contact-review/page.tsx", { fenceRowsByCandidate: 1 }],
  ["app/employee-portals/contact-review/page.tsx", { fenceRowsByCandidate: 1 }],
  ["app/(admin)/cv-database/page.tsx", { fenceRowsByCandidate: 1 }],
  ["app/employee-portals/cv-database/page.tsx", { fenceRowsByCandidate: 1 }],
  ["app/(admin)/recruitment/manager-engagement/page.tsx", { fenceManagerEngagementReport: 1 }],
  ["app/employee-portals/recruitment-engagement/page.tsx", { fenceManagerEngagementReport: 1 }],
  // The HR dashboards' loaders — her overview (tasks, "CVs received", today, her next interviews and
  // the month) and the HR Command Center (tasks and tiles).
  ["src/lib/hr/talent-acquisition-overview.ts", { fenceCandidatesReceivedCount: 1, fenceHrDashboardSources: 1, fenceInterviewBookings: 3 }],
  ["src/lib/hr/command-center.ts", { fenceHrDashboardSources: 1 }],
];

/** Boundaries that hand the viewer to a loader which fences inside, by who is reading. */
const DELEGATED: Array<[file: string, pattern: RegExp]> = [
  ["app/(admin)/recruitment/screening/page.tsx", /loadScreeningWorkspace\(access\.hrId, filters, \{\s*access,/],
  ["app/employee-portals/recruitment/screening/page.tsx", /loadScreeningWorkspace\(access\.hrId, filters, \{\s*access,/],
  ["src/lib/recruitment/screening-workspace.ts", /const allCandidates = await fenceRowsByCandidate\(options\.access, everyCandidate, \(candidate\) => candidate\.id\);/],
  ["app/(admin)/recruitment/whatsapp-inbox/page.tsx", /listInboxConversations\(\{ access \}\)/],
  ["app/api/whatsapp-inbox/conversations/route.ts", /listInboxConversations\(\{\s*access,/],
  ["src/lib/whatsapp-inbox/store.ts", /const hiddenChats = fenced \? await inboxConversationsHiddenFrom\(input\.access, read\.map\(fenceRowOf\)\)/],
  ["app/(admin)/recruitment/whatsapp-applicants/page.tsx", /loadWhatsAppApplicantsView\(\{ access \}\)[\s\S]*loadWhatsAppCvArchiveView\(\{ access \}\)/],
  ["app/api/recruitment/whatsapp-applicants/[sessionId]/application/route.ts", /loadWhatsAppApplication\(sessionId, \{ access \}\)/],
  ["app/api/recruitment/whatsapp-cv-archive/[fileId]/route.ts", /getWhatsAppCvArchiveFile\(fileId, \{ access \}\)/],
];

function runBoundaryWalk() {
  for (const [file, calls] of BOUNDARIES) {
    const source = code(file);
    assert.match(source, /from "@\/lib\/recruitment\/workspace\/fence"|from "@\/lib\/whatsapp-inbox\/store"/, `${file} imports the fence`);
    for (const [call, minimum] of Object.entries(calls)) {
      const found = source.split(`${call}(`).length - 1;
      assert.ok(
        found >= minimum,
        `${file} must call ${call} at least ${minimum} time(s) — found ${found}. A boundary without its fence shows her an HR applicant.`,
      );
    }
  }
  for (const [file, pattern] of DELEGATED) {
    assert.match(code(file), pattern, `${file} must hand the viewer to the fence`);
  }

  // The fence is asked BEFORE the person is read, on the pages that open one record.
  for (const file of ["app/(admin)/recruitment/candidate/[id]/page.tsx", "app/employee-portals/recruitment/candidate/[id]/page.tsx"]) {
    const source = code(file);
    const fenceAt = source.indexOf("candidateHiddenFrom(access, candidateId)");
    assert.ok(fenceAt > 0 && fenceAt < source.indexOf("await loadCandidateRecord("), `${file} asks the fence before loading the record`);
    assert.ok(source.indexOf("parseCandidatePageId(") < source.indexOf("await loadCandidateRecord("));
  }
  // The dashboards fence their sources BEFORE the task list is built from them, so no name gets through.
  for (const file of ["src/lib/hr/talent-acquisition-overview.ts", "src/lib/hr/command-center.ts"]) {
    const source = code(file);
    const fenceAt = source.indexOf("await fenceHrDashboardSources(access, loaded)");
    assert.ok(fenceAt > 0 && fenceAt < source.indexOf("buildHrTodayTasks(loaded"), `${file} fences its sources before naming anyone`);
  }
  const printPage = code("app/print/candidate-record/[id]/page.tsx");
  assert.ok(printPage.indexOf("candidateHiddenFrom(access, id)") < printPage.indexOf("loadCandidateRecordPrint(id)"), "the printed record is fenced before it is read");

  // The inbox list takes its viewer by type, so no caller can forget it.
  assert.match(code("src/lib/whatsapp-inbox/store.ts"), /export async function listInboxConversations\(input: \{\s*access: Pick<AccessContext, "role" \| "scope">;/);
  // So does the screening workstation.
  assert.match(code("src/lib/recruitment/screening-workspace.ts"), /canAttachToRequisition\?: boolean;\s*access: Pick<AccessContext, "role" \| "scope">;\s*\},/);

  // NEVER INSIDE THE SHARED READERS. Intake, merge and the CV extraction call them and must see everyone.
  assert.ok(!read("src/lib/recruitment/candidates.ts").includes("workspace/fence"), "the shared candidate readers stay unfenced");
}

export async function runRecruitmentTaFenceTests() {
  runDecisionTests();
  runSideRuleTests();
  await runNoQueryTests();
  runEarlyReturnPins();
  runBoundaryWalk();
}
