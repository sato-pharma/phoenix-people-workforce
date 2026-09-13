import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  cvOpenRefusal,
  feedbackBlockMessage,
  feedbackIsGiven,
  FEEDBACK_REQUIRED_FROM,
  openIsUnderTheRule,
  type OutstandingFeedback,
} from "../src/lib/recruitment/cv-feedback-lock.ts";

/**
 * "CVs are forwarded automatically to maybe more than one district manager, so what is happening now
 *  is a clash. We call some candidates, they tell us someone other from Sato Pharma also called us,
 *  because there is no any note that this candidate has anyone from the company called him. If you
 *  make it optional, normally no one will put his feedback, and it will keep clashing. So I'm trying
 *  to make them put their feedback by force."
 *
 * The owner, 2026-09-09.
 *
 * FOUR PROPERTIES THIS FILE HOLDS STILL.
 *
 * IT LOOKS ONLY FORWARD. Production held 331 recorded CV opens by 13 people that day, 325 of them
 * with no comment from the person who opened them. A lock that counted history would have locked all
 * 13 managers out on their first page load, each owing feedback on dozens of CVs read weeks ago, and
 * it would have been switched off within the hour. This is the single assertion that keeps the
 * feature shippable at all.
 *
 * REOPENING THE CV HE OWES IS ALWAYS ALLOWED. Without that one line the lock traps a manager behind a
 * document he is being told to write about and cannot re-read. It is one `if`, it is invisible when
 * it works, and everything else here is worthless without it.
 *
 * A RESERVATION IS NOT FEEDBACK. "I will call" records an intention; the sentence the next manager
 * needs is what happened when the call was made. Letting the reservation clear the obligation would
 * leave precisely the empty record the owner is trying to end.
 *
 * AND IT IS ENFORCED WHERE THE CV ACTUALLY OPENS. The card refusing is a courtesy; the file route
 * refusing is the rule. A lock that lives only in a component is a lock the next screen forgets.
 */
export async function runCvFeedbackLockTests() {
  const owed = (over: Partial<OutstandingFeedback> = {}): OutstandingFeedback => ({
    candidateId: "cand-owed",
    candidateName: "Ahmed Hasan",
    openedAt: "2026-09-10T09:00:00.000Z",
    ...over,
  });

  // ── 1 · It looks only forward ─────────────────────────────────────────────────────────────────
  assert.equal(openIsUnderTheRule("2026-09-10T09:00:00.000Z"), true, "an open after the cutoff counts");
  assert.equal(
    openIsUnderTheRule("2026-09-08T09:00:00.000Z"),
    false,
    "an open BEFORE the cutoff must never create an obligation — 325 such opens existed on the day this shipped",
  );
  assert.equal(openIsUnderTheRule(FEEDBACK_REQUIRED_FROM), true, "the cutoff instant itself counts");
  assert.equal(openIsUnderTheRule(null), false, "no timestamp is no obligation");
  assert.equal(openIsUnderTheRule("not a date"), false, "and neither is an unreadable one");

  // ── 2 · Reopening the CV he owes is always allowed ────────────────────────────────────────────
  assert.equal(
    cvOpenRefusal(owed(), "cand-owed"),
    null,
    "he must always be able to re-read the CV he is being asked to write about",
  );
  assert.ok(cvOpenRefusal(owed(), "some-other-cv"), "and must be refused every other one");
  assert.equal(cvOpenRefusal(null, "anything"), null, "owing nothing blocks nothing");

  // ── 3 · The refusal names the person, and says why ────────────────────────────────────────────
  {
    const message = String(cvOpenRefusal(owed(), "other"));
    assert.match(message, /Ahmed Hasan/, "it names the candidate rather than quoting an id");
    // The owner dictated this sentence; it must survive intact. He asked for the CONDITION and the
    // REMEDY in one line, not for an explanation of the policy behind it.
    assert.match(message, /To open this CV or any other/, "the opener is the owner's own wording");
    assert.match(message, /feedback on the ones you opened before/, "and so is the remedy half of it");
    // A CV whose name could not be resolved must still produce a sentence, not "undefined".
    const nameless = feedbackBlockMessage(owed({ candidateName: null }));
    assert.doesNotMatch(nameless, /undefined|null/, `a nameless CV still reads as English: ${nameless}`);
  }

  // ── 4 · A reservation is not feedback ─────────────────────────────────────────────────────────
  assert.equal(feedbackIsGiven({ answeredWithNote: false, commented: true }), true, "a comment clears it");
  assert.equal(
    feedbackIsGiven({ answeredWithNote: true, commented: false }),
    true,
    "and so does the reason Skip already forces him to type",
  );
  assert.equal(
    feedbackIsGiven({ answeredWithNote: false, commented: false }),
    false,
    "opening the CV and pressing 'I will call' leaves the obligation standing — an intention is not a finding",
  );

  // ── 5 · Enforced where the CV actually opens, and it fails OPEN ───────────────────────────────
  const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

  const view = read("../src/lib/recruitment/hiring-manager-view.ts");
  assert.ok(
    view.includes("loadOutstandingFeedback(access.hrId)") && view.includes("cvOpenRefusal(outstanding, candidateId)"),
    "the file chokepoint must ask the lock — every CV open in the portal passes through it, whichever screen asked",
  );
  {
    // Sliced to the DOWNLOAD function's own body. The first version of this compared file-wide
    // indexes and failed against correct code, because the import of the loader sits above the scope
    // helper's definition — a source pin that reads the wrong occurrence is worse than none, since
    // the obvious way to "fix" it is to delete it.
    const start = view.indexOf("export async function downloadHiringManagerCandidateFile");
    assert.ok(start > 0, "the download function must still be here");
    const body = view.slice(start);
    const scopeAt = body.indexOf("assertCandidateInHiringManagerScope(access, candidateId)");
    const lockAt = body.indexOf("loadOutstandingFeedback(access.hrId)");
    assert.ok(scopeAt > 0 && lockAt > 0, "both checks must run inside the download path");
    assert.ok(
      scopeAt < lockAt,
      "the lock must be asked AFTER the scope check, so a manager is never told he owes feedback on a CV he may not see",
    );
  }

  const route = read("../app/api/recruitment/hiring-manager/candidates/[candidateId]/files/[fileId]/route.ts");
  assert.ok(
    route.includes("CvFeedbackRequiredError") && route.includes("423"),
    "the route must answer 423 with the outstanding CV attached — a 403 would send him to have a permission fixed that is not broken",
  );

  const db = read("../src/lib/recruitment/cv-feedback-lock-db.ts");
  assert.ok(
    /catch \(error\)[\s\S]{0,600}?return null;/.test(db),
    "the loader must FAIL OPEN: a database error may cost one missing note, never lock a manager out of every CV in the company",
  );

  // The card refuses at the button, using the SAME function, so its sentence and the 423's are one.
  const actions = read("../src/components/employee-portal/candidate-cv-actions.tsx");
  assert.ok(
    actions.includes("cvOpenRefusal(outstandingFeedback, candidateId)"),
    "the card must ask the same rule rather than re-deriving it",
  );
  // ── THE WAY OUT IS A BOX, NOT ONLY A LINK ─────────────────────────────────────────────────────
  //
  // MEASURED ON PRODUCTION, 2026-09-13: eleven people locked, ten of them on a CV that was never sent
  // to them — opened from an area folder or a team list. "Go to that CV →" was an in-page anchor to a
  // card that exists only while its folder is open, or not at all once the applicant is re-placed.
  // Samaa Shalabi could not reach Ahmed Abdelgwad either way, and could open no other CV.
  const box = read("../src/components/employee-portal/owed-feedback-box.tsx");
  assert.ok(
    actions.includes("<OwedFeedbackBox") && !actions.includes('href={`#candidate-'),
    "the card's block must carry the feedback box itself, not a bare link to a card that may not be on the page",
  );
  assert.ok(
    /<textarea/.test(box) && box.includes("/comments`") && /method: "POST"/.test(box),
    "the box must let him WRITE the feedback in place, posting to the same comment route the card uses",
  );
  assert.ok(box.includes("#candidate-"), "and still offers the link, for when the card is on the page");

  // The comment route must let the person who OPENED the CV write about it, wherever the candidate
  // sits now. The lock remembers the open; if the route re-derives scope from today's folders, the
  // manager is told to write something the route then refuses.
  const commentsRoute = read("../app/api/recruitment/hiring-manager/candidates/[candidateId]/comments/route.ts");
  {
    const post = commentsRoute.slice(commentsRoute.indexOf("export async function POST"));
    assert.ok(
      /if \(!\(await hasOpenedCandidate\(access\.hrId, candidateId\)\)\) \{\s*await assertCanComment\(access, candidateId\);/.test(post),
      "POST must accept a comment from anyone who has opened this CV before falling back to the scope check",
    );
    const get = commentsRoute.slice(commentsRoute.indexOf("export async function GET"), commentsRoute.indexOf("export async function POST"));
    assert.doesNotMatch(get, /hasOpenedCandidate/, "reading the thread keeps the strict scope — only the write is widened");
  }
  assert.ok(
    /hasOpenedCandidate[\s\S]{0,1400}?if \(error\) return false;[\s\S]{0,200}?catch \{\s*return false;/.test(db),
    "the opener check widens who may write, so it must fail CLOSED",
  );

  // Every card that can open a CV must also be able to write the feedback that releases it. The
  // interview-round card had no comment thread at all, which would have been a dead end.
  const portal = read("../src/components/employee-portal/recruitment-candidates-portal.tsx");
  assert.equal(
    (portal.match(/<CandidateCommentThread/g) ?? []).length,
    2,
    "both portal cards that open a CV must carry a comment thread, or opening one is a trap with no way out",
  );

  // ── 6 · A locked CV explains itself; it does not pretend to be broken ─────────────────────────
  //
  // MEASURED ON SCREEN, 2026-09-09. Opening a second CV while owing feedback showed "Could not load
  // the document. Ask the recruitment team to send you a readable copy of this CV." Nothing was
  // wrong with that file. The owner read it as the portal being broken, and worse, it points him at
  // somebody else over a problem only he can clear.
  const viewer = read("../src/components/recruitment/cv-preview-modal.tsx");
  assert.ok(
    /res\.status === 423/.test(viewer),
    "the preview must recognise the lock's 423 instead of treating it as a failed document load",
  );
  assert.ok(
    viewer.includes("<OwedFeedbackBox"),
    "and must carry the feedback box for the CV he owes, or the notice is a dead end",
  );
  assert.ok(
    /const documentBody = locked \?/.test(viewer),
    "when the lock refused there is no document and nothing loading, so the notice must REPLACE the body rather than sit beside a spinner and a red error",
  );

  // ── 7 · One box, not two ─────────────────────────────────────────────────────────────────────
  //
  // The owner, 2026-09-09: *"I have two fields for your answer and your comments — merge them into
  // one field, no need two fields."* After the lock there is only one thing to type on a CV.
  assert.doesNotMatch(
    portal,
    /A short note for the recruitment team/,
    "the card's second textarea must be gone — the answer and the comment are one box now",
  );
  {
    // Scoped to the SENT card, which is the one the owner was looking at. The interview-outcome
    // form further up owns a "Feedback notes" box of its own and is a different thing entirely —
    // the result of an interview, with scores, not what he found on the CV. A whole-file textarea
    // count catches that one too and reads as a defect, which is how a correct screen gets
    // "fixed".
    const start = portal.indexOf("function SentCandidateCard(");
    assert.ok(start > 0, "the sent-CV card must still be here");
    const card = portal.slice(start, portal.indexOf("\nexport function RecruitmentCandidatesPortal"));
    assert.equal(
      (card.match(/<textarea/g) ?? []).length,
      0,
      "the sent-CV card must own no textarea of its own; the comment composer is the only box on it",
    );
  }
  assert.ok(
    portal.includes("composerActions={"),
    "the answer buttons must be rendered INSIDE the comment composer, sharing its text",
  );
  assert.ok(
    /answer\("not_interested", draft, clearDraft\)/.test(portal),
    "and Skip must take its required reason from that shared box",
  );
}
