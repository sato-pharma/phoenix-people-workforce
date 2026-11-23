import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import ts from "typescript";

// ─────────────────────────────────────────────────────────────────────────────
// THE PRIVATE CALENDAR STARTS EVERY READ TOGETHER (owner, 2026-11-23: "fix the calendar").
//
// `getPrivateCalendarWorkspace` read its sources in one Promise.all and then, only once all of them
// had finished, awaited two more reads one after the other: the accepted deduction disputes (a
// company-wide event read plus a second wave, added 2026-11-13) and the reply threads under the
// review requests. Neither depends on a source: the deductions read depends on nothing loaded there,
// and the threads need only the disputes' ids. Both now start with the sources (the threads chained
// on the dispute read), so the calendar waits for its slowest read once instead of three times.
//
// What this pins is the SHAPE, read with the TypeScript compiler so a comment quoting a call cannot
// satisfy it: inside the workspace function neither read is awaited on its own, and both are still
// called there (a rename cannot make it look at nothing). Each pin is handed a broken copy and must fire.
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE = "../src/lib/private-calendar/service.ts";
const WORKSPACE = "getPrivateCalendarWorkspace";
const STARTED_TOGETHER = ["loadAcceptedDeductionCorrections", "listMessagesForDisputes"];

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");

function workspaceFunction(source: ts.SourceFile): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | null = null;
  source.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === WORKSPACE) found = node;
  });
  assert.ok(found, `${WORKSPACE} not found in ${SERVICE}`);
  return found;
}

/** The name at the root of a call chain: `a(...)`, `a(...).catch(...)`, `a(...).then(...)` all give `a`. */
function rootCallee(expression: ts.Expression): string | null {
  let current: ts.Expression = expression;
  while (true) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (ts.isIdentifier(callee)) return callee.text;
      if (ts.isPropertyAccessExpression(callee)) current = callee.expression;
      else return null;
    } else return null;
  }
}

export function serialReadsInWorkspace(text: string): { called: Set<string>; awaitedAlone: string[] } {
  const source = ts.createSourceFile("service.ts", text, ts.ScriptTarget.Latest, true);
  const fn = workspaceFunction(source);
  const called = new Set<string>();
  const awaitedAlone: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && STARTED_TOGETHER.includes(node.expression.text)) {
      called.add(node.expression.text);
    }
    if (ts.isAwaitExpression(node)) {
      const root = rootCallee(node.expression);
      if (root && STARTED_TOGETHER.includes(root)) awaitedAlone.push(root);
    }
    node.forEachChild(visit);
  };
  fn.forEachChild(visit);
  return { called, awaitedAlone };
}

function assertStartedTogether(text: string) {
  const { called, awaitedAlone } = serialReadsInWorkspace(text);
  for (const name of STARTED_TOGETHER) {
    assert.ok(called.has(name), `${WORKSPACE} no longer calls ${name}; this pin would be checking nothing`);
  }
  assert.deepEqual(awaitedAlone, [], `${WORKSPACE} awaits ${awaitedAlone.join(", ")} on its own instead of starting it with the sources`);
}

export function runPrivateCalendarReadsStartTogetherTests() {
  const text = read(SERVICE);
  assertStartedTogether(text);

  // Broken copy 1: the deductions read awaited after the batch again, as it was before 2026-11-23.
  const serialDeductions = text.replace(
    "const deductionCorrectionsPromise = loadAcceptedDeductionCorrections(",
    "const deductionCorrectionsPromise = await loadAcceptedDeductionCorrections(",
  );
  assert.notEqual(serialDeductions, text, "broken copy 1 did not apply — the pin's anchor moved");
  assert.throws(() => assertStartedTogether(serialDeductions), /awaits loadAcceptedDeductionCorrections/);

  // Broken copy 2: the reply threads awaited on their own, with the old `.catch` chained on.
  const serialMessages = text.replace(
    "const reviewRequests",
    "const lateMessages = await listMessagesForDisputes([]).catch(() => new Map());\n  const reviewRequests",
  );
  assert.notEqual(serialMessages, text, "broken copy 2 did not apply — the pin's anchor moved");
  assert.throws(() => assertStartedTogether(serialMessages), /awaits listMessagesForDisputes/);

  // Broken copy 3: a rename that leaves the pin looking at nothing.
  const renamed = text.replaceAll("loadAcceptedDeductionCorrections", "loadAcceptedDeductionFixes");
  assert.throws(() => assertStartedTogether(renamed), /no longer calls loadAcceptedDeductionCorrections/);
}
