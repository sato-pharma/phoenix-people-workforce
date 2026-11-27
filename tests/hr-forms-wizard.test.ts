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
  assert.ok(manager.includes("hrFormsPaperSteps(path, paperScope)"), "the paper steps come from the one list");
  assert.ok(!manager.includes("<PaperGroup"), "no package tab of grouped cards is left");
  assert.ok(!/<FormsDrive[\s/>]/u.test(manager), "nor the folder drive above it");
  assert.ok(manager.includes("editAny || target <= furthest"), "Edit any form opens every step");
  assert.ok(manager.includes("path === \"leaver\" && !editAny"), "and lists every person on the leaver path");
  for (const page of ["app/(admin)/hiring-pack/page.tsx", "app/employee-portals/hiring-pack/page.tsx"]) {
    assert.ok(code(page).includes('canEditAnyForm={access.role === "Super Admin"}'), `${page} offers Edit any form to the Super Admin only`);
  }
  const route = code("app/api/hiring-pack/paper-register/route.ts");
  assert.ok(route.includes("listPaperIssuesForEmployee(hrId)"), "one person's prints are read from the register");
  assert.ok(route.includes("paperIssuesForViewer(access, listed)"), "through the same seat filter as the recent list");
}

export function runHrFormsWizardTests() {
  testThePathsAndTheirPapers();
  testTheClearancesNeverHangOnTheExitRoute();
  testATickIsAPrintOrASignature();
  testTheBannerAsksThePrinterForTheCount();
  testTheScreenIsTheWizard();
}
