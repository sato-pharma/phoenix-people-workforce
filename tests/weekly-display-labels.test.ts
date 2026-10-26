import assert from "node:assert/strict";

import {
  labelWeeklyDashboardNames,
  weeklyAreaLabel,
  weeklyDistributorLabel,
  weeklyPersonLabel,
  weeklyRegionLabel,
} from "../src/lib/sales/weekly/display-labels.ts";

// The National Sales Manager's Weekly Sales printed the stored spellings: "overseas", "Ibn sina", "ramco",
// "Sohag1", "October -Zayed", "Port said - Domiat", regions and a manager's name in capitals. These labels
// are DISPLAY ONLY — the stored name, the codes and the area names the governorate matching reads never
// change — so the checks below pin both halves: what a person reads, and what stays exactly as stored.

export function runWeeklyDisplayLabelsTests() {
  // Regions: only a name typed entirely in capitals is tidied; somebody's own spelling is kept.
  assert.equal(weeklyRegionLabel("UPPER EGYPT"), "Upper Egypt");
  assert.equal(weeklyRegionLabel("Delta (1)"), "Delta (1)");
  assert.equal(weeklyRegionLabel("Alex-BHR"), "Alex-BHR");
  assert.equal(weeklyRegionLabel("Upper Egypt 2"), "Upper Egypt 2");
  assert.equal(weeklyRegionLabel(null), "");

  // People: Sahar El Gallad's card read in capitals; an Arabic or mixed-case name is untouched.
  assert.equal(weeklyPersonLabel("SAHAR EL GALLAD"), "Sahar El Gallad");
  assert.equal(weeklyPersonLabel("Sahar El Gallad"), "Sahar El Gallad");
  assert.equal(weeklyPersonLabel("سحر الجلاد"), "سحر الجلاد");
  assert.equal(weeklyPersonLabel(undefined), "");

  // Distributors: the code decides when the screen has it, the registry name decides otherwise.
  assert.equal(weeklyDistributorLabel("overseas", "PS"), "Overseas");
  assert.equal(weeklyDistributorLabel("Ibn sina", "IS"), "Ibn Sina");
  assert.equal(weeklyDistributorLabel("ramco", "RM"), "RAMCO");
  assert.equal(weeklyDistributorLabel("Ibn Sina-Lacto", "IS-L"), "Ibn Sina Lacto");
  assert.equal(weeklyDistributorLabel("Ibn Sina-Sato", "IS-S"), "Ibn Sina Sato");
  assert.equal(weeklyDistributorLabel("EGD", "EG"), "EGD");
  assert.equal(weeklyDistributorLabel("Direct (Company)", "Direct"), "Direct (Company)");
  // Name only (an option built without a code): matched to the registry ignoring case, spaces and hyphens.
  assert.equal(weeklyDistributorLabel("Ibn sina"), "Ibn Sina");
  assert.equal(weeklyDistributorLabel("ibn sina-lacto"), "Ibn Sina Lacto");
  assert.equal(weeklyDistributorLabel("overseas"), "Overseas");
  // A code the registry has never heard of keeps its stored words, capitalised — never dropped or invented.
  assert.equal(weeklyDistributorLabel("new depot", "ZZ"), "New Depot");

  // Areas: a glued number, a lopsided dash and the Damietta spelling.
  assert.equal(weeklyAreaLabel("Sohag1"), "Sohag 1");
  assert.equal(weeklyAreaLabel("Sohag2"), "Sohag 2");
  assert.equal(weeklyAreaLabel("October -Zayed"), "October - Zayed");
  assert.equal(weeklyAreaLabel("Port said - Domiat"), "Port Said - Damietta");
  assert.equal(weeklyAreaLabel("Minia 1"), "Minia 1");
  assert.equal(weeklyAreaLabel("Alex-BHR"), "Alex-BHR");

  // The dashboard payload: names are relabelled, codes and figures are not.
  const raw = {
    availableRegions: [{ code: "UE", name: "UPPER EGYPT" }],
    availableUploads: [{ name: "overseas · 2026-10-19 · W3" }],
    distributors: [{ code: "PS", name: "overseas" }],
    regions: [{ code: "UE", name: "UPPER EGYPT", value: 10 }],
    distributorBreakdown: [{ code: "RM", name: "ramco", value: 5 }],
    branchBreakdown: [{ regionName: "UPPER EGYPT", branchName: "Sohag1 depot" }],
    zeroSalesBranches: [{ regionName: "DELTA (1)" }],
  };
  const labelled = labelWeeklyDashboardNames(raw);
  assert.equal(labelled.availableRegions[0].name, "Upper Egypt");
  assert.equal(labelled.availableRegions[0].code, "UE");
  assert.equal(labelled.availableUploads[0].name, "Overseas · 2026-10-19 · W3");
  assert.equal(labelled.distributors[0].name, "Overseas");
  assert.equal(labelled.distributors[0].code, "PS");
  assert.equal(labelled.regions[0].name, "Upper Egypt");
  assert.equal(labelled.regions[0].value, 10);
  assert.equal(labelled.distributorBreakdown[0].name, "RAMCO");
  assert.equal(labelled.distributorBreakdown[0].code, "RM");
  assert.equal(labelled.distributorBreakdown[0].value, 5);
  assert.equal(labelled.branchBreakdown[0].regionName, "Upper Egypt");
  assert.equal(labelled.branchBreakdown[0].branchName, "Sohag1 depot");
  assert.equal(labelled.zeroSalesBranches[0].regionName, "Delta (1)");
  // The raw payload is never mutated — the stored spelling is still what the data holds.
  assert.equal(raw.distributors[0].name, "overseas");
  assert.equal(raw.regions[0].name, "UPPER EGYPT");
}
