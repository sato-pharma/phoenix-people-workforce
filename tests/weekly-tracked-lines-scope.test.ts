import assert from "node:assert/strict";

import {
  applyWeeklyTrackedLineScope,
  isWeeklyTrackedLine,
  weeklyTrackedLineOptions,
  WEEKLY_TRACKED_SCOPE_NOTE,
} from "../src/lib/sales/weekly/tracked-lines.ts";

type Row = { officialLine: string | null; salesValue: number };

const row = (officialLine: string | null, salesValue = 1): Row => ({ officialLine, salesValue });

/**
 * GOLDEN RULE — the owner tracks Weekly Sales for CNS, Anti Infective and Pedia only. Head Office is
 * not tracked weekly, so its missing area/region/manager mapping is CORRECT, not a defect.
 *
 * This is pinned in a test because the cost of getting it wrong is not a wrong pixel, it is a wrong
 * headline: Head Office is EGP 297,229,509 of the weekly tables, 78% of everything in them, and an
 * unscoped total is therefore dominated by a line the owner does not follow. On 2026-08-26 an audit
 * led with "80.8% of weekly money reaches no manager" for exactly this reason; the truth, scoped, is
 * 12.8%. Anything that quietly widens this scope re-creates that error.
 */
export async function runWeeklyTrackedLinesScopeTests() {
  // 1) HEADLINE — the three tracked lines, and nothing else.
  {
    for (const line of ["CNS", "Anti Infective", "Pedia"]) {
      assert.equal(isWeeklyTrackedLine(line), true, `${line} is tracked weekly`);
    }
    assert.equal(isWeeklyTrackedLine("Head Office"), false, "Head Office is NOT tracked weekly — the golden rule");
  }

  // 2) The alias spellings that reach this code from real weekly rows must all resolve, or a line
  //    would silently drop out of the owner's totals depending on how a sheet spelled it.
  {
    for (const spelling of ["anti infective", "Anti-Infective", "anti_infective", "ANTI INF", "antiinfective", "  cns  ", "PEDIA"]) {
      assert.equal(isWeeklyTrackedLine(spelling), true, `"${spelling}" must resolve to a tracked line`);
    }
  }

  // 3) Unknown and blank lines are NOT tracked. The safe direction: a line nobody can name must not
  //    join the numbers the owner reads as his field-force performance.
  {
    for (const value of [null, undefined, "", "   ", "Head office", "HEAD OFFICE", "Consumer", "Derma"]) {
      assert.equal(isWeeklyTrackedLine(value as string | null), false, `${JSON.stringify(value)} must not be tracked`);
    }
  }

  // 4) The scope filter itself — Head Office money must not reach a default-scoped total.
  {
    const rows = [row("CNS", 10), row("Head Office", 297), row("Anti Infective", 20), row("Pedia", 30), row(null, 5)];
    const scoped = applyWeeklyTrackedLineScope(rows);
    assert.equal(scoped.length, 3, "only the three tracked lines survive the default scope");
    assert.equal(
      scoped.reduce((sum, r) => sum + r.salesValue, 0),
      60,
      "the Head Office value must be absent from the scoped total, not merely unlabelled",
    );
    assert.ok(!scoped.some((r) => r.officialLine === "Head Office"), "no Head Office row survives");
  }

  // 5) The escape hatch. This is a DEFAULT SCOPE, not a deletion: when the viewer names a line the
  //    request wins and every row is reachable again. Without this the data would be unreachable,
  //    which is a different and worse bug than the one being fixed.
  {
    const rows = [row("CNS", 10), row("Head Office", 297)];
    const all = applyWeeklyTrackedLineScope(rows, { includeUntracked: true });
    assert.equal(all.length, 2, "naming a line explicitly reaches untracked lines too");
    assert.equal(all.reduce((sum, r) => sum + r.salesValue, 0), 307);
    // ...and the default is still the scoped one when nothing is named.
    assert.equal(applyWeeklyTrackedLineScope(rows, {}).length, 1, "an empty options object is still the default scope");
    assert.equal(applyWeeklyTrackedLineScope(rows, { includeUntracked: false }).length, 1);
  }

  // 6) The scope must be SAYABLE. The owner's standing rule is that an export matches the screen and
  //    that nothing is dropped without a label, so the note has to name the lines and the exclusion.
  {
    for (const needle of ["CNS", "Anti Infective", "Pedia", "Head Office"]) {
      assert.ok(WEEKLY_TRACKED_SCOPE_NOTE.includes(needle), `the scope note must name ${needle}`);
    }
    // The note must not promise a door that no longer exists. Until 2026-08-30 it ended "select it in
    // the Line filter to see it", which was true then and is a lie now that the option is gone.
    assert.ok(
      !/select it in the line filter/i.test(WEEKLY_TRACKED_SCOPE_NOTE),
      "the scope note must not tell the reader to pick Head Office in a filter that no longer offers it",
    );
  }

  // 7) THE LINE FILTER OFFERS TRACKED LINES ONLY — owner, 2026-08-30: "remove head office from the
  //    line filter", on the back of "The head office will not be used in the weekly sales or monthly
  //    sales." Before this, Head Office sat in the dropdown deliberately, as the escape hatch that
  //    made the rule a default rather than a deletion. It is now a deletion, at the UI, by decision.
  //
  //    Why this earns its own pin: measured 2026-08-30 across four books off one August sheet, Head
  //    Office is EGP 37,568,199 against CNS 2,648,156 + Pedia 831,362 + Anti Infective 610,238 —
  //    90.2% of the total. One click on a dropdown entry turned a 4M report into a 41M one, and
  //    nothing on the page distinguished the two. The option IS the defect.
  {
    const offered = weeklyTrackedLineOptions(["Anti Infective", "CNS", "Head Office", "Pedia"]);
    assert.deepEqual(offered, ["Anti Infective", "CNS", "Pedia"], "the Line filter offers the three tracked lines");
    assert.ok(!offered.includes("Head Office"), "Head Office must never be offered in the Line filter");

    // Order is the caller's, not re-sorted here — the service sorts before calling, and a second
    // sort inside a filter is where a dropdown quietly stops matching the list beside it.
    assert.deepEqual(weeklyTrackedLineOptions(["Pedia", "CNS"]), ["Pedia", "CNS"], "input order is preserved");

    // A line nobody can name is not tracked, so it cannot be offered either — same safe direction as
    // isWeeklyTrackedLine. A blank entry reaching a dropdown renders as an empty, selectable row.
    assert.deepEqual(weeklyTrackedLineOptions(["", "Head Office", "Something New"]), []);
    assert.deepEqual(weeklyTrackedLineOptions([]), []);

    // The two halves must agree: whatever the filter offers, the default scope must also keep.
    for (const line of weeklyTrackedLineOptions(["Anti Infective", "CNS", "Head Office", "Pedia"])) {
      assert.equal(
        applyWeeklyTrackedLineScope([row(line)]).length,
        1,
        `${line} is offered in the filter, so the default scope must keep it`,
      );
    }
  }
}
