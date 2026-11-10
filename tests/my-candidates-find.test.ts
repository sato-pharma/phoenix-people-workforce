import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { CandidateCallClaims } from "../src/lib/recruitment/candidate-call-claims.ts";
import type { DistrictManagerBoard } from "../src/lib/recruitment/district-manager-folders.ts";
import {
  candidateMatchesTokens,
  countMyCandidatesViews,
  findTokens,
  foldForFind,
  goingBackInDays,
  goingBackLabel,
  goingBackSoonIds,
  isAwaitingManagerAnswer,
  isFindActive,
  matchesMyCandidatesFind,
  narrowBoards,
  MANAGER_HOLD_WARN_DAYS,
  type MyCandidatesFind,
} from "../src/lib/recruitment/my-candidates-find.ts";
import { managerHoldDaysLeft } from "../src/lib/recruitment/manager-hold-window.ts";
import type { Candidate } from "../src/lib/recruitment/types.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Finding a CV on the manager's "My Candidates" page (owner, 2026-11-10: "premium polish the page,
 * god mode enhancements"). One search and four quick views narrow every list of his own at once, and
 * an opened CV walks its own list with Previous / Next and J / K.
 */

function candidate(id: string, fields: Partial<Candidate> = {}): Candidate {
  return {
    address: null,
    appliedForJobTitle: null,
    currentEmployer: null,
    currentJobTitle: null,
    email: null,
    faculty: null,
    fullName: `Candidate ${id}`,
    governorate: null,
    id,
    phone: null,
    status: "new",
    university: null,
    ...fields,
  } as Candidate;
}

function source(path: string): string {
  // Comments are stripped so a sentence explaining a call can never satisfy an assertion about it.
  return stripComments(readFileSync(new URL(path, import.meta.url), "utf8"));
}

export function runMyCandidatesFindTests() {
  // ── Arabic and digits are matched the way people type them ─────────────────────────────────────
  assert.equal(foldForFind("  أحمد   إبراهيم "), "احمد ابراهيم", "hamza forms fold to bare alef and runs of spaces collapse");
  assert.equal(foldForFind("مُصْطَفَى"), "مصطفي", "short vowels are ignored and alef maqsura reads as ya");
  assert.equal(foldForFind("فاطمة"), "فاطمه", "ta marbuta reads as ha");
  assert.equal(foldForFind("٠١٠٠۱۲۳"), "0100123", "Arabic-Indic and extended Arabic-Indic digits read as digits");
  assert.equal(foldForFind("Mona ADEL"), "mona adel", "case is ignored");
  assert.deepEqual(findTokens(""), [], "nothing typed is no words");
  assert.deepEqual(findTokens("   "), [], "spaces alone are no words");

  // ── Every word must be on the CV — AND, never OR ───────────────────────────────────────────────
  const mona = candidate("a", {
    currentEmployer: "Pharco",
    fullName: "Mona Adel Ibrahim",
    governorate: "Gharbia",
    phone: "0100 123-4567",
    university: "Mansoura University",
  });
  const ahmed = candidate("b", { fullName: "أحمد مصطفى", governorate: "طنطا" });
  assert.ok(candidateMatchesTokens(mona, findTokens("mona mansoura")), "two words, both on the CV");
  assert.ok(!candidateMatchesTokens(mona, findTokens("mona cairo")), "a word NOT on the CV fails the match, even beside one that is");
  assert.ok(candidateMatchesTokens(mona, findTokens("pharco")), "the current employer is searched");
  assert.ok(candidateMatchesTokens(mona, findTokens("01001234567")), "a number typed whole finds a phone stored with spaces and a dash");
  assert.ok(candidateMatchesTokens(mona, findTokens("0100 1234")), "a number typed in pieces finds it too");
  assert.ok(!candidateMatchesTokens(mona, findTokens("0199")), "a number that is not on the phone does not match");
  assert.ok(candidateMatchesTokens(ahmed, findTokens("احمد مصطفي")), "Arabic typed without hamza or with ya finds the stored spelling");
  assert.ok(candidateMatchesTokens(ahmed, findTokens("طنطا")), "the governorate is searched");
  assert.ok(candidateMatchesTokens(ahmed, []), "no words matches everyone");
  // A phone the server hid is not on the candidate at all, so it can never be searched out.
  assert.ok(!candidateMatchesTokens(candidate("c", { fullName: "Hidden Phone", phone: null }), findTokens("0100123")), "a hidden phone matches no number");

  // ── The quick views ────────────────────────────────────────────────────────────────────────────
  assert.ok(isAwaitingManagerAnswer("new"), "an untouched CV is waiting on him");
  assert.ok(isAwaitingManagerAnswer("sent_to_manager"), "a sent, unanswered CV is waiting on him");
  assert.ok(!isAwaitingManagerAnswer("rejected"), "an answered CV is not");
  const claims = {
    a: { candidateId: "a", managerHrId: "B-94", managerName: "Taha" },
    b: { candidateId: "b", managerHrId: "B-11", managerName: "Someone Else" },
  } as unknown as CandidateCallClaims;
  const base: MyCandidatesFind = { claims, leavingIds: new Set(["a"]), tokens: [], unseenIds: new Set(["b"]), view: "all", viewerHrId: "b-94" };
  assert.ok(!isFindActive(base), "All with nothing typed narrows nothing");
  assert.ok(isFindActive({ ...base, view: "waiting" }), "a view other than All narrows");
  assert.ok(isFindActive({ ...base, tokens: ["x"] }), "a word typed narrows");
  assert.ok(matchesMyCandidatesFind(mona, false, { ...base, view: "calling" }), "his own claim is in You will call, whatever the hr id's case");
  assert.ok(!matchesMyCandidatesFind(ahmed, true, { ...base, view: "calling" }), "another manager's claim is not his");
  assert.ok(matchesMyCandidatesFind(ahmed, false, { ...base, view: "unopened" }), "a folder CV he has not opened is in Not opened");
  assert.ok(!matchesMyCandidatesFind(mona, true, { ...base, view: "unopened" }), "one he has opened is not");
  assert.ok(matchesMyCandidatesFind(mona, true, { ...base, view: "waiting" }), "Waiting on you takes the caller's own answer");
  assert.ok(!matchesMyCandidatesFind(mona, false, { ...base, view: "waiting" }), "and leaves out what he has answered");
  assert.ok(matchesMyCandidatesFind(mona, false, { ...base, view: "leaving" }), "a CV going back soon is in Going back soon");
  assert.ok(!matchesMyCandidatesFind(ahmed, false, { ...base, view: "leaving" }), "one that is not going back is not");
  assert.ok(!matchesMyCandidatesFind(mona, true, { ...base, tokens: findTokens("cairo"), view: "waiting" }), "the view AND the words must both hold");

  // ── The tab counts are PEOPLE, never cards ─────────────────────────────────────────────────────
  const counts = countMyCandidatesViews(
    [
      { awaiting: false, candidate: mona },
      { awaiting: true, candidate: mona }, // the same person in a folder and on the sent list
      { awaiting: false, candidate: ahmed },
    ],
    { claims, leavingIds: new Set(["a"]), tokens: [], unseenIds: new Set(["b"]), viewerHrId: "B-94" },
  );
  assert.deepEqual(counts, { all: 2, calling: 1, leaving: 1, unopened: 1, waiting: 1 }, "one person in two lists is one CV, and waiting wins");
  const searched = countMyCandidatesViews([{ awaiting: true, candidate: mona }, { awaiting: true, candidate: ahmed }], {
    claims,
    leavingIds: new Set(),
    tokens: findTokens("mona"),
    unseenIds: new Set(),
    viewerHrId: "B-94",
  });
  assert.equal(searched.all, 1, "the counts follow the words typed");
  assert.equal(searched.waiting, 1, "every tab is counted after the words");

  // ── Going back: the 45-day clock as a countdown, only where it runs ──────────────────────────────
  const now = new Date("2026-11-10T10:00:00.000Z");
  const sentDaysAgo = (days: number, hours = 0) => new Date(now.getTime() - days * 86_400_000 - hours * 3_600_000).toISOString();
  const sent = (id: string, sentAt: string | null) =>
    candidate(id, { managerNotified: sentAt ? { areaName: null, hrId: "B-94", jobTitle: null, name: "Taha", regionName: null, sentAt } : null });
  assert.equal(managerHoldDaysLeft(sentDaysAgo(0), now), 45, "a CV sent this instant has the whole 45 days");
  assert.equal(managerHoldDaysLeft(sentDaysAgo(44, 1), now), 1, "its last day reads 1 day, never 0 while it is still there");
  assert.equal(managerHoldDaysLeft(sentDaysAgo(45), now), 0, "at 45 days it has gone");
  assert.equal(managerHoldDaysLeft("not a date", now), null, "an unreadable date gets no countdown");
  const clock = { holdsFolders: false, now };
  assert.equal(goingBackInDays(sent("x", sentDaysAgo(40)), clock), 5, "sent 40 days ago goes back in 5 days");
  assert.equal(goingBackInDays(sent("x", sentDaysAgo(40)), { ...clock, holdsFolders: true }), null, "a manager who holds area folders keeps his sends — no countdown at all");
  assert.equal(goingBackInDays(sent("x", null), clock), null, "a CV with no send date has no clock");
  const soon = goingBackSoonIds(
    [sent("fresh", sentDaysAgo(10)), sent("week", sentDaysAgo(45 - MANAGER_HOLD_WARN_DAYS)), sent("eight", sentDaysAgo(45 - MANAGER_HOLD_WARN_DAYS - 1)), sent("last", sentDaysAgo(44, 20)), sent("none", null)],
    clock,
  );
  assert.deepEqual([...soon].sort(), ["last", "week"], "only the CVs in their last week are going back soon");
  assert.equal(goingBackSoonIds([sent("last", sentDaysAgo(44, 20))], { ...clock, holdsFolders: true }).size, 0, "nothing is going back for a folder holder");
  assert.equal(goingBackLabel(1), "Goes back tomorrow");
  assert.equal(goingBackLabel(5), "Goes back in 5 days");

  // ── Narrowed folders keep every area, recounted ────────────────────────────────────────────────
  const board = {
    candidateCount: 2,
    coveringVacantSeat: null,
    folders: [
      { areaName: "Tanta 1", candidates: [mona, ahmed], kind: "area" },
      { areaName: "Mahalla", candidates: [], kind: "area" },
    ],
    intake: "reps",
    lineName: "Pedia",
    managerHrId: "B-94",
    regionName: "Delta (1)",
    seatId: "seat-1",
    seatLabel: "PEDIA Delta (1) DM",
  } as unknown as DistrictManagerBoard<Candidate>;
  const [narrowed] = narrowBoards([board], (row) => row.id === "a");
  assert.equal(narrowed.folders.length, 2, "an area with no match is still one of his areas");
  assert.deepEqual(narrowed.folders[0].candidates.map((row) => row.id), ["a"], "only the match is left in its folder");
  assert.equal(narrowed.candidateCount, 1, "the board's count is recounted to what is shown");
  assert.equal(board.candidateCount, 2, "the board passed in is not changed");

  // ── The page wires it: one tray, every own list narrowed, Previous / Next live ────────────────
  const portal = source("../src/components/employee-portal/recruitment-candidates-portal.tsx");
  assert.match(portal, /<MyCandidatesFindBar\b/, "the find tray is on the page");
  assert.match(portal, /partitionManagerCandidates\(shownSentToMe, filings\)/, "the sent list and his shelf are drawn from the narrowed list");
  assert.match(portal, /const areaBoards = shownBoards;/, "the area folders are drawn from the narrowed boards");
  assert.match(portal, /shownApplications\.map\(/, "the open positions are drawn from the narrowed list");
  assert.match(portal, /hasNext=\{nextId !== null\}/, "the opened CV's Next button is live when there is a next CV");
  assert.match(portal, /<ManagerCvList ids=\{liveSendOrder\}>/, "the sent list names its order for Previous and Next");
  assert.match(portal, /<ManagerCvList ids=\{applicationOrder\}>/, "so do the open positions");
  assert.doesNotMatch(portal, /hasNext=\{false\}/, "Previous and Next are no longer drawn dead");
  assert.match(portal, /goingBackInDays\(candidate, hold\)/, "each sent card reads its own countdown");
  assert.match(portal, /goingBackSoonIds\(sentToMe, hold\)/, "Going back soon is drawn from his sends alone");
  assert.match(portal, /searchParams\.set\(CANDIDATE_LINK_PARAM, openId\)/, "the address follows the open CV");
  assert.doesNotMatch(portal, /history\.pushState/, "and is replaced, never pushed — opening CVs never fills Back");
  const page = source("../app/employee-portals/recruitment-candidates/page.tsx");
  assert.match(page, /holdsFolders=\{holdsFolders\}/, "the page says whether his sends run on the clock");
  assert.match(page, /managerHoldsFolders\(access\.hrId\)\.catch\(\(\) => true\)/, "a failed read draws no countdown, never a wrong one");
  const areas = source("../src/components/employee-portal/district-folders-section.tsx");
  const shelf = source("../src/components/employee-portal/manager-folders-section.tsx");
  for (const [name, text] of [["district folders", areas], ["manager folders", shelf]] as const) {
    assert.match(text, /<ManagerCvList ids=/, `the ${name} name each open folder's order`);
    assert.doesNotMatch(text, /\brounded(-[a-z0-9]+)?\b/, `square-edge golden rule: no rounded corner in the ${name}`);
    assert.doesNotMatch(text, /truncate|text-ellipsis|overflow-x-auto|whitespace-nowrap|bg-gradient/, `the ${name} wrap, never cut, and carry no gradient`);
  }
}
