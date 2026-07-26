import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Guards unconfirmPart1 (owner request 2026-07-26): after manually correcting
 * an employee's base salary post-confirm (Ahmed Nagy case), HR needs to reopen
 * a Part-1-confirmed run so the First Part recomputes from the corrected data
 * on the next confirm. unconfirmPart1 is not pure (Supabase reads/writes), so
 * this is a source-scan test — pinning the phase guard, the "clear every
 * frozen First Part" behavior, and the run-state reset, so a future refactor
 * can't silently leave a stale frozen value in place or unconfirm a run that
 * was never confirmed.
 */
export function runAutomatedPayrollUnconfirmPart1Tests() {
  const source = readFileSync(new URL("../src/lib/automated-payroll/run-service.ts", import.meta.url), "utf8");

  const fnStart = source.indexOf("export async function unconfirmPart1");
  assert.ok(fnStart >= 0, "unconfirmPart1 must be exported from run-service.ts");
  const nextExportStart = source.indexOf("\nexport ", fnStart + 1);
  const fnBody = source.slice(fnStart, nextExportStart > 0 ? nextExportStart : undefined);

  assert.ok(
    fnBody.includes('if (run.phase !== "part2")'),
    "must only allow unconfirming a run whose Part 1 is confirmed and Part 2 is not (phase === 'part2')",
  );
  assert.ok(
    fnBody.includes("firstPartFrozen: null"),
    "must clear every draft row's frozen First Part — a stale pre-correction value must not survive to Part 2",
  );
  assert.ok(fnBody.includes('phase: "part1"'), "must reset the run back to the part1 phase");
  assert.ok(
    fnBody.includes("part1ConfirmedAt: null") && fnBody.includes("part1ConfirmedBy: null"),
    "must clear the Part 1 confirmation stamp so confirmPart1 can run again cleanly",
  );
  assert.ok(fnBody.includes('action: "part1_unconfirmed"'), "must write an audit log entry for the reversal");

  // ---- API route + UI wiring --------------------------------------------
  const routeSource = readFileSync(
    new URL("../app/api/automated-payroll/runs/[runId]/part1/unconfirm/route.ts", import.meta.url),
    "utf8",
  );
  assert.ok(routeSource.includes("unconfirmPart1"), "the unconfirm API route must call the service function");
  assert.ok(routeSource.includes("assertSameOriginMutation"), "the mutation route must carry the CSRF guard like every other automated-payroll route");

  const wizardSource = readFileSync(
    new URL("../src/components/automated-payroll/automated-payroll-wizard.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(
    wizardSource.includes("/part1/unconfirm"),
    "the wizard must expose an Unconfirm Part 1 action wired to the new route",
  );
}
