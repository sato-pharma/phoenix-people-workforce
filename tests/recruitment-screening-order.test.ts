import assert from "node:assert/strict";

import { candidateRoleFamilies } from "../src/lib/recruitment/candidate-role-family.ts";
import {
  countByBand,
  orderForScreening,
  screeningBand,
  screeningBandForFamily,
  screeningBandLabels,
  screeningBandDescriptions,
  screeningBands,
  screeningSortKey,
  type ScreeningOrderInput,
} from "../src/lib/recruitment/screening-order.ts";

type Row = ScreeningOrderInput & { name: string };

function row(name: string, overrides: Partial<ScreeningOrderInput> = {}): Row {
  return {
    createdAt: "2026-08-01T00:00:00Z",
    family: null,
    hasPharmaExperience: null,
    name,
    ...overrides,
  };
}

const describe = (r: Row): ScreeningOrderInput => r;

export function runRecruitmentScreeningOrderTests() {
  // --- Every family lands in a band. A family added later with no entry here would resolve to
  // --- undefined, and the sort would silently drop those candidates to a random position instead
  // --- of failing — the kind of fault nobody notices because the queue still "works".
  for (const family of candidateRoleFamilies) {
    const band = screeningBandForFamily(family);
    assert.ok(screeningBands.includes(band), `${family} must map to a real band, got ${String(band)}`);
    assert.ok(screeningBandLabels[band], `${band} needs a label`);
    assert.ok(screeningBandDescriptions[band], `${band} needs a description — the order must be explainable on screen`);
  }

  // --- The three field-force jobs are the ones Phoenix actually hires into the field. If any of
  // --- these ever slid into another band, the whole point of the ordering would be lost.
  assert.equal(screeningBandForFamily("medical_rep"), "field_force");
  assert.equal(screeningBandForFamily("district_manager"), "field_force");
  assert.equal(screeningBandForFamily("area_regional_manager"), "field_force");
  assert.equal(screeningBandForFamily("pharmacist"), "pharma_adjacent");
  assert.equal(screeningBandForFamily("product_manager"), "pharma_adjacent");
  assert.equal(screeningBandForFamily("human_resources"), "unrelated");
  assert.equal(screeningBandForFamily("finance"), "unrelated");

  // --- THE DISTINCTION THAT MATTERS. `null` is "nobody could work out a family" and `other` is "a
  // --- title was read and it is something else". Folding the first into the second would bury the
  // --- 75 candidates whose CV could not be read behind 137 accountants — the one group that
  // --- genuinely needs a human would be the group nobody ever reaches.
  assert.equal(screeningBandForFamily(null), "unknown");
  assert.equal(screeningBandForFamily("other"), "unrelated");

  // --- EVERY band is explainable on screen, including the ones no family maps to. The loop above
  // --- only reaches bands a family points at, so a band added later would ship with no label and
  // --- render as `undefined` in the header chip.
  for (const band of screeningBands) {
    assert.ok(screeningBandLabels[band], `${band} needs a label`);
    assert.ok(screeningBandDescriptions[band], `${band} needs a description`);
  }

  // --- A FILE THE EXTRACTOR ALREADY JUDGED NOT TO BE A CV outranks whatever title was read off it.
  // --- A photographed certificate carrying the words "Medical Representative" is still not a CV,
  // --- and putting it at the FRONT of the queue would be the worst possible use of the ordering.
  assert.equal(
    screeningBand({ createdAt: "2026-08-01T00:00:00Z", family: "medical_rep", hasPharmaExperience: true, notACv: true }),
    "no_cv",
    "not-a-CV must beat even the strongest family — there is nothing in the file to screen",
  );

  // --- ...but ONLY on a recorded `true`. Absent means nobody has judged the file, which is the
  // --- state of every row read before the column existed; treating those as no-CV would bury most
  // --- of the pool. This is the same distinction `isNotACv` itself is built around.
  assert.equal(
    screeningBand({ createdAt: "2026-08-01T00:00:00Z", family: "medical_rep", hasPharmaExperience: true }),
    "field_force",
    "an unjudged file must fall through to the family, not to no_cv",
  );
  assert.equal(
    screeningBand({ createdAt: "2026-08-01T00:00:00Z", family: "medical_rep", hasPharmaExperience: true, notACv: false }),
    "field_force",
    "a file judged to BE a CV must fall through to the family",
  );

  // --- And it is LAST. 27 of the 67 candidates the queue called "needs a read" on 2026-08-25 were
  // --- in this state — already answered, costing a full open-read-and-decide each to discover
  // --- there was nothing to read. They sit behind even the unrelated industries.
  const withNoCv = [
    row("certificate", { family: "medical_rep", hasPharmaExperience: true, notACv: true }),
    row("accountant", { family: "finance" }),
    row("unreadable"),
    row("rep", { family: "medical_rep" }),
  ];
  assert.deepEqual(
    orderForScreening(withNoCv, describe).map((r) => r.name),
    ["rep", "unreadable", "accountant", "certificate"],
  );

  // --- Band order, best first.
  const mixed = [
    row("accountant", { family: "finance" }),
    row("unreadable"),
    row("pharmacist", { family: "pharmacist" }),
    row("rep", { family: "medical_rep" }),
  ];
  assert.deepEqual(
    orderForScreening(mixed, describe).map((r) => r.name),
    ["rep", "pharmacist", "unreadable", "accountant"],
  );

  // --- Confirmed pharma experience lifts a candidate INSIDE their band...
  const sameBand = [
    row("no pharma", { family: "medical_rep", hasPharmaExperience: false }),
    row("unanswered", { family: "medical_rep", hasPharmaExperience: null }),
    row("pharma", { family: "medical_rep", hasPharmaExperience: true }),
  ];
  assert.deepEqual(
    orderForScreening(sameBand, describe).map((r) => r.name),
    ["pharma", "unanswered", "no pharma"],
  );

  // --- ...and it never lifts them OUT of it. A district manager with no pharma answer still comes
  // --- before an accountant who happens to have one.
  const acrossBands = [
    row("accountant with pharma", { family: "finance", hasPharmaExperience: true }),
    row("dm without", { family: "district_manager", hasPharmaExperience: false }),
  ];
  assert.deepEqual(
    orderForScreening(acrossBands, describe).map((r) => r.name),
    ["dm without", "accountant with pharma"],
  );

  // --- An UNANSWERED pharma flag must not be scored as "no" — 66 production rows are in that
  // --- state, and punishing a candidate for a gap in our own data is the same fault the pool's
  // --- three-way experience filter exists to avoid.
  const unansweredKey = screeningSortKey(row("x", { family: "medical_rep", hasPharmaExperience: null }));
  const noKey = screeningSortKey(row("y", { family: "medical_rep", hasPharmaExperience: false }));
  assert.ok(unansweredKey[1] < noKey[1], "an unanswered flag must outrank a recorded 'no', never tie with it");

  // --- Newest first inside everything else, which is the rule the table itself uses.
  const byDate = [
    row("march", { createdAt: "2026-03-01T00:00:00Z", family: "medical_rep" }),
    row("august", { createdAt: "2026-08-20T00:00:00Z", family: "medical_rep" }),
    row("june", { createdAt: "2026-06-15T00:00:00Z", family: "medical_rep" }),
  ];
  assert.deepEqual(
    orderForScreening(byDate, describe).map((r) => r.name),
    ["august", "june", "march"],
  );

  // --- An unparseable timestamp must not throw and must not shuffle the queue randomly. Production
  // --- has rows with a null createdAt reaching this code as "".
  const broken = [row("broken", { createdAt: "not a date", family: "medical_rep" }), row("fine", { createdAt: "2026-08-20T00:00:00Z", family: "medical_rep" })];
  assert.doesNotThrow(() => orderForScreening(broken, describe));
  assert.equal(orderForScreening(broken, describe).length, 2, "a bad date loses its place, never its row");

  // --- Nothing is dropped and nothing is hidden. Every candidate handed in comes back out — this
  // --- reorders a queue, it does not filter one, and an auto-reject is not what was asked for.
  const everyone = [...mixed, ...sameBand, ...byDate];
  assert.equal(orderForScreening(everyone, describe).length, everyone.length);
  assert.deepEqual(
    new Set(orderForScreening(everyone, describe).map((r) => r.name)),
    new Set(everyone.map((r) => r.name)),
  );

  // --- The caller's array is left alone: it is the visible table's own order, and sorting it in
  // --- place would silently rearrange the page behind the reader.
  const input = [row("b", { family: "finance" }), row("a", { family: "medical_rep" })];
  orderForScreening(input, describe);
  assert.deepEqual(input.map((r) => r.name), ["b", "a"], "the caller's array is not mutated");

  // --- Stable: two candidates the key cannot separate keep the order they arrived in, so the queue
  // --- does not reshuffle itself between renders.
  const tied = [
    row("first", { createdAt: "2026-08-01T00:00:00Z", family: "medical_rep", hasPharmaExperience: true }),
    row("second", { createdAt: "2026-08-01T00:00:00Z", family: "medical_rep", hasPharmaExperience: true }),
  ];
  assert.deepEqual(orderForScreening(tied, describe).map((r) => r.name), ["first", "second"]);

  // --- The counts behind the header chip.
  assert.deepEqual(countByBand(mixed, describe), {
    field_force: 1,
    pharma_adjacent: 1,
    unknown: 1,
    unrelated: 1,
    no_cv: 0,
  });
  assert.deepEqual(countByBand([], describe), { field_force: 0, pharma_adjacent: 0, unknown: 0, unrelated: 0, no_cv: 0 });

  // --- The header chip must count no-CV rows in their OWN band, or the screener is told 67 people
  // --- need reading when 40 do.
  assert.deepEqual(
    countByBand([row("a", { family: "medical_rep", notACv: true }), row("b", { family: "medical_rep" })], describe),
    { field_force: 1, pharma_adjacent: 0, unknown: 0, unrelated: 0, no_cv: 1 },
  );
}
