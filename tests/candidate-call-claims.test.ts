import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  callClaimNotice,
  candidateCallRefusal,
  isCandidateCallRequest,
  redactCandidateContact,
  redactCandidateListContact,
  redactDistrictBoardsContact,
  revealPhoneToViewer,
  type CandidateCallClaim,
} from "../src/lib/recruitment/candidate-call-claims.ts";
import { hiringManagerDecisionLabels } from "../src/lib/recruitment/candidate-status.ts";
import type { DistrictManagerBoard } from "../src/lib/recruitment/district-manager-folders.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * "On every CV I want the phone number to be hidden, and the download to be blocked of the CV, and
 *  have 2 buttons on every CV — I will call and Skip. If the manager chooses skip then he is skipped
 *  normally, and if pressed I will call then every other manager receiving this CV, when open the
 *  same CV, shows that Ahmed will call this CV, or reserved."
 *
 * The owner, 2026-09-09.
 *
 * FOUR PROPERTIES THIS FILE HOLDS STILL.
 *
 * THE PHONE NUMBER IS REVEALED BY THE CLAIM AND BY NOTHING ELSE. Not by being able to claim, not by
 * being the manager the CV was sent to, not by sitting above him on the org chart. One function
 * decides it, both the server redaction and the card ask that function, and this file is what stops
 * a second copy of the rule appearing on the screen side where it would quietly disagree.
 *
 * hr_id CASE CANNOT BREAK IT. ats_candidates stores 'b-10' where public.employees stores 'B-10'. A
 * case-sensitive comparison here does not fail loudly — it hides the number from the very manager
 * holding the reservation, which reads as the feature being broken rather than as a casing bug.
 *
 * THE NESTED FOLDERS ARE REDACTED TOO. The district boards carry their candidates two levels down.
 * A redaction written by hand at a call site covers the flat list, misses the folders, and the phone
 * numbers keep travelling inside the half of the payload nobody looked at.
 *
 * THE DOWNLOAD BLOCK IS SERVER-SIDE. A card that stops offering a Download link while the URL still
 * serves the file has not blocked anything, and that URL is one right-click away.
 */
export async function runCandidateCallClaimTests() {
  const claim = (managerHrId: string, managerName: string | null = "Ahmed Gawish"): CandidateCallClaim => ({
    candidateId: "cand-1",
    claimedAt: "2026-09-09T10:00:00.000Z",
    managerHrId,
    managerName,
  });

  const person = (id: string, phone: string | null, whatsapp: string | null) => ({
    id,
    fullName: `Applicant ${id}`,
    phone,
    whatsapp,
  });

  // ── 1 · Only the holder sees the number ───────────────────────────────────────────────────────
  assert.equal(revealPhoneToViewer(claim("B-10"), "B-10"), true, "the holder sees it");
  assert.equal(revealPhoneToViewer(claim("B-10"), "A-12"), false, "another manager does not");
  assert.equal(revealPhoneToViewer(null, "B-10"), false, "an unclaimed CV shows nobody the number");
  assert.equal(revealPhoneToViewer(claim("B-10"), null), false, "and neither does a viewer with no hr id");
  assert.equal(revealPhoneToViewer(claim("B-10"), "   "), false, "blank is not an hr id");

  // ── 2 · hr_id case, in BOTH directions ────────────────────────────────────────────────────────
  //
  // The stored side is upper-case canonical and the session side is the lower-case comparison key,
  // so these two rows are the real production pairing, not a contrived one.
  assert.equal(revealPhoneToViewer(claim("B-10"), "b-10"), true, "stored upper, viewer lower");
  assert.equal(revealPhoneToViewer(claim("b-10"), "B-10"), true, "stored lower, viewer upper");

  // ── 3 · Redaction blanks the WhatsApp number with the phone ───────────────────────────────────
  //
  // It is the same number in practice and the same act — ringing the candidate directly — so leaving
  // it behind would make the phone rule decorative.
  {
    const held = redactCandidateContact(person("a", "0100", "0100"), true);
    assert.equal(held.phone, "0100", "the holder keeps the phone");
    assert.equal(held.whatsapp, "0100", "and the WhatsApp number");

    const hidden = redactCandidateContact(person("a", "0100", "0100"), false);
    assert.equal(hidden.phone, null, "everybody else gets neither");
    assert.equal(hidden.whatsapp, null, "including the WhatsApp number");
    assert.equal(hidden.fullName, "Applicant a", "and nothing else on the row is touched");
  }

  // ── 4 · A list redacts per candidate, against that candidate's own claim ──────────────────────
  {
    const claims = { "cand-1": claim("B-10") };
    const list = [
      { ...person("cand-1", "0100", "0111"), id: "cand-1" },
      { ...person("cand-2", "0200", "0222"), id: "cand-2" },
    ];
    const asHolder = redactCandidateListContact(list, claims, "b-10");
    assert.equal(asHolder[0].phone, "0100", "his own reserved CV keeps its number");
    assert.equal(asHolder[1].phone, null, "the one he has NOT reserved does not");

    const asOther = redactCandidateListContact(list, claims, "a-12");
    assert.deepEqual(
      asOther.map((row) => row.phone),
      [null, null],
      "another manager sees no number on either",
    );
  }

  // ── 5 · The district folders are redacted at their real depth ─────────────────────────────────
  {
    const boards: DistrictManagerBoard<ReturnType<typeof person>>[] = [
      {
        candidateCount: 1,
        coveringVacantSeat: null,
        folders: [
          {
            areaName: "Nasr City",
            candidates: [person("cand-2", "0200", "0222")],
            fromCvText: [],
            fromGovernorate: [],
            kind: "area",
          },
        ],
        lineName: "Pedia",
        managerHrId: "A-12",
        regionName: "Cairo",
        seatId: "seat-1",
        seatLabel: "PEDIA Cairo DM",
      } as unknown as DistrictManagerBoard<ReturnType<typeof person>>,
    ];
    const redacted = redactDistrictBoardsContact(boards, {}, "a-12");
    assert.equal(
      redacted[0].folders[0].candidates[0].phone,
      null,
      "a CV nested inside a folder is redacted like any other",
    );
    assert.equal(redacted[0].folders[0].areaName, "Nasr City", "and the folder itself is unchanged");
    assert.equal(boards[0].folders[0].candidates[0].phone, "0200", "the input is not mutated");
  }

  // ── 6 · The notice names the holder, and addresses the holder differently ─────────────────────
  assert.equal(
    callClaimNotice(claim("A-12", "Ahmed Gawish"), "b-10"),
    "Ahmed Gawish will call this candidate.",
    "the owner's own example, in his own words",
  );
  assert.match(callClaimNotice(claim("B-10"), "b-10"), /^You /, "the holder is told it is his");
  assert.equal(
    callClaimNotice(claim("A-12", null), "b-10"),
    "Unnamed manager will call this candidate.",
    // Owner's rule: names, never raw ids — see AGENTS.md §4. This used to read "A-12 will call this
    // candidate.", printing the raw HR id in the one sentence whose whole job is to say WHO. It
    // still names somebody the only way it honestly can, in words instead of a code nobody can act on.
    "a claim whose name could not be resolved still names somebody — in words, never as the raw id",
  );

  // ── 7 · What a press is refused for ───────────────────────────────────────────────────────────
  assert.equal(candidateCallRefusal("will_call", null, "b-10"), null, "a free CV may be taken");
  assert.equal(
    candidateCallRefusal("will_call", claim("B-10"), "b-10"),
    null,
    "pressing twice means the same thing as pressing once, so it is not an error",
  );
  assert.match(
    String(candidateCallRefusal("will_call", claim("A-12"), "b-10")),
    /Ahmed Gawish/,
    "a taken CV is refused, and the refusal says who has it",
  );
  assert.match(
    String(candidateCallRefusal("release", claim("A-12"), "b-10")),
    /Ahmed Gawish/,
    "and nobody can release somebody else's reservation",
  );
  assert.equal(candidateCallRefusal("release", claim("B-10"), "b-10"), null, "his own, he may release");
  assert.equal(
    candidateCallRefusal("skip", claim("A-12"), "b-10"),
    null,
    "passing on a CV somebody else has taken is an ordinary thing to do",
  );
  assert.ok(candidateCallRefusal("will_call", null, null), "an account with no hr id cannot reserve");

  assert.equal(isCandidateCallRequest("will_call"), true);
  assert.equal(isCandidateCallRequest("interview"), false, "the decision vocabulary is a different one");

  // ── 8 · The button says Skip ──────────────────────────────────────────────────────────────────
  //
  // Only the label moved. The CODE stays `not_interested` because it is the wire value the decision
  // route validates against, so renaming it would be an API change dressed as a wording change.
  assert.equal(hiringManagerDecisionLabels.not_interested, "Skip", "the owner's word, on the button");
  assert.equal(hiringManagerDecisionLabels.interview, "I want to interview", "the after-the-call answer is unchanged");

  // ── 9 · The download block lives on the SERVER, and the card does not offer one ───────────────
  //
  // Read as source rather than exercised, because the thing being pinned is an ABSENCE — a Download
  // link that must not come back, and a route that must not serve a file. Both were removed at the
  // owner's instruction and both are the kind of thing a later session restores as a convenience.
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

  const fileRoute = read(
    "../app/api/recruitment/hiring-manager/candidates/[candidateId]/files/[fileId]/route.ts",
  );
  // An ALLOW-LIST, and the whole of it is pinned here. Until 2026-09-27 this route tested for one
  // mode (`!== "base64"`); it now serves a second RENDER — `doc-text`, the lines of a Word 97-2003
  // binary .doc read on the server, because no browser can open that format and the manager's card
  // otherwise had only a sentence for it. What must never change is the shape: a closed list of
  // modes that hand over a RENDER, refusing everything else, so the bare URL (a save-file prompt)
  // and `?disposition=inline` (the same bytes one keystroke from being saved) stay refused.
  assert.match(
    fileRoute,
    /RENDER_ONLY_FORMATS\s*=\s*new Set\(\["base64", "doc-text"\]\)/,
    "the manager's file route must serve ONLY in-page renders, from a closed list — adding a mode that hands over the document itself is the download coming back",
  );
  // THE FILE FOLLOWS THE PHONE NUMBER (owner, 2026-10-13: download only after "I will call"). Anything
  // not on the render list — no format at all, the bare URL's save-file prompt — is served only to
  // the manager `revealPhoneToViewer` names, and is asked BEFORE the file is fetched.
  // 2026-10-16: a CV a person SENT to the caller is served as the file with no reservation first
  // ("no restriction — he can download"). Every other CV keeps the reservation test, still the same
  // function that unmasks the number and never a second copy of it.
  assert.match(
    fileRoute,
    /const isRender = Boolean\(format && RENDER_ONLY_FORMATS\.has\(format\)\);\s*if \(\s*!isRender &&\s*!\(await isCandidateSentToCaller\(access, candidateId\)\) &&\s*!revealPhoneToViewer\(await loadCallClaim\(candidateId\), access\.hrId\)\s*\) \{/,
    "a non-render request must be refused unless the CV was sent to the caller or the caller holds the reservation — the same test that unmasks the number, never a second copy of it",
  );
  assert.ok(
    fileRoute.indexOf("revealPhoneToViewer(await loadCallClaim") <
      fileRoute.indexOf("await downloadHiringManagerCandidateFile("),
    "the reservation is asked before the file is fetched out of Drive",
  );
  // `disposition` is refused by NOT being on that list, so the check is that the route never reads
  // it as a branch of its own. Comments are stripped first: the route's own explanation names the
  // mode it refuses, and raw source would match the explanation rather than the code.
  assert.ok(
    !/disposition/.test(fileRoute.replace(/^[ \t]*\/\/.*$/gm, "")),
    "the manager's route must never branch on ?disposition — that mode is the open-in-a-new-tab escape hatch and it stays refused",
  );
  assert.ok(
    !/NextResponse\.redirect/.test(fileRoute),
    "an external file must not be redirected to either: that hands over the raw document at an origin nothing here reaches",
  );

  // ── 10 · EVERY manager route that hands back a candidate must redact it ──────────────────────
  //
  // A SWEEP, not a list of the three that exist today. The page redacts its own lists, and two live
  // routes were still answering with the raw row when this was written — /hiring-manager/candidates,
  // which no screen calls at all and so is the easiest to forget, and the decision route, which
  // returns the candidate as STORED after an answer. Either one leaves the whole rule resting on a
  // page that happens not to ask, and a fourth such route is one PR away.
  //
  // The call route is deliberately NOT caught by this: it returns `phone` and no `candidate`, which
  // is the one response allowed to carry a number — to the manager who just reserved the CV.
  {
    const routesRoot = fileURLToPath(new URL("../app/api/recruitment/hiring-manager/", import.meta.url));
    const routeFiles = readdirSync(routesRoot, { encoding: "utf8", recursive: true })
      .filter((name) => name.endsWith("route.ts"))
      .sort();
    assert.ok(routeFiles.length >= 5, "the hiring-manager route folder should not have emptied");

    // IT READS THE VALUE, NOT THE FILE. The first version of this asked whether the source mentioned
    // "redactCandidate" anywhere, and it passed on a route whose redaction had been deleted — the
    // IMPORT line still carried the word. So it looks for the two shapes that actually hand over a
    // raw row inside a response body: the object shorthand `{ candidates, ... }` and the identity
    // `{ candidates: candidates }`. Anything else there is a call, and the only calls that produce a
    // candidate for a manager are the redactors.
    // THE TWO ROUTES THAT HAND BACK ONLY THE CALLER'S OWN SENT CVs ARE EXEMPT (owner, 2026-10-16: once a
    // CV has reached a manager there is "no any restriction — can download, can see number, can do
    // anything"). Both read the caller's own id off the session, so what they return is a CV a person
    // pushed to that very manager. The team routes — a manager reading what sits with those BELOW
    // him — stay redacted and stay in this sweep.
    const OWN_SENT_ROUTES = new Set(["candidates/route.ts", "candidates/[candidateId]/decision/route.ts"]);
    for (const exempt of OWN_SENT_ROUTES) {
      assert.ok(
        routeFiles.some((name) => name.replace(/\\/g, "/") === exempt),
        `the exempt route ${exempt} should still exist — a stale exemption is a hole`,
      );
    }
    const offenders: string[] = [];
    for (const name of routeFiles) {
      if (OWN_SENT_ROUTES.has(name.replace(/\\/g, "/"))) continue;
      const source = stripComments(readFileSync(join(routesRoot, name), "utf8"));
      for (const body of source.matchAll(/NextResponse\.json\(\{([\s\S]{0,800}?)\}\s*[,)]/g)) {
        const payload = body[1];
        if (/(^|[{,\s])candidates?\s*[,}\s]*$|(^|[{,\s])candidates?\s*,/.test(payload)) {
          offenders.push(`${name} (shorthand)`);
        }
        if (/\bcandidates?\s*:\s*candidates?\s*[,}]/.test(payload)) offenders.push(`${name} (identity)`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `these hiring-manager routes hand a manager a candidate row with its phone number still on it: ${offenders.join(", ")}`,
    );
  }

  // ── 11 · A folder holds only what a person sent ──────────────────────────────────────────────
  //
  // 2026-10-16: the folders are filled by sends and nothing else, so a manager's Return or Skip is
  // not a suppression to be remembered any more — it deletes his own send row, and a re-push by
  // Talent Acquisition is a new send that brings the CV back. The loader therefore reads his sends
  // and neither a return table nor a skip table.
  const foldersLoader = read("../src/lib/recruitment/district-manager-folders-db.ts");
  assert.ok(
    foldersLoader.includes("listSendsForManager(managerHrId)"),
    "the manager-scoped folder loader must read the CVs sent to him",
  );
  assert.ok(
    !foldersLoader.includes("loadManagerSkipSuppressions") && !foldersLoader.includes("placeCandidatesInDistrictFolders"),
    "and must not place anybody by itself — a folder filled by a rule is the automatic delivery the owner removed",
  );

  const cvActions = read("../src/components/employee-portal/candidate-cv-actions.tsx");
  // The card's Download link and the modal's own are both drawn only for the reservation holder, off
  // the SAME flag that unmasks the number — so the offer and the server's refusal cannot drift.
  assert.ok(
    cvActions.includes("allowDownload={showPhoneNumbers}"),
    "the preview modal's own Download link follows the reservation, never a constant",
  );
  assert.ok(
    /\{showPhoneNumbers \? \(\s*<a[\s\S]{0,300}?href=\{href\}[\s\S]{0,200}?Download CV/.test(cvActions),
    "the card's Download CV link is drawn only when the viewer holds the reservation",
  );
  assert.ok(!cvActions.includes("allowDownload={false}"), "the constant block is gone");
}
