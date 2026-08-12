import assert from "node:assert/strict";

import { pickTopEarlyBirdPerLine } from "../src/lib/early-birds/service.ts";
import type { EarlyBirdsWinnerRecord } from "../src/lib/early-birds/service.ts";

// Three stars, one per line — never a single company-wide "best of the best" that could go whole
// fortnights without ever being a CNS rep's own line. Each line's own top scorer is picked
// independently, so a rep always sees a face from their own line on the landing card.

let nextId = 0;

function winner(overrides: Partial<EarlyBirdsWinnerRecord> & { lineName: string | null }): EarlyBirdsWinnerRecord {
  nextId += 1;
  return {
    id: `w${nextId}`,
    periodKey: "2026-16",
    periodLabel: "Fortnight 16",
    employeeHrId: `HR-${nextId}`,
    employeeName: `Rep ${nextId}`,
    areaName: "Giza",
    hireDate: "2024-01-01",
    managerHrId: "M-1",
    totalScore: 500,
    rankAtApproval: 1,
    headlineStats: {},
    timeline: [],
    confirmationSource: "manager",
    confirmedAt: "2026-08-01T00:00:00Z",
    isNational: false,
    ...overrides,
  };
}

export function runEarlyBirdsLineStarsTests() {
  // ── Each line's own top scorer wins, independently of the other lines ──────────
  {
    const pedia = winner({ lineName: "Pedia", employeeName: "Pedia Leader", totalScore: 900 });
    const stars = pickTopEarlyBirdPerLine([
      winner({ lineName: "Pedia", employeeName: "Pedia Runner-up", totalScore: 700 }),
      pedia,
      winner({ lineName: "Anti Infective", employeeName: "AI Leader", totalScore: 200 }),
      winner({ lineName: "CNS", employeeName: "CNS Leader", totalScore: 950 }),
    ]);
    assert.equal(stars.length, 3, "one star comes out per line present in the input");
    assert.deepEqual(
      stars.map((s) => s.lineName),
      ["CNS", "Pedia", "Anti Infective"],
      "sorted by score descending, CNS's 950 leads even though Pedia has two candidates",
    );
    assert.equal(
      stars.find((s) => s.lineName === "Pedia")?.employeeName,
      "Pedia Leader",
      "the higher-scoring Pedia rep wins over the lower-scoring one from the SAME line",
    );
  }

  // ── A line with only one confirmed winner still gets its star ──────────────────
  {
    const stars = pickTopEarlyBirdPerLine([winner({ lineName: "CNS", employeeName: "Only CNS Rep" })]);
    assert.equal(stars.length, 1);
    assert.equal(stars[0].employeeName, "Only CNS Rep");
  }

  // ── A candidate with no line is never picked, and never blocks a real line ──────
  {
    const stars = pickTopEarlyBirdPerLine([
      winner({ lineName: null, employeeName: "No Line Rep", totalScore: 999 }),
      winner({ lineName: "Pedia", employeeName: "Pedia Rep", totalScore: 100 }),
    ]);
    assert.equal(stars.length, 1, "the null-line row must not become a phantom 'line'");
    assert.equal(stars[0].employeeName, "Pedia Rep");
  }

  // ── A genuine tie keeps the first-seen row (stable sort) ────────────────────────
  {
    const first = winner({ lineName: "Pedia", employeeName: "First In", totalScore: 500 });
    const second = winner({ lineName: "Pedia", employeeName: "Second In", totalScore: 500 });
    const stars = pickTopEarlyBirdPerLine([first, second]);
    assert.equal(stars.length, 1);
    assert.equal(stars[0].employeeName, "First In", "equal scores must not flip who is shown from run to run");
  }

  // ── Untouched fields pass through — this is a pick, not a re-map ────────────────
  {
    const source = winner({ lineName: "CNS", employeeName: "Full Record", isNational: true, areaName: "Alexandria" });
    const stars = pickTopEarlyBirdPerLine([source]);
    assert.deepEqual(stars[0], source, "the picked record is the same object shape, nothing dropped or renamed");
  }

  // ── No input, no stars ───────────────────────────────────────────────────────────
  {
    assert.deepEqual(pickTopEarlyBirdPerLine([]), []);
  }
}
