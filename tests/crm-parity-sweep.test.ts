import assert from "node:assert/strict";

import {
  PARITY_SLICE_DAYS,
  compareVisitIdSets,
  decideParityAction,
  parityWindowKey,
  resolveParityWindows,
  selectStalestWindow,
} from "../src/lib/crm/parity.ts";

/**
 * FULL-HISTORY PARITY SWEEP.
 *
 * THE GAP IT CLOSES (measured on production 2026-08-28). Every sync here is bounded to a recent
 * window — live poll: today, rolling cron: 10 days, wide reconcile: 120 days on a 4-week rotation.
 * Nothing had ever re-examined a day older than 120 days, so 53,068 of 126,547 mirror rows (42%)
 * had not been compared against the CRM since the day they were first pulled, and 509 rows across 8
 * months genuinely disagreed. The vendor API can only be queried by VISIT DATE and has no "changed
 * since" filter, so a visit saved late — all 36 of the missing rows were entered 18-91 days after
 * their own visit date — lands in a window every scheduled sync has already passed.
 *
 * These tests cover the pure core. The safety decision in section (D) is the important one: it is
 * the only place in this feature where being wrong DELETES real history.
 */
export function runCrmParitySweepTests() {
  // ── (A) Windows tile history completely, and never run past today ────────────────────────
  const windows = resolveParityWindows("2026-01-01", "2026-08-28");
  assert.equal(windows[0].from, "2026-01-01", "the first window starts at the floor");
  assert.equal(windows[0].to, "2026-01-30", `a window spans ${PARITY_SLICE_DAYS} days inclusive`);
  assert.equal(windows[1].from, "2026-01-31", "windows are contiguous — no day may fall between two");
  const last = windows[windows.length - 1];
  assert.equal(last.to, "2026-08-28", "the newest window is CLAMPED to today, never past it");
  // No gaps and no overlaps, checked across the whole set rather than at the seams only: a single
  // uncovered day is a day the two systems could disagree on forever without anything noticing.
  for (let index = 1; index < windows.length; index += 1) {
    const previous = windows[index - 1];
    const current = windows[index];
    const expected = new Date(`${previous.to}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + 1);
    assert.equal(
      current.from,
      expected.toISOString().slice(0, 10),
      `window ${index} must begin the day after window ${index - 1} ends`,
    );
  }
  assert.deepEqual(resolveParityWindows("2026-09-01", "2026-08-28"), [], "a floor after today yields no windows");
  assert.equal(resolveParityWindows("2026-08-28", "2026-08-28").length, 1, "a single day is still one window");

  // ── (B) The window key is its START, so the newest window cannot starve the rest ──────────
  //
  // The last window's END moves every day (it is clamped to today). Keying on the pair would make
  // that window look never-checked on every single run, so the sweep would re-verify TODAY forever
  // and never reach January — the exact blind spot it was built to remove.
  assert.equal(parityWindowKey({ from: "2026-03-02", to: "2026-03-31" }), "2026-03-02");
  assert.equal(
    parityWindowKey({ from: "2026-08-25", to: "2026-08-28" }),
    parityWindowKey({ from: "2026-08-25", to: "2026-08-29" }),
    "the key must not change when the newest window's clamped end moves with the calendar",
  );

  // ── (C) The stalest window is the one that runs ───────────────────────────────────────────
  const three = [
    { from: "2026-01-01", to: "2026-01-30" },
    { from: "2026-01-31", to: "2026-03-01" },
    { from: "2026-03-02", to: "2026-03-31" },
  ];
  assert.deepEqual(
    selectStalestWindow(three, new Map()),
    three[0],
    "with nothing ever checked, start at the oldest window",
  );
  assert.deepEqual(
    selectStalestWindow(
      three,
      new Map([
        ["2026-01-01", "2026-08-28T02:00:00Z"],
        ["2026-03-02", "2026-08-27T02:00:00Z"],
      ]),
    ),
    three[1],
    "a NEVER-checked window outranks every checked one, whatever their dates",
  );
  assert.deepEqual(
    selectStalestWindow(
      three,
      new Map([
        ["2026-01-01", "2026-08-28T02:00:00Z"],
        ["2026-01-31", "2026-08-20T02:00:00Z"],
        ["2026-03-02", "2026-08-27T02:00:00Z"],
      ]),
    ),
    three[1],
    "once all are checked, the one checked longest ago runs",
  );
  assert.equal(selectStalestWindow([], new Map()), null, "no windows, no work");

  // ── (D) THE SAFETY DECISION — the only place being wrong destroys history ─────────────────
  assert.deepEqual(
    decideParityAction({ crmRows: 500, mirrorRows: 500, missingInMirror: 0, extraInMirror: 0 }),
    { action: "equal", reason: null },
    "identical id sets need no action",
  );
  assert.equal(
    decideParityAction({ crmRows: 501, mirrorRows: 500, missingInMirror: 1, extraInMirror: 0 }).action,
    "repair",
    "a single late-saved visit the mirror lacks is repaired — this is the case the sweep exists for",
  );
  assert.equal(
    decideParityAction({ crmRows: 500, mirrorRows: 502, missingInMirror: 0, extraInMirror: 2 }).action,
    "repair",
    "a couple of rows the CRM no longer returns is a real deletion and is reconciled",
  );

  // An EMPTY answer for a window the mirror has rows for is a failed fetch, not a month in which
  // nobody in the company logged a single visit. Repairing it would delete the entire window.
  const empty = decideParityAction({ crmRows: 0, mirrorRows: 4200, missingInMirror: 0, extraInMirror: 4200 });
  assert.equal(empty.action, "refuse", "an empty CRM answer must NEVER be treated as a mass deletion");
  assert.match(String(empty.reason), /0 visits/, "the refusal says why, so it is actionable rather than mysterious");

  // A MASS SHORTFALL is the same failure part-way. The threshold matches the sync's own 50% delete
  // guard, applied one step earlier so the sweep can record WHY it stopped.
  const truncated = decideParityAction({ crmRows: 1000, mirrorRows: 4200, missingInMirror: 0, extraInMirror: 2101 });
  assert.equal(truncated.action, "refuse", "losing more than half the window reads as a truncated fetch");
  assert.match(String(truncated.reason), />50%/, "the >50% refusal names its own threshold");

  // ── THE DELETION CEILINGS ─────────────────────────────────────────────────────────────────
  // Exactly half used to be REPAIRED here, on the reasoning that the guard matched the sync
  // engine's own >50% threshold. That reasoning held and the guard still did nothing, because
  // production never came near it: five consecutive nights deleted 366, 351, 353 and 458 rows,
  // every one between 2.0% and 2.6% of its window. 1,879 rows left under a guard that was never
  // tested once, against a database with no point-in-time recovery.
  const halfWindow = decideParityAction({ crmRows: 4200, mirrorRows: 4200, missingInMirror: 0, extraInMirror: 2100 });
  assert.equal(halfWindow.action, "refuse", "half a window of deletions is refused, not repaired unattended");

  // The ROW ceiling catches the shape that actually happened — a small SHARE of a big window.
  const measured = decideParityAction({ crmRows: 19769, mirrorRows: 20227, missingInMirror: 0, extraInMirror: 458 });
  assert.equal(measured.action, "refuse", "the 02 Oct 2026 window (458 of 20,227 = 2.3%) is refused by the row ceiling");
  assert.match(String(measured.reason), /250-row ceiling/, "the refusal says which ceiling stopped it");

  // The SHARE ceiling catches the same shape in a small window, where 250 rows would be most of it.
  const smallWindow = decideParityAction({ crmRows: 900, mirrorRows: 1000, missingInMirror: 0, extraInMirror: 100 });
  assert.equal(smallWindow.action, "refuse", "10% of a window is over the 5% share ceiling despite being under 250 rows");
  assert.match(String(smallWindow.reason), /5% ceiling/, "the share refusal names the share, not the row count");

  // And a routine difference still repairs — the sweep has to keep working, not merely stop.
  assert.equal(
    decideParityAction({ crmRows: 20000, mirrorRows: 20010, missingInMirror: 0, extraInMirror: 10 }).action,
    "repair",
    "ten rows out of 20,000 is the routine case and is still reconciled",
  );

  // ADDITIONS ARE NEVER REFUSED, however large. Adding rows cannot destroy anything, and a big
  // backlog of late saves is precisely what a window unverified for months looks like.
  assert.equal(
    decideParityAction({ crmRows: 9000, mirrorRows: 10, missingInMirror: 8990, extraInMirror: 0 }).action,
    "repair",
    "a window that only needs rows ADDED is always safe to repair, at any size",
  );
  // A first-ever check of a window the mirror has never held is additions-only, not a mass deletion.
  assert.equal(
    decideParityAction({ crmRows: 300, mirrorRows: 0, missingInMirror: 300, extraInMirror: 0 }).action,
    "repair",
    "an empty MIRROR is the opposite of an empty CRM answer and must not be refused",
  );

  // ── (E) The id-set comparison counts both directions independently ────────────────────────
  const diff = compareVisitIdSets([1, 2, 3, 4], [3, 4, 5]);
  assert.equal(diff.missingInMirror, 2, "1 and 2 are in the CRM and not the mirror");
  assert.equal(diff.extraInMirror, 1, "5 is in the mirror and not the CRM");
  assert.equal(diff.crmRows, 4);
  assert.equal(diff.mirrorRows, 3);
  assert.deepEqual(
    compareVisitIdSets([7, 7, 8], [8, 7]),
    { crmRows: 2, mirrorRows: 2, missingInMirror: 0, extraInMirror: 0, missingIds: [], extraIds: [] },
    "duplicate ids in the vendor's answer must not fabricate a difference",
  );
  assert.deepEqual(
    compareVisitIdSets([], []),
    { crmRows: 0, mirrorRows: 0, missingInMirror: 0, extraInMirror: 0, missingIds: [], extraIds: [] },
    "two empty windows are equal, not a problem",
  );

  // THE IDS, not just the counts. These are what the sync archives before deleting, so a count that
  // is right while the id list is wrong would archive the wrong rows and read as success — the
  // deletion archive is only worth having if these two agree.
  assert.deepEqual(diff.extraIds, [5], "the id the mirror holds and the CRM does not is the one carried out");
  assert.deepEqual([...diff.missingIds].sort((a, b) => a - b), [1, 2], "both late-save ids are carried out");
  assert.equal(diff.extraIds.length, diff.extraInMirror, "extraIds and extraInMirror can never disagree");
  assert.equal(diff.missingIds.length, diff.missingInMirror, "missingIds and missingInMirror can never disagree");
}
