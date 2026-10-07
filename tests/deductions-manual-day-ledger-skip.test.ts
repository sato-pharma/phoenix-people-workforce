import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { collectClaimedLedgerDays, MANUAL_ENTRY_SOURCE_SYSTEM } from "../src/lib/deductions/conflict.ts";
import { ledgerRowStillClaimsItsDays } from "../src/lib/deductions/connectors/vacation.ts";

/**
 * A MANUAL ENTRY'S PLACEHOLDER DATE MUST NOT BLOCK A GENUINE DEDUCTION ON THE REAL 1ST.
 *
 * connectors/manual.ts anchors every manual Loan/Other entry to `${monthKey}-01` as a deterministic
 * placeholder meaning "HR typed an amount, not a day" — never a detected day. The three connector
 * "already deducted days" reads (vacation, holiday-bridge, dsm-no-record) ingest every live
 * candidate's dates as already-claimed, and until this fix they counted that placeholder too. So a
 * genuine same-employee deduction that really fell on the 1st was read as already claimed and
 * silently dropped — the mirror image of the collision gate, which conflict.ts:findDayCollisions
 * already skips `manual_hr` to avoid (constant MANUAL_ENTRY_SOURCE_SYSTEM = "manual_hr").
 *
 * The three reads now share collectClaimedLedgerDays, which skips `manual_hr` exactly as the
 * collision gate does. This pins that core and the wiring in all three reads.
 */
export function runDeductionsManualDayLedgerSkipTests() {
  const monthKey = "2026-07";
  const firstOfMonth = `${monthKey}-01`;

  // ---- The plain shape (holiday-bridge / dsm-no-record): no keepRow ------------------------------
  {
    const claimed = collectClaimedLedgerDays([
      // A manual Loan entry — amount + reason, anchored to the 1st. Its date is NOT a detection.
      { employee_hr_id_compact: "b100", dates: [firstOfMonth], source_system: MANUAL_ENTRY_SOURCE_SYSTEM },
      // A genuine detected candidate on another day — this is a real claim and must survive.
      { employee_hr_id_compact: "b200", dates: ["2026-07-05"], source_system: "crm_visits_mirror" },
    ]);
    assert.ok(
      !claimed.has(`b100:${firstOfMonth}`),
      "a manual_hr placeholder on the 1st must NOT be read as a claim — otherwise a genuine deduction on the real 1st is dropped",
    );
    assert.ok(
      claimed.has("b200:2026-07-05"),
      "a real detected candidate's day is still claimed — the skip must be narrow to manual_hr only",
    );
  }

  // ---- The vacation shape: keepRow = ledgerRowStillClaimsItsDays ----------------------------------
  // The manual_hr skip runs BEFORE keepRow, so a manual placeholder is dropped even though it is in
  // another category (which keepRow would otherwise keep). A real cross-category day still claims.
  {
    const claimed = collectClaimedLedgerDays(
      [
        { employee_hr_id_compact: "b100", dates: [firstOfMonth], category: "other", source_system: MANUAL_ENTRY_SOURCE_SYSTEM },
        // A real fingerprint day in another category — another category always claims its day.
        { employee_hr_id_compact: "b300", dates: ["2026-07-10"], category: "fingerprint", source_system: "fingerprint_report" },
      ],
      (row) =>
        ledgerRowStillClaimsItsDays({ category: row.category ?? null, lockedAt: row.locked_at ?? null }, "unpaid_vacation"),
    );
    assert.ok(
      !claimed.has(`b100:${firstOfMonth}`),
      "a manual_hr placeholder must be skipped before keepRow even sees it — a genuine vacation day on the 1st survives",
    );
    assert.ok(
      claimed.has("b300:2026-07-10"),
      "a real other-category day still claims its day against this vacation run",
    );
  }

  // ---- The three reads must all actually use the shared core and select source_system -----------
  // A read that silently drops either half re-opens the dropped-1st bug for its own connector.
  for (const file of [
    "../src/lib/deductions/connectors/vacation.ts",
    "../src/lib/deductions/connectors/holiday-bridge.ts",
    "../src/lib/deductions/connectors/dsm-no-record.ts",
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(source, /collectClaimedLedgerDays\(/, `${file} must build its claimed-day set through the shared manual_hr-skipping core`);
    assert.match(source, /source_system/, `${file} must read source_system back, or the manual_hr skip can never fire`);
  }
}
