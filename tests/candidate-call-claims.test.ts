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
    "A-12 will call this candidate.",
    "a claim whose name could not be resolved still names somebody — it is still a claim",
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
  assert.ok(
    fileRoute.includes('!== "base64"'),
    "the manager's file route must serve ONLY the in-page base64 render — the bare URL is a save-file prompt and ?disposition=inline is the same bytes one keystroke from being saved",
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
    const offenders: string[] = [];
    for (const name of routeFiles) {
      const source = readFileSync(join(routesRoot, name), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
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

  // ── 11 · A skip must actually leave the manager's folder ─────────────────────────────────────
  //
  // The suppression set the placement rule is handed has to carry BOTH halves. Its sibling test
  // (recruitment-district-returns) pins that the manager-scoped loader passes `suppressedReturns` at
  // all, which is what proves a RETURN is applied; this pins that a SKIP is folded into that same
  // set. Without it the union can be dropped in a tidy-up and every skipped CV silently comes back,
  // with the sibling test still green because the call literal it reads is unchanged.
  const foldersLoader = read("../src/lib/recruitment/district-manager-folders-db.ts");
  assert.ok(
    foldersLoader.includes("loadManagerSkipSuppressions(managerHrId)"),
    "the manager-scoped folder loader must read his skips",
  );
  assert.ok(
    /skippedByHim\.size === 0 \? returnedByHim : new Set\(\[\.\.\.returnedByHim, \.\.\.skippedByHim\]\)/.test(
      foldersLoader,
    ),
    "and must union them with his returns into the ONE set the placement rule is given — a skip that is read but not folded in leaves the CV sitting in his folder",
  );

  const cvActions = read("../src/components/employee-portal/candidate-cv-actions.tsx");
  assert.ok(
    !/>\s*Download/.test(cvActions) && !cvActions.includes("`Download — ${"),
    "the manager's CV card must offer no Download control",
  );
  assert.ok(
    cvActions.includes("allowDownload={false}"),
    "and must tell the preview modal to hide its own Download link, which is the second copy of it",
  );
}
