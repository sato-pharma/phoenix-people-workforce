import assert from "node:assert/strict";

import {
  CORRECTABLE_KEYS,
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
