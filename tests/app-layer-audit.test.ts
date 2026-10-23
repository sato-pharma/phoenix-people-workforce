import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { csvCell, neutralizeCsvFormula } from "../src/lib/export/csv-cell.ts";
import { clientSafeErrorMessage, toApiError } from "../src/lib/http/api-errors.ts";
import {
  INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT,
  isIncentiveEligible,
} from "../src/lib/incentives/eligibility-threshold.ts";
import { calculateIncentive2026 } from "../src/lib/incentives/scheme-2026.ts";
import { createRequestSequence, planForSelection } from "../src/lib/production-planning/request-sequence.ts";
import { prepareSatoEmailBody } from "../src/lib/sato-email/render.ts";
import {
  REJECTION_REASON_REQUIRED,
  vacationDecisionFailureMessage,
  vacationDecisionFormProblem,
  vacationDecisionRetryPath,
} from "../src/lib/vacation/decision-form.ts";

/**
 * The app-layer findings of the 23 Oct 2026 technical audit (§17.6, PR "E"), one runner each.
 * Every headline assertion here was proven by breaking its fix and watching it fail.
 */

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

/** A live event-handler attribute anywhere in a tag — what an email body must never carry. */
const EVENT_HANDLER_IN_A_TAG = /<[a-z][^>]*\son[a-z]+\s*=/i;

// ── P7-02 ───────────────────────────────────────────────────────────────────────────────────────
export function runSatoEmailFinalSanitizeTests() {
  // The reproduced bypass: `stripFills` removes ` bgcolor='…'` from inside a title attribute up to a
  // quote in the following text, and the text after it became live attributes again.
  const bypass = `<p><span title="q bgcolor='">'" onmouseover="alert(1)" x="</span> hi</p>`;
  const sent = prepareSatoEmailBody(bypass);
  assert.equal(
    EVENT_HANDLER_IN_A_TAG.test(sent),
    false,
    `🔴 a body the regex rewrites re-armed must leave with NO event handler — the preview renders this string and the same string is sent. Got: ${sent}`,
  );

  // The same trick through the other rewrites: a background shorthand and a javascript: link.
  const viaBackground = prepareSatoEmailBody(
    `<p><span title="a background:x;">" onclick="alert(1)" y="</span></p><a href="javascript:alert(1)">x</a>`,
  );
  assert.equal(EVENT_HANDLER_IN_A_TAG.test(viaBackground), false, "no handler survives any rewrite");
  assert.equal(/javascript:/i.test(viaBackground), false, "and no javascript: link");

  // The final pass only removes: the house markup it stamps is still there, byte for byte.
  const table = prepareSatoEmailBody("<h2>Heading</h2><table><tr><th>A</th></tr><tr><td>1</td></tr></table>");
  assert.ok(table.includes('class="sato-cell"'), "the phone sheet's cell tag survives the last pass");
  assert.ok(table.includes('role="presentation"'), "the section rule's presentation table survives");
  assert.ok(table.includes("&nbsp;</td>"), "the spacer entity is kept as written, not decoded");
  assert.ok(table.includes("mso-table-lspace:0pt"), "Outlook's own declarations are kept verbatim");
}

// ── P7-04 ───────────────────────────────────────────────────────────────────────────────────────
export function runProductionPlanningRequestSequenceTests() {
  const loads = createRequestSequence();
  // He picks product A, then product B before A's answer is back.
  const forA = loads.begin();
  const forB = loads.begin();
  // B answers first, then A arrives late.
  const applied: string[] = [];
  if (loads.isCurrent(forB)) applied.push("B");
  if (loads.isCurrent(forA)) applied.push("A");
  assert.deepEqual(
    applied,
    ["B"],
    "🔴 a late answer for the product he LEFT must be dropped — only the newest request may write the screen",
  );

  const calculations = createRequestSequence();
  const pending = calculations.begin();
  calculations.invalidate(); // a new product's payload replaced the one this plan was computed for
  assert.equal(calculations.isCurrent(pending), false, "a plan still in flight when the product changed is stale");

  const planForA = { productId: "product-a" };
  assert.equal(planForSelection(planForA, "product-b"), null, "A's plan is never shown — or saved — under B");
  assert.equal(planForSelection(planForA, "product-a"), planForA, "and is shown while A is selected");
  assert.equal(planForSelection(planForA, ""), null, "nothing selected yet, nothing to save");

  const workspace = read("src/components/production-planning/production-planning-workspace.tsx");
  assert.match(workspace, /const ticket = loads\.begin\(\);/, "every load takes a ticket");
  assert.match(workspace, /if \(!loads\.isCurrent\(ticket\)\) return;\n\s*if \(!response\.ok\)/, "and checks it before writing anything");
  assert.equal(
    (workspace.match(/plan=\{shownPlan\}/g) ?? []).length,
    2,
    "the Planner and Cost tabs are handed only the selected product's plan, never the raw one",
  );
}

// ── P7-05 ───────────────────────────────────────────────────────────────────────────────────────
export function runVacationDecisionFormTests() {
  assert.equal(
    vacationDecisionFormProblem("reject", "   "),
    REJECTION_REASON_REQUIRED,
    "🔴 a reject with no reason is refused ON THE FORM with the service's own sentence — never the outage screen",
  );
  assert.equal(vacationDecisionFormProblem("reject", "Overlaps the audit week"), null, "a reasoned reject passes");
  assert.equal(vacationDecisionFormProblem("approve", ""), null, "an approval needs no comment");

  assert.equal(
    vacationDecisionFailureMessage(new Error("This vacation request already has a final decision.")),
    "This vacation request already has a final decision.",
    "the service's refusal is shown in its own words",
  );
  const wrapped = vacationDecisionFailureMessage(new Error('duplicate key value violates unique constraint "vacation_requests_pkey"'));
  assert.ok(!wrapped.includes("vacation_requests_pkey"), "a database sentence is never shown");
  assert.equal(
    vacationDecisionFailureMessage(new Error("Forbidden: not this step's approver.")),
    "You are not authorized to decide this vacation request.",
  );
  assert.equal(
    vacationDecisionRetryPath("abc-1", "reject", REJECTION_REASON_REQUIRED),
    "/leave-management/vacation-decision/abc-1?decision=reject&decisionError=A+rejection+reason+is+required.",
    "a refusal comes back to the same page, on the same decision",
  );

  const page = read("app/(admin)/leave-management/vacation-decision/[id]/page.tsx");
  assert.match(page, /required=\{reasonRequired\}/, "the reason box is required on a reject, matching the server");
  assert.match(
    page,
    /try \{\n\s*await decideVacationRequest\(access, \{ decision, decisionComment, requestId \}\);\n\s*\} catch \(error\) \{\n\s*failure = vacationDecisionFailureMessage\(error\);/,
    "the Server Action catches the service's refusal",
  );
  assert.doesNotMatch(page, /recommended/i, "the screen no longer calls a required reason 'recommended'");
}

// ── F-19 ────────────────────────────────────────────────────────────────────────────────────────

/**
 * The raw-error shapes still left in route files. Counted, so the number can only go down. At this
 * PR every one left is a CRON or notification route answering a machine (cron-job.org, the dead
 * man's switch) or the payslips route's development-only branch — none answers a person.
 */
const RAW_ROUTE_ERROR_BASELINE = 17;
const RAW_ROUTE_ERROR_PATTERNS = [
  /\b(\w+) instanceof Error \? \1\.message\b(?!\.toLowerCase)/g,
  /\bString\((?:error|err|e|caught|cause|reason)(?: \?\? "")?\)/g,
  /JSON\.stringify\((?:error|err|e)\)/g,
];

function rawRouteErrorSites() {
  const files = execSync("git ls-files app", { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((file) => file.endsWith("/route.ts"));
  const sites: string[] = [];
  for (const file of files) {
    read(file)
      .split("\n")
      .forEach((line, index) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        for (const pattern of RAW_ROUTE_ERROR_PATTERNS) {
          pattern.lastIndex = 0;
          for (const _match of line.matchAll(pattern)) sites.push(`${file}:${index + 1}`);
        }
      });
  }
  return sites;
}

export function runApiErrorWrappedDatabaseTextTests() {
  const FALLBACK = "Could not save the plan.";
  // The ~270 domain wrappers: `throw new Error(error.message)` keeps Postgres's words, loses its fields.
  const wrapped = new Error('duplicate key value violates unique constraint "employees_crm_username_unique_idx"');
  assert.equal(
    toApiError(wrapped, FALLBACK).message,
    FALLBACK,
    "🔴 a re-wrapped database error must reach the caller as the fallback — the constraint name is the leak",
  );
  assert.equal(clientSafeErrorMessage(wrapped, FALLBACK), FALLBACK, "the route-level helper redacts it the same way");
  assert.equal(
    clientSafeErrorMessage(new Error('Save failed: column employees.salary_note does not exist'), FALLBACK),
    FALLBACK,
    "a wrapper's own prefix does not hide the database sentence after it",
  );
  assert.equal(
    toApiError(new Error("canceling statement due to statement timeout"), FALLBACK).status,
    503,
    "a re-wrapped timeout still gets its own actionable 503",
  );
  for (const text of [
    "Could not find the table 'public.x' in the schema cache",
    'new row violates row-level security policy for table "salary_records"',
    'invalid input syntax for type uuid: "abc"',
    "TypeError: fetch failed",
  ]) {
    assert.equal(clientSafeErrorMessage(new Error(text), FALLBACK), FALLBACK, `redacted: ${text}`);
  }
  // Our own prose is untouched — including prose that merely mentions a column or a fetch.
  for (const text of [
    "A rejection reason is required.",
    "The column mapping does not exist.",
    "Google Drive metadata fetch failed.",
    "That vacation request was not found.",
  ]) {
    assert.equal(clientSafeErrorMessage(new Error(text), FALLBACK), text, `kept: ${text}`);
  }
  assert.equal(toApiError(new Error("That vacation request was not found."), FALLBACK).status, 404);

  const sites = rawRouteErrorSites();
  assert.ok(
    sites.length <= RAW_ROUTE_ERROR_BASELINE,
    `raw error text in route files may only go DOWN (baseline ${RAW_ROUTE_ERROR_BASELINE}, now ${sites.length}) — use clientSafeErrorMessage / toApiError:\n${sites.join("\n")}`,
  );
  const exposed = sites.filter((site) => /^app\/api\/(public|share)\//.test(site));
  assert.deepEqual(exposed, [], "a route anyone can reach without signing in carries no raw error text at all");
}

// ── S-APP-03 ────────────────────────────────────────────────────────────────────────────────────
const THRESHOLD_SCREENS = [
  "app/employee-portals/team-performance/page.tsx",
  "app/employee-portals/med-reps-performance/page.tsx",
  "app/employee-portals/dsms-performance/page.tsx",
  "app/(admin)/admin/field-sales/dsm-performance/page.tsx",
  "app/(admin)/admin/field-sales/med-reps-performance/page.tsx",
  "app/employee-portals/team-performance/team-members-breakdown.client.tsx",
];

export function runIncentiveThresholdConstantTests() {
  // The constant is checked against the LOCKED curve, read-only: the badge and the money agree.
  const below = calculateIncentive2026({ achievementPercent: INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT - 0.01, basicSalary: 10_000 });
  const at = calculateIncentive2026({ achievementPercent: INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT, basicSalary: 10_000 });
  assert.equal(below.payoutPercentage, 0, "just under the shared threshold the locked scheme pays nothing");
  assert.equal(at.payoutPercentage, 50, "at the shared threshold the locked scheme starts paying");
  assert.equal(INCENTIVE_ELIGIBILITY_THRESHOLD_PERCENT, 90, "the value the screens showed before is unchanged");
  assert.equal(isIncentiveEligible(90), true);
  assert.equal(isIncentiveEligible(89.9), false);

  for (const file of THRESHOLD_SCREENS) {
    const source = read(file);
    assert.match(source, /from "@\/lib\/incentives\/eligibility-threshold"/, `${file} imports the one threshold`);
    assert.doesNotMatch(
      source,
      /(>=|<|<=|>)\s*90\b|\b90\s*-\s*\w|x=\{90\}|"90%"|\b90-99%/,
      `🔴 ${file} carries no private copy of the 90% threshold`,
    );
  }

  // Owner, 2026-10-23: the "Avg" line under Team Achievement is removed. A plain mean of the reps' own
  // percentages (covered sales, a no-target rep at 0%) read as a second, contradicting team figure —
  // 28.2% beside 59.5% for Upper Egypt 2. The chart's orange line sits AT the team figure, so it says "Team".
  const teamPage = read("app/employee-portals/team-performance/page.tsx");
  assert.doesNotMatch(teamPage, />Avg: \{|reduce\(\(s, m\) => s \+ m\.achievementPercent/, "🔴 Team Performance shows no per-rep mean beside the team figure");
  const teamChart = read("app/employee-portals/team-performance/team-members-breakdown.client.tsx");
  assert.match(teamChart, /x=\{Math\.round\(teamAchievementPercent \* 10\) \/ 10\}[\s\S]{0,120}value: "Team"/, "the team-figure line on the chart is labelled Team");
  assert.doesNotMatch(teamChart, /value: "Avg"/, "🔴 no chart line is labelled Avg");
}

// ── S-APP-08 ────────────────────────────────────────────────────────────────────────────────────
export function runCsvFormulaNeutraliserTests() {
  assert.equal(
    csvCell('=HYPERLINK("https://evil.example","Open CV")'),
    `"'=HYPERLINK(""https://evil.example"",""Open CV"")"`,
    "🔴 a candidate name that is a formula reaches the sheet as TEXT — apostrophe first, then RFC4180 quoting",
  );
  assert.equal(neutralizeCsvFormula("@SUM(A1:A9)"), "'@SUM(A1:A9)");
  assert.equal(neutralizeCsvFormula("+cmd"), "'+cmd");
  assert.equal(neutralizeCsvFormula("-2+3+cmd|' /C calc'!A0"), "'-2+3+cmd|' /C calc'!A0", "the classic DDE payload");
  assert.equal(neutralizeCsvFormula("\t=1+1"), "'\t=1+1");

  // What must NOT change, or the feed fills with apostrophes.
  assert.equal(csvCell(-500), "-500", "a negative number stays a number");
  assert.equal(csvCell("-1250.50"), "-1250.50", "a negative amount written as text stays a number");
  assert.equal(csvCell("+20 100 123 4567"), "+20 100 123 4567", "a phone number is not a formula");
  assert.equal(csvCell("-"), "-", "a dash used as an empty marker is left alone");
  assert.equal(csvCell("Mona, Ali"), '"Mona, Ali"', "RFC4180 quoting is unchanged");
  assert.equal(csvCell(null), "");

  for (const file of [
    "src/lib/recruitment/cv-lifecycle.ts",
    "src/lib/direct-orders/report-share-links.ts",
    "src/lib/marketing-requests/report-share-links.ts",
  ]) {
    const source = read(file);
    assert.match(source, /import \{ csvCell \} from "@\/lib\/export\/csv-cell";/, `${file} uses the shared cell`);
    assert.doesNotMatch(source, /function csvCell\(/, `${file} keeps no private, un-neutralised copy`);
  }
}
