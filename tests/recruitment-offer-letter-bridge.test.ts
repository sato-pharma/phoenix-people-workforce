import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { buildOfferLetterDraft } from "../src/lib/recruitment/offer-letter-bridge.ts";
import type { OfferApprovalTrail, OfferTerms } from "../src/lib/recruitment/offer-rules.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * The offer bridge: an approved recruitment offer's terms, carried into the letter composer.
 *
 * Two properties matter more than everything else here, and both are about what the bridge
 * REFUSES to do.
 *
 * 1. It cannot become a route past approval. The owner's rule is one approval before anything
 *    reaches a candidate. The registry once listed offer_initiated -> offer_sent, skipping it;
 *    a pre-filled letter is a way to reach a candidate, so the bridge must be shut on every
 *    unapproved state, not merely on the obvious one.
 *
 * 2. It cannot become a third opinion on the money. src/lib/offers/pay.ts owns the split of a
 *    package into basic, transport and cost of living, and documents at length why it must not
 *    borrow payroll's 70% even though the two agree today. A bridge that pre-computed any part
 *    of that would put a fourth number on a document somebody signs.
 */

// Annotated, not inferred: from the values alone TypeScript reads `sentAt: null` and
// `approvedAt: string` as the types, and then every variant below is a type error rather
// than a case. The test suite strips types, so only the typecheck job sees that.
const approved: OfferTerms & OfferApprovalTrail = {
  jobTitle: "Medical Representative",
  monthlyGross: 18_550,
  startDate: "2026-10-01",
  submittedForApprovalAt: "2026-09-20T09:00:00.000Z",
  approvedAt: "2026-09-21T09:00:00.000Z",
  sentAt: null,
};

const candidate = {
  fullName: "Omar Tamer",
  email: "omar.tamer@example.com",
  preferredAreaName: "Tanta",
  preferredRegionName: "Delta",
};

function sourceFilesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry.startsWith("_wt-") || entry === ".next") continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

export function runRecruitmentOfferLetterBridgeTests() {
  // ── 1. THE APPROVAL GATE, on every unapproved state ────────────────────────────────────────
  //
  // Not just "unapproved": each of these is a different way for an offer to be short of approval,
  // and a guard that only checks approvedAt would pass three of them.
  const unapproved: Array<[string, (OfferTerms & OfferApprovalTrail) | null, RegExp]> = [
    ["no offer at all", null, /no offer on this application/i],
    [
      "terms still incomplete",
      { ...approved, monthlyGross: null, approvedAt: null, submittedForApprovalAt: null },
      /missing its monthly gross salary/i,
    ],
    ["never submitted", { ...approved, submittedForApprovalAt: null, approvedAt: null }, /not been submitted for approval/i],
    ["submitted, still waiting", { ...approved, approvedAt: null }, /waiting for approval/i],
    ["already sent", { ...approved, sentAt: "2026-09-22T09:00:00.000Z" }, /already been sent/i],
  ];

  for (const [what, offer, expected] of unapproved) {
    const result = buildOfferLetterDraft({ offer, candidate });
    assert.equal(
      result.ok,
      false,
      `an offer with ${what} must NOT produce a pre-filled letter - a pre-filled letter is a way `
        + "to reach a candidate, and the owner's rule is one approval before anything reaches one",
    );
    assert.match(
      result.ok ? "" : result.reason,
      expected,
      `the refusal for "${what}" must say which gate stopped it, in the recruiter's words`,
    );
  }

  // ── 2. THE MONEY IS CARRIED, NEVER DERIVED ────────────────────────────────────────────────
  const ok = buildOfferLetterDraft({ offer: approved, candidate });
  assert.ok(ok.ok, "an approved offer with a named candidate must produce a draft");
  if (!ok.ok) return;

  assert.equal(
    ok.draft.totalMonthly,
    18_550,
    "the approved figure must reach the letter to the pound. src/lib/offers/pay.ts derives basic, "
      + "transport and cost of living FROM this number - anything the bridge computed would be a "
      + "second answer to a question that already has one",
  );

  // Nothing the offers module mints or owns may appear in the draft. Checked as ABSENT KEYS, not
  // as empty strings: an empty string is a value the composer would treat as answered.
  for (const owned of ["costOfLiving", "contractTerm", "reportsTo", "reference", "dateOfIssue", "validUntil"]) {
    assert.equal(
      owned in ok.draft,
      false,
      `${owned} must NOT be carried. costOfLiving, contractTerm and reportsTo belong to the job `
        + "title's own entry in the offers module; reference, dateOfIssue and validUntil are minted "
        + "there. Filling any of them here would be the ATS guessing at data it does not hold",
    );
  }

  // ── 3. WHAT IT CARRIES, AND WHAT IT ADMITS IT CANNOT ──────────────────────────────────────
  assert.equal(ok.draft.candidateName, "Omar Tamer");
  assert.equal(ok.draft.title, "Medical Representative");
  assert.equal(ok.draft.startDate, "2026-10-01");
  assert.equal(ok.draft.candidateEmail, "omar.tamer@example.com");
  assert.equal(ok.draft.territory, "Tanta", "the stated area preference is better than blank");

  assert.equal(
    ok.draft.salutationName,
    "Omar Tamer",
    "no honorific may be invented - guessing Dr, Mr or Ms means guessing a qualification and a "
      + "gender on a document the person keeps",
  );
  assert.equal(/^(dr|mr|ms|mrs)\b/i.test(ok.draft.salutationName), false, "and certainly not a guessed one");

  assert.ok(
    ok.leftForYou.some((line) => /cost of living/i.test(line)),
    "the screen must be told cost of living is still outstanding, or a half-filled letter reads as a complete one",
  );
  assert.ok(
    ok.leftForYou.some((line) => /not a posting/i.test(line)),
    "a carried territory is a candidate's PREFERENCE and must be named as one - nobody has been posted anywhere at offer time",
  );

  // A candidate with a preference stated only at region level still gets one.
  const regionOnly = buildOfferLetterDraft({
    offer: approved,
    candidate: { ...candidate, preferredAreaName: null },
  });
  assert.ok(regionOnly.ok && regionOnly.draft.territory === "Delta", "region is the fallback when no area was stated");

  // No email is not a refusal - the composer collects it - but it must be said out loud.
  const noEmail = buildOfferLetterDraft({ offer: approved, candidate: { ...candidate, email: null } });
  assert.ok(noEmail.ok, "a missing email must not block composing - the composer collects it");
  assert.ok(
    noEmail.ok && noEmail.leftForYou.some((line) => /email address/i.test(line)),
    "but the recruiter must be told, because the letter cannot be sent without one",
  );

  // ── 4. A LETTER MUST BE ADDRESSED TO SOMEBODY ─────────────────────────────────────────────
  for (const nameless of [null, "", "   "]) {
    const result = buildOfferLetterDraft({ offer: approved, candidate: { ...candidate, fullName: nameless } });
    assert.equal(result.ok, false, `a candidate whose name is ${JSON.stringify(nameless)} must be refused`);
    assert.match(result.ok ? "" : result.reason, /addressed to nobody/i);
  }

  // ── 5. THE ONE GATE, NOT A SECOND COPY ────────────────────────────────────────────────────
  //
  // offerSendBlockReason reads approvedAt rather than the stage, on purpose: the workflow registry
  // is editable at RUNTIME, so it can never be the thing that decides this. A bridge that
  // re-implemented the rule would be a second copy to keep in step, and the copy is always what
  // drifts.
  const bridge = readFileSync("src/lib/recruitment/offer-letter-bridge.ts", "utf8");
  assert.match(
    bridge,
    /offerSendBlockReason\(input\.offer\)/,
    "the bridge must call offerSendBlockReason, not restate the approval rule",
  );
  assert.equal(
    /approvedAt\s*(===|!==|==|!=)/.test(bridge),
    false,
    "the bridge must not read approvedAt itself - that is precisely the second copy that drifts",
  );

  // ── 6. THE OWNER'S INSTRUCTION, PINNED MECHANICALLY ───────────────────────────────────────
  //
  // src/lib/offers/types.ts opens with the owner's rule: that module is deliberately independent
  // of recruitment, an offer may be issued to somebody who never entered the ATS, and "the two
  // must not be merged". Coupling has a DIRECTION, and only one direction breaks that rule.
  //
  // This is the assertion that keeps the bridge honest a year from now, when somebody reaches for
  // a candidate's record from inside the composer because it is right there.
  const offenders: string[] = [];
  for (const file of sourceFilesUnder(join("src", "lib", "offers"))) {
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, index) => {
      if (/from\s+["']@\/lib\/recruitment|from\s+["']\.\.\/recruitment/.test(line)) {
        offenders.push(`${file.split(sep).join("/")}:${index + 1}  ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "src/lib/offers must never import recruitment. The owner asked for a module that can issue an "
      + "offer to somebody who never entered the ATS, and its own header says the two must not be "
      + "merged. The bridge points the other way - recruitment reads a TYPE from offers - so an "
      + `offer to a walk-in keeps working:\n${offenders.join("\n")}`,
  );

  // ── 7. THE ROUTE THAT MAKES IT REACHABLE ──────────────────────────────────────────────────
  //
  // A bridge nothing calls is not a bridge. These pin the two properties of the route that a
  // future edit could quietly drop, both of which are about authority rather than correctness.
  const route = readFileSync("app/api/recruitment/applications/[id]/offer-letter/route.ts", "utf8");

  assert.match(
    route,
    /requireRecruitmentAccess\(request, "recruitment", "approve"\)/,
    "the route must scope the application - requireRecruitmentAccess throws when the requisition "
      + "is outside the caller's reach, and without it any recruiter could compose against any pipeline",
  );
  assert.match(
    route,
    /assertPermission\(access, "offers", "create"\)/,
    "and must separately require offers:create - reading a pipeline is not authority to put the "
      + "company's name on a letter. Two different privileges, both needed",
  );
  assert.match(
    route,
    /buildOfferLetterDraft\(\{ offer, candidate: application\.candidate \}\)/,
    "the route must go through the bridge, which is what runs the approval gate",
  );
  // Comments STRIPPED first. The route's own documentation explains that approval is read from
  // `approvedAt` rather than inferred from a stage, and a raw scan matches that sentence - the
  // check then fails on the explanation of why it passes. Prose is not code.
  const routeCode = stripComments(route);
  assert.equal(
    /approvedAt|submittedForApprovalAt/.test(routeCode),
    false,
    "the route must not read the approval trail itself - one gate, in offerSendBlockReason",
  );
  assert.match(
    route,
    /reference: "",/,
    "the reference must be left blank for createOffer to allocate at insert time - a number chosen "
      + "here could be reserved and then not used",
  );

  // The button, and the stage it appears at. offer_approved is both the moment the retyping
  // happens and the moment the terms are final; any earlier stage would offer a letter for terms
  // still being negotiated.
  const workspace = readFileSync("src/components/recruitment/recruitment-workspace.tsx", "utf8");
  assert.match(workspace, /Draft the offer letter/, "the panel must offer the button, or the bridge is unreachable");
  const buttonAt = workspace.indexOf("Draft the offer letter");
  const approvedBlockAt = workspace.indexOf('stage === "offer_approved"');
  assert.ok(
    approvedBlockAt > -1 && approvedBlockAt < buttonAt,
    "the button must sit inside the offer_approved block - offering it earlier would draft a letter "
      + "for terms nobody has approved",
  );

  // ── 8. THE ANSWER THE SYSTEM COULD NEVER RECORD ───────────────────────────────────────────
  //
  // PATCH /api/offers/[id] has accepted "accepted" and "declined" since the module shipped, and
  // nothing has ever called it with either: the two words appeared in the composer ONLY as badge
  // colours, for a status no button could reach. So an offer's outcome lived in somebody's memory
  // and every letter sat on "sent" forever.
  const composer = readFileSync("src/components/offers/offer-composer.tsx", "utf8");
  assert.match(
    composer,
    /call\(`\/api\/offers\/\$\{offer\.id\}`, "PATCH", \{ status \}\)/,
    "the composer must actually PATCH the status - the route has always accepted it and nothing ever sent one",
  );
  assert.match(
    composer,
    /offer\.status === "sent"/,
    "and only for a SENT offer - a draft has not been answered because it has not been asked, and "
      + "re-answering a recorded accept or decline would overwrite a fact with a mis-click",
  );
  assert.match(
    composer,
    /canManage && offer\.status === "sent"/,
    "recording an answer is a management action, not something a read-only viewer may do",
  );

  // The fits-the-screen rule: three controls in one cell must WRAP, never scroll sideways.
  assert.match(
    composer,
    /flex flex-wrap justify-end gap-1\.5/,
    "the row's controls must wrap - overflow-x-auto over a min-width floor IS the bug, not the fix",
  );

  // ── RECORDING THE ANSWER, ON BOTH SURFACES ────────────────────────────────────────────────
  //
  // The Accepted / Declined pair lived only in the desktop table, so an offer's outcome could be
  // recorded at a desk and nowhere else - while a phone is how these are read. An offer nobody can
  // answer sits on "sent" forever, which is the state that made every letter look outstanding and
  // the reason this pair was added in the first place.
  //
  // Counted, not matched: one occurrence passes while the card still carries nothing.
  {
    for (const [what, pattern] of [
      ["the accept action", /recordAnswer\(offer, "accepted"\)/g],
      ["the decline action", /recordAnswer\(offer, "declined"\)/g],
      ["both gates together", /canManage && offer\.status === "sent"/g],
    ] as const) {
      const found = composer.match(pattern) ?? [];
      assert.ok(
        found.length >= 2,
        `${what} must appear on BOTH the desktop row and the mobile card - it was on the table `
          + `only, so an answer could be recorded at a desk and nowhere else. Found ${found.length}`,
      );
    }
    // The card's own row must wrap too. Three buttons do not fit one line at 375px, and the
    // owner's rule makes wrapping the answer - never a sideways scroll, never a shrunk control.
    assert.match(
      composer,
      /className="mt-3 flex flex-wrap gap-2"/,
      "the card's controls must wrap: with Accepted, Declined and PDF on one line, a fixed row "
        + "overflows a 375px card, and overflow-x-auto over a min-width floor IS the bug",
    );
  }

  // ── THE RECIPIENT ADDRESS, ON BOTH SURFACES ───────────────────────────────────────────────
  //
  // The desktop table has carried the email under the candidate's name since the module shipped.
  // The mobile card did not, so on a phone an offer was a name and nothing else - and a phone is
  // how these are read.
  //
  // Measured 2026-09-08: three offers in this list read as three different people and were one
  // person testing the feature into a single inbox. An audit acted on that reading and moved a
  // candidate's hiring status, which had to be reverted. Nothing on the card could have shown it;
  // the address was one line away on the other surface.
  //
  // Counted rather than merely matched: one occurrence would pass while the card still showed
  // nothing, which is exactly the state this fixes.
  {
    const shown = composer.match(/\{offer\.candidateEmail\}/g) ?? [];
    assert.ok(
      shown.length >= 2,
      "offer.candidateEmail must be rendered on BOTH the desktop row and the mobile card - it was "
        + `on the table only, and a name alone cannot tell two offers apart. Found ${shown.length}`,
    );
    // No ellipsis, and a break that actually works on an address: an email has no space to break
    // at, so `break-words` alone leaves it overflowing its card at 375px.
    assert.match(
      composer,
      /className="mt-0\.5 break-all text-xs text-slate-500">\{offer\.candidateEmail\}/,
      "the card's address must be break-all and never truncated - a half-shown address defeats the "
        + "whole point of showing it, which is telling two addresses apart",
    );
  }

  // And the bridge's own import must stay type-only, so it cannot create a runtime edge either.
  assert.match(
    bridge,
    /import type \{ OfferFields \} from "@\/lib\/offers\/types";/,
    "the bridge's import of the letter's shape must be `import type` - a value import would build "
      + "a real runtime dependency from recruitment into the offers module",
  );
}
