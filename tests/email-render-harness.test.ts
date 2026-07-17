import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// FUNCTIONAL email-render harness (added after the 2026-07-14 blank-token incident). Unlike a source
// assertion, this actually runs the render engine (contextVariables + interpolate from render-core,
// which has no JSX imports so it loads under the type-stripping runner) and asserts token VALUES
// appear in the output. It also enforces, for EVERY module, that each {{token}} used in a template
// body is resolvable by the render map — the systemic guard against "declared but not rendered".
import { contextVariables, interpolate } from "../src/lib/email-templates/render-core.ts";

export function runEmailRenderHarnessTests() {
  // ── 1) The render map resolves each probation token to its input value (the exact bug) ──
  const ctx = {
    dvDate: "2026-07-13", evaluatorName: "Mina Farouk", evaluatorRole: "District Manager",
    visitCount: "3", dvProgress: "DM 2/3 · Total 4/6", milestoneDay: "60",
    probationDay: "44", daysRemaining: "46", provisionalScore: "6.8 / 10", riskStatus: "not decision ready",
    employeeName: "Engy Said", employeeHrId: "CN-0004", area: "Cairo", status: "Feedback pending",
  } as const;
  const vars = contextVariables(ctx, "Team");
  for (const [k, v] of Object.entries(ctx)) {
    assert.equal((vars as Record<string, string>)[k], v, `contextVariables must resolve ${k} to its value (render-map completeness)`);
  }

  // ── 2) interpolate actually fills a probation-shaped body — the fields that shipped blank ──
  const body =
    "day {{probationDay}} of probation · DV {{dvDate}} · Evaluator {{evaluatorName}} ({{evaluatorRole}}) · " +
    "{{visitCount}} visits · Progress {{dvProgress}} · Score {{provisionalScore}} · Risk {{riskStatus}}";
  const out = interpolate(body, vars, false);
  assert.doesNotMatch(out, /\{\{/, "no unresolved {{token}} remains in the rendered body");
  for (const value of ["day 44 of probation", "DV 2026-07-13", "Evaluator Mina Farouk", "(District Manager)",
    "3 visits", "DM 2/3 · Total 4/6", "Score 6.8 / 10", "Risk not decision ready"]) {
    assert.ok(out.includes(value), `rendered body must contain "${value}"`);
  }

  // ── 3) SYSTEMIC (all modules): every {{token}} used in a template body must be in the render map ──
  const svc = readFileSync("src/lib/email-templates/service.ts", "utf8");
  const usedTokens = new Set(Array.from(svc.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)).map((m) => m[1]));
  const mappedKeys = new Set(Object.keys(contextVariables({}, "Team")));
  const unmapped = [...usedTokens].filter((t) => !mappedKeys.has(t)).sort();
  assert.deepEqual(unmapped, [], `every {{token}} used in a template body must be mapped in contextVariables(); unmapped: ${unmapped.join(", ")}`);
}
