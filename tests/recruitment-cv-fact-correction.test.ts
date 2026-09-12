import assert from "node:assert/strict";

import {
  CORRECTABLE_KEYS,
  isExperienceDrift,
  looksLikeAnEmployerNotARole,
  namesTheSameGovernorate,
  normalizeFactForComparison,
  saysTheSameThing,
  selectFactCorrections,
} from "../src/lib/recruitment/cv-fact-correction.ts";
import { defaultCvPositionKey } from "../src/lib/recruitment/cv-field-schemas.ts";

type Fields = Parameters<typeof selectFactCorrections>[0]["extractedFields"];

const high = (value: unknown) => ({ value, confidence: "high" as const });
const low = (value: unknown) => ({ value, confidence: "low" as const });

function propose(
  extractedFields: Record<string, { value: unknown; confidence: "high" | "low" }>,
  candidate: Record<string, unknown>,
  extra: { hasDeclaredPreferences?: boolean; allowClearingGraduationYear?: boolean } = {},
) {
  return selectFactCorrections({
    candidate,
    extractedFields: extractedFields as unknown as Fields,
    hasDeclaredPreferences: extra.hasDeclaredPreferences ?? false,
    positionKey: defaultCvPositionKey,
    allowClearingGraduationYear: extra.allowClearingGraduationYear,
  });
}

export async function runRecruitmentCvFactCorrectionTests(): Promise<void> {
  // A genuine correction — the owner's own reference case. Stored Cairo, CV says Beheira.
  {
    const corrections = propose({ governorate: high("Beheira") }, { governorate: "Cairo" });
    assert.equal(corrections.length, 1, "a genuine governorate disagreement must be proposed");
    assert.equal(corrections[0].column, "governorate");
    assert.equal(corrections[0].from, "Cairo");
    assert.equal(corrections[0].to, "Beheira");
  }

  // Gate 4 — cosmetics are not corrections. This is the gate that removed most of the 120 rows a
  // blanket rewrite would have touched on production.
  {
    assert.equal(saysTheSameThing("Chemist", "Chemist."), true, "a trailing full stop is not a new answer");
    assert.equal(saysTheSameThing("Senior  Medical   Rep", "senior medical rep"), true);
    assert.equal(saysTheSameThing(3, "3.0"), true, "numeric equality survives the jsonb boundary");
    assert.equal(saysTheSameThing("Chemist", "Chemist / Medical Representative"), false);

    const corrections = propose({ currentJobTitle: high("Chemist.") }, { currentJobTitle: "Chemist" });
    assert.equal(corrections.length, 0, "a trailing full stop must never be proposed as a correction");
  }

  // Gate 3 — the applicant's own WhatsApp answer is the owner's source of truth.
  {
    const withoutDeclaration = propose({ governorate: high("Beheira") }, { governorate: "Cairo" });
    assert.equal(withoutDeclaration.length, 1, "control: the same pair IS proposed when nothing was declared");

    const withDeclaration = propose({ governorate: high("Beheira") }, { governorate: "Cairo" }, {
      hasDeclaredPreferences: true,
    });
    assert.equal(withDeclaration.length, 0, "a declared answer is never overwritten by a CV guess");
  }

  // ───────────────────────────────────────────────────────────────────────────────────────────
  // Gates 6-8. Every pair below is a REAL row from the free preview run over production on
  // 2026-09-12, which gates 1-5 let through and which is not a correction.
  // ───────────────────────────────────────────────────────────────────────────────────────────

  // Gate 6 — experience accrues with the calendar. A sub-year move is drift, not a repair.
  {
    for (const [from, to] of [[7.7, 7.8], [7.75, 7.8], [18, 18.1], [23, 23.2], [10.4, 10.6]] as const) {
      assert.equal(isExperienceDrift(from, to), true, `${from} -> ${to} is the clock, not a correction`);
      const corrections = propose({ yearsExperience: high(to) }, { yearsExperience: from });
      assert.equal(corrections.length, 0, `${from} -> ${to} years must not be proposed`);
    }

    // The defect this job exists for is never this small: a fresh graduate credited with years.
    assert.equal(isExperienceDrift(5, 0), false, "5 years down to 0 is the fresh-graduate defect itself");
    const real = propose({ yearsExperience: high(0) }, { yearsExperience: 5 });
    assert.equal(real.length, 1, "control: a whole-year disagreement IS still proposed");
    assert.equal(real[0].to, 0);

    // Exactly one year is a correction; the threshold is a floor, not a window.
    assert.equal(isExperienceDrift(10, 11), false, "a full year of difference is not drift");
    assert.equal(isExperienceDrift(10, 10.999), true, "just under a year still is");
  }

  // Gate 7 — the same governorate spelled another way. Writing the variant over the app's
  // canonical spelling would be a regression, not a repair.
  {
    for (const [stored, cv] of [
      ["Sharqia", "Sharkia"],
      ["Dakahlia", "Ad Daqahliyah"],
      ["Menoufia", "Menofia"],
      ["Beheira", "Elbehaira"],
      ["Al Buhayrah", "Beheira"],
      ["Qalyubia", "kaliobia"],
      ["Sohag", "Sohage"],
      ["Kafr El Sheikh", "Kafr el-Sheikh"],
    ] as const) {
      assert.equal(namesTheSameGovernorate(stored, cv), true, `"${stored}" and "${cv}" are one place`);
      const corrections = propose({ governorate: high(cv) }, { governorate: stored });
      assert.equal(corrections.length, 0, `"${stored}" -> "${cv}" is spelling, not a correction`);
    }

    // A real move between two different governorates still gets through.
    assert.equal(namesTheSameGovernorate("Cairo", "Sharqia"), false);
    const real = propose({ governorate: high("Sharqia") }, { governorate: "Cairo" });
    assert.equal(real.length, 1, "control: Cairo -> Sharqia is a genuine disagreement");

    // An unrecognisable value must NOT silently suppress a disagreement.
    assert.equal(namesTheSameGovernorate("Cairo", "Wakanda"), false);
    assert.equal(namesTheSameGovernorate("", "Cairo"), false);
  }

  // Gate 8 — an employer is never a job title. This is the owner's original defect 3 (the CV
  // headline stored as the job) reappearing inside the PROPOSAL.
  {
    for (const [stored, cv] of [
      ["Community Pharmacist", "Dr. Tarek ElTohamy Pharmacy"],
      ["Senior Accountant / Chief Accountant", "Madawa Pharmaceutical Company"],
      ["HR | Senior Personnel Specialist", "❖ Company: Keys Payroll"],
      ["HR Personnel", "HR Personnel In Postal Distribution Company"],
      ["Sales Manager", "Sales Manager, Amoun Pharmaceutical Company"],
      ["محامي", "شركة المحاماة الدولية"],
    ] as const) {
      assert.equal(looksLikeAnEmployerNotARole(stored, cv), true, `"${cv}" names an employer, not a role`);
      const corrections = propose({ currentJobTitle: high(cv) }, { currentJobTitle: stored });
      assert.equal(corrections.length, 0, `"${stored}" -> "${cv}" must not be proposed`);
    }

    // A genuine role refinement with no employer in it still gets through.
    assert.equal(looksLikeAnEmployerNotARole("Veterinarian", "Clinical Veterinarian"), false);
    const real = propose({ currentJobTitle: high("Clinical Veterinarian") }, { currentJobTitle: "Veterinarian" });
    assert.equal(real.length, 1, "control: a role-to-role refinement IS still proposed");

    // When the STORED value already names an employer, the proposal is no worse — leave it alone.
    assert.equal(
      looksLikeAnEmployerNotARole("Pharmacist at El Ezaby Pharmacy", "El Ezaby Pharmacy"),
      false,
      "the stored value already carries the employer, so this gate does not apply",
    );

    // The markers must not fire on ordinary roles that merely sound institutional.
    assert.equal(looksLikeAnEmployerNotARole("Rep", "Medical Representative"), false);
    assert.equal(looksLikeAnEmployerNotARole("Accountant", "Senior Accountant"), false);
  }

  // Gate 2 — the extractor's own hedge is respected.
  {
    const corrections = propose({ currentJobTitle: low("Area Sales Manager") }, { currentJobTitle: "Sales Manager" });
    assert.equal(corrections.length, 0, "a low-confidence reading never corrects a stored fact");
  }

  // A gap is not a correction — cv-auto-apply.ts owns the blank column, and two writers on one
  // column would make provenance unreadable.
  {
    assert.equal(propose({ governorate: high("Beheira") }, { governorate: null }).length, 0);
    assert.equal(propose({ governorate: high("Beheira") }, { governorate: "   " }).length, 0);
  }

  // Gate 5 — clearing a populated column happens only for graduationYear, and only on request.
  {
    const stored = { graduationYear: 2023, currentJobTitle: "Medical Rep" };
    assert.equal(
      propose({ graduationYear: high(null) }, stored).length,
      0,
      "a null proposal must not blank a populated column by default",
    );
    const cleared = propose({ graduationYear: high(null) }, stored, { allowClearingGraduationYear: true });
    assert.equal(cleared.length, 1, "an ongoing degree clears the graduation year when explicitly allowed");
    assert.equal(cleared[0].to, null);
    assert.match(cleared[0].reason, /still in progress/i);

    assert.equal(
      propose({ currentJobTitle: high(null) }, stored, { allowClearingGraduationYear: true }).length,
      0,
      "the opt-in clears graduationYear ONLY — it must never reach another column",
    );
  }

  // Gate 1 — identity is permanently out of reach. These decide dedupe and their _norm indexes are
  // app-maintained, so a correction job must never be able to repoint one person's record.
  {
    for (const identityKey of ["fullName", "email", "phone", "nationalId"]) {
      assert.equal(
        CORRECTABLE_KEYS.includes(identityKey),
        false,
        `${identityKey} must never be correctable`,
      );
      const corrections = propose(
        { [identityKey]: high("someone-else") },
        { fullName: "A", email: "a@b.c", phone: "0100", nationalId: "123" },
      );
      assert.equal(corrections.length, 0, `${identityKey} must not be proposed as a correction`);
    }
  }

  // Normalisation itself, since every gate above leans on it.
  {
    assert.equal(normalizeFactForComparison("  Cairo.  "), "cairo");
    assert.equal(normalizeFactForComparison(""), null);
    assert.equal(normalizeFactForComparison(null), null);
    assert.equal(normalizeFactForComparison(2019), "2019");
  }
}
