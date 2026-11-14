import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { assertSameOriginMutation } from "../src/lib/security/api-csrf.ts";

const apiRoot = path.join(process.cwd(), "app", "api");

function walkRouteFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkRouteFiles(fullPath);
    return entry.name === "route.ts" ? [fullPath] : [];
  });
}

// A prefix that actually consumes the guard's return value: an assignment, a `return`, or use
// inside an expression. Anything else — a bare call, a `void` — throws the 403 away.
const consumesGuardResult = /(?:=|\breturn|\(|,|\?\?|\|\||&&|!)\s*$/;

function prefixBeforeCall(source: string, callIndex: number): string {
  const lineStart = source.lastIndexOf("\n", callIndex - 1) + 1;
  const sameLine = source.slice(lineStart, callIndex).trimEnd();
  if (sameLine.trim()) return sameLine;

  // `const csrf =` on its own line, call on the next — read back to the last non-blank line.
  const earlierLines = source.slice(0, lineStart).split("\n");
  for (let index = earlierLines.length - 1; index >= 0; index -= 1) {
    const candidate = String(earlierLines[index]).trimEnd();
    if (candidate.trim()) return candidate;
  }
  return "";
}

const csrfProtectedMutationRoutes = [
  "../app/api/excuses/[id]/reassign/route.ts",
  "../app/api/weekly-plans/[id]/reassign/route.ts",
  "../app/api/admin/outstation/[id]/route.ts",
  "../app/api/admin/outstation/calculate-manager-distance/route.ts",
  "../app/api/admin/outstation/manager-expenses/[id]/route.ts",
  "../app/api/admin/outstation/manager-expenses/route.ts",
  "../app/api/contracts/[id]/workflow/route.ts",
  "../app/api/contracts/route.ts",
  "../app/api/employees/[hrId]/resign/route.ts",
  "../app/api/employees/route.ts",
  "../app/api/outstation/calculate/route.ts",
  "../app/api/outstation/capture-location/route.ts",
  "../app/api/outstation/medical-rep-expenses/route.ts",
  "../app/api/outstation/policy/route.ts",
  "../app/api/outstation/reverse-geocode/route.ts",
  "../app/api/outstation/submit/route.ts",
  "../app/api/outstation/sync-offline/route.ts",
  "../app/api/payroll/[id]/replace/route.ts",
  "../app/api/payroll/[id]/route.ts",
  "../app/api/payroll/[id]/workflow/route.ts",
  "../app/api/admin/outstation/expenses/analyze/route.ts",
  "../app/api/admin/outstation/expenses/import/route.ts",
  "../app/api/admin/outstation/expenses/reports/[id]/route.ts",
  "../app/api/admin/outstation/expenses/route.ts",
  "../app/api/payroll/upload/route.ts",
  "../app/api/payroll/validate/route.ts",
  "../app/api/recruitment/applications/[id]/convert/route.ts",
  "../app/api/recruitment/applications/[id]/workflow/route.ts",
  "../app/api/recruitment/applications/route.ts",
  "../app/api/recruitment/applications/[id]/interviews/route.ts",
  "../app/api/recruitment/interviews/[id]/route.ts",
  "../app/api/recruitment/candidates/import/route.ts",
  "../app/api/recruitment/candidates/route.ts",
  "../app/api/recruitment/candidates/[id]/files/route.ts",
  "../app/api/recruitment/requisitions/[id]/workflow/route.ts",
  "../app/api/recruitment/requisitions/route.ts",
  "../app/api/resignations/[id]/dates/route.ts",
  "../app/api/resignations/[id]/workflow/route.ts",
  "../app/api/resignations/route.ts",
  "../app/api/recruitment/intake/retry/route.ts",
  "../app/api/admin/activity/force-logout/route.ts",
];

export function runCsrfRouteCoverageTests() {
  // The premise the scan below rests on: the guard REPORTS a rejection by returning a 403 — it
  // never throws. So a caller that drops the return value silently protects nothing, and no
  // compiler, linter or type-checker objects. This is the only thing that can catch it.
  const rejected = assertSameOriginMutation(
    new Request("https://phoenix-hr.satopharma.com/api/anything", { method: "POST" }),
  );
  assert.ok(
    rejected,
    "assertSameOriginMutation must RETURN a rejection for a cross-origin mutation, not throw — "
      + "if this ever changes to throwing, the discarded-return scan below is no longer the guard.",
  );
  assert.equal(rejected.status, 403, "the returned CSRF rejection must be a 403.");

  for (const routeFile of walkRouteFiles(apiRoot)) {
    const source = readFileSync(routeFile, "utf8");
    const relative = path.relative(process.cwd(), routeFile).replaceAll("\\", "/");

    for (const match of source.matchAll(/assertSameOriginMutation\s*\(/g)) {
      const callIndex = match.index ?? 0;
      const prefix = prefixBeforeCall(source, callIndex);
      const line = source.slice(0, callIndex).split("\n").length;
      assert.ok(
        consumesGuardResult.test(prefix),
        `${relative}:${line} discards the return of assertSameOriginMutation, which makes the CSRF `
          + "check a no-op. Assign it and return it: `const csrf = assertSameOriginMutation(request); "
          + "if (csrf) return csrf;`",
      );

      // Assigning the rejection and then never returning it is the same no-op one step later.
      const assigned = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=$/.exec(prefix);
      if (!assigned) continue;
      const name = assigned[1];
      const restOfHandler = source.slice(callIndex).split(/\n\s*export (?:async )?function /)[0];
      assert.match(
        restOfHandler,
        new RegExp(`return\\s+${name}\\b`),
        `${relative}:${line} assigns the CSRF rejection to \`${name}\` but never returns it, so the `
          + "handler carries on and mutates anyway.",
      );
    }
  }

  for (const route of csrfProtectedMutationRoutes) {
    const source = readFileSync(new URL(route, import.meta.url), "utf8");
    const mutationHandlers = source.match(/export async function (POST|PATCH|PUT|DELETE)\b/g) ?? [];
    const guardCalls = source.match(/assertSameOriginMutation\(request\)/g) ?? [];

    assert.match(
      source,
      /assertSameOriginMutation/,
      `${route} must call the same-origin CSRF guard before mutation handling.`,
    );
    assert.ok(
      guardCalls.length >= mutationHandlers.length,
      `${route} must guard every POST/PATCH/PUT/DELETE handler.`,
    );
  }
}
