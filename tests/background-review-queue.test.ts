import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  backgroundReviewQueue,
  isBackgroundConfirmationOutcome,
  needsBackgroundReview,
  resolveBackgroundStanding,
  type BackgroundReviewCandidate,
} from "../src/lib/recruitment/background-review.ts";
import {
  placeCandidatesInDistrictFolders,
  type DistrictSeatRow,
} from "../src/lib/recruitment/district-manager-folders.ts";

/**
 * "The two hundred eligible, you will backfill them. But anyone non eligible, you will make the
 *  admin be able to check first their CV and confirm."  — the owner, 2026-08-31.
 *
 * THE RISK THIS SUITE EXISTS FOR is that the admin's answer turns out to be decorative. Recording a
 * confirmation is easy; making every downstream rule read it instead of re-deriving the verdict from
 * the same faculty string is the part that silently does not happen. The failure looks like success
 * — the button works, the row leaves the queue, a toast appears — and then the CV either keeps
 * reaching managers who were told it should not, or never reaches the ones who were told it should.
 * Nothing on screen shows either.
 *
 * The second risk is the queue admitting people who do not belong in it. It is worked through by
 * hand, one row at a time, so every CV that should not be there is a minute of somebody's day.
 */

function person(
  id: string,
  fields: Partial<BackgroundReviewCandidate> = {},
): BackgroundReviewCandidate {
  return {
    backgroundConfirmedAt: null,
    backgroundConfirmedByHrId: null,
    backgroundConfirmedOutcome: null,
    declaredBackground: null,
    declaredExpectedSalary: null,
    declaredExperience: null,
    faculty: null,
    folder: null,
    fullName: `Candidate ${id}`,
    id,
    status: "new",
    ...fields,
  } as BackgroundReviewCandidate;
}

export function runBackgroundReviewQueueTests(): void {
  // ── Who decides: the parser, or the person who opened the CV ───────────────────────────────────
  {
    const judged = resolveBackgroundStanding(person("a", { faculty: "Faculty of Pharmacy" }));
    assert.equal(judged.outcome, "eligible");
    assert.equal(judged.source, "judged", "nobody has been asked, so this is the rule's reading");

    // BOTH DIRECTIONS, and both matter. A confirmation that only ever widens would let a wrong
    // parse route somebody the admin excluded; one that only ever narrows would leave every
    // unreadable CV stranded forever however many people read it.
    const overruled = resolveBackgroundStanding(
      person("b", { backgroundConfirmedAt: "2026-08-31T09:00:00.000Z", backgroundConfirmedOutcome: "paramedical", faculty: "Faculty of Pharmacy" }),
    );
    assert.equal(overruled.outcome, "paramedical", "a person read the document; the parser read a string");
    assert.equal(overruled.source, "confirmed");
    assert.equal(overruled.verdict.outcome, "eligible", "and the evidence is KEPT, not rewritten — the two claims stay separable");

    const rescued = resolveBackgroundStanding(
      person("c", { backgroundConfirmedAt: "2026-08-31T09:00:00.000Z", backgroundConfirmedOutcome: "eligible", faculty: "qwerty zzz" }),
    );
    assert.equal(rescued.outcome, "eligible");
    assert.equal(rescued.source, "confirmed");

    // A value the database would refuse must not become a standing here either. "unknown" is the
    // rule's own word for "I cannot tell" and is deliberately not an answer anybody can give.
    assert.equal(isBackgroundConfirmationOutcome("unknown"), false);
    assert.equal(isBackgroundConfirmationOutcome("eligible"), true);
    assert.equal(isBackgroundConfirmationOutcome(""), false);
    const nonsense = resolveBackgroundStanding(
      person("d", { backgroundConfirmedOutcome: "banana", faculty: "Faculty of Pharmacy" }),
    );
    assert.equal(nonsense.source, "judged", "an unrecognised confirmation is ignored, never trusted");
  }

  // ── Who is IN the queue, and the four who are not ──────────────────────────────────────────────
  {
    assert.equal(needsBackgroundReview(person("q1", { faculty: "Faculty of Physical Therapy" })), true);
    assert.equal(needsBackgroundReview(person("q2", { faculty: "qwerty zzz" })), true);
    assert.equal(needsBackgroundReview(person("q3")), true, "no evidence at all is the largest group, not an excuse to skip them");

    assert.equal(needsBackgroundReview(person("s1", { faculty: "Faculty of Pharmacy" })), false, "already routing — the owner asked for a check on the OTHER ones");
    assert.equal(
      needsBackgroundReview(person("s2", { backgroundConfirmedAt: "2026-08-31T09:00:00.000Z", backgroundConfirmedOutcome: "paramedical" })),
      false,
      "asking again is what storing the answer was for",
    );
    assert.equal(
      needsBackgroundReview(person("s3", { folder: { filedAt: "2026-08-31T09:00:00.000Z", filedByHrId: null, key: "Paramedical", kind: "paramedical" } })),
      false,
      "already on the shelf",
    );
    assert.equal(needsBackgroundReview(person("s4", { status: "rejected" })), false, "the whole application was decided, not just the degree");
    assert.equal(needsBackgroundReview(null), false);
  }

  // ── The queue is two questions, not one list ───────────────────────────────────────────────────
  {
    const queue = backgroundReviewQueue([
      person("p1", { declaredBackground: "Physical therapy" }),
      person("p2", { faculty: "Faculty of Law" }),
      person("u1", { faculty: "qwerty zzz" }),
      person("u2"),
      person("u3"),
      person("skip", { faculty: "Faculty of Pharmacy" }),
      person("gone", { status: "rejected", faculty: "Faculty of Law" }),
    ]);

    assert.deepEqual(queue.paramedical.map((row) => row.candidate.id), ["p1", "p2"]);
    assert.deepEqual(queue.unreadable.map((row) => row.candidate.id), ["u1", "u2", "u3"]);
    assert.equal(queue.total, 5);
    assert.equal(queue.withoutEvidence, 2, "u2 and u3 have nothing on screen to read but the document itself");

    // The evidence travels with the row. An admin reading "Faculty of Law" settles it without
    // opening anything; a queue of bare names would make them open all five to find the two.
    assert.equal(queue.paramedical[1]?.standing.verdict.evidence, "Faculty of Law");
    assert.equal(queue.paramedical[0]?.standing.verdict.source, "declared", "their own answer, not something read off a CV");
  }

  // ── THE ONE THAT MATTERS: the answer actually changes who sees the CV ──────────────────────────
  //
  // Recording a confirmation and having the routing rule ignore it is the failure this whole file
  // exists for, and it is invisible from every screen.
  {
    const ROWS: DistrictSeatRow[] = [
      { is_vacant: false, line_name: "CNS", occupant_hr_id: "B-118", region_name: "Upper Egypt", seat_display_label: "CNS Upper Egypt DM", seat_id: "cns-ue", seat_tier: "DM" },
      { area_name: "Sohag", is_vacant: false, parent_seat_id: "cns-ue", seat_id: "cns-ue-1", seat_tier: "REP" },
    ];
    const archived = (id: string, fields: Record<string, unknown>) => ({
      ...person(id, fields as Partial<BackgroundReviewCandidate>),
      // These three measure the eligibility gate, not the address routing that sits below it, so
      // they carry no address on purpose — with one they would file by area rather than by the
      // governorate, and the question here is whether the CV reaches anybody at all.
      address: null,
      governorate: "Qena",
      preferencesDeclaredAt: null,
      preferredAreaName: null,
      preferredRegionCode: null,
      preferredRegionName: null,
    });

    // Unreadable and unanswered: reaches nobody. This is the state 167 real CVs are in.
    const waiting = placeCandidatesInDistrictFolders({
      candidates: [archived("waiting", { faculty: "qwerty zzz" })],
      rows: ROWS,
    });
    assert.equal(waiting.placements, 0, "an unanswered CV waits — that is what the queue is");

    // The admin says yes. The SAME unreadable faculty now routes.
    const confirmed = placeCandidatesInDistrictFolders({
      candidates: [
        archived("confirmed", {
          backgroundConfirmedAt: "2026-08-31T09:00:00.000Z",
          backgroundConfirmedOutcome: "eligible",
          faculty: "qwerty zzz",
        }),
      ],
      rows: ROWS,
    });
    assert.equal(confirmed.placements, 1, "confirming a degree must actually send the CV — otherwise the queue is a button that does nothing");

    // And the other direction: a pharmacy faculty an admin has excluded stops reaching anybody.
    const excluded = placeCandidatesInDistrictFolders({
      candidates: [
        archived("excluded", {
          backgroundConfirmedAt: "2026-08-31T09:00:00.000Z",
          backgroundConfirmedOutcome: "paramedical",
          faculty: "Faculty of Pharmacy",
        }),
      ],
      rows: ROWS,
    });
    assert.equal(excluded.placements, 0, "an exclusion a person made by hand must outrank a string the parser liked");
  }

  // ── The write path does BOTH halves of one decision ────────────────────────────────────────────
  //
  // Confirming somebody paramedical without filing them leaves a row that is out of the queue, out
  // of the routing rule, and still in the pool everybody works from — answered, invisible, and
  // nowhere. Substring pins on the call, never a byte window.
  {
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

    const service = read("../src/lib/recruitment/candidates.ts");
    assert.ok(
      service.includes('return fileCandidateToFolder(access, id, "paramedical", PARAMEDICAL_FOLDER_KEY);'),
      "a paramedical answer must also put the CV on the Paramedical shelf — the owner asked for the folder first and the confirmation second, and they are one action",
    );

    const rule = read("../src/lib/recruitment/district-manager-folders.ts");
    assert.ok(
      rule.includes("const standing = resolveBackgroundStanding(candidate);"),
      "the routing rule must read the STANDING, not re-judge the faculty — calling judgeBackground here would make every admin answer decorative",
    );
    assert.ok(
      !rule.includes("judgeBackground("),
      "and it must not keep a second path to the raw verdict beside it",
    );

    const route = read("../app/api/recruitment/candidates/[id]/background/route.ts");
    assert.ok(
      route.includes('requireRecruitmentAccess(request, "candidates", "update")'),
      "recording an answer files a CV and changes who can see it — it is an update, never a read",
    );
    assert.ok(
      route.includes("assertSameOriginMutation(request)"),
      "every recruitment mutation is same-origin checked",
    );
  }
}
