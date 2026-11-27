// HR Forms is the Adverse Drug Reaction report's wizard (owner, 2026-11-27): new hire, leaver or
// another paper; then the person; then one step per paper, ticked once it is printed or signed. And
// a print draws ONE copy — the desk sets the count on the printer.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
  EXIT_FORM_STEP,
  HR_FORMS_PATHS,
  LEAVER_PAPERS,
  NEW_HIRE_PAPERS,
  hrFormsPaperSteps,
  isPaperDone,
  latestPrintByDocument,
  paperStatus,
  papersInPackages,
} from "../src/lib/hiring-pack/hr-forms-wizard.ts";
import {
  ARRANGEABLE_STEPS,
  DEFAULT_FORMS_LAYOUT,
  FIXED_STEPS,
  cleanPackageSteps,
  isFixedStep,
  mayArrange,
  movableSteps,
  normalizeFormsLayout,
  sameFormsLayout,
  stepsOutsidePackages,
} from "../src/lib/hiring-pack/forms-layout.ts";
import { printBanner } from "../src/lib/hiring-pack/render-shared.ts";
import { singleCopyBanner } from "../src/lib/hiring-pack/single-copy.ts";
import { HIRING_PACK_DOCUMENTS } from "../src/lib/hiring-pack/types.ts";

const code = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** The three answers to step one, in the order he named them, and each path's papers in desk order. */
function testThePathsAndTheirPapers() {
  assert.deepEqual(
    HR_FORMS_PATHS.map((option) => option.value),
    ["newHire", "leaver", "other"],
    "new hire, then leaver, then another paper",
  );
  const newHire = hrFormsPaperSteps("newHire");
  assert.deepEqual(newHire.slice(0, 2), ["contract", "form1"], "the joiner starts at the contract, then Form 1");
  const leaver = hrFormsPaperSteps("leaver");
  assert.deepEqual(leaver.slice(0, 2), ["form6", EXIT_FORM_STEP], "the leaver starts at Form 6, then the exit form");
  assert.deepEqual(hrFormsPaperSteps("other"), [], "another paper is chosen, not walked through");

  for (const step of [...NEW_HIRE_PAPERS, ...LEAVER_PAPERS]) {
    if (step === EXIT_FORM_STEP) continue;
    assert.ok((HIRING_PACK_DOCUMENTS as readonly string[]).includes(step), `${step} is a paper this system prints`);
  }
  assert.equal(new Set(newHire).size, newHire.length, "no paper twice on the joiner's rail");
  assert.equal(new Set(leaver).size, leaver.length, "no paper twice on the leaver's rail");
  assert.ok(papersInPackages().has("resignation") && papersInPackages().has("mutualTermination"), "both exit forms belong to the leaver package");
}

/**
 * THE TWO EXIT FORMS ARE ONE STEP; THE TWO CLEARANCES ARE TWO. One exit form is signed, never both —
 * the clearances are complements and each protects the side that does not keep it, so neither may
 * hang on the route.
 */
function testTheClearancesNeverHangOnTheExitRoute() {
  const leaver = hrFormsPaperSteps("leaver");
  assert.ok(!leaver.includes("resignation") && !leaver.includes("mutualTermination"), "the exit forms are not steps of their own");
  assert.equal(leaver.filter((step) => step === EXIT_FORM_STEP).length, 1, "one exit-form step");
  assert.ok(leaver.includes("clearanceEmployee"), "the employee clearance is always a step");
  assert.ok(leaver.includes("clearanceCompany"), "the company clearance is always a step");

  // A seat limited to its papers sees only those, and the exit step stays while either form is hers.
  assert.deepEqual(hrFormsPaperSteps("leaver", ["clearanceCompany"]), ["clearanceCompany"]);
  assert.deepEqual(hrFormsPaperSteps("leaver", ["mutualTermination"]), [EXIT_FORM_STEP]);
  assert.deepEqual(hrFormsPaperSteps("newHire", ["nda", "form6"]), ["nda"]);
}

/** A tick is a print or a signature, read from the register — never a step walked past. */
function testATickIsAPrintOrASignature() {
  const latest = latestPrintByDocument([
    { document: "contract", issuedAt: "2026-11-20T08:00:00Z", reference: "HR-1" },
    { document: "contract", issuedAt: "2026-11-27T09:30:00Z", reference: "HR-3" },
    { document: "contract", issuedAt: "2026-11-25T10:00:00Z", reference: "HR-2" },
    { document: "form1", issuedAt: "2026-11-21T08:00:00Z", reference: "HR-4" },
  ]);
  assert.equal(latest.contract?.reference, "HR-3", "the newest print by its time, not by the order the rows came in");
  assert.equal(latest.form1?.reference, "HR-4");
  assert.equal(latest.nda, undefined, "a paper never printed has no row");

  assert.deepEqual(paperStatus("2026-11-26", "2026-11-27T09:30:00Z"), { on: "2026-11-26", state: "signed" }, "signed beats printed");
  assert.deepEqual(paperStatus(null, "2026-11-27T09:30:00Z"), { on: "2026-11-27T09:30:00Z", state: "printed" });
  assert.deepEqual(paperStatus("", null), { state: "open" }, "an empty date is not a signature");
  assert.equal(isPaperDone({ state: "open" }), false);
  assert.equal(isPaperDone({ on: "2026-11-27T09:30:00Z", state: "printed" }), true);
}

/**
 * ONE COPY ON THE PAGE. Every renderer's banner line is rewritten to ask the print dialog for the
 * count — read off each renderer's own source, so a reworded banner is caught rather than left
 * telling the desk to leave the count at 1 on a page that now holds one copy.
 */
function testTheBannerAsksThePrinterForTheCount() {
  const renderers = [
    "src/lib/hiring-pack/render-contract.ts",
    "src/lib/hiring-pack/render-custom-template.ts",
    "src/lib/hiring-pack/render-form1.ts",
    "src/lib/hiring-pack/render-form6.ts",
    "src/lib/hiring-pack/render-labour-exit.ts",
    "src/lib/hiring-pack/render-official-form.ts",
    "src/lib/hiring-pack/render-worker-form.ts",
  ];
  let seen = 0;
  for (const file of renderers) {
    const source = code(file);
    // The banner sentence as the renderer writes it, with each interpolation standing for 3.
    const sentences = [...source.matchAll(/`[^`]*laid out below[^`]*`(?:\s*\+\s*"[^"]*")?/gu)].map((match) =>
      match[0]
        .replace(/`\s*\+\s*"/u, "")
        .replace(/^`|`$|"$/gu, "")
        .replace(/\$\{[^}]*(?:===\s*1\s*\?\s*"copy is"\s*:\s*"copies are")[^}]*\}/gu, "copies are")
        .replace(/\$\{[^}]*\}/gu, "3"),
    );
    assert.ok(sentences.length > 0, `${file} draws a copy banner`);
    for (const sentence of sentences) {
      seen += 1;
      const banner = printBanner([sentence]);
      const rewritten = singleCopyBanner(banner, 3);
      assert.ok(!rewritten.includes("copy count at 1"), `${file}: "${sentence}" is rewritten`);
      assert.ok(
        rewritten.includes("One copy is laid out below — set the print dialog&#39;s copies to 3."),
        `${file}: the desk is told to set the dialog's copies to the count`,
      );
    }
  }
  assert.ok(seen >= renderers.length, `every renderer's banner was checked (${seen})`);
  assert.equal(
    singleCopyBanner("4 copies are already laid out below — leave the dialog's copy count at 1.", 4),
    "One copy is laid out below — set the print dialog's copies to 4.",
    "an unescaped apostrophe keeps its own form",
  );

  // The print route and the hand-typed route draw one copy; the PDF holds one copy too.
  const print = code("app/api/hiring-pack/[hrId]/print/route.ts");
  assert.ok(print.includes("copies: url.searchParams.get(\"copies\"),\n      singleCopy: true,"), "the print route draws one copy");
  assert.ok(/renderHiringPaperPdf\([^)]*\), \{\n\s*copies: 1,/u.test(print), "and the PDF is one copy");
  assert.ok(code("app/api/hiring-pack/manual/route.ts").includes("singleCopy: true,"), "a typed-in paper draws one copy too");
  const paper = code("src/lib/hiring-pack/render-paper.ts");
  assert.ok(paper.includes("const drawnCopies = singleCopy ? 1 : copies;"), "one copy is drawn");
  assert.ok(paper.includes("return { copies, data, fields, html, ok: true, template, versionId };"), "while the register still records the count asked for");
}

/** The screen is the wizard, and the Super Admin's "Edit any form" reaches it from both pages. */
function testTheScreenIsTheWizard() {
  const manager = code("src/components/hiring-pack/hiring-pack-manager.tsx");
  assert.ok(manager.includes("<FormWizard"), "HR Forms wears the report's wizard");
  assert.ok(manager.includes("isStepDone={isStepDone}"), "the rail ticks what was printed, not what was passed");
  assert.ok(manager.includes("hrFormsPaperSteps(path, paperScope, storedLayout.layout)"), "the paper steps come from the one list");
  assert.ok(!manager.includes("<PaperGroup"), "no package tab of grouped cards is left");
  assert.ok(!/<FormsDrive[\s/>]/u.test(manager), "nor the folder drive above it");
  assert.ok(manager.includes("editAny || target <= furthest"), "Edit any form opens every step");
  assert.ok(manager.includes("path === \"leaver\" && !editAny"), "and lists every person on the leaver path");
  // ONE STEP HOLDS EVERYTHING ABOUT ITS PAPER: its own fields, its card, then the paper drawn under
  // them — no separate details step to fill first and come back from.
  assert.ok(!manager.includes('kind: "details"'), "there is no separate details step");
  assert.ok(manager.includes('current.paper === "contract" ? renderJoinerFields(pack, [IDENTITY_GROUP, TERMS_GROUP], true)'), "the contract step carries the contract's own fields");
  assert.ok(manager.includes('current.paper === "form1" ? renderJoinerFields(pack, [IDENTITY_GROUP, FORM1_GROUP], false)'), "Form 1's step carries Form 1's boxes");
  assert.ok(manager.includes('current.paper === "form6" ? renderExitFields(pack, [DEPARTURE_GROUP], true)'), "Form 6's step carries the departure");
  assert.ok(manager.includes('-${paperRedraw}`}'), "a save draws the paper under its fields again");
  assert.equal(manager.split("setPaperRedraw((value) => value + 1);").length - 1, 3, "every one of the three saves redraws it");
  // A different package starts over with nobody chosen: a new hire must never reach Form 6.
  const choosePath = manager.slice(manager.indexOf("const choosePath = "), manager.indexOf("const chooseEmployee = "));
  assert.ok(choosePath.includes('if (value !== path) void selectEmployee("");'), "changing the package clears the person");
  for (const page of ["app/(admin)/hiring-pack/page.tsx", "app/employee-portals/hiring-pack/page.tsx"]) {
    assert.ok(code(page).includes('canEditAnyForm={access.role === "Super Admin"}'), `${page} offers Edit any form to the Super Admin only`);
  }
  const route = code("app/api/hiring-pack/paper-register/route.ts");
  assert.ok(route.includes("listPaperIssuesForEmployee(hrId)"), "one person's prints are read from the register");
  assert.ok(route.includes("paperIssuesForViewer(access, listed)"), "through the same seat filter as the recent list");
}

/**
 * THE CONTROL TAB (owner, 2026-11-27): "rearrange the forms that appear, remove a form, add a form —
 * move it from another paper to new hire, or from new hire to another paper." Each package is an
 * ordered list stored once; "Another paper" is every paper on neither list; a stored list is cleaned,
 * never trusted.
 */
function testTheControlTabArrangesThePackages() {
  // Nothing stored is the standard order, and the wizard walks exactly it.
  assert.deepEqual(normalizeFormsLayout(null), DEFAULT_FORMS_LAYOUT);
  assert.deepEqual(hrFormsPaperSteps("newHire", null, DEFAULT_FORMS_LAYOUT), hrFormsPaperSteps("newHire"));
  assert.deepEqual(hrFormsPaperSteps("leaver", null, DEFAULT_FORMS_LAYOUT), hrFormsPaperSteps("leaver"));

  // THE FIXED PAPERS (owner, 2026-11-27: "Form 1 and the contract are for new hires. Be smart. Remove
  // them from rearrange"): each package always opens with its own, in the standard order, and the
  // standard order itself starts with them, so nothing he saw before moved.
  const fixedNewHire = ["contract", "form1", "workerDataForm", "appointmentDocsReceipt"];
  const fixedLeaver = ["form6", EXIT_FORM_STEP, "clearanceEmployee", "clearanceCompany", "appointmentDocsReturn"];
  assert.deepEqual(FIXED_STEPS.newHire, fixedNewHire);
  assert.deepEqual(FIXED_STEPS.leaver, fixedLeaver);
  assert.deepEqual(DEFAULT_FORMS_LAYOUT.newHire.slice(0, fixedNewHire.length), fixedNewHire, "the standard new-hire order opens with its fixed papers");
  assert.deepEqual(DEFAULT_FORMS_LAYOUT.leaver.slice(0, fixedLeaver.length), fixedLeaver, "the standard leaver order opens with its fixed papers");
  for (const step of [...fixedNewHire, ...fixedLeaver]) {
    assert.ok(isFixedStep(step) && !mayArrange(step), `${step} is fixed, never arranged`);
    assert.ok(!ARRANGEABLE_STEPS.includes(step as never), `${step} is never offered to move`);
  }

  // Rearranged, removed and added: the wizard follows the stored order — fixed papers first, wherever
  // the stored list put them, and never moved across or dropped.
  const arranged = normalizeFormsLayout({
    leaver: ["nda", "form6", "contract"],
    newHire: ["custodyLaptop", "form1", "contract", "form6", "nda"],
  });
  assert.deepEqual(hrFormsPaperSteps("newHire", null, arranged), [...fixedNewHire, "custodyLaptop", "nda"]);
  assert.deepEqual(hrFormsPaperSteps("leaver", null, arranged), [...fixedLeaver, "nda"]);
  assert.deepEqual(movableSteps(arranged, "newHire"), ["custodyLaptop", "nda"]);
  assert.deepEqual(cleanPackageSteps([], "newHire"), fixedNewHire, "nothing movable keeps the fixed papers");
  // A seat limited to its papers still sees only those, in the arranged order.
  assert.deepEqual(hrFormsPaperSteps("newHire", ["nda", "contract"], arranged), ["contract", "nda"]);

  // A removed paper lands in "Another paper"; a placed or fixed one is never there.
  const outside = stepsOutsidePackages(arranged);
  assert.ok(outside.includes("socialStatusSheet"), "the social status sheet, taken off new hire, is another paper");
  assert.ok(!outside.includes("nda") && !outside.includes("custodyLaptop"), "a paper on a package is not offered again");
  assert.ok(!outside.some((step) => isFixedStep(step)), "a fixed paper is never another paper");
  const placed = new Set([...movableSteps(arranged, "newHire"), ...movableSteps(arranged, "leaver")]);
  assert.equal(outside.length + placed.size, ARRANGEABLE_STEPS.length, "every movable paper is somewhere, once");

  // Cleaned, never trusted: an unknown key, a repeat, the exit forms one by one, a fixed paper elsewhere.
  assert.deepEqual(cleanPackageSteps(["nda", "nda", "noSuchPaper", 7, "exitForm"], "newHire"), [...fixedNewHire, "nda"]);
  assert.deepEqual(cleanPackageSteps(["resignation", "mutualTermination", "nda"], "leaver"), [...fixedLeaver, "nda"], "the two exit forms are the fixed exit-form step");
  assert.equal(cleanPackageSteps("contract", "newHire"), null, "anything but a list keeps the standard order");
  assert.ok(!ARRANGEABLE_STEPS.includes("resignation") && !ARRANGEABLE_STEPS.includes("mutualTermination"));
  assert.ok(sameFormsLayout(normalizeFormsLayout({ newHire: [...DEFAULT_FORMS_LAYOUT.newHire] }), DEFAULT_FORMS_LAYOUT));
  assert.ok(sameFormsLayout(normalizeFormsLayout(DEFAULT_FORMS_LAYOUT), DEFAULT_FORMS_LAYOUT), "the standard order survives its own cleaning");

  // The screen: the tab, the wizard reading the arrangement, Another paper following it.
  const manager = code("src/components/hiring-pack/hiring-pack-manager.tsx");
  assert.ok(manager.includes('{ id: "control", label: "Arrange forms" }'), "HR Forms has the Arrange forms tab");
  assert.ok(manager.includes('canEditAnyForm && screenTab === "control" ? ('), "for the Super Admin only");
  assert.ok(manager.includes("const placed = stepsInPackages(storedLayout.layout);"), "Another paper leaves out what the packages hold");
  assert.ok(manager.includes('return entry.audience !== "departed" || personLeft;'), "a leaver's paper is offered for a departed person only");
  for (const page of ["app/(admin)/hiring-pack/page.tsx", "app/employee-portals/hiring-pack/page.tsx"]) {
    assert.ok(code(page).includes("formsLayout={formsLayout}"), `${page} hands the wizard the stored arrangement`);
  }
  const route = code("app/api/hiring-pack/forms-layout/route.ts");
  assert.ok(route.includes('if (access.role !== "Super Admin") {'), "only the Super Admin saves an arrangement");
  assert.ok(route.includes("const steps = cleanPackageSteps(raw, pack);"), "every list is cleaned before it is stored");
  assert.ok(route.includes("assertSameOriginMutation(request)"), "the save is a same-origin write");
}

export function runHrFormsWizardTests() {
  testThePathsAndTheirPapers();
  testTheClearancesNeverHangOnTheExitRoute();
  testATickIsAPrintOrASignature();
  testTheBannerAsksThePrinterForTheCount();
  testTheScreenIsTheWizard();
  testTheControlTabArrangesThePackages();
}
