import assert from "node:assert/strict";

import type { DistributionListSpec } from "../src/lib/distribution-lists/spec.ts";
import {
  computeListCoverage,
  distributionListCovers,
  groupSatoEmailLists,
  type SatoListGroupItem,
} from "../src/lib/sato-email/list-groups.ts";

/**
 * The composer's distribution lists, grouped for the eye and checked for coverage by rule.
 *
 * Owner 2026-09-13: "make the dls appears horizontly grouped and tidy and user friendly". Two
 * things must stay true under that redesign, and neither is visible by looking at the screen:
 *
 *  1. NO LIST DISAPPEARS. Grouping parses labels, and a label that fits no shape must land in
 *     "Other lists" — a list the sender cannot see is a list they cannot pick.
 *  2. "INCLUDED" IS PROVEN FROM THE RULE, NEVER THE LABEL. The sender acts on that hint by not
 *     ticking the narrower list, so a wrong "included" silently loses recipients.
 */

function spec(partial: Partial<DistributionListSpec> & { listKey: string }): DistributionListSpec {
  return {
    allEmployees: false,
    areaIds: [],
    departmentIds: [],
    description: "",
    enabled: true,
    excludedHrIds: [],
    externalEmails: [],
    includedHrIds: [],
    label: partial.listKey,
    lineIds: [],
    positionIds: [],
    regionCodes: [],
    roles: [],
    rolesDropped: false,
    ...partial,
  };
}

function item(label: string, listKey = label): SatoListGroupItem {
  return { coveredBy: [], description: `${label} description`, label, listKey };
}

export function runSatoEmailListGroupsTests() {
  // --- 1. Grouping: every list lands somewhere, in a sensible place -----------------------------
  const labels = [
    "All District Managers",
    "All Medical Reps",
    "HR Team",
    "Head Office",
    "Pedia - everyone",
    "Pedia - District Managers",
    "Pedia - Medical Reps",
    "Pedia - Others - Medical Reps",
    "Pedia - Giza - District Managers",
    "Pedia - Cairo - Medical Reps",
    "Pedia - Cairo - District Managers",
    "CNS - Upper Egypt - Medical Reps",
    "CNS - Cairo - Medical Reps",
    "Pedia - Cairo - Pharmacists",
    "Weird - list - with - four - parts",
  ];
  const groups = groupSatoEmailLists(labels.map((label) => item(label)));

  const placed = [
    ...groups.companyWide,
    ...groups.teams,
    ...groups.other,
    ...groups.lines.flatMap((line) => [
      line.everyone,
      line.districtManagers,
      line.medicalReps,
      ...line.regions.flatMap((row) => [row.districtManagers, row.medicalReps]),
    ]),
  ].filter((entry): entry is SatoListGroupItem => entry !== null);

  assert.deepEqual(
    placed.map((entry) => entry.listKey).sort(),
    [...labels].sort(),
    "every offered list must be placed exactly once — a list grouping cannot place is a list the sender cannot pick",
  );

  assert.deepEqual(groups.companyWide.map((entry) => entry.label), ["All District Managers", "All Medical Reps"]);
  assert.deepEqual(groups.teams.map((entry) => entry.label), ["Head Office", "HR Team"]);
  assert.deepEqual(groups.other.map((entry) => entry.label), ["Pedia - Cairo - Pharmacists", "Weird - list - with - four - parts"]);
  assert.deepEqual(groups.lines.map((line) => line.line), ["CNS", "Pedia"]);

  const pedia = groups.lines.find((line) => line.line === "Pedia");
  assert.ok(pedia);
  assert.equal(pedia.everyone?.label, "Pedia - everyone");
  assert.equal(pedia.districtManagers?.label, "Pedia - District Managers");
  assert.equal(pedia.medicalReps?.label, "Pedia - Medical Reps");
  assert.deepEqual(
    pedia.regions.map((row) => row.region),
    ["Cairo", "Giza", "Others"],
    "regions follow the organogram order, Others last — not the alphabet",
  );
  const cairo = pedia.regions[0];
  assert.equal(cairo.districtManagers?.label, "Pedia - Cairo - District Managers");
  assert.equal(cairo.medicalReps?.label, "Pedia - Cairo - Medical Reps");
  assert.equal(pedia.regions[1].medicalReps, null, "a region with no reps list shows an empty cell, not a borrowed list");

  // A second list claiming a slot already taken goes to Other rather than overwriting the first.
  const twin = groupSatoEmailLists([item("Pedia - Giza - Medical Reps", "a"), item("Pedia - Giza - Medical Reps", "b")]);
  assert.equal(twin.lines[0].regions[0].medicalReps?.listKey, "a");
  assert.deepEqual(twin.other.map((entry) => entry.listKey), ["b"]);

  // --- 2. Coverage: proven from the rule --------------------------------------------------------
  const allDms = spec({ listKey: "all_dms", roles: ["District Manager"] });
  const allReps = spec({ listKey: "all_reps", roles: ["Medical Rep"] });
  const pediaEveryone = spec({ lineIds: [2], listKey: "pedia" });
  const pediaDms = spec({ lineIds: [2], listKey: "pedia_dms", roles: ["District Manager"] });
  const pediaGizaDms = spec({ lineIds: [2], listKey: "pedia_giza_dms", regionCodes: ["Giza", "GZ"], roles: ["District Manager"] });
  const pediaGizaReps = spec({ lineIds: [2], listKey: "pedia_giza_reps", regionCodes: ["giza", "gz"], roles: ["Medical Rep"] });
  const cnsGizaReps = spec({ lineIds: [3], listKey: "cns_giza_reps", regionCodes: ["Giza", "GZ"], roles: ["Medical Rep"] });
  const headOffice = spec({ departmentIds: [2, 40], listKey: "head_office" });

  assert.ok(distributionListCovers(allDms, pediaGizaDms), "All District Managers reaches every regional DM list");
  assert.ok(distributionListCovers(allDms, pediaDms));
  assert.ok(distributionListCovers(pediaEveryone, pediaGizaReps), "a line's everyone list reaches its regional reps");
  assert.ok(distributionListCovers(pediaDms, pediaGizaDms), "a line's DM list reaches its regional DM lists");
  assert.ok(distributionListCovers(pediaEveryone, pediaDms));

  assert.ok(!distributionListCovers(pediaDms, pediaGizaReps), "a DM list never covers a reps list");
  assert.ok(!distributionListCovers(allReps, pediaGizaDms));
  assert.ok(!distributionListCovers(pediaEveryone, cnsGizaReps), "one line never covers another");
  assert.ok(!distributionListCovers(pediaGizaDms, pediaDms), "a narrow list never covers the wider one");
  assert.ok(!distributionListCovers(pediaDms, allDms), "a line list never covers the company-wide one");
  assert.ok(!distributionListCovers(headOffice, allDms), "a department rule never covers a role rule it does not constrain");
  assert.ok(!distributionListCovers(pediaGizaDms, pediaGizaDms), "a list never covers itself");

  // What the matcher treats specially is never claimed as covered.
  assert.ok(
    !distributionListCovers(allDms, { ...pediaGizaDms, includedHrIds: ["B-99"] }),
    "a hand-added name on the narrow list is not reached by the wide rule",
  );
  assert.ok(
    !distributionListCovers(allDms, { ...pediaGizaDms, externalEmails: ["clinic@example.com"] }),
    "an outside address on the narrow list is not reached by the wide rule",
  );
  assert.ok(
    !distributionListCovers({ ...allDms, excludedHrIds: ["B-99"] }, pediaGizaDms),
    "a wide list that excludes someone may miss a person the narrow list reaches",
  );
  assert.ok(!distributionListCovers({ ...allDms, enabled: false }, pediaGizaDms));
  assert.ok(!distributionListCovers({ ...allDms, rolesDropped: true, roles: [] }, pediaGizaDms));
  assert.ok(!distributionListCovers(spec({ listKey: "blank" }), pediaGizaDms), "a list with no rule reaches nobody, so covers nobody");
  assert.ok(!distributionListCovers(spec({ allEmployees: true, listKey: "family" }), pediaGizaDms));

  const coverage = computeListCoverage([allDms, pediaEveryone, pediaDms, pediaGizaDms, pediaGizaReps]);
  assert.deepEqual(coverage.get("pedia_giza_dms")?.sort(), ["all_dms", "pedia", "pedia_dms"]);
  assert.deepEqual(coverage.get("pedia_giza_reps"), ["pedia"]);
  assert.deepEqual(coverage.get("all_dms"), []);
}
