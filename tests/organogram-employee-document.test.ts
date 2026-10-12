// The organogram employee-record document — SATO-DIS-2026-01 v1.0.
//
// EVERY ASSERTION IS ON THE EMITTED ARTIFACT, never on the module's source. The same class of defect
// the payslip test exists to catch lives here too — an escaped slash reaching the browser, a quoted
// font stack closing a `style=""`, a section silently rendering nothing — and only building the
// document and reading what came out can see it.
//
// THE PERMISSION MIRRORING IS TESTED AT THE DOCUMENT SEAM. The route re-derives the viewer's sections
// with `buildOrganogramEmployeeDetail` (the exact call the JSON popup makes) and hands the result
// here; this module renders whatever sections it is given and invents none. So the guarantee "the PDF
// can never reveal a field the popup withheld" reduces to one checkable claim: a detail WITHOUT the
// Compensation section produces a document with no salary anywhere in it. That is asserted below.

import assert from "node:assert/strict";

import { HOUSE_IDENTITY_CSS, houseLetterhead } from "../src/lib/hiring-pack/house-identity.ts";
import { premiumDocumentStylesheet } from "../src/lib/hiring-pack/premium-identity.ts";
import type { OrganogramEmployeeDetail } from "../src/lib/reports/organogram-employee-detail.ts";
import {
  buildOrganogramEmployeeDocument,
  buildOrganogramEmployeeRecordSheet,
  ORGANOGRAM_RECORD_CSS,
  organogramRecordContentDisposition,
  organogramRecordFileName,
} from "../src/lib/reports/organogram-employee-document.ts";

// The org + contact sections a line manager receives — and one fully-empty section, to prove empty
// sections are dropped rather than printed as a bare heading. "Position" is null, to prove an empty
// CELL is dropped rather than shown as "—".
const RESTRICTED: OrganogramEmployeeDetail = {
  hrId: "a-000",
  displayName: "Ahmed Specimen Mohamed",
  fullName: "Ahmed Specimen Mohamed",
  jobTitle: "Medical Representative",
  areaName: "Cairo 1",
  hireDate: "2024-03-01",
  canViewSensitive: false,
  sections: [
    {
      title: "Identity",
      items: [
        { label: "Full name", value: "Ahmed Specimen Mohamed" },
        { label: "Arabic name", value: "أحمد نموذج محمد" },
        { label: "HR ID", value: "a-000" },
        { label: "Job title", value: "Medical Representative" },
        { label: "Status", value: "Active" },
        { label: "Position", value: null },
      ],
    },
    {
      title: "Placement",
      items: [
        { label: "Line", value: "CNS" },
        { label: "Area", value: "Cairo 1" },
        { label: "Region", value: "Cairo" },
      ],
    },
    {
      title: "Contact",
      items: [
        { label: "Work email", value: "ahmed@example.com" },
        { label: "Mobile", value: "01000000000" },
      ],
    },
    { title: "Nothing populated", items: [{ label: "Absent", value: null }] },
  ],
};

// The same person as an HR/finance/executive viewer sees them: the two sensitive sections are now
// present, with a DISTINCT money figure in every column so a dropped line cannot hide behind a twin.
const SENSITIVE: OrganogramEmployeeDetail = {
  ...RESTRICTED,
  canViewSensitive: true,
  sections: [
    ...RESTRICTED.sections,
    {
      title: "Personal",
      items: [
        { label: "National ID", value: "29003010100011" },
        { label: "Residence city", value: "Cairo" },
      ],
    },
    {
      title: "Compensation",
      items: [
        { label: "Base salary", value: "EGP 9,001" },
        { label: "Net salary", value: "EGP 11,204" },
        { label: "Bank", value: "CIB" },
      ],
    },
  ],
};

const RESTRICTED_SHEET = buildOrganogramEmployeeRecordSheet(RESTRICTED);
const SENSITIVE_SHEET = buildOrganogramEmployeeRecordSheet(SENSITIVE);
const DOCUMENT = buildOrganogramEmployeeDocument(SENSITIVE);

export function runOrganogramEmployeeDocumentTests() {
  // ── the mark, and whose document this is ───────────────────────────────────────────────────────
  // A record extracted from the organogram is a company document; it wears the COMPANY's identity,
  // never Phoenix's — the app's brand belongs on the app's screens.
  assert.match(
    RESTRICTED_SHEET,
    /src="\/brand\/sato-pharma-logo-on-light\.svg"/,
    "The record must carry the Sato Pharma mark — the ON-LIGHT file, whose SATO wordmark is not white.",
  );
  assert.doesNotMatch(RESTRICTED_SHEET, /phoenix/i, "No Phoenix branding may appear on a company document.");
  assert.match(RESTRICTED_SHEET, /SATO-DIS-2026-01 v1\.0/, "The sheet states the standard it is drawn to.");

  // ── the premium dress (owner, 2026-10-13: "change to the premium look") ────────────────────────
  // The whole-sheet no-Phoenix check above now covers the chrome too, because the chrome is part of
  // the sheet; it is kept as it was and pinned separately below so that a chrome that DOES name the
  // app fails here by name, not as an unrelated word match. The foot says Sato Pharma alone — a
  // company record's own rule — which is `PREMIUM_COMPANY_DOCUMENT_BRAND`, never "phoenix".
  const chromeAt = RESTRICTED_SHEET.indexOf('<div class="pm-chrome"');
  assert.ok(chromeAt > -1, "The record wears the premium identity: the frame, watermark and running foot are on the sheet.");
  const chrome = RESTRICTED_SHEET.slice(chromeAt);
  assert.match(
    chrome,
    /<\/div>\s*<\/article>\s*$/,
    "The chrome is the LAST child of the sheet, so it can shift no cell and no heading.",
  );
  assert.doesNotMatch(chrome, /<(?:section|footer|header|table)\b/, "Nothing of the record's own lives inside the chrome.");
  assert.doesNotMatch(chrome, /phoenix/i, "The chrome names Sato Pharma alone — no Phoenix emblem, no Phoenix wording.");
  assert.match(chrome, /<div class="pm-foot__ph"><\/div>/, "The foot's left slot is empty: it carries no app brand.");
  assert.ok(
    chrome.includes("SATO PHARMA L.L.C. · HUMAN RESOURCES · HEAD OFFICE")
      && !chrome.includes("PHOENIX WORKFORCE"),
    "The frame's microtext is the Sato phrase, without the app's name.",
  );
  assert.ok(
    chrome.includes("Sato Pharma · Human Resources · SATO-DIS-2026-01 v1.0"),
    "The running foot carries the identity code, as every premium paper's does.",
  );
  assert.ok(
    chrome.includes('src="/brand/sato-pharma-arabic-on-light.png"')
      && !RESTRICTED_SHEET.slice(0, chromeAt).includes("sato-pharma-arabic"),
    "The Arabic Sato logo is the watermark in the chrome and appears nowhere else — never in the masthead.",
  );
  assert.doesNotMatch(RESTRICTED_SHEET, /sato-hr-seal/, "No company seal on a record: a computer-generated extract needs no stamp.");
  assert.equal(
    (RESTRICTED_SHEET.match(/<header class="pm-mast pm-mast--compact">/g) ?? []).length,
    1,
    "The masthead is the premium compact one — a fully populated record must not gain a page.",
  );
  assert.doesNotMatch(RESTRICTED_SHEET, /class="lh"|lh__rule/, "The old house letterhead is gone from the sheet.");

  // ── bilingual, two lines, never one mixed line ─────────────────────────────────────────────────
  assert.match(
    RESTRICTED_SHEET,
    /<h1 class="pm-mast__t pm-mast__t--en" dir="ltr" lang="en">Employee Record<\/h1>/,
    "English leads on an English-facing paper.",
  );
  assert.match(
    RESTRICTED_SHEET,
    /<p class="pm-mast__tar" dir="rtl" lang="ar">بيانات الموظف<\/p>/,
    "…and the paper's Arabic name sits under it, on its own line with its own direction.",
  );
  // The subtitle names the job title and area, and states LTR so a trailing area name is not painted
  // at the wrong end of the run.
  assert.match(
    RESTRICTED_SHEET,
    /<p class="pm-mast__s" dir="ltr" lang="en">Medical Representative · Cairo 1<\/p>/,
    "The subtitle carries the person's job title and area.",
  );
  assert.match(
    RESTRICTED_SHEET,
    /<p class="lh__purpose" dir="ltr">Confidential · HR record<\/p>/,
    "…and the purpose band still says what kind of record this is.",
  );

  // ── the person, named once ─────────────────────────────────────────────────────────────────────
  assert.match(RESTRICTED_SHEET, /Ahmed Specimen Mohamed/, "The employee is named.");
  assert.match(RESTRICTED_SHEET, /class="rec__id-code">a-000</, "…and carries their HR id.");

  // ── the permission seam: a restricted detail leaks no money, ever ──────────────────────────────
  // This is the whole safety claim of the feature. A line manager's PDF is built from a detail with
  // no Compensation section; if a single salary figure or the section heading appeared, the download
  // would be revealing what the popup itself withholds.
  assert.doesNotMatch(RESTRICTED_SHEET, /Compensation/, "A restricted record has no Compensation section.");
  assert.doesNotMatch(RESTRICTED_SHEET, /Personal/, "…nor a Personal section.");
  assert.doesNotMatch(RESTRICTED_SHEET, /EGP/, "…and no money figure anywhere in it.");
  assert.doesNotMatch(RESTRICTED_SHEET, /National ID/, "…and no personal identifier.");

  // ── …and a sensitive detail renders exactly what it was handed ─────────────────────────────────
  assert.match(SENSITIVE_SHEET, /Compensation/, "An HR/finance viewer's record shows the Compensation section.");
  assert.match(SENSITIVE_SHEET, /Personal/, "…and the Personal section.");
  for (const figure of ["EGP 9,001", "EGP 11,204", "CIB", "29003010100011"]) {
    assert.ok(SENSITIVE_SHEET.includes(figure), `The sensitive record must print "${figure}".`);
  }

  // ── empty sections and empty cells are dropped, not printed as "—" ─────────────────────────────
  // The popup's SectionGrid skips a section with nothing populated; the document does the same, so a
  // person with a blank field does not get a wall of dashes on paper.
  assert.doesNotMatch(RESTRICTED_SHEET, /Nothing populated/, "A fully-empty section is dropped, not headed.");
  assert.doesNotMatch(RESTRICTED_SHEET, /—/, "An empty cell is dropped; no em dash is printed on paper.");
  // "Position" was null in the Identity section, whose other cells are populated — so the section
  // prints, but that one cell does not.
  assert.ok(RESTRICTED_SHEET.includes("Job title"), "A populated Identity cell prints…");
  assert.doesNotMatch(RESTRICTED_SHEET, />Position</, "…while the null Position cell in the same section does not.");

  // ── the square-edge rule (owner, 2026-09-04) ───────────────────────────────────────────────────
  // Measured on the stylesheet that ships: a 4 px radius inherited from `tokens.css` is invisible in
  // a screenshot and survives review.
  const radii = ORGANOGRAM_RECORD_CSS.match(/border-radius:\s*([^;]+);/g) ?? [];
  assert.ok(radii.length > 0, "The reset that pins square edges must be present.");
  for (const rule of radii) {
    assert.match(
      rule,
      /border-radius:\s*0\s*!important;/,
      `Every border-radius in the record must be a square-edge reset — found ${rule}`,
    );
  }

  // ── the ink rule ───────────────────────────────────────────────────────────────────────────────
  // Colour is carried by LINES AND TYPE. A record is label/value cells, not a money table, so it
  // carries NO zebra — the only painted areas admissible are the on-screen ground and the
  // engine-turned band, which is line, not fill. Any other painted background fails here.
  const backgrounds = (ORGANOGRAM_RECORD_CSS.match(/background:\s*([^;]+);/g) ?? [])
    .map((rule) => rule.replace(/background:\s*/, "").replace(/;$/, "").trim())
    .filter((value) => value !== "#fff" && value !== "#ffffff" && value !== "none" && value !== "transparent");
  const allowed = new Set(["#eef2f6"]);
  for (const value of backgrounds) {
    const inlineSvg = value.match(/url\(data:image\/svg\+xml,([^)]*)\)/);
    if (inlineSvg) {
      const svg = decodeURIComponent(inlineSvg[1]);
      assert.ok(
        svg.includes('fill="none"'),
        `A background image here must be drawn in line only — "${value.slice(0, 70)}…" declares no fill="none".`,
      );
      assert.ok(
        !/fill="(?!none)[^"]*"/.test(svg),
        `The ink rule forbids a filled shape, including inside a background image — found one in "${value.slice(0, 70)}…".`,
      );
      continue;
    }
    assert.ok(
      allowed.has(value),
      `The ink rule allows the on-screen ground and the engine-turned band only — found "${value}".`,
    );
  }

  // ── the ellipsis ban (owner rule) ──────────────────────────────────────────────────────────────
  assert.doesNotMatch(ORGANOGRAM_RECORD_CSS, /text-overflow/, "Text is never truncated with an ellipsis.");
  assert.doesNotMatch(SENSITIVE_SHEET, /…/, "No ellipsis character may reach the page.");
  assert.match(
    ORGANOGRAM_RECORD_CSS,
    /overflow-wrap:\s*anywhere/,
    "Long values wrap instead — wrapping is the permitted answer, cutting is not.",
  );

  // ── the fits-the-screen rule ───────────────────────────────────────────────────────────────────
  assert.doesNotMatch(ORGANOGRAM_RECORD_CSS, /overflow-x:\s*auto/, "No horizontal scroll container.");
  assert.match(
    ORGANOGRAM_RECORD_CSS,
    /@media screen and \(max-width: 800px\)[\s\S]*?\.rec__cell \{ flex-basis: 100%/,
    "The sheet must reflow to one column on a phone rather than scroll sideways.",
  );

  // THE FRAME AND THE FOOT ARE ONE SET PER PRINTED PAGE. In print they are `position: fixed`, which
  // Chrome repeats on every printed page, so a record that runs to a second page (a fully populated
  // HR/finance one does) carries the frame and the running foot on both without a second copy.
  assert.match(
    ORGANOGRAM_RECORD_CSS,
    /\.pm-chrome \.pm-frame \{ position: fixed; top: 0; left: 0; \}/,
    "In print the frame is fixed to the page, so every printed page has one.",
  );
  // The sheet's own page inset is the premium identity's: a padding of the record's own on the sheet
  // would fight it, so the only `.rec` padding left is the phone's.
  // Read from the record's OWN rules, with the house and premium sheets taken out: the premium
  // stylesheet declares the inset itself, on the very selector this checks.
  const ownCss = ORGANOGRAM_RECORD_CSS.replace(HOUSE_IDENTITY_CSS, "").replace(premiumDocumentStylesheet(".rec"), "");
  const sheetRule = /\n\.rec \{([^}]*)\}/.exec(ownCss);
  assert.ok(sheetRule, "The sheet's own rule must be found.");
  assert.doesNotMatch(sheetRule[1], /padding/, "The page inset is the premium identity's — a padding here would silently fight it.");
  // A sheet is a whole 297 mm on a wide screen so its frame and foot sit on it; on paper that same
  // min-height is how a blank page is born, so it is screen-only. On a phone the chrome is hidden.
  assert.equal(
    (ORGANOGRAM_RECORD_CSS.match(/min-height: 297mm/g) ?? []).length,
    1,
    "One min-height of a whole sheet, and only the one on screen.",
  );
  assert.match(
    ORGANOGRAM_RECORD_CSS,
    /@media screen and \(min-width: 801px\) \{\s*\.rec \{ min-height: 297mm; \}\s*\}/,
    "The whole-sheet height is scoped to a screen wide enough to show the sheet.",
  );
  assert.match(
    ORGANOGRAM_RECORD_CSS,
    /@media screen and \(max-width: 800px\)[\s\S]*?\.rec \.pm-chrome \{ display: none; \}/,
    "On a phone the 210 mm frame is hidden — it must not push the page sideways.",
  );

  // ── the saved file's name (the payslip's format, applied to a record) ──────────────────────────
  // "<Employee Name> - employee record.pdf". It leads with the PERSON, and the person is a NAME.
  assert.equal(
    organogramRecordFileName({ fullName: "Ahmed Specimen Mohamed", displayName: "Ahmed Mohamed", hrId: "a-000" }),
    "Ahmed Specimen Mohamed - employee record.pdf",
    "Name first, then what the file is.",
  );
  // Spaces, digits, apostrophes and hyphens are part of real names and survive; only the
  // filesystem-illegal set is removed.
  assert.equal(
    organogramRecordFileName({ fullName: "Sara O'Brien Al-Sayed 2", displayName: "", hrId: "" }),
    "Sara O'Brien Al-Sayed 2 - employee record.pdf",
    "Apostrophes, hyphens and digits belong to the name, not to the illegal set.",
  );
  assert.equal(
    organogramRecordFileName({ fullName: 'a/b:c*d?e"f<g>h|i', displayName: "", hrId: "" }),
    "a b c d e f g h i - employee record.pdf",
    "The Windows-illegal set becomes spaces; the name is not otherwise mangled.",
  );
  // The fallback chain — display name, then HR id, then the bare word.
  assert.equal(
    organogramRecordFileName({ fullName: "", displayName: "", hrId: "A-137" }),
    "A-137 - employee record.pdf",
    "With no name, the HR id stands in.",
  );
  assert.equal(
    organogramRecordFileName({ fullName: "", displayName: "", hrId: "" }),
    "Employee - employee record.pdf",
    "With nothing at all, the download still gets a name.",
  );

  // ── the header that actually ships ─────────────────────────────────────────────────────────────
  const disposition = organogramRecordContentDisposition({
    fullName: "Ahmed Specimen Mohamed",
    displayName: "Ahmed Mohamed",
    hrId: "a-000",
  });
  assert.equal(
    disposition,
    `attachment; filename="Ahmed Specimen Mohamed - employee record.pdf"; `
      + `filename*=UTF-8''${encodeURIComponent("Ahmed Specimen Mohamed - employee record.pdf")}`,
    "Both RFC 6266 forms, in order.",
  );
  // A name is USER DATA on its way into a protocol header; no control character or stray quote may
  // reach it.
  const hostile = organogramRecordContentDisposition({
    fullName: 'Ahmed" \r\nX-Injected: yes',
    displayName: "",
    hrId: "",
  });
  assert.doesNotMatch(hostile, /[\r\n]/, "No control character may reach the header.");
  assert.equal(
    (hostile.match(/"/g) ?? []).length,
    2,
    "Exactly the two quotes that delimit the fallback — a name cannot add a third.",
  );
  // An Arabic-only name survives in the UTF-8 form even though the ASCII fallback falls through to
  // the HR id, which is the entire reason both forms are sent.
  const arabic = organogramRecordContentDisposition({ fullName: "محمد عبد الله", displayName: "", hrId: "A-9" });
  assert.match(
    arabic,
    /filename="A-9 - employee record\.pdf"/,
    "The ASCII fallback falls THROUGH to the HR id rather than to a file that opens with a dash.",
  );
  assert.equal(
    decodeURIComponent(arabic.split("filename*=UTF-8''")[1]),
    "محمد عبد الله - employee record.pdf",
    "…while the UTF-8 form carries the real name intact.",
  );

  // ── the document as a whole ────────────────────────────────────────────────────────────────────
  assert.match(DOCUMENT, /^<!doctype html>/, "A whole document, servable as-is.");
  assert.match(DOCUMENT, /<html lang="en">/, "…declared English, which is what it is written in.");
  assert.match(DOCUMENT, /@page \{ size: A4; margin: 0; \}/, "A4, with the sheet holding its own margins.");
  assert.ok(DOCUMENT.includes(ORGANOGRAM_RECORD_CSS), "The page ships the stylesheet this test measured.");

  // ── the house letterhead stayed additive ───────────────────────────────────────────────────────
  // This document uses the bilingual English-facing mode of `houseLetterhead`. An Arabic-only caller
  // must still emit exactly what it always did — the same guarantee the payslip test pins, re-checked
  // here so a change made for the record cannot move the contract or the clearances.
  const arabicOnly = houseLetterhead({
    legalNameAr: "شركة ساتو فارما",
    legalNameEn: "Sato Pharma",
    purposeAr: "نسخة العامل",
    subtitleAr: "طبقاً لأحكام قانون العمل",
    titleAr: "عقد عمل",
  });
  assert.match(arabicOnly, /<h1>عقد عمل<\/h1>/, "An Arabic-only paper keeps the Arabic in the h1…");
  assert.doesNotMatch(arabicOnly, /lh__ar/, "…with no English-mode element emitted at all.");
}
