import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  backgroundFolderFilingRefusal,
  type BackgroundReviewCandidate,
} from "../src/lib/recruitment/background-review.ts";

/**
 * The manual "File to folder" path (recruitment-workspace.tsx's FileToFolderPicker, PATCH
 * /api/recruitment/candidates/[id]/folder) lets a recruiter file ANY CV onto ANY shelf by hand,
 * without ever asking about a degree — unlike the bulk "file what they answered" action in
 * candidate-folder-suggestion.ts, which already holds this rule. That gap is how a CV with a
 * Faculty of Education degree sat on the Medical Representative / Behira 1 shelf in production for
 * eleven days with nobody having opened it: a recruiter filing candidates by hand has no reason to
 * suspect a degree was never checked, because the folder looks the same either way.
 *
 * `backgroundFolderFilingRefusal` is the same rule, applied at the one path that bypassed it.
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
    faculty: null,
    folder: null,
    fullName: `Candidate ${id}`,
    id,
    status: "new",
    ...fields,
  } as BackgroundReviewCandidate;
}

export function runBackgroundFolderFilingGateTests(): void {
  // ── The two field-force shelves refuse an unchecked paramedical degree ─────────────────────────
  {
    const habiba = person("habiba", { faculty: "Faculty of Education" });
    const medicalRepRefusal = backgroundFolderFilingRefusal(habiba, "medical_rep");
    assert.ok(
      typeof medicalRepRefusal === "string" && medicalRepRefusal.length > 0,
      "a paramedical degree nobody has checked must not reach the Medical Representative shelf",
    );

    const districtManagerRefusal = backgroundFolderFilingRefusal(habiba, "district_manager");
    assert.ok(
      typeof districtManagerRefusal === "string" && districtManagerRefusal.length > 0,
      "the District Manager shelf is the other half of the same rule",
    );
  }

  // ── Every other shelf is untouched — this gate is about the two field-force shelves only ───────
  {
    const commerceGraduate = person("c1", { faculty: "Faculty of Commerce" });
    assert.equal(
      backgroundFolderFilingRefusal(commerceGraduate, "other"),
      null,
      "a head-office seat has no degree rule to fail — screeningBandForFamily already excludes it elsewhere",
    );
    assert.equal(
      backgroundFolderFilingRefusal(commerceGraduate, "paramedical"),
      null,
      "filing THEM as paramedical is the correct answer, not a refusal",
    );
    assert.equal(
      backgroundFolderFilingRefusal(commerceGraduate, "duplicate"),
      null,
      "the duplicate archive is a discard, not a shelf the degree rule has an opinion about",
    );
  }

  // ── Unknown is deliberately let through — the common case, not an edge case ────────────────────
  {
    const noFacultyAtAll = person("u1");
    assert.equal(
      backgroundFolderFilingRefusal(noFacultyAtAll, "medical_rep"),
      null,
      "159 of 604 production CVs carry no faculty at all — gating on 'unknown' would break ordinary filing for most of the pool, the same reasoning candidate-folder-suggestion.ts already holds",
    );
  }

  // ── A confirmation outranks the parser, in BOTH directions ─────────────────────────────────────
  {
    const rescued = person("r1", {
      backgroundConfirmedAt: "2026-09-05T09:00:00.000Z",
      backgroundConfirmedOutcome: "eligible",
      faculty: "Faculty of Education",
    });
    assert.equal(
      backgroundFolderFilingRefusal(rescued, "medical_rep"),
      null,
      "an admin who opened the CV and confirmed eligible must not be second-guessed by the parser",
    );

    const excluded = person("e1", {
      backgroundConfirmedAt: "2026-09-05T09:00:00.000Z",
      backgroundConfirmedOutcome: "paramedical",
      faculty: "Faculty of Pharmacy",
    });
    assert.ok(
      typeof backgroundFolderFilingRefusal(excluded, "medical_rep") === "string",
      "an admin's exclusion must still block filing even when the faculty string alone reads as eligible",
    );
  }

  // ── The wiring itself is pinned, not just the pure function ────────────────────────────────────
  //
  // A gate that exists but is never called from the write path is invisible from every screen —
  // the same failure shape background-review-queue.test.ts pins for the paramedical confirmation.
  {
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    const service = read("../src/lib/recruitment/candidates.ts");
    assert.ok(
      service.includes("backgroundFolderFilingRefusal(existing, kind)"),
      "fileCandidateToFolder must call the gate before writing the folder columns, or a recruiter filing by hand still bypasses it entirely",
    );
  }
}
