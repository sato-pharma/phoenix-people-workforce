import assert from "node:assert/strict";

import {
  normalizeSearchValue,
  organogramSearchText,
  rowMatchesOrganogramSearch,
} from "../src/lib/reports/organogram-view-model.ts";
import type { OrganogramReportRow } from "../src/lib/reports/vacancies.ts";

// The organogram search used to index the English name only. Every employee record also carries an
// Arabic name, and HR types in Arabic, so a search for a name spelled the way it appears on the
// person's own contract returned nobody — and an empty chart reads as "this person is not in the
// organogram", which is the wrong conclusion drawn from a search that never looked.
//
// Two halves have to hold together for that to work, and only one of them is obvious:
//   1. row.nameAr is in the searchable text at all;
//   2. the query and the row text are folded by the SAME spelling policy. Arabic writes one name
//      several ways (أ إ آ ٱ for alef, ة vs ه, ى vs ي), so an unfolded comparison matches only when
//      the typist happens to reproduce the stored orthography character for character.
// A test that only covered (1) would pass on an exact-spelling query and hide the whole of (2).

function row(overrides: Partial<OrganogramReportRow>): OrganogramReportRow {
  return {
    areaId: null,
    areaName: null,
    departmentId: 1,
    departmentName: "Sales",
    displayName: "Employee",
    fullName: "Employee",
    hireDate: null,
    hrId: "E-1",
    jobTitle: null,
    lineId: 1,
    lineName: "Pedia",
    managerHrId: null,
    managerName: null,
    positionId: null,
    positionTitle: null,
    regionName: null,
    sourceRowNumber: null,
    status: "active",
    teamId: null,
    teamName: null,
    type: "employee",
    vacancyCode: null,
    ...overrides,
  };
}

export function runOrganogramArabicSearchTests() {
  // A real production row: PD-0013, added 2026-09-09, whose Arabic name is the spelling HR reads
  // off the contract while the chart card shows the English one.
  const ebtissam = row({
    areaName: "Kafr El-Sheikh 1",
    fullName: "Ebtissam Alaa ElDin Anwar",
    displayName: "Ebtissam Alaa ElDin Anwar",
    hrId: "PD-0013",
    jobTitle: "Medical Representative",
    nameAr: "ابتسام علاء الدين انور",
  });

  // (1) The Arabic name reaches the searchable text at all. Asserted on the text rather than only
  // through the matcher so a failure says which half broke.
  assert.ok(
    organogramSearchText(ebtissam).includes("ابتسام"),
    "row.nameAr must be part of the searchable text, or an Arabic query can never match anything",
  );

  // The headline behaviour: the name as HR types it finds the person.
  assert.equal(
    rowMatchesOrganogramSearch(ebtissam, normalizeSearchValue("ابتسام")),
    true,
    "typing the Arabic first name finds the employee whose Arabic name starts with it",
  );

  // (2) The folding, in both directions. Neither side may be privileged: the stored spelling is
  // whatever HR happened to type when the record was created, and so is the query.
  assert.equal(
    rowMatchesOrganogramSearch(ebtissam, normalizeSearchValue("إبتسام")),
    true,
    "a hamza-below alef in the QUERY still matches a plain-alef stored name",
  );
  const withHamza = row({ hrId: "E-2", nameAr: "إبتسام علاء" });
  assert.equal(
    rowMatchesOrganogramSearch(withHamza, normalizeSearchValue("ابتسام")),
    true,
    "a plain-alef query still matches a hamza-below STORED name — folding is symmetric, not one-sided",
  );
  const taMarbuta = row({ hrId: "E-3", nameAr: "فاطمة حسن" });
  assert.equal(
    rowMatchesOrganogramSearch(taMarbuta, normalizeSearchValue("فاطمه")),
    true,
    "ta marbuta and ha are one letter for search — both spellings of the same name must agree",
  );

  // Negative control. Without this the folding could collapse everything into everything and the
  // three assertions above would still pass.
  assert.equal(
    rowMatchesOrganogramSearch(ebtissam, normalizeSearchValue("خالد")),
    false,
    "an unrelated Arabic name must NOT match — folding must not widen into matching everyone",
  );

  // The matcher normalizes its own query. Both live callers already normalize, so this pins the
  // guarantee for the next caller: the row side is always folded, so an unfolded query would match
  // NOTHING, and that empty result looks exactly like a person who is not on the chart.
  assert.equal(
    rowMatchesOrganogramSearch(ebtissam, "  EBTISSAM   ALAA  "),
    true,
    "a raw, uppercased, loosely-spaced query is normalized inside the matcher rather than trusted",
  );
  assert.equal(
    rowMatchesOrganogramSearch(ebtissam, "PD-0013"),
    true,
    "a raw HR_ID query with its original casing still matches",
  );

  // An employee with no Arabic name recorded must not throw, and must not become a wildcard that
  // matches any Arabic query.
  const noArabic = row({ fullName: "Ahmed Farag", hrId: "AI-0020", nameAr: null });
  assert.equal(
    rowMatchesOrganogramSearch(noArabic, normalizeSearchValue("ابتسام")),
    false,
    "a row with no Arabic name matches no Arabic query, rather than matching every one",
  );

  // The English behaviour this change must not disturb.
  assert.equal(
    rowMatchesOrganogramSearch(ebtissam, normalizeSearchValue("Ebtissam Alaa ElDin Anwar")),
    true,
    "the full English name still matches",
  );
  assert.equal(
    rowMatchesOrganogramSearch(ebtissam, normalizeSearchValue("Kafr El-Sheikh 1")),
    true,
    "searching by area still matches — Latin text is untouched by the Arabic folding",
  );
  assert.equal(
    rowMatchesOrganogramSearch(ebtissam, ""),
    true,
    "an empty query still matches every row, so clearing the box does not empty the chart",
  );
}
