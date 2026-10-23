import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MIN_CANDIDATE_QUERY_LENGTH,
  digitsOf,
  nameTokenScore,
  newestCvPerCandidate,
  phoneTailOf,
  planCandidateQuery,
} from "../src/lib/employees/employee-cv-candidates.ts";

/**
 * Carrying a candidate's CV onto an employee who was hired before the two were ever linked.
 *
 * 🔴 THE RULE THIS FILE EXISTS TO HOLD: THE SYSTEM NEVER DECIDES WHICH CANDIDATE AN EMPLOYEE IS.
 *
 * It looks like it could. Every employee has a mobile number and most candidates have one, so an
 * automatic match is four lines of SQL — and it is wrong. Measured on production 2026-09-29: of
 * the 8 employees with no CV whose mobile matched a candidate who had one, on the last 9 digits,
 * THREE were a different person entirely. The National Sales Manager matched "Esraa Mabrouk.".
 * The CEO matched "Weaam Gweed". A Group Product Manager matched "Youssef hesham Tawfik". One HR
 * person's own mobile matched three separate candidates, because a CV that arrives over WhatsApp
 * carries the number of whoever FORWARDED it, not the applicant's.
 *
 * A name match is no safer in either direction: "Samaa Shalaby" and "Samaa AbdelRahman AbdelRaouf
 * Shalabi" are one person and do not match, while two real reps in this company share a full name
 * and would.
 *
 * So the wrong fix is an automatic one, the failure is silent, and the cost is not a wrong number
 * on a screen — it is a stranger's CV, with their name, address, education and salary history,
 * filed permanently under an employee's record and downloadable from the organogram by the SFE
 * Manager. Worse than no CV at all. What is asserted below is that the code keeps OFFERING rather
 * than deciding, and that the search cannot quietly become a list of everyone who ever applied.
 */

const CANDIDATES_MODULE = "src/lib/employees/employee-cv-candidates.ts";
const ROUTE_PATH = "app/api/employees/[hrId]/cv/route.ts";
const CONTROLS_PATH = "src/components/employees/employee-cv-controls.tsx";

function read(relative: string): string {
  return readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}

/** Hard-wrapped source: flatten before looking for a sentence, or a wrapped line reads as absent. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

export function runEmployeeCvCarryFromRecruitmentTests() {
  // ── 1. NEWEST CV WINS, AND A CANDIDATE WITHOUT ONE IS NOT OFFERED ─────────────────────────
  // The same rule copyCandidateCvToEmployee applies when it actually copies. If the two disagree,
  // the person is shown one file name and a different file lands on the record — a quiet lie
  // about what was attached.
  const newest = newestCvPerCandidate([
    { candidateId: "c1", createdAt: "2026-03-01T00:00:00Z", fileName: "old.pdf" },
    { candidateId: "c1", createdAt: "2026-05-01T00:00:00Z", fileName: "new.pdf" },
    { candidateId: "c2", createdAt: "2026-01-01T00:00:00Z", fileName: "only.pdf" },
  ]);
  assert.equal(newest.get("c1")?.fileName, "new.pdf", "the newest CV must win, whatever order the rows arrive in");
  assert.equal(newest.get("c2")?.fileName, "only.pdf");
  assert.equal(newest.get("c3"), undefined, "a candidate with no CV row must not appear at all");

  // Order-independence, explicitly: the query orders newest-first today, and a future edit that
  // drops the order clause must not silently start attaching the older file.
  const reversed = newestCvPerCandidate([
    { candidateId: "c1", createdAt: "2026-05-01T00:00:00Z", fileName: "new.pdf" },
    { candidateId: "c1", createdAt: "2026-03-01T00:00:00Z", fileName: "old.pdf" },
  ]);
  assert.equal(reversed.get("c1")?.fileName, "new.pdf", "newest must win even when the rows arrive newest-first");

  // An unknown date is not evidence of being newer — it must never displace a real one.
  const undated = newestCvPerCandidate([
    { candidateId: "c1", createdAt: "2026-05-01T00:00:00Z", fileName: "dated.pdf" },
    { candidateId: "c1", createdAt: null, fileName: "undated.pdf" },
  ]);
  assert.equal(undated.get("c1")?.fileName, "dated.pdf", "a row with no date must not displace a dated one");

  // A nameless file still has to be offerable — the file exists, and refusing to carry a real CV
  // because its name was lost would be the wrong answer.
  const nameless = newestCvPerCandidate([{ candidateId: "c1", createdAt: null, fileName: null }]);
  assert.equal(nameless.get("c1")?.fileName, "CV");

  // ── 2. THE PHONE IS SHOWN AS EVIDENCE, NEVER AS A WHOLE NUMBER ────────────────────────────
  assert.equal(digitsOf("+20 109 588 8700"), "201095888700", "spacing and + must not make two numbers of one");
  assert.equal(digitsOf("01095888700"), "01095888700");
  assert.equal(phoneTailOf("+20 109 588 8700"), "8700", "only the last four digits are shown");
  assert.equal(phoneTailOf("123"), null, "too short to be a phone tail is null, never a partial number");
  assert.equal(phoneTailOf(null), null);

  // ── 2b. THE QUERY PLAN — BOTH BRANCHES ARE FIXES FOR A MEASURED DEFECT ────────────────────
  // Probed against production before this shipped: the first version wrapped the whole typed
  // string in one ilike, and BOTH of the cases this feature exists for returned the wrong thing.

  // THE NAME. Seeding the box with the employee's own record — the whole point of seeding it —
  // returned NOTHING, because the employee is "Samaa AbdelRahman AbdelRaouf Shalabi" and
  // recruitment holds her as "Samaa Shalaby". A legal name and a CV name are different strings
  // by nature, so each WORD is searched.
  const byName = planCandidateQuery("Samaa AbdelRahman AbdelRaouf Shalabi");
  assert.equal(
    byName.filters.length,
    4,
    "each word of the name must be its own filter — one filter would be the whole-string match " +
      "that found nobody on production",
  );
  assert.ok(
    byName.filters.every((filter) => /^full_name\.ilike\."%[^%"]+%"$/.test(filter)),
    "a name query must search full_name only, one word per filter",
  );
  // The value is DOUBLE-QUOTED and the wildcard is `%`, not `*` (AGENTS.md MR-B04). `*` is what
  // PostgREST translates to `%` for the caller's convenience, which is exactly why it cannot be
  // left in a value: a name token carrying one would have become a wildcard. The quotes are what
  // stop a token holding a `,` or a `)` from ending the clause and handing PostgREST a filter
  // nobody wrote — the whole-name search this test already proves must keep finding her.
  assert.deepEqual(
    byName.filters[0],
    'full_name.ilike."%Samaa%"',
    "the first word's filter, quoted, with the term unaltered inside it",
  );
  assert.equal(byName.phoneTailDigits, null, "a name is not a phone");
  assert.deepEqual(byName.tokens, ["samaa", "abdelrahman", "abdelraouf", "shalabi"]);

  // THE PHONE. The same number in the two formats production actually stores must plan to the
  // SAME comparison. "+20 109 588 8700" splits the digits with spaces, so a digits-only ilike
  // matched the unformatted copies and silently missed the formatted ones — including the one
  // candidate the search was looking for.
  const spaced = planCandidateQuery("+20 109 588 8700");
  const plain = planCandidateQuery("01095888700");
  assert.equal(
    spaced.phoneTailDigits,
    plain.phoneTailDigits,
    "the same number typed two ways must compare identically, or a formatted phone is invisible",
  );
  assert.deepEqual(
    spaced.filters,
    ['phone.ilike."%8700%"'],
    "the DB filter is the last FOUR digits: the longest run that survives \"+20 109 588 8700\"",
  );
  assert.equal(spaced.tokens.length, 0, "a phone query must not also search names");
  // And the precise comparison the loop applies afterwards, which is what stops the loose 4-digit
  // filter returning everyone whose number merely ends the same way.
  assert.ok(digitsOf("+20 109 588 8700").endsWith(spaced.phoneTailDigits ?? "x"));
  assert.ok(
    !digitsOf("01234568700").endsWith(spaced.phoneTailDigits ?? "x"),
    "a stranger sharing the last four digits must be dropped by the digits-only check",
  );

  // Too short, and nothing that survives tokenising, both return no filters rather than a filter
  // that would match everybody.
  assert.deepEqual(planCandidateQuery("ab").filters, []);
  assert.deepEqual(planCandidateQuery("a b c").filters, []);

  // ── 2c. RANKING: THE GIVEN NAME COUNTS DOUBLE ─────────────────────────────────────────────
  // Measured: a flat count put "Samaa Shalaby" third, behind unrelated people who matched only
  // the middle name "AbdelRahman". The tokens are the query's, in order.
  const tokens = byName.tokens;
  assert.ok(
    nameTokenScore("Samaa Shalaby", tokens) > nameTokenScore("Abdelrahman Alaa Ali", tokens),
    "a candidate matching the GIVEN name must rank above one matching only a middle name",
  );
  assert.equal(nameTokenScore("nobody at all", tokens), 0);

  // ── 3. THE SEARCH CANNOT BECOME A LISTING ─────────────────────────────────────────────────
  assert.ok(
    MIN_CANDIDATE_QUERY_LENGTH >= 3,
    "a one or two letter query would return half the candidate database to the employee screen",
  );
  // Not named `module`: @next/next/no-assign-module-variable is an error in this repo's lint.
  const candidatesSource = flat(read(CANDIDATES_MODULE));
  assert.ok(
    candidatesSource.includes(".or(plan.filters.join(\",\"))"),
    "the candidate query must always be filtered by what was typed — there is no listing branch",
  );
  assert.ok(
    candidatesSource.includes('.eq("kind", "cv")')
      && candidatesSource.includes('.not("drive_file_id", "is", null)'),
    "only candidates with a real CV file behind them may be offered — there is nothing to carry from the rest",
  );

  // ── 4. THE ROUTE TAKES A CHOSEN CANDIDATE AND GATES ON WHO MAY WRITE ──────────────────────
  const route = read(ROUTE_PATH);
  const flatRoute = flat(route);
  assert.ok(
    /export async function PUT/.test(route),
    "the carry is a PUT on the CV route — it replaces the whole document from a named source",
  );
  assert.ok(
    flatRoute.includes("const candidateId = String(body.candidateId ?? \"\").trim()"),
    "the carry must take the candidate id the person CHOSE, never derive one from the employee",
  );
  // The headline gate assertion. The candidate search must be behind assertCanManage
  // (employees:update), NOT behind the four-role read gate that exists so the SFE Manager can
  // open a CV — reading one employee's CV is not permission to search the candidate database.
  const searchBranch = flatRoute.slice(
    flatRoute.indexOf('searchParams.get("candidates")'),
    flatRoute.indexOf("const access = await resolveAccessContext(request)"),
  );
  assert.ok(
    searchBranch.length > 60 && searchBranch.length < 900,
    "the candidate-search branch could not be located in the route — the assertions below would be vacuous",
  );
  assert.ok(
    searchBranch.includes("await assertCanManage(request, hrId)"),
    "the candidate search must be gated on employees:update (assertCanManage), not on the CV read gate",
  );
  assert.ok(
    !searchBranch.includes("canDownloadEmployeeCv"),
    "the candidate search must NOT ride in on canDownloadEmployeeCv — that set exists to let the " +
      "SFE Manager open one employee's CV, and it is not permission to search recruitment",
  );

  // ── 5. NOTHING IN THE UI ATTACHES WITHOUT A CLICK ─────────────────────────────────────────
  const controls = read(CONTROLS_PATH);
  const flatControls = flat(controls);
  assert.ok(
    flatControls.includes("Attach this CV"),
    "the attach must be a button the person presses against one named candidate",
  );
  assert.ok(
    !/auto[- ]?match|bestMatch|autoAttach/i.test(controls),
    "there must be no automatic match anywhere in this control: on production 3 of 8 phone matches " +
      "were a different person",
  );
  // The evidence a human judges on — all three, or the click is a guess.
  for (const shown of ["candidateName", "cvFileName", "phoneTail"]) {
    assert.ok(
      flatControls.includes(shown),
      `the candidate row must show ${shown}: the name, the file name and the phone tail together ` +
        "are what let a person tell one applicant from another",
    );
  }
}
