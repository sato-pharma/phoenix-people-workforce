/**
 * Reading a leaver's mailbox Edit form in the Turbify console — what this file protects (13 Nov 2026).
 *
 * The capture opens ONE mailbox row's Edit form as the console administrator, reads every control,
 * and leaves without keeping anything. Its whole value is that it is a READ: the moment it presses a
 * control that keeps a change, it becomes an unreviewed edit of a live mailbox. So four things are
 * pinned, each a way it could go wrong quietly:
 *
 *   1. **The route refuses a non–System Administrator BEFORE it reads the body.**
 *   2. **An address that is not a leaver on the register is refused BEFORE a driver is built** — and
 *      the match is exact, so `el.sayed@` never matches `adel.sayed@`.
 *   3. **Leaving can only press Close modal, Cancel or Close, then Escape** — asserted against the
 *      driver's comment-stripped source, because the comments name every word it must not press.
 *   4. **The answer never carries a text value, only lengths** — proved by running the real in-page
 *      reader against a fake page whose fields hold recognisable values.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import { JOINER_STEP_ORDER, createDryRunJoinerDriver } from "../src/lib/new-hire-mailbox/robot/driver.ts";
import {
  readEditDialogOpenInPage,
  readMailboxEditFormInPage,
  readOwningRowCellsInPage,
  shapeMailboxEditForm,
} from "../src/lib/new-hire-mailbox/robot/turbify-joiner.ts";
import { ECP_LOCATORS, MAILBOX_EDIT_FORM } from "../src/lib/turbify/locators.ts";
import { matchLeaverOnRegister } from "../src/lib/mailbox-offboarding/service.ts";

/** Comment-stripped, whitespace-collapsed, and with adjacent string fragments joined. */
function readable(path: string): string {
  return stripComments(readFileSync(new URL(path, import.meta.url), "utf8"))
    .replace(/\s+/g, " ")
    .replace(/["`]\s*\+\s*["`]/g, "");
}

const ROUTE = "../app/api/mailbox-offboarding/edit-form-controls/route.ts";
const ACTION = "../src/lib/new-hire-mailbox/robot/actions/edit-form-controls-action.ts";
const JOINER = "../src/lib/new-hire-mailbox/robot/turbify-joiner.ts";

function slice(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `${start} must exist`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `${end} must follow ${start}, so the region can be isolated`);
  return source.slice(from, to);
}

/** The words leaving must never press, as a prefix match: `resetPassword`, `deleteUser`, `submitOpenForm`. */
const FORBIDDEN_PRESS = new RegExp(`\\b(${MAILBOX_EDIT_FORM.neverPress.join("|")})`, "i");

// ── 1. The gate comes before the body ──────────────────────────────────────────────────────────
function runGateBeforeBodyCases(): void {
  const route = readable(ROUTE);
  const resolved = route.indexOf("resolveAccessContext(request)");
  const gate = route.indexOf("if (!canReadInitialPassword(access.role))");
  const body = route.indexOf("request.json(");
  assert.ok(resolved > -1 && gate > -1 && body > -1, "the route must resolve access, gate, and read a body");
  assert.ok(resolved < gate, "the gate reads the resolved access context");
  assert.ok(
    gate < body,
    "a non–System Administrator must be refused BEFORE the body is read — a gate after the read has "
    + "already parsed what it should never have accepted",
  );
  assert.match(
    route.slice(gate, body), /status: 403/,
    "and the refusal must RETURN 403 between the gate and the read, not merely be computed there",
  );
  const csrf = route.indexOf("assertSameOriginMutation(request)");
  assert.ok(csrf > -1 && csrf < resolved, "a cross-origin request is refused before anything else");
}

// ── 2. The register comes before the driver ────────────────────────────────────────────────────
function runRegisterBeforeDriverCases(): void {
  // The website route: register, then the rate limit, then the run — forwarded or local — and the
  // run is handed the REGISTER's address on both paths.
  const route = readable(ROUTE);
  const lookup = route.indexOf("findLeaverOnRegister(asked)");
  const refusal = route.indexOf("if (!leaver)");
  const limit = route.indexOf("assertApiRateLimit(");
  const forward = route.indexOf('forwardToRobotService({ action: "edit-form-controls"');
  const local = route.indexOf("runEditFormControlsAction({ actor, address: leaver.workEmail })");
  assert.ok(lookup > -1 && refusal > -1 && limit > -1 && forward > -1 && local > -1, "every step of the route must be present");
  const run = Math.min(forward, local);
  assert.ok(
    lookup < refusal && refusal < run,
    "an address that is not a leaver on the register must be refused BEFORE the run — a browser "
    + "signed in as the console administrator is the thing this gate exists to withhold",
  );
  assert.match(route.slice(refusal, run), /status: 404/, "and the refusal must return before the run");
  assert.ok(limit > refusal && limit < run, "the rate limit sits between the register and the run");
  assert.match(route, /request: \{ address: leaver\.workEmail \}/, "the robot service is sent the REGISTER's address");
  assert.doesNotMatch(route, /createJoinerDriverFromEnv/, "the website route builds no driver of its own");
  assert.doesNotMatch(route, /sendEmail|sendMail|queueEmail|notify/i, "the capture sends no email");

  // The ONE implementation asks the register AGAIN before a driver is built: on the robot service
  // the address arrives in a forwarded body.
  const action = readable(ACTION);
  const again = action.indexOf("findLeaverOnRegister(asked)");
  const againRefusal = action.indexOf("if (!leaver)");
  const driver = action.indexOf("createJoinerDriverFromEnv()");
  assert.ok(again > -1 && againRefusal > again && driver > againRefusal, "the action: register, refusal, then the driver");
  assert.match(action.slice(againRefusal, driver), /status: 404/, "and its refusal returns before the driver");
  assert.match(
    action, /captureMailboxEditForm\(\{ address: leaver\.workEmail \}\)/,
    "the driver is handed the REGISTER's address, never the body's string",
  );
  assert.match(action, /driver\.close\(\)/, "the browser must be closed whatever happened");
  assert.doesNotMatch(action, /sendEmail|sendMail|queueEmail|notify/i, "the capture sends no email");

  // The match itself: exact and lowered, never a substring.
  const rows = [
    { employee_name: "Adel Sayed", id: "t-1", work_email: "adel.sayed@satopharma.com" },
    { employee_name: "Leaver One", id: "t-2", work_email: " Leaver.One@SatoPharma.com " },
  ];
  assert.equal(
    matchLeaverOnRegister(rows, "el.sayed@satopharma.com"), null,
    "`el.sayed@` must NOT match `adel.sayed@` — the console's own substring trap, kept out of the gate",
  );
  assert.deepEqual(
    matchLeaverOnRegister(rows, "leaver.one@satopharma.com"),
    { employeeName: "Leaver One", taskId: "t-2", workEmail: "leaver.one@satopharma.com" },
    "an exact address matches whatever its case and padding on the register",
  );
  assert.equal(matchLeaverOnRegister(rows, "someone.else@satopharma.com"), null, "an address not on the register is refused");
  assert.equal(matchLeaverOnRegister(rows, ""), null, "an empty address is refused");
  assert.equal(matchLeaverOnRegister([], "leaver.one@satopharma.com"), null, "an empty register refuses everyone");
}

// ── 3. Leaving can only press the closing controls ─────────────────────────────────────────────
function runLeaveWithoutKeepingCases(): void {
  const allowed = new Set(["Close modal", "Cancel", "Close"]);
  for (const control of MAILBOX_EDIT_FORM.leave) {
    assert.ok(allowed.has(control.value), `"${control.value}" is not one of the allowed closing controls`);
    assert.doesNotMatch(control.value, FORBIDDEN_PRESS, `"${control.value}" is a control that keeps a change`);
    assert.deepEqual([...control.tags], ["button"], "a closing control is a button and nothing else");
  }
  assert.equal(ECP_LOCATORS.editUser.kind, "aria");
  assert.equal(ECP_LOCATORS.editUser.value, "Edit", "the row action pressed is the aria-labelled Edit");

  const driver = readable(JOINER);
  const method = slice(driver, "async captureMailboxEditForm(", "}, async ");
  const leave = slice(driver, "async function closeEditFormKeepingNothing(", "export type JoinerDriverPorts");

  for (const [name, region] of [["captureMailboxEditForm", method], ["closeEditFormKeepingNothing", leave]] as const) {
    const hit = FORBIDDEN_PRESS.exec(region);
    assert.equal(
      hit, null,
      `${name} names "${hit?.[0]}" — leaving must never reach Save, Update, Apply, Submit, Delete, Reset or Transfer`,
    );
    assert.doesNotMatch(region, /moreActions|clickOneOf\(|clickOne\(|page\.click\(/, `${name} presses only what it resolves exactly`);
    assert.doesNotMatch(region, /fillOne\(|fillField\(|\.type\(|clearField/, `${name} types into nothing`);
  }

  // The method's ONE press is the Edit button, through the hit-tested path, inside the identity check.
  assert.equal((method.match(/deliverClick\(/g) ?? []).length, 1, "the method presses exactly one control itself");
  assert.match(method, /deliverClick\(handle, ECP_LOCATORS\.editUser\.purpose\)/, "and that control is Edit");
  assert.equal((method.match(/clickResolved\(/g) ?? []).length, 0, "the method presses nothing else directly");
  const identity = method.indexOf("rowIdentityRefusal(rows, wanted,");
  const press = method.indexOf("act(page, ECP_LOCATORS.editUser,");
  const owner = method.indexOf("readOwningRowCellsInPage");
  assert.ok(identity > -1 && press > identity, "the row is proved by identity BEFORE Edit is pressed");
  assert.ok(owner > press && owner < method.indexOf("deliverClick("), "and the button's own row is checked before the press");
  assert.ok(method.indexOf("closeEditFormKeepingNothing(page)") > method.indexOf("readMailboxEditFormInPage"), "the form is read before it is left");

  // The helper's only presses: each leave control in turn, then Escape.
  assert.match(leave, /for \(const control of MAILBOX_EDIT_FORM\.leave\)/, "leaving walks the allowed list and nothing else");
  assert.equal((leave.match(/clickResolved\(/g) ?? []).length, 1, "one press site, fed only from the allowed list");
  assert.match(leave, /clickResolved\(page, control\)/);
  assert.deepEqual(leave.match(/press\("[^"]*"\)/g), ['press("Escape")'], "the only key pressed is Escape");

  // The reader looks and never acts.
  const reader = slice(driver, "export function readMailboxEditFormInPage(", "const EDIT_FORM_LABEL_MAX");
  assert.doesNotMatch(reader, /\.click\(|dispatchEvent|\.submit\(|\.focus\(|\.value =(?!=)/, "the reader presses, focuses and sets nothing");

  // Never a step, never a sweep.
  assert.equal((JOINER_STEP_ORDER as readonly string[]).includes("captureMailboxEditForm"), false);
  for (const path of [
    "../src/lib/new-hire-mailbox/robot/runner.ts",
    "../src/lib/new-hire-mailbox/robot/adopt-runner.ts",
    "../src/lib/new-hire-mailbox/robot/sweep-hook.ts",
    "../src/lib/mailbox-offboarding/sweep.ts",
    "../src/lib/mailbox-offboarding/robot/sweep-hook.ts",
  ]) {
    assert.doesNotMatch(readable(path), /captureMailboxEditForm/, `${path} must never reach the Edit-form capture`);
  }
}

// ── 4. The answer carries lengths, never values ────────────────────────────────────────────────
type Fake = Record<string, unknown>;

function el(tag: string, attrs: Record<string, string> = {}, props: Fake = {}, text = ""): Fake {
  return {
    closest: () => null,
    getAttribute: (name: string) => attrs[name] ?? null,
    getClientRects: () => (props.invisible ? [] : [{}]),
    innerText: text,
    parentElement: null,
    tagName: tag.toUpperCase(),
    textContent: text,
    ...props,
  };
}

async function runNoValueCases(): Promise<void> {
  const SECRETS = {
    hidden: "HIDDEN-VALUE-zq81",
    password: "PASSWORD-VALUE-kx42",
    text: "forward.to.someone@elsewhere.example",
    textarea: "TEXTAREA-VALUE-mm07",
  };
  const PROSE = "PROSE-ONLY-MARKER the dialog's own sentences";

  const optionActive = el("option", {}, {}, "Active");
  const optionSuspended = el("option", {}, {}, "Suspended");
  const fields = [
    el("input", { id: "fwd", name: "forwardTo" }, { type: "text", value: SECRETS.text }),
    el("input", { "aria-label": "New password", name: "password" }, { type: "password", value: SECRETS.password }),
    el("input", { "aria-label": "Mailbox enabled", name: "enabled" }, { checked: true, type: "checkbox", value: "on" }),
    el("input", { name: "status" }, { checked: true, closest: () => el("label", {}, {}, "Active"), type: "radio", value: "a" }),
    el("input", { name: "status" }, { checked: false, closest: () => el("label", {}, {}, "Suspended"), type: "radio", value: "s" }),
    el("select", { "aria-label": "Plan", name: "plan" }, { options: [optionActive, optionSuspended], selectedIndex: 1, value: "s" }),
    el("textarea", { "aria-label": "Note", name: "note" }, { value: SECRETS.textarea }),
    el("input", { name: "token" }, { invisible: true, type: "hidden", value: SECRETS.hidden }),
    el("button", { "aria-checked": "false", "aria-label": "Access", role: "switch" }),
  ];
  const dialog = el("div", { role: "dialog" }, {
    querySelectorAll: (selector: string) =>
      selector.includes("textarea") ? fields
        : selector.includes("h1") ? [el("h2", {}, {}, "Edit leaver.one@satopharma.com")]
          : selector.includes("button") ? [el("button", {}, {}, "Cancel"), el("button", { "aria-label": "Close modal" })]
            : [],
  }, `Edit leaver.one@satopharma.com ${PROSE}`);

  const g = globalThis as unknown as Record<string, unknown>;
  const saved = g.document;
  try {
    g.document = {
      body: dialog,
      getElementById: () => null,
      querySelector: (selector: string) => (selector === 'label[for="fwd"]' ? el("label", {}, {}, "Forward to") : null),
      querySelectorAll: (selector: string) => (selector.includes('role="dialog"') ? [dialog] : []),
    };
    assert.equal(readEditDialogOpenInPage(), true, "a visible dialog reads as open");

    const raw = readMailboxEditFormInPage();
    const rawJson = JSON.stringify(raw.fields);
    for (const [kind, value] of Object.entries(SECRETS)) {
      assert.equal(rawJson.includes(value), false, `the ${kind} field's VALUE must never leave the page`);
    }
    const byName = (name: string) => raw.fields.find((field) => field.name === name);
    assert.equal(byName("forwardTo")?.filled, SECRETS.text.length, "a text field reports its LENGTH");
    assert.equal(byName("forwardTo")?.label, "Forward to", "and its label from label[for]");
    assert.equal(byName("password")?.filled, SECRETS.password.length);
    assert.equal(byName("note")?.filled, SECRETS.textarea.length);
    assert.equal(byName("token")?.filled, null, "a hidden field reports no length at all");
    assert.equal(byName("token")?.hidden, true);
    assert.equal(byName("enabled")?.checked, true, "a checkbox reports ticked");
    assert.equal(byName("enabled")?.filled, null, "and no length");
    assert.deepEqual(byName("plan")?.options, ["Active", "Suspended"], "a select reports its option LABELS");
    assert.equal(byName("plan")?.selected, "Suspended", "and which one is chosen");
    const toggle = raw.fields.find((field) => field.type === "switch");
    assert.equal(toggle?.checked, false, "an ARIA switch reports on/off from aria-checked");
    assert.equal(toggle?.label, "Access");
    assert.equal(raw.scope, "dialog");

    const shaped = shapeMailboxEditForm(raw, "leaver.one@satopharma.com", []);
    const json = JSON.stringify(shaped);
    for (const [kind, value] of Object.entries(SECRETS)) {
      assert.equal(json.includes(value), false, `the ${kind} field's VALUE must never reach the answer`);
    }
    assert.equal("scopeText" in shaped, false, "the dialog's prose is used for one boolean and dropped");
    assert.equal(json.includes("PROSE-ONLY-MARKER"), false, "no prose that was not a label reaches the answer");
    assert.equal(shaped.namesAddress, true, "the form names the leaver");
    assert.deepEqual(
      shaped.fields.filter((field) => field.type === "radio").map((field) => field.options),
      [["Active", "Suspended"], ["Active", "Suspended"]],
      "a radio's options are its group's labels",
    );
    assert.deepEqual(shaped.buttons, ["Cancel", "Close modal"], "the form's own button wordings are reported");
    assert.equal(
      shapeMailboxEditForm(raw, "one@satopharma.com", []).namesAddress, false,
      "a substring of the address is not the address — whole tokens only",
    );
    assert.deepEqual(
      shapeMailboxEditForm({ ...raw, headings: ["Signed in as AdminPass99"] }, "leaver.one@satopharma.com", ["AdminPass99"]).headings,
      ["Signed in as [redacted]"],
      "a secret the run holds is removed from every label",
    );
  } finally {
    g.document = saved;
  }

  // The owning-row read: cell by cell, so the name never glues onto the address.
  const cells = [el("td", {}, {}, "Leaver One"), el("td", {}, {}, " leaver.one@satopharma.com ")];
  const row = el("tr", {}, { querySelectorAll: () => cells });
  const button = el("button", { "aria-label": "Edit" }, { closest: () => row });
  assert.deepEqual(readOwningRowCellsInPage(button as unknown as Element), ["Leaver One", "leaver.one@satopharma.com"]);
  assert.deepEqual(readOwningRowCellsInPage(el("button") as unknown as Element), [], "no row, no cells");

  // The dry run opens nothing and says so.
  const dry = createDryRunJoinerDriver();
  const reading = await dry.captureMailboxEditForm({ address: "leaver.one@satopharma.com" });
  assert.equal(reading.reached, false);
  assert.deepEqual(reading.fields, []);
  assert.deepEqual(dry.calls, ["captureMailboxEditForm:leaver.one@satopharma.com"]);

  // The route stores and answers the reading itself — which is why the reading must be value-free.
  const route = readable(ROUTE);
  assert.doesNotMatch(route, /\.value\b/, "the route never reads a field value");
}

// ── 5. The card ────────────────────────────────────────────────────────────────────────────────
function runCardCases(): void {
  const card = readable("../src/components/mailbox-offboarding/mailbox-edit-form-probe-card.tsx");
  assert.doesNotMatch(card, /router\.refresh|useRouter/, "no refresh after the run — it would erase the reading");
  assert.match(card, /fetch\("\/api\/mailbox-offboarding\/edit-form-controls"/);
  assert.match(card, /className=\{phxSelectClassName\}/, "the select wears the one form design");
  assert.match(card, /\{candidate\.name\} — \{candidate\.lastDay\}/, "the leaver is chosen by NAME, not by address");
  assert.doesNotMatch(card, /rounded|overflow-x-auto|truncate/, "square corners, no sideways scroll, no truncation");

  const page = readable("../app/(admin)/mailbox-offboarding/page.tsx");
  assert.match(page, /canReadEditForm = canReadInitialPassword\(access\.role\)/, "the card is the System Administrator's alone");
  const workspace = readable("../src/components/mailbox-offboarding/mailbox-offboarding-workspace.tsx");
  assert.match(workspace, /canReadEditForm && data \? \( <MailboxEditFormProbeCard/, "and it renders only behind that flag");
}

export async function runMailboxEditFormCaptureTests(): Promise<void> {
  runGateBeforeBodyCases();
  runRegisterBeforeDriverCases();
  runLeaveWithoutKeepingCases();
  await runNoValueCases();
  runCardCases();
}
