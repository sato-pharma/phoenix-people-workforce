import assert from "node:assert/strict";

import { candidateRoleFamilies } from "../src/lib/recruitment/candidate-role-family.ts";
import {
  countByBand,
  countByRegion,
  duplicateSets,
  experienceRank,
  filterByRegion,
  NO_REGION,
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
  assert.equal(screeningBandForFamily("sales"), "sales");
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

  // --- SALES SITS BETWEEN THE PHARMA BANDS AND `unknown`, and never inside either. Landing it in
  // --- `pharma_adjacent` would tell the screener these people are in pharma when nothing on the CV
  // --- says so; landing it in `unrelated` would file a Sales Representative beside an accountant
  // --- when selling IS the job. This band arrived on main in #2395 with no entry in the map at
  // --- all, which made every sales candidate's sort key NaN and every band count read 0.
  const salesPlacement = [
    row("accountant", { family: "finance" }),
    row("unreadable"),
    row("salesman", { family: "sales" }),
    row("pharmacist", { family: "pharmacist" }),
    row("rep", { family: "medical_rep" }),
  ];
  assert.deepEqual(
    orderForScreening(salesPlacement, describe).map((r) => r.name),
    ["rep", "pharmacist", "salesman", "unreadable", "accountant"],
  );

  // --- Every band's rank is a real number. An unmapped family makes `bandRank[undefined]` NaN, and
  // --- a NaN comparator does not throw — it silently scatters those candidates through the queue,
  // --- which is precisely how #2395 shipped unnoticed.
  for (const family of candidateRoleFamilies) {
    const key = screeningSortKey(row("x", { family }));
    assert.ok(Number.isFinite(key[0]), `${family} produced a non-finite band rank (${String(key[0])}) — it is unmapped`);
  }

  // --- ...and countByBand must not grow an "undefined" key, which is what it did on main: every
  // --- real band read 0 and the header chip would have shown the screener nothing at all.
  const salesCount = countByBand([row("s", { family: "sales" })], describe);
  assert.deepEqual(Object.keys(salesCount).sort(), [...screeningBands].sort(), "countByBand grew a key that is not a band");
  assert.equal(salesCount.sales, 1);

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
    sales: 0,
    unknown: 1,
    unrelated: 1,
    no_cv: 0,
  });
  assert.deepEqual(countByBand([], describe), { field_force: 0, pharma_adjacent: 0, sales: 0, unknown: 0, unrelated: 0, no_cv: 0 });

  // --- The header chip must count no-CV rows in their OWN band, or the screener is told 67 people
  // --- need reading when 40 do.
  assert.deepEqual(
    countByBand([row("a", { family: "medical_rep", notACv: true }), row("b", { family: "medical_rep" })], describe),
    { field_force: 1, pharma_adjacent: 0, sales: 0, unknown: 0, unrelated: 0, no_cv: 1 },
  );

  // ── Experience, the third tiebreaker ────────────────────────────────────────────────────────────
  //
  // Measured on production 2026-09-04: of 534 undecided rows, 296 carry NO years figure at all, 27
  // are under 2 years, 49 are 2–5, and 162 are 5 or more.
  assert.equal(experienceRank(12), 0, "a senior candidate ranks first");
  assert.equal(experienceRank(5), 0, "5 years is the senior cut");
  assert.equal(experienceRank(3), 1, "mid");
  assert.equal(experienceRank(2), 1, "2 years is the mid cut");
  assert.equal(experienceRank(1.5), 2, "under 2 is junior");
  assert.equal(experienceRank(0), 2, "zero is a real answer, and it is junior");

  // THE headline assertion for this rule. 296 of 534 rows have no figure; ranking them below
  // everyone who has one would demote more than half the pool for a gap in our own data, and
  // ranking them above would invent seniority nobody claimed. The middle is the only honest place.
  assert.equal(experienceRank(null), 1, "an unknown year count sits in the MIDDLE bucket, never last");
  assert.equal(experienceRank(undefined), 1, "an absent year count sits in the middle too");
  assert.equal(experienceRank(Number.NaN), 1, "an unreadable figure is an unknown, not a zero");

  // Experience sorts BELOW pharma: a confirmed rep with 1 year still outranks a 20-year non-rep,
  // because pharma experience is the thing being hired for and the bucket is only a tiebreaker.
  assert.deepEqual(
    orderForScreening(
      [
        row("veteran, not a rep", { family: "medical_rep", hasPharmaExperience: false, yearsExperience: 20 }),
        row("junior rep", { family: "medical_rep", hasPharmaExperience: true, yearsExperience: 1 }),
      ],
      describe,
    ).map((r) => r.name),
    ["junior rep", "veteran, not a rep"],
    "pharma experience outranks years — years is a tiebreaker, not a promotion",
  );

  // But ABOVE recency: inside one band with the same pharma answer, the 12-year candidate is met
  // before the 1-year one even though the 1-year one applied later.
  assert.deepEqual(
    orderForScreening(
      [
        row("newer, junior", {
          createdAt: "2026-09-01T00:00:00Z",
          family: "medical_rep",
          hasPharmaExperience: true,
          yearsExperience: 1,
        }),
        row("older, senior", {
          createdAt: "2026-08-01T00:00:00Z",
          family: "medical_rep",
          hasPharmaExperience: true,
          yearsExperience: 12,
        }),
      ],
      describe,
    ).map((r) => r.name),
    ["older, senior", "newer, junior"],
    "within a band and a pharma answer, experience beats recency",
  );

  // A row with no figure must not fall behind a junior one.
  assert.deepEqual(
    orderForScreening(
      [
        row("junior", { family: "medical_rep", hasPharmaExperience: true, yearsExperience: 1 }),
        row("unknown", { family: "medical_rep", hasPharmaExperience: true }),
      ],
      describe,
    ).map((r) => r.name),
    ["unknown", "junior"],
    "a missing year count must never cost somebody their place",
  );

  // ── Near-duplicates: made adjacent, NEVER merged ────────────────────────────────────────────────
  //
  // 28 undecided rows share a phone with another row and 9 of those carry a DIFFERENT name — a
  // mother and daughter, two colleagues, one handset. So the key clusters and reports; it does not
  // decide. This is the assertion that must fail if anybody ever makes it merge.
  const twins = [
    row("Amr Mohamed Rozza", { createdAt: "2026-09-01T00:00:00Z", duplicateKey: "201004316664", family: "medical_rep" }),
    row("stranger", { createdAt: "2026-08-20T00:00:00Z", family: "medical_rep" }),
    row("Amr rozza", { createdAt: "2026-07-01T00:00:00Z", duplicateKey: "201004316664", family: "medical_rep" }),
  ];
  const clustered = orderForScreening(twins, describe);
  assert.equal(clustered.length, 3, "clustering must never DROP a row — it is not a merge");
  assert.deepEqual(
    clustered.map((r) => r.name),
    ["Amr Mohamed Rozza", "Amr rozza", "stranger"],
    "the twin is lifted to sit behind its best-ranked copy, and everybody else keeps their order",
  );

  // The best-ranked member keeps the place the RANKING gave it — a duplicate can never drag its
  // twin up the queue, which is the failure that would make this unsafe to do to a list in use.
  const dragged = [
    row("strong", { family: "medical_rep", hasPharmaExperience: true }),
    row("weak twin A", { createdAt: "2026-09-01T00:00:00Z", duplicateKey: "p", family: "finance" }),
    row("weak twin B", { createdAt: "2026-08-01T00:00:00Z", duplicateKey: "p", family: "finance" }),
  ];
  assert.deepEqual(
    orderForScreening(dragged, describe).map((r) => r.name),
    ["strong", "weak twin A", "weak twin B"],
    "a duplicate pair must not climb above a better candidate",
  );

  // A blank key is not a key — otherwise every row without a phone would cluster into one lump.
  const blanks = [
    row("no phone 1", { duplicateKey: "", family: "medical_rep" }),
    row("no phone 2", { duplicateKey: null, family: "medical_rep" }),
    row("no phone 3", { duplicateKey: "   ", family: "medical_rep" }),
  ];
  assert.equal(orderForScreening(blanks, describe).length, 3, "blank keys must not collapse anything");
  assert.equal(duplicateSets(blanks, describe).size, 0, "a blank key is never a duplicate set");

  // The sets the screen shows. Only groups of two or more, so a lone CV never gets a badge.
  const sets = duplicateSets(twins, describe);
  assert.equal(sets.size, 1, "one duplicate set");
  assert.deepEqual(
    sets.get("201004316664")?.map((r) => r.name),
    ["Amr Mohamed Rozza", "Amr rozza"],
    "both names come back, because telling one person from two is the reader's job, not ours",
  );

  // ── Region: a filter, and a bucket for the ones we cannot place ─────────────────────────────────
  //
  // 73 of 534 undecided rows resolve to no region at all. They get their own chip rather than
  // vanishing from every region a screener might pick.
  const byRegion = [
    row("cairo", { family: "medical_rep", region: "CA" }),
    row("delta", { family: "medical_rep", region: "D1" }),
    row("cairo too", { family: "medical_rep", region: "CA" }),
    row("nowhere", { family: "medical_rep" }),
  ];
  const regionCounts = countByRegion(byRegion, describe);
  assert.equal(regionCounts.get("CA"), 2);
  assert.equal(regionCounts.get("D1"), 1);
  assert.equal(regionCounts.get(NO_REGION), 1, "an unplaceable candidate is counted, never dropped");

  assert.deepEqual(
    filterByRegion(byRegion, describe, "CA").map((r) => r.name),
    ["cairo", "cairo too"],
  );
  assert.deepEqual(
    filterByRegion(byRegion, describe, NO_REGION).map((r) => r.name),
    ["nowhere"],
    "the no-region chip must be reachable, or 73 people are unscreenable",
  );
  assert.equal(filterByRegion(byRegion, describe, null).length, 4, "no filter returns everybody");

  // Filtering must not reorder. The screener picked a region, not a different ranking.
  const orderedByRegion = orderForScreening(byRegion, describe);
  assert.deepEqual(
    filterByRegion(orderedByRegion, describe, "CA").map((r) => r.name),
    orderedByRegion.filter((r) => r.region === "CA").map((r) => r.name),
    "a region filter narrows the queue and changes nothing else about it",
  );

}
