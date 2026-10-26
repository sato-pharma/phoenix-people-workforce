import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { COMPANY_DETAILS_DEFAULT } from "../src/lib/hiring-pack/company-details.ts";
import {
  copiesClauseAr,
  parsePrintCopies,
  PRINT_COPIES_MAX,
} from "../src/lib/hiring-pack/copies-clause.ts";
import { HR_PAPER_NDA_V1 } from "../src/lib/hiring-pack/hr-paper-text.ts";
import { buildManualHiringPack } from "../src/lib/hiring-pack/manual-pack.ts";
import {
  documentTakesAddressChoice,
  OFFICE_ADDRESS_AR,
  parsePrintAddress,
  printAddressText,
  withPrintAddress,
} from "../src/lib/hiring-pack/print-address.ts";
import { renderHrPaperHtml } from "../src/lib/hiring-pack/render-hr-paper.ts";
import { resolveCopies } from "../src/lib/hiring-pack/render-paper.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE PRINT PROMPT — the owner, 2026-09-20: before any HR form prints, ask how many copies (and write
// the copies sentence from the answer), and ask which company address goes on the paper.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
/** Source with whitespace collapsed, so a pin survives a reflow. */
const flat = (path: string): string => read(path).replace(/\s+/g, " ");

const SAMPLE: Record<string, string> = {
  "employee.nameAr": "شخص عيّنة",
  "employee.hrId": "T-1",
  "profile.jobTitleAr": "مندوب دعاية طبية",
};

function testTheCountIsMadeSafe() {
  assert.equal(parsePrintCopies("3", 1), 3);
  assert.equal(parsePrintCopies(" 2 ", 1), 2);
  assert.equal(parsePrintCopies("", 1), 1, "a blank box is the fallback, never zero copies");
  assert.equal(parsePrintCopies("0", 2), 2, "zero is not a print run");
  assert.equal(parsePrintCopies("-4", 2), 2);
  assert.equal(parsePrintCopies("abc", 2), 2);
  assert.equal(parsePrintCopies("500", 1), PRINT_COPIES_MAX, "clamped, not refused");
  // The prompt and the route must clamp at the same ceiling, or the paper states a count that was
  // not printed.
  assert.equal(resolveCopies("500", 1), PRINT_COPIES_MAX, "the route clamps to the prompt's ceiling");
}

function testTheClauseIsWrittenFromTheCount() {
  assert.equal(copiesClauseAr(1), "تُحرَّر هذه الشهادة من نسخة واحدة تُسلَّم لصاحب الشأن.");
  assert.ok(copiesClauseAr(2).includes("من نسختين، نسخة تُسلَّم لصاحب الشأن ونسخة تُحفظ بملف الخدمة"));
  assert.ok(copiesClauseAr(3).includes("من ثلاث نسخ"));
  assert.ok(copiesClauseAr(10).includes("من عشر نسخ"));
  assert.ok(copiesClauseAr(12).includes("من 12 نسخة"));
  assert.equal(copiesClauseAr(0), copiesClauseAr(1), "nonsense reads as one copy, never a broken sentence");
}

function testTheAddressChoiceIsNarrowed() {
  assert.equal(parsePrintAddress("registered"), "registered");
  assert.equal(parsePrintAddress("office"), "office");
  assert.equal(parsePrintAddress("HQ"), null, "an unknown value is no choice, never a guess");
  assert.equal(parsePrintAddress(null), null);
  assert.equal(parsePrintAddress(undefined), null);
  assert.equal(documentTakesAddressChoice("form1"), false, "the Authority's own forms never take it");
  assert.equal(documentTakesAddressChoice("form6"), false);
  assert.equal(documentTakesAddressChoice("contract"), true);
  assert.equal(documentTakesAddressChoice("salaryLetterAr"), true);
  assert.ok(OFFICE_ADDRESS_AR.includes("مربع ١٢٥٨"), "the working office is property 8, block 1258");
}

/**
 * THE CHOICE REACHES THE PAPER. Rendered for real: the recital's «المركز العام» line carries the
 * address the desk chose, and only that one.
 */
function testTheChosenAddressLandsOnThePaper() {
  const pack = buildManualHiringPack(SAMPLE, COMPANY_DETAILS_DEFAULT);
  const registered = pack.company.contractRecital.headOfficeAr;
  assert.notEqual(registered, OFFICE_ADDRESS_AR, "two different addresses, or there is nothing to choose");

  const untouched = renderHrPaperHtml(withPrintAddress(pack, null), 1, HR_PAPER_NDA_V1);
  assert.ok(untouched.includes(registered), "no choice — the registered head office, as it always was");
  assert.ok(!untouched.includes(OFFICE_ADDRESS_AR));

  const registeredChoice = renderHrPaperHtml(withPrintAddress(pack, "registered"), 1, HR_PAPER_NDA_V1);
  assert.ok(registeredChoice.includes(registered) && !registeredChoice.includes(OFFICE_ADDRESS_AR));

  const office = renderHrPaperHtml(withPrintAddress(pack, "office"), 1, HR_PAPER_NDA_V1);
  assert.ok(
    office.includes(`data-hp-key="COMPANY_HEAD_OFFICE_FULL">${OFFICE_ADDRESS_AR}<`),
    "the office address fills the recital's head-office blank",
  );
  assert.ok(!office.includes(registered), "and the registered one is not there beside it");

  // The resolved pack is shared by the caller: choosing must never edit it in place.
  assert.equal(pack.company.contractRecital.headOfficeAr, registered, "the original pack is untouched");
  assert.equal(printAddressText(pack.company, "office"), OFFICE_ADDRESS_AR);
  assert.equal(printAddressText(pack.company, "registered"), registered);
}

/**
 * EVERY PRINT BUTTON ASKS FIRST. Source pins over the three screens that print an HR form: none of
 * them may open the print URL straight from a click any more. Break one — put `openPrint("nda")`
 * back on a row — and this fires.
 */
function testNoPrintButtonSkipsThePrompt() {
  const manager = flat("src/components/hiring-pack/hiring-pack-manager.tsx");
  assert.ok(!/onPrint=\{\(\) => openPrint\(/.test(manager), "no row prints without asking");
  assert.ok(!/onPrint=\{\(document, versionId\) => openPrint\(/.test(manager), "nor the archive, nor the studio");
  assert.ok(manager.includes("if (how === \"print\") requestPrint(document, template.id, template.defaultCopies);"), "nor a company template row");
  assert.ok(manager.includes("<PrintOptionsDialog"), "the prompt is rendered");
  assert.ok(
    manager.includes("openPrint(document, versionId, answer.copies, answer.address, answer.marks)"),
    // THREE answers since 2026-09-29, not two: the dialog also asks what this run is stamped and
    // signed with. Pinned the same way and for the same reason as the other two - every one of them
    // must come from the confirmation rather than from a default the caller supplied, or the
    // question stops being a question. A stamp reaching the URL from anywhere but this line would
    // be a paper stamped by the system rather than by the desk.
    "and only its confirmation reaches openPrint, with all three answers",
  );
  assert.ok(manager.includes("setCopiesFor(document, String(answer.copies))"), "the row's Copies box follows the answer");
  assert.ok(manager.includes("&address=${address}"), "the address travels in the print URL");

  const devices = flat("src/components/devices/device-register-workspace.tsx");
  assert.ok(!/<a[^>]*print\?document=/.test(devices), "the custody receipt is no longer a bare link");
  assert.ok(devices.includes("<PrintOptionsDialog"), "it asks first");

  const manual = flat("src/components/hiring-pack/manual-paper-workspace.tsx");
  assert.ok(manual.includes("onClick={() => setAsking(true)}"), "the typed-in paper's Print opens the prompt");
  assert.ok(!manual.includes("onClick={() => void print()}"), "and never prints straight from the click");
}

function testThePromptDoesNotLetTheAddressBeSkipped() {
  const dialog = flat("src/components/hiring-pack/print-options-dialog.tsx");
  assert.ok(
    dialog.includes("const ready = count >= 1 && (!askAddress || address !== null);"),
    "Print stays disabled until a count AND, where it applies, an address are chosen",
  );
  assert.ok(dialog.includes("disabled={!ready}"));
  assert.ok(dialog.includes("useState<PrintAddressChoice | null>(askAddress ? initialAddress : null)"), "no address is pre-chosen the first time");
  assert.ok(dialog.includes("dir=\"rtl\""), "the Arabic address reads right to left");
}

function testTheRoutesCarryBothAnswers() {
  const print = flat("app/api/hiring-pack/[hrId]/print/route.ts");
  assert.ok(print.includes('const address = url.searchParams.get("address");'));
  assert.equal((print.match(/\baddress,/g) ?? []).length >= 1, true, "the address is listed in the inputs that choose the paper");
  assert.equal((print.match(/\.\.\.paperInput/g) ?? []).length, 2, "both the HTML and the PDF render take the address through the shared paperInput");
  assert.ok(
    print.includes('statedCopies: url.searchParams.get("copies")'),
    "the PDF draws one copy and stamps the rest — the sentence must still state the real count",
  );
  const manual = flat("app/api/hiring-pack/manual/route.ts");
  assert.ok(manual.includes('address: typeof payload.address === "string" ? payload.address : null'));
  const render = flat("src/lib/hiring-pack/render-paper.ts");
  assert.ok(render.includes("parsePrintAddress(input.address)"), "the address is applied to the data before any renderer runs");
}

/**
 * THE TICK IS REMEMBERED FOR THE SAME PAPER, AND ONLY AS A STARTING POINT — the owner, 2026-09-29:
 * "make the print dialog remember the last tick for the same paper."
 *
 * Two things have to hold at once, and they pull against each other, which is why this is pinned.
 *
 * ONE — it must actually survive to the next print of that paper. The trap is that `availableMarks`
 * is FETCHED by the manager after the dialog is already mounted, so it is EMPTY on the render that
 * seeds the dialog's state. Filtering the remembered ticks at mount - which reads as the obviously
 * careful thing to write - drops every one of them, every time, and the feature looks like it was
 * never built while the source looks correct. So the state is seeded unfiltered and narrowed on the
 * way out.
 *
 * TWO — it must stay a starting point. A remembered tick that outlived the tab would be a standing
 * instruction to stamp, which is precisely what he ruled against ("donot put the stamp permanent").
 * Session state only: no storage, no cookie, nothing that reaches the next person to sit down.
 */
function testTheTickIsRememberedPerPaper() {
  const manager = flat("src/components/hiring-pack/hiring-pack-manager.tsx");
  const dialog = flat("src/components/hiring-pack/print-options-dialog.tsx");

  // PER PAPER AND VERSION, through the one key function both sides use - the availability lookup and
  // the remembered ticks keying a print differently is how a tick starts describing another paper.
  assert.ok(
    manager.includes("function printKeyOf(document: PrintableDocument, versionId?: string): string {"),
    "one function names a paper for both the lookup and the remembered tick",
  );
  assert.ok(
    manager.includes("setLastMarks((current) => ({ ...current, [printKeyOf(document, versionId)]: answer.marks }))"),
    "the confirmed answer is remembered against the paper it was given for",
  );
  assert.ok(
    manager.includes("initialMarks={lastMarks[printRequestKey] ?? []}"),
    "and handed back to the dialog the next time that same paper prints",
  );
  assert.ok(
    manager.includes("const printRequestKey = printRequest ? printKeyOf(printRequest.document, printRequest.versionId) : \"\";"),
    "the availability lookup keys the same way",
  );

  // SEEDED UNFILTERED. `availableMarks` has not arrived on the seeding render.
  assert.ok(
    dialog.includes("const [marks, setMarks] = useState<DocumentMark[]>(() => [...initialMarks]);"),
    "the remembered ticks are taken whole - filtering here would drop all of them, always",
  );
  // NARROWED ON THE WAY OUT, so a tick remembered for a position deleted since prints nothing.
  assert.ok(
    dialog.includes("const ticked = marks.filter((mark) => availableMarks.includes(mark));"),
    "and narrowed to what this paper still has a position for",
  );
  assert.ok(
    dialog.includes("onConfirm({ address, copies: count, marks: ticked })"),
    "the narrowed set is what Print sends, never the raw remembered one",
  );

  // NOT PERSISTED. `lastAddress` above it is the precedent: remembered for the tab, never beyond it.
  assert.ok(
    manager.includes("const [lastMarks, setLastMarks] = useState<Record<string, DocumentMark[]>>({});"),
    "remembered in session state",
  );
  assert.ok(
    !/lastMarks[\s\S]{0,400}(localStorage|sessionStorage|document\.cookie)/.test(manager),
    "and never written to storage - a tick that outlives the tab is a standing instruction to stamp",
  );
}

export function runHiringPackPrintOptionsTests() {
  testTheCountIsMadeSafe();
  testTheClauseIsWrittenFromTheCount();
  testTheAddressChoiceIsNarrowed();
  testTheChosenAddressLandsOnThePaper();
  testNoPrintButtonSkipsThePrompt();
  testThePromptDoesNotLetTheAddressBeSkipped();
  testTheRoutesCarryBothAnswers();
  testTheTickIsRememberedPerPaper();
}
