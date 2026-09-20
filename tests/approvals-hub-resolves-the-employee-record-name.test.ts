import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  employeeRecordName,
  resolveEmployeeRecordName,
} from "../src/lib/employees/record-name.ts";
import { outstationRecordName } from "../src/lib/outstation/employee-name.ts";

// PRs #4135 and #4136 aligned the outstation write and read paths to the employee RECORD name.
// The approvals hub resolved the SAME kind of persisted `employee_name` snapshot — leave, excuses
// and weekly plans — to `displayName`, which is nickname-first by design. So one outstation
// request read as the record name on the outstation queue and as a nickname in the hub, for the
// same person on the same day.
//
// This pins two things: the rule has ONE definition that both domains share, and the hub uses it.
// Two copies of a naming rule is exactly how that gap opened, so a re-fork must fail here.

const APPROVALS_HUB = join(process.cwd(), "src/lib/approvals-hub/service.ts");

/** The body of one function declaration, from its signature to the closing brace in column 1. */
function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} must exist — this test is pinned to it by name`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `${declaration} must be a top-level function`);
  return source.slice(start, end + 2);
}

export function runApprovalsHubResolvesTheEmployeeRecordNameTests() {
  // ── The rule ──────────────────────────────────────────────────────────────
  assert.equal(
    employeeRecordName({
      fullName: "Khaled Mohamed Ali Bedair",
      displayName: "Khaled Bedair",
      hrId: "A-2",
    }),
    "Khaled Mohamed Ali Bedair",
    "the record name is full_name, never the nickname-first display name",
  );
  assert.equal(
    employeeRecordName({ fullName: "  Dina   Hamdy  Fadel ", displayName: null, hrId: "B-12" }),
    "Dina Hamdy Fadel",
    "whitespace in the stored full name is collapsed, not rendered as typed",
  );
  assert.equal(
    employeeRecordName({ fullName: "", displayName: "Rana Adel", hrId: "B-13" }),
    "Rana Adel",
    "a record with a blank full name falls back to the display name, never to a blank",
  );
  assert.equal(
    employeeRecordName({ fullName: null, displayName: null, hrId: "B-13" }),
    "B-13",
    "a record with no name at all yields the HR id — the rule never yields an empty string",
  );

  // ── The guards, all of which land on the stored snapshot ──────────────────
  assert.equal(
    resolveEmployeeRecordName("Khaled Mohamed Ali Bedair", "A-2", "Khaled Bedair"),
    "Khaled Mohamed Ali Bedair",
    "a resolved record name replaces the snapshot the row was written with",
  );
  assert.equal(
    resolveEmployeeRecordName(null, null, "Historic Import Name"),
    "Historic Import Name",
    "a row carrying no HR id keeps its stored name — there is nothing to resolve against",
  );
  assert.equal(
    resolveEmployeeRecordName(null, "B-999", "Someone Who Left"),
    "Someone Who Left",
    "an HR id the directory cannot answer for keeps the stored name rather than blanking",
  );
  assert.equal(
    resolveEmployeeRecordName("B-122", "B-122", "Amr Naguib"),
    "Amr Naguib",
    "a record that resolved to its own HR id has no usable name — the stored name beats a code",
  );
  assert.equal(
    resolveEmployeeRecordName("B-122", "b-122", ""),
    "B-122",
    "with nothing stored either, the HR id is still better than an empty cell",
  );

  // ── ONE definition, two spellings ─────────────────────────────────────────
  assert.equal(
    outstationRecordName,
    employeeRecordName,
    "outstationRecordName must BE the shared rule, not a second copy of it — the hub and the " +
      "outstation queue drifted apart once already because the rule existed in one domain only",
  );

  // ── The approvals hub uses it ─────────────────────────────────────────────
  const hub = readFileSync(APPROVALS_HUB, "utf8");
  const resolver = functionBody(hub, "function liveEmployeeName(");

  assert.ok(
    resolver.includes("resolveEmployeeRecordName("),
    "liveEmployeeName must resolve through the shared rule",
  );
  assert.ok(
    !resolver.includes("displayName"),
    "liveEmployeeName must not reach for displayName — it renders a persisted workflow snapshot, " +
      "and EmployeeDirectoryRow's own type comment reserves fullName for exactly that. Resolving " +
      "to displayName puts the nicknames back on the cards the record-name repair aligned.",
  );

  // Every snapshot render in this file goes through the one resolver: ten call sites across leave,
  // excuses, weekly plans and the plan tracker's "submitted" step.
  const callSites = hub.split("\n").filter((line) => line.includes("liveEmployeeName(directory"))
    .length
    + hub.split("\n").filter((line) => line.includes("liveEmployeeName(employees")).length;
  assert.ok(
    callSites >= 10,
    `every employee_name snapshot the hub renders must route through liveEmployeeName — found ` +
      `${callSites} call sites, expected the full ten. A new list that resolves a name inline is ` +
      `how this drifts again.`,
  );

  // ── The name has to be READABLE, not ellipsised ───────────────────────────
  //
  // These three lists all share one shape: a `min-w-0` text column beside a `shrink-0` chip
  // column, so the text column shrinks and the row can never push the page sideways. They also
  // all carried `truncate` on the name, which is `text-overflow: ellipsis`. Measured at 375px
  // with the longest name the employee master actually holds — 55 characters — that clipped 349px
  // of it. The owner's rule is that where an ellipsis and the no-horizontal-scroll rule collide,
  // wrapping wins; at 1440px both spellings fit on one line, so this costs the desktop nothing.
  // The whole folder, not just the name lines: the owner asked for the secondary lines too, and a
  // folder-wide assertion is the one a new card cannot be added around.
  const hubDir = join(process.cwd(), "src/components/approvals-hub");
  const truncating: string[] = [];
  for (const entry of readdirSync(hubDir)) {
    if (!entry.endsWith(".tsx")) continue;
    readFileSync(join(hubDir, entry), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/className="[^"]*\btruncate\b/.test(line)) truncating.push(`${entry}:${i + 1}`);
      });
  }
  assert.deepEqual(
    truncating,
    [],
    "no card in the approvals hub may truncate its text. These render the employee RECORD name, " +
      "which runs to four and five parts — at 375px the longest one in the employee master had " +
      "349px of itself hidden behind an ellipsis. Every one of these sits in a min-w-0 column " +
      "beside a shrink-0 sibling, so wrapping grows the row taller and never pushes the page " +
      "sideways. Truncating at: " + truncating.join(", "),
  );

  for (const file of [
    "src/components/approvals-hub/approvals-workspace.tsx",
    "src/components/approvals-hub/history-list.tsx",
    "src/components/approvals-hub/company-requests-list.tsx",
  ]) {
    const nameLine = readFileSync(join(process.cwd(), file), "utf8")
      .split("\n")
      .find((line) => line.includes("text-sm font-bold text-slate-900"));
    assert.ok(nameLine, `${file} must still render the employee name in its own bold line`);
    assert.ok(
      nameLine.includes("break-words"),
      `${file} must WRAP the employee name — dropping the truncate without wrapping would let it ` +
        `overflow its column instead`,
    );
  }

  // ── The one deliberate exception ──────────────────────────────────────────
  assert.ok(
    functionBody(hub, "function deciderDisplayName(").includes("employee.displayName"),
    "deciderDisplayName is NOT resolving a snapshot — it names a live person beside their job " +
      "title, which is the live-UI case displayName exists for. It must stay as it is.",
  );
}
