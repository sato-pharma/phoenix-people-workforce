import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AccessContext } from "@/lib/auth/permissions";
import {
  PAYROLL_DOWNLOADS_PER_HOUR,
  PAYROLL_FILE_DOWNLOADED,
  recordPayrollFileDownload,
} from "@/lib/automated-payroll/download-log";
import { jsonError } from "@/lib/automated-payroll/http";
import { ApiRateLimitError } from "@/lib/security/api-rate-limit";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Every payroll sheet and bank file downloaded writes one row on its run, a person is limited per
 * hour, and the run lists them (REC-054, F-PAY-001). The row is driven through a fake client: this
 * suite runs with production credentials and must never write the real audit table.
 */
export async function runPayrollDownloadLogTests() {
  // ── One download, one row, naming who, which run and which file ───────────
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const fake = {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return { error: null };
      },
    }),
  } as unknown as Parameters<typeof recordPayrollFileDownload>[2];
  const access = { hrId: "b-10", loginId: "owner", role: "Finance Manager", source: "session" } as unknown as AccessContext;
  await recordPayrollFileDownload(
    access,
    { runId: "run-1", file: "fab_bank_file", scope: "part2", fileName: "FAB-Salary-Transfer-October-2026-part2.xlsx", rows: 42 },
    fake,
  );
  assert.equal(inserts.length, 1, "one download writes exactly one row");
  assert.equal(inserts[0].table, "automated_payroll_audit");
  assert.equal(inserts[0].row.run_id, "run-1");
  assert.equal(inserts[0].row.action, PAYROLL_FILE_DOWNLOADED);
  assert.equal(inserts[0].row.actor_hr_id, "B-10", "the actor is stored in canonical casing");
  assert.deepEqual(inserts[0].row.detail, {
    file: "fab_bank_file",
    scope: "part2",
    fileName: "FAB-Salary-Transfer-October-2026-part2.xlsx",
    rows: 42,
    role: "Finance Manager",
  });

  // ── A failed row never keeps finance from the file ────────────────────────
  const failing = {
    from: () => ({ insert: async () => ({ error: { message: "down" } }) }),
  } as unknown as Parameters<typeof recordPayrollFileDownload>[2];
  await recordPayrollFileDownload(access, { runId: "run-1", file: "cib_bank_file", scope: "part1", fileName: "x.xlsx", rows: 1 }, failing);

  // ── Past the limit is a readable 429, not a 500 ───────────────────────────
  assert.equal(PAYROLL_DOWNLOADS_PER_HOUR, 30);
  const refused = jsonError(new ApiRateLimitError(600));
  assert.equal(refused.status, 429);
  const refusedBody = (await refused.json()) as { error: string };
  assert.match(refusedBody.error, /Too many payroll files downloaded in the last hour\. Please try again in about 10 minutes\./);

  // ── All four builders: gate, limit, build, then the row ───────────────────
  const service = stripComments(readFileSync("src/lib/automated-payroll/run-service.ts", "utf8"));
  const builders: Array<[string, string, string]> = [
    ["buildRunSheet", "assertAutomatedPayrollHrActor(access)", '"run_sheet"'],
    ["buildFinanceSheet", "assertAutomatedPayrollFinanceActor(access)", '"finance_sheet"'],
    ["buildFabSheet", "assertAutomatedPayrollFinanceActor(access)", '"fab_bank_file"'],
    ["buildCibSheet", "assertAutomatedPayrollFinanceActor(access)", '"cib_bank_file"'],
  ];
  for (const [name, gate, file] of builders) {
    const start = service.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const end = service.indexOf("\nexport ", start + 1);
    const body = service.slice(start, end > start ? end : undefined);
    const gateAt = body.indexOf(gate);
    const limitAt = body.indexOf("await assertPayrollDownloadAllowed(access)");
    const buildAt = body.indexOf("Workbook(");
    const recordAt = body.indexOf(`await recordPayrollFileDownload(access, { runId: run.id, file: ${file}`);
    const returnAt = body.lastIndexOf("return {");
    assert.ok(gateAt >= 0 && limitAt > gateAt, `${name} checks the role, then the limit`);
    assert.ok(buildAt > limitAt, `${name} builds nothing before the limit`);
    assert.ok(recordAt > buildAt && recordAt < returnAt, `${name} writes its row after the file is built and before it is returned`);
  }

  // ── The history route is Super Admin's, like the wizard ───────────────────
  const route = stripComments(readFileSync("app/api/automated-payroll/runs/[runId]/downloads/route.ts", "utf8"));
  assert.ok(
    route.indexOf("assertAutomatedPayrollHrActor(access)") >= 0 &&
      route.indexOf("assertAutomatedPayrollHrActor(access)") < route.indexOf("listRunDownloads("),
    "the history is read only after the Super Admin gate",
  );
  const log = stripComments(readFileSync("src/lib/automated-payroll/download-log.ts", "utf8"));
  const list = log.slice(log.indexOf("export async function listRunDownloads"));
  assert.match(list, /^[^{]*\{\s*assertAutomatedPayrollHrActor\(access\);/, "the service gates the history too");
  assert.match(list, /\.eq\("run_id", runId\)\s*\.eq\("action", PAYROLL_FILE_DOWNLOADED\)/, "only this run's downloads");
}
