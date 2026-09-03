import { strict as assert } from "node:assert";

import { arabicDepartmentName } from "../src/lib/hiring-pack/department-names.ts";
import {
  INSURANCE_WAGE_CEILING,
  INSURANCE_WAGE_DIVISOR,
  insuranceWageFromBase,
} from "../src/lib/hiring-pack/insurance-wage.ts";
import {
  buildPaperEditPatch,
  PAPER_FIELD_BINDINGS,
  paperFieldBinding,
  paperFieldCurrentValue,
  parsePaperDate,
  parsePaperMoney,
  stripDirectionMarks,
  type PaperFieldBinding,
} from "../src/lib/hiring-pack/paper-fields.ts";
import {
  DEFAULT_ZOOM,
  fitZoomForWidth,
  MIN_FIT_ZOOM,
  PAGE_WIDTH_PX,
} from "../src/lib/hiring-pack/paper-zoom.ts";
import { renderClearanceEmployeeHtml } from "../src/lib/hiring-pack/render-clearance.ts";
import { renderContractHtml } from "../src/lib/hiring-pack/render-contract.ts";
import { renderCustodyLaptopHtml } from "../src/lib/hiring-pack/render-custody.ts";
import { renderForm1Html } from "../src/lib/hiring-pack/render-form1.ts";
import {
  collectHiringPackGaps,
  emptyOffboardingProfile,
  resolveContractTerms,
} from "../src/lib/hiring-pack/service.ts";
import type {
  HiringPackData,
  HiringPackEmployeeFacts,
  HiringPackProfile,
  OffboardingProfile,
} from "../src/lib/hiring-pack/types.ts";

/**
 * Editing a printed document on the page it prints as.
 *
 * The fill screen shows each of the nine documents as the page it will actually be, and lets the
 * values on it be corrected where they sit. Two mechanisms carry that: the renderers stamp every
 * value with `data-hp-key`, and `paper-fields.ts` says which of those keys may be written and where
 * each one goes. Both are invisible — a document with the attributes stripped still prints
 * perfectly, and a binding pointing at a column that does not exist still returns HTTP 200 — so
 * neither has any natural failure signal. That is what this file is for.
 *
 * Four things are pinned, each of which has a plausible edit that breaks it silently:
 *
 *   1. THE PAYLOAD IS ALWAYS THE WHOLE RECORD. All three save endpoints write with a hand-listed
 *      object literal, so a key absent from the body is written as NULL rather than left alone. A
 *      patch carrying only the edited field would therefore blank every other field on that record
 *      — a salary, a national ID, a hire date — with no error anywhere. This is the single most
 *      dangerous thing in the feature and the first test below is the guard on it.
 *
 *   2. EVERY BINDING NAMES A FIELD THE ENDPOINT ACTUALLY ACCEPTS. A typo in a binding's `field`
 *      produces a body with one extra key that the server quietly ignores, so the request succeeds,
 *      the screen reloads, and the value is simply unchanged — which is EXACTLY the complaint this
 *      whole feature was built to answer ("I edit and save and the print shows the old value").
 *
 *   3. THE ALLOW-LIST STAYS AN ALLOW-LIST. A value belonging to the company rather than to this
 *      employee, or one derived from another value, must not be writable from a page. Binding
 *      `COMPANY_NAME` would let one contract rename the legal entity on every document, and binding
 *      `SALARY_WORDS` would let the words disagree with the digits on an instrument where مادة (2)
 *      prints both and the words control.
 *
 *   4. THE RENDERERS STILL STAMP THE KEYS. Without the attribute nothing on the page is editable at
 *      all, and the screen degrades to a plain picture with no error and no visible difference until
 *      somebody tries to click a value.
 */

function employeeFixture(
  overrides: Partial<HiringPackEmployeeFacts> = {},
): HiringPackEmployeeFacts {
  return {
    hrId: "H-2001",
    fullName: "Omar Sample",
    nameAr: "عمر عينة",
    nationalId: "29001011200123",
    // Left unrecorded so the fixtures exercise the national-ID derivation rather than masking it.
    gender: null,
    socialInsuranceNumber: "123456789",
    socialInsuranceWage: 4500,
    baseSalary: 12750,
    grossSalary: 16000,
    birthDate: "1990-01-01",
    hireDate: "2026-03-01",
    jobTitle: "Medical Rep",
    // The department, not the line — this rep is in Sales and works the Pedia line.
    departmentAr: "المبيعات",
    departmentId: 1,
    lineId: 3,
    residenceAddress: "12 شارع النيل، المعادي",
    residenceCity: "القاهرة",
    mobileNumber: "01001234567",
    workEmail: "omar@satopharma.com",
    employmentStatus: "active",
    departed: false,
    lastWorkingDate: null,
    ...overrides,
  };
}

function profileFixture(overrides: Partial<HiringPackProfile> = {}): HiringPackProfile {
  return {
    hrId: "H-2001",
    nationality: "مصرية",
    qualification: "بكالوريوس صيدلة",
    birthPlace: "القاهرة",
    jobTitleAr: "مندوب دعاية طبية",
    occupationCode: "123456",
    insuranceOffice: "المعادي",
    addressBuilding: "12",
    addressDistrict: "01",
    addressStreet: "شارع النيل",
    addressMarkaz: "02",
    addressGovernorate: "01",
    contractDurationMonths: null,
    contractStartDate: "2026-03-01",
    contractEndDate: null,
    underperformanceThresholdPct: null,
    underperformanceMonths: null,
    trainingBondMonths: null,
    notes: "internal only",
    contractSignedDate: null,
    form1SignedDate: null,
    contractPrintedAt: null,
    form1PrintedAt: null,
    contractTemplateVersion: null,
    updatedAt: null,
    ...overrides,
  };
}

function packFixture(
  employeeOverrides: Partial<HiringPackEmployeeFacts> = {},
  profileOverrides: Partial<HiringPackProfile> = {},
  offboardingOverrides: Partial<OffboardingProfile> = {},
): HiringPackData {
  const employee = employeeFixture(employeeOverrides);
  const profile = profileFixture(profileOverrides);
  const offboarding = { ...emptyOffboardingProfile("H-2001"), ...offboardingOverrides };
  return {
    employee,
    profile,
    offboarding,
    exit: null,
    suggestedJobTitleAr: null,
    gaps: collectHiringPackGaps(employee, profile, offboarding, null),
    terms: resolveContractTerms(employee, profile, offboarding, null),
  };
}

/** A value of the right SHAPE for a binding, so every binding can be exercised the same way. */
function sampleFor(binding: PaperFieldBinding): string {
  if (binding.kind === "money") return "9999";
  if (binding.kind === "date") return "2026-08-24";
  if (binding.kind === "dateDay") return "05";
  if (binding.kind === "dateMonth") return "07";
  if (binding.kind === "dateYear") return "2027";
  return "قيمة";
}

export function runHiringPackPaperEditorTests() {
  // ── 1. The whole record, every time ───────────────────────────────────────────────────────────
  //
  // Editing the Arabic name must not blank the salary, the national ID, or anything else the same
  // endpoint writes. If this ever fails, the feature is silently destroying employee records.
  {
    const pack = packFixture();
    const binding = paperFieldBinding("EMPLOYEE_NAME");
    assert.ok(binding, "EMPLOYEE_NAME must be bound — it is on every document in the pack");

    const patch = buildPaperEditPatch(pack, binding, "اسم جديد");
    assert.ok(patch.ok, "a plain name edit must be accepted");
    assert.equal(patch.store, "employee");
    assert.equal(patch.body.nameAr, "اسم جديد");

    // Everything else on that record travels with it, unchanged.
    assert.equal(patch.body.baseSalary, 12750, "the salary must survive a name edit");
    assert.equal(patch.body.nationalId, "29001011200123");
    assert.equal(patch.body.socialInsuranceNumber, "123456789");
    assert.equal(patch.body.birthDate, "1990-01-01");
    assert.equal(patch.body.hireDate, "2026-03-01");
    assert.equal(patch.body.fullName, "Omar Sample");
    assert.equal(patch.body.mobileNumber, "01001234567");
    assert.equal(patch.body.workEmail, "omar@satopharma.com");
    assert.equal(patch.body.residenceAddress, "12 شارع النيل، المعادي");
    assert.equal(patch.body.lineId, 3);
    assert.equal(patch.body.jobTitle, "Medical Rep");
  }

  // The same, on the hiring profile: editing the job title must not wipe the address codes.
  {
    const pack = packFixture();
    const binding = paperFieldBinding("JOB_TITLE");
    assert.ok(binding);
    const patch = buildPaperEditPatch(pack, binding, "مدير منطقة");
    assert.ok(patch.ok);
    assert.equal(patch.store, "profile");
    assert.equal(patch.body.jobTitleAr, "مدير منطقة");
    assert.equal(patch.body.addressBuilding, "12");
    assert.equal(patch.body.addressDistrict, "01");
    assert.equal(patch.body.addressMarkaz, "02");
    assert.equal(patch.body.addressGovernorate, "01");
    assert.equal(patch.body.addressStreet, "شارع النيل");
    assert.equal(patch.body.occupationCode, "123456");
    assert.equal(patch.body.insuranceOffice, "المعادي");
    assert.equal(patch.body.nationality, "مصرية");
    assert.equal(patch.body.notes, "internal only", "the internal note is not a form field, and must not be dropped by an edit made on the paper");
  }

  // And on the leaving side.
  {
    const pack = packFixture({}, {}, {
      addresseeNameAr: "أ. محمد",
      endReasonAr: "ظروف خاصة",
      exitRoute: "resignation",
      lastWorkingDate: "2026-09-30",
    });
    const binding = paperFieldBinding("endReason");
    assert.ok(binding);
    const patch = buildPaperEditPatch(pack, binding, "دواعي السفر");
    assert.ok(patch.ok);
    assert.equal(patch.store, "offboarding");
    assert.equal(patch.body.endReasonAr, "دواعي السفر");
    assert.equal(patch.body.lastWorkingDate, "2026-09-30", "the last working day must survive");
    assert.equal(patch.body.exitRoute, "resignation", "the route decides which template prints");
    assert.equal(patch.body.addresseeNameAr, "أ. محمد");
  }

  // ── 2. Every binding names a field its endpoint accepts ───────────────────────────────────────
  //
  // A misspelt `field` yields a body with a key nobody reads: the request succeeds and the value
  // never changes.
  {
    const pack = packFixture(
      {},
      { contractStartDate: "2026-03-01" },
      { agreementDate: "2026-09-15", lastWorkingDate: "2026-09-30" },
    );

    for (const [key, binding] of Object.entries(PAPER_FIELD_BINDINGS)) {
      const patch = buildPaperEditPatch(pack, binding, sampleFor(binding));
      assert.ok(patch.ok, `${key} rejected its own sample value: ${patch.ok ? "" : patch.message}`);
      assert.equal(patch.store, binding.store, `${key} saved to the wrong store`);

      // Read the payload WITHOUT this binding's own override sitting on top of it.
      //
      // The patch is `{ ...payload, [field]: value }`, so the edited key is spread in whether or not
      // the payload ever carried it — asking the finished patch whether it has the field is asking a
      // question whose answer is yes for a real name and an invented one alike. This test WAS
      // written that way, passed, and proved nothing; it only showed up when the guard was
      // deliberately broken and the assertion did not fire. Sending the same store through a
      // sentinel field instead yields the untouched payload, and a name the endpoint does not accept
      // is then simply missing from it.
      const probe = buildPaperEditPatch(
        pack,
        { ...binding, field: "__unbound_probe__", kind: "text" },
        "",
      );
      assert.ok(probe.ok);
      assert.ok(
        Object.prototype.hasOwnProperty.call(probe.body, binding.field),
        `${key} binds to "${binding.field}", which the ${binding.store} payload does not carry — the save would be accepted, return 200, and change nothing`,
      );
    }
  }

  // ── 3. The allow-list stays an allow-list ────────────────────────────────────────────────────
  //
  // Each of these prints on a document and none of them may be typed over there. The company ones
  // belong to the legal entity and are shared by every employee; the derived ones must keep
  // agreeing with the value they are computed from.
  for (const key of [
    "COMPANY_NAME",
    "COMPANY_LEGAL_FORM",
    "COMPANY_HEAD_OFFICE",
    "COMPANY_HEAD_OFFICE_FULL",
    "COMMERCIAL_REGISTER",
    "UNIFIED_REGISTER",
    "TAX_CARD",
    "CONTRACT_SIGNATORY",
    "RESPONSIBLE_MANAGER",
    "SALARY_WORDS",
    "DURATION",
    "DEPARTMENT",
    "HR_ID",
    "ISSUE_DATE",
    "taxRegPart1",
    "taxRegPart2",
    "taxRegPart3",
    "establishmentNumber",
    "sectorCode",
    "companyName",
    "writtenDay",
    "writtenMonth",
    "writtenYear",
  ]) {
    assert.equal(
      paperFieldBinding(key),
      null,
      `${key} must NOT be editable on the page — it is the company's own value or is derived from another`,
    );
  }

  // ── 4. Dates, money, and the invisible direction marks ───────────────────────────────────────
  {
    // What the documents actually print — dd / mm / yyyy, the order a date is written by hand here.
    assert.equal(parsePaperDate("24 / 08 / 2026"), "2026-08-24");
    assert.equal(parsePaperDate("24/08/2026"), "2026-08-24");
    assert.equal(parsePaperDate("4-8-2026"), "2026-08-04");
    assert.equal(parsePaperDate("2026-08-24"), "2026-08-24");

    // A date that does not exist is refused rather than rolled forward into March, which is what
    // `new Date(2026, 1, 31)` would silently do.
    assert.equal(parsePaperDate("31 / 02 / 2026"), null);
    assert.equal(parsePaperDate("2026-13-01"), null);
    assert.equal(parsePaperDate("not a date"), null);
    assert.equal(parsePaperDate(""), null);

    assert.equal(parsePaperMoney("12,750"), 12750);
    assert.equal(parsePaperMoney("12750.50"), 12750.5);
    assert.equal(parsePaperMoney("abc"), null);
    assert.equal(parsePaperMoney("-5"), null, "a negative salary is not a salary");

    // `pinLtr` wraps Latin runs in U+2066/U+2069 so Arabic prose does not reorder them. Those
    // characters are part of the rendered text, so they come back with anything read out of the
    // page — and a value stored with them welded on would never compare equal to what was typed.
    assert.equal(stripDirectionMarks("⁦477-108-318⁩"), "477-108-318");
    assert.equal(stripDirectionMarks("عادي"), "عادي");
  }

  // A rejected value is reported, never guessed at.
  {
    const pack = packFixture();
    const binding = paperFieldBinding("BIRTH_DATE");
    assert.ok(binding);
    const patch = buildPaperEditPatch(pack, binding, "sometime in 1990");
    assert.equal(patch.ok, false);
    if (!patch.ok) assert.match(patch.message, /not a date/i);
  }

  // ── 5. One component of a date, patched into the other two ───────────────────────────────────
  //
  // Form 1 prints the start date as three separate box grids. Correcting the day must keep the
  // month and the year that are printed beside it.
  {
    const pack = packFixture({}, { contractStartDate: "2026-03-01" });
    const day = paperFieldBinding("startDay");
    assert.ok(day);
    const patched = buildPaperEditPatch(pack, day, "15");
    assert.ok(patched.ok);
    assert.equal(patched.body.contractStartDate, "2026-03-15");

    const month = paperFieldBinding("startMonth");
    assert.ok(month);
    const monthPatched = buildPaperEditPatch(pack, month, "11");
    assert.ok(monthPatched.ok);
    assert.equal(monthPatched.body.contractStartDate, "2026-11-01");

    // A component that cannot make a real date with the other two is refused, not rounded.
    const bad = buildPaperEditPatch(pack, day, "99");
    assert.equal(bad.ok, false);
  }

  // With nothing pinned, the printed start date falls back to the hire date — so that is what a
  // component edit has to be measured against, or correcting the day would silently move the year.
  {
    const pack = packFixture({ hireDate: "2026-06-10" }, { contractStartDate: null });
    assert.equal(pack.terms.contractStartDate, "2026-06-10");
    const day = paperFieldBinding("startDay");
    assert.ok(day);
    const patched = buildPaperEditPatch(pack, day, "22");
    assert.ok(patched.ok);
    assert.equal(
      patched.body.contractStartDate,
      "2026-06-22",
      "editing the printed day must build on the date the page actually shows",
    );
  }

  // Clearing a value is a real edit, and stores nothing rather than the empty string.
  {
    const pack = packFixture();
    const binding = paperFieldBinding("BIRTH_PLACE");
    assert.ok(binding);
    const patch = buildPaperEditPatch(pack, binding, "   ");
    assert.ok(patch.ok);
    assert.equal(patch.body.birthPlace, null);
  }

  // What the editor shows when a boxed value is clicked is the STORED form, ready to be retyped —
  // not the formatted run of digits sitting in the printed cells.
  {
    const pack = packFixture();
    const salary = paperFieldBinding("SALARY_FIGURES");
    assert.ok(salary);
    assert.equal(paperFieldCurrentValue(pack, salary), "12750");

    // The insurance wage is NOT among them: it is derived from the base salary, so it renders
    // read-only. A binding here would take a typed figure, save nothing, and redraw the computed
    // value over it — the exact "I edited it and the old number still prints" complaint.
    assert.equal(
      paperFieldBinding("INSURANCE_WAGE"),
      null,
      "a derived value must not be bound for editing",
    );

    const startDay = paperFieldBinding("startDay");
    assert.ok(startDay);
    assert.equal(paperFieldCurrentValue(pack, startDay), "01");
  }

  // ── 6. The renderers still stamp the keys ────────────────────────────────────────────────────
  //
  // Nothing on the page is editable without these, and their absence is invisible: the document
  // renders and prints exactly as before.
  {
    const pack = packFixture();

    const contract = renderContractHtml(pack, 1);
    assert.ok(
      contract.includes('data-hp-key="EMPLOYEE_NAME"'),
      "the contract must mark the employee name so it can be corrected on the page",
    );
    assert.ok(contract.includes('data-hp-key="SALARY_FIGURES"'));
    assert.ok(contract.includes('data-hp-key="JOB_TITLE"'));

    const form1 = renderForm1Html(pack, 1);
    assert.ok(form1.includes('data-hp-key="nationalId"'));
    assert.ok(form1.includes('data-hp-key="insuredName"'));
    assert.ok(form1.includes('data-hp-key="jobTitleAr"'));

    const custody = renderCustodyLaptopHtml(pack, 1);
    assert.ok(custody.includes('data-hp-key="EMPLOYEE_NAME"'));

    const clearance = renderClearanceEmployeeHtml(pack, 1);
    assert.ok(clearance.includes('data-hp-key="NATIONAL_ID"'));

    // A BLANK value keeps its key on the custody and clearance instruments, which is what lets an
    // empty dotted rule be filled in from the page rather than hunted for in a box above.
    const noAddress = packFixture({ residenceAddress: null }, { addressStreet: null });
    const blankCustody = renderCustodyLaptopHtml(noAddress, 1);
    assert.ok(
      blankCustody.includes('data-hp-key="ADDRESS"'),
      "an empty rule must still carry its key — filling a blank in place is the point",
    );
  }

  // The attributes are inert: they add no visible text to any document.
  {
    const pack = packFixture();
    const contract = renderContractHtml(pack, 1);
    assert.ok(
      !contract.includes("data-hp-key=\"\""),
      "an empty key would mark a value as bindable to nothing",
    );
  }

  // ── 7. The page opens at a zoom that fits the panel ───────────────────────────────────────────
  //
  // Pinned here because it cannot be pinned in a browser. The fit runs from a ResizeObserver, and
  // ResizeObserver delivers its callbacks on the rendering lifecycle — so with the preview pane
  // hidden it never fires once, not even the guaranteed first call, while `clientWidth` keeps
  // answering correctly. Measured 2026-08-31: a control observer on an element resized by hand
  // logged zero callbacks, `requestAnimationFrame` never ran, and `document.visibilityState` was
  // "hidden". A feature that works reads identically to one that is dead. The arithmetic is the
  // half that can actually be wrong, so the arithmetic is what gets a test.
  {
    // Roomy panel: the page keeps the default rather than being blown up to fill the space. A
    // preview magnified past its printed size has stopped previewing the printed size.
    assert.equal(fitZoomForWidth(1400), DEFAULT_ZOOM);
    assert.equal(fitZoomForWidth(PAGE_WIDTH_PX * DEFAULT_ZOOM), DEFAULT_ZOOM);

    // Exactly one pixel short of the default's own width is the first case that must shrink.
    assert.ok(
      fitZoomForWidth(PAGE_WIDTH_PX * DEFAULT_ZOOM - 1) < DEFAULT_ZOOM,
      "a panel narrower than the page at 85% must shrink the page, not clip it",
    );

    // The measured phone case: 375px viewport, 273px panel, 16px of padding a side.
    //
    // This one does NOT fit, and that is the rule rather than a shortfall in it. Fitting 900px of
    // paper into 241px of room means 27%, at which the body text of a contract is under three
    // pixels tall — a page nobody can read, whole. The floor stops there and the panel keeps a
    // short scroll. What the fit is worth is still most of the distance: 765px of page hidden
    // behind a 273px panel becomes 288px, so the operator sees the sheet and scrolls fifteen
    // pixels, rather than seeing a fifth of it and having no reason to think there is more.
    const phone = fitZoomForWidth(273 - 32);
    assert.equal(phone, MIN_FIT_ZOOM, "a phone-width panel sits on the floor");
    assert.ok(
      phone * PAGE_WIDTH_PX < 273 * 1.1,
      `the fitted page must be within a sliver of the 273px panel, got ${Math.round(phone * PAGE_WIDTH_PX)}px`,
    );
    assert.ok(
      phone * PAGE_WIDTH_PX < PAGE_WIDTH_PX * DEFAULT_ZOOM * 0.5,
      "fitting must hide far less of the page than the unfitted default did",
    );

    // The floor holds all the way down, so a very narrow panel keeps a legible page and its
    // scrollbar instead of shrinking the paper into an unreadable strip.
    assert.equal(fitZoomForWidth(40), MIN_FIT_ZOOM);
    assert.equal(fitZoomForWidth(1), MIN_FIT_ZOOM);

    // A width measured mid-layout must not scale the page to nothing.
    assert.equal(fitZoomForWidth(0), DEFAULT_ZOOM);
    assert.equal(fitZoomForWidth(-50), DEFAULT_ZOOM);
    assert.equal(fitZoomForWidth(Number.NaN), DEFAULT_ZOOM);

    // Between the floor and the default it is a true fit: the page is exactly as wide as the room.
    const mid = fitZoomForWidth(600);
    assert.ok(
      Math.abs(mid * PAGE_WIDTH_PX - 600) <= PAGE_WIDTH_PX * 0.001,
      `600px of panel must render a 600px-wide page, got ${(mid * PAGE_WIDTH_PX).toFixed(1)}px`,
    );

    // The box the page is drawn into stays wider than the widest sheet any of the nine documents
    // print on — US Legal at 816px and A4 at 794px, both at 96dpi. Narrower and the iframe's own
    // viewport reflows the document, which is the defect this panel exists to disprove. That is not
    // hypothetical: the base stylesheet's `max-width: 100%` did exactly this until 2026-08-31,
    // squeezing an A4 copy to 717px inside a frame declared at 900.
    assert.ok(
      PAGE_WIDTH_PX > 816,
      "the frame must be wider than US Legal, or the page reflows inside its own preview",
    );
  }

  // ── 8. The four corrections of 2026-08-31 ───────────────────────────────────────────────────
  //
  // Four values were printing wrong, each on a document somebody signs. They are pinned together
  // because they were reported together and because three of them are the same class of mistake:
  // the pack printed a NEIGHBOURING fact rather than the one the box asks for.
  {
    // (a) The insurance wage is the base salary divided by 1.3, stopping at the legal ceiling.
    assert.equal(INSURANCE_WAGE_DIVISOR, 1.3);
    assert.equal(insuranceWageFromBase(13_000), 10_000, "13,000 ÷ 1.3 is exactly 10,000");
    assert.equal(insuranceWageFromBase(11_000), 8_462, "rounded to whole pounds, not 8,461.54");

    // DIVIDE, not multiply. The owner was asked directly and confirmed it against a real record;
    // multiplying gives a wage ABOVE the base, which is the opposite instrument.
    assert.ok(
      insuranceWageFromBase(11_000)! < 11_000,
      "the insurance wage sits below the base salary — dividing, never multiplying",
    );

    // The ceiling binds. A base of 90,000 exists in production; uncapped it would declare 69,231.
    assert.equal(insuranceWageFromBase(90_000), INSURANCE_WAGE_CEILING);
    assert.equal(insuranceWageFromBase(INSURANCE_WAGE_CEILING * 1.3), INSURANCE_WAGE_CEILING);

    // No base, no invented figure — the paper prints its dotted rule instead.
    assert.equal(insuranceWageFromBase(null), null);
    assert.equal(insuranceWageFromBase(0), null);
    assert.equal(insuranceWageFromBase(Number.NaN), null);

    // (b) The contract prints the BASE salary, and the gross must not appear on it at all.
    const pack = packFixture();
    assert.equal(pack.employee.baseSalary, 12_750);
    assert.equal(pack.employee.grossSalary, 16_000, "the fixture must differ, or this proves nothing");
    const contract = renderContractHtml(pack, 1);
    assert.ok(contract.includes("12,750"), "the contract must print the base salary");
    assert.ok(!contract.includes("16,000"), "the gross salary must not reach the contract");

    // ...and the insurance wage on the CONTRACT is now a reference to the law, not a figure. The
    // owner's 2026-08-30 contract (v3) sets it "وفقًا لأحكام قانون التأمينات الاجتماعية" and prints
    // no number — the numeric wage moved to Form 1, the insurance declaration itself (asserted just
    // below). Two things must still hold: the clause must ADDRESS the insurance wage (so a dropped
    // salary clause is caught), and the stored column must NEVER leak onto the paper.
    assert.equal(pack.employee.socialInsuranceWage, 4_500);
    assert.ok(
      contract.includes("قانون التأمينات الاجتماعية"),
      "the contract must set the insurance wage by reference to the Social Insurance Law",
    );
    assert.ok(
      !contract.includes("4,500"),
      "the stored social_insurance_wage column must never reach the contract",
    );
    assert.ok(
      !contract.includes("9,808"),
      "the numeric insurance wage belongs on Form 1, not the contract (owner's v3)",
    );

    // Form 1 is the insurance declaration itself, so it — not the contract — carries the numeric
    // wage. 9,808 (12,750 ÷ 1.3, rounded) reaches it one digit per box, so assert on the digits.
    const form1 = renderForm1Html(pack, 1);
    for (const digit of ["9", "8", "0"]) {
      assert.ok(form1.includes(`>${digit}<`), `Form 1 must carry the digit ${digit} of the wage`);
    }

    // (c) The job title is Arabic or it is blank. Never the English title off the employee record.
    const noArabicTitle = packFixture({}, { jobTitleAr: null });
    assert.equal(noArabicTitle.employee.jobTitle, "Medical Rep", "the English title is still on the record");
    for (const [name, html] of [
      ["the contract", renderContractHtml(noArabicTitle, 1)],
      ["the clearance", renderClearanceEmployeeHtml(noArabicTitle, 1)],
      ["the custody form", renderCustodyLaptopHtml(noArabicTitle, 1)],
    ] as const) {
      assert.ok(
        !html.includes("Medical Rep"),
        `${name} must leave the job title blank rather than print it in English`,
      );
    }

    // (d) The department is the department. The line is a different fact about the same person.
    assert.equal(arabicDepartmentName("Sales"), "المبيعات");
    assert.equal(arabicDepartmentName("sales"), "المبيعات", "matched case-insensitively");
    assert.equal(arabicDepartmentName("Human Resources"), "الموارد البشرية");
    assert.equal(arabicDepartmentName(null), null);
    assert.equal(arabicDepartmentName("   "), null);
    assert.equal(
      arabicDepartmentName("Regulatory Affairs"),
      "Regulatory Affairs",
      "a department created after this map was written prints visibly, not blank",
    );

    // The line names — CNS, Anti Infective, Pedia and their Arabic forms — are NOT departments, so
    // the map must not quietly answer for one. This is the actual reported bug: a rep's contract
    // named his product line where it should have named Sales.
    for (const line of ["CNS", "Pedia", "Anti Infective"]) {
      assert.equal(
        arabicDepartmentName(line),
        line,
        `${line} is a line, not a department — it must not resolve to an Arabic department name`,
      );
    }
    assert.equal(pack.employee.departmentAr, "المبيعات");
    assert.ok(
      renderContractHtml(pack, 1).includes("المبيعات"),
      "the contract must name the department that employs him",
    );
  }
}
