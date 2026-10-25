import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { workerOnlyRouteRefusal } from "../src/lib/platform/process-role.ts";
import { JOBS as DECLARED_JOBS, PROD, WORKER, planJobAction } from "../scripts/cronjob-sync.mjs";

type Declaration = {
  adopted?: { jobId: number };
  base?: string;
  enabled?: boolean;
  path: string;
  schedule: Record<string, number[]>;
};
const JOBS = DECLARED_JOBS as unknown as Record<string, Declaration>;

/**
 * THE HEAVY CRON ROUTES RUN ON THE WORKER ONLY, AND THE REPOSITORY SAYS WHICH JOBS CALL IT
 * (23 Oct 2026 audit, F-04 / S-INT-07 / S-INT-19).
 *
 * The process-role split stopped the in-process schedulers on the page server, but nothing stopped a
 * cron-job.org job pointed at the website from running the heavy routes there. They now answer 503
 * `wrong_process` where PHOENIX_PROCESS_ROLE=web. And the five hand-made jobs behind them are declared
 * in scripts/cronjob-sync.mjs as `adopted` — reported, never written, even under --apply (so the
 * auto-arm on merge writes nothing for them).
 */
export async function runWorkerOnlyCronRoutesTests() {
  const refused = workerOnlyRouteRefusal("cron/inbound-intake", "web");
  assert.ok(refused, "the page server refuses a worker-only job");
  assert.equal(refused.status, 503, "loudly — the scheduler shows red, never a quiet 200");
  assert.equal(refused.body.error, "wrong_process");
  assert.equal(workerOnlyRouteRefusal("cron/inbound-intake", "worker"), null, "the worker runs it");
  assert.equal(workerOnlyRouteRefusal("cron/inbound-intake", undefined), null, "an unset role is 'all', exactly as before the split");
  assert.ok(workerOnlyRouteRefusal("cron/inbound-intake", " Web "), "the role is read the way resolveProcessRole reads it");

  const routes: Array<[string, string, string]> = [
    ["app/api/notifications/process/route.ts", "export async function GET", "notifications/process"],
    ["app/api/cron/inbound-intake/route.ts", "export async function GET", "cron/inbound-intake"],
    ["app/api/cron/recruitment-email-intake/route.ts", "export async function GET", "cron/recruitment-email-intake"],
    ["app/api/cron/crm-contact-lists/route.ts", "export async function GET", "cron/crm-contact-lists"],
  ];
  for (const [file, handler, job] of routes) {
    const source = readFileSync(file, "utf8");
    const body = source.slice(source.indexOf(handler));
    const auth = body.indexOf("if (denied) return denied;");
    const refusal = body.indexOf(`refuseOnPageServer("${job}")`);
    assert.ok(auth > -1 && refusal > auth, `${file}: the role refusal runs right after the cron bearer check`);
    const firstWork = body.indexOf("try {");
    assert.ok(refusal < (firstWork === -1 ? Infinity : firstWork), `${file}: and before any work starts`);
    assert.match(body.slice(refusal, refusal + 200), /if \(wrongProcess\) return wrongProcess;/);
  }
  // The admin's manual drain (POST, session-authorised) still runs wherever it is pressed.
  const drain = readFileSync("app/api/notifications/process/route.ts", "utf8");
  const post = drain.slice(drain.indexOf("export async function POST"), drain.indexOf("export async function GET"));
  assert.doesNotMatch(post, /refuseOnPageServer/);

  // ── cronjob-sync: the adopted jobs, and that adopted means never written ──────────────────────
  assert.equal(WORKER, "https://phoenix-workforce-worker-production.up.railway.app", "the worker is Railway's again (23 Oct, owner)");
  const adopted: Record<string, { base: string; jobId: number; path: string }> = {
    "background-jobs": { base: PROD, jobId: 8200915, path: "/api/cron/background-jobs" },
    "crm-contact-lists": { base: WORKER, jobId: 8344730, path: "/api/cron/crm-contact-lists" },
    "inbound-intake": { base: WORKER, jobId: 8200920, path: "/api/cron/inbound-intake" },
    "process-notifications": { base: WORKER, jobId: 8200914, path: "/api/notifications/process?limit=50" },
    "recruitment-email-intake": { base: WORKER, jobId: 8200919, path: "/api/cron/recruitment-email-intake" },
  };
  for (const [key, want] of Object.entries(adopted)) {
    const spec = JOBS[key];
    assert.ok(spec, `${key} is declared`);
    assert.equal(spec.adopted?.jobId, want.jobId, `${key} names its live job`);
    assert.equal(`${spec.base ?? PROD}${spec.path}`, `${want.base}${want.path}`, `${key} is matched on its real URL`);
  }
  // On again since 25 Oct 2026 14:55 Cairo — it was left off after an outage, never switched off on purpose.
  assert.notEqual(JOBS["inbound-intake"].enabled, false, "inbound-intake is not declared OFF — the CV intake job runs");

  const spec = JOBS["recruitment-email-intake"];
  const live = { enabled: false, jobId: 8200919, schedule: { ...spec.schedule, timezone: "Africa/Cairo" } };
  assert.deepEqual(planJobAction(spec, null, { apply: true }), { drift: [], status: "missing", write: null }, "an adopted job is never CREATED");
  const drifted = planJobAction(spec, live, { apply: true });
  assert.equal(drifted.status, "drift");
  assert.equal(drifted.write, null, "an adopted job is never PATCHED, even under --apply");
  const intake = JOBS["inbound-intake"];
  const intakeLive = { ...live, schedule: { ...intake.schedule, timezone: "Africa/Cairo" } };
  assert.deepEqual(
    planJobAction({ ...intake, enabled: false }, intakeLive, { apply: true }),
    { drift: [], status: "ok", write: null },
    "a job declared off and found off is not drift",
  );
  assert.deepEqual(
    planJobAction(intake, { ...intakeLive, enabled: true }, { apply: true }),
    { drift: [], status: "ok", write: null },
    "the CV intake job found on is not drift",
  );
  const intakeOff = planJobAction(intake, intakeLive, { apply: true });
  assert.equal(intakeOff.status, "drift", "the CV intake job found OFF is reported as drift");
  assert.equal(intakeOff.write, null, "and, being adopted, it is reported, never patched");
  // A managed (non-adopted) declaration keeps its old behaviour.
  const managed = JOBS["territory-restamp"];
  assert.equal(planJobAction(managed, null, { apply: true }).write, "create");
  assert.equal(planJobAction(managed, null, { apply: false }).write, null);
  assert.equal(planJobAction(managed, { enabled: false, schedule: { ...managed.schedule, timezone: "Africa/Cairo" } }, { apply: true }).write, "patch");

  const script = readFileSync("scripts/cronjob-sync.mjs", "utf8");
  assert.match(script, /if \(process\.argv\[1\] && import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href\) \{/, "main() runs only as a command");
  assert.match(script, /if \(plan\.write !== "create"\) continue;/, "the create path obeys the plan");
  assert.match(script, /if \(plan\.write !== "patch"\) continue;/, "the patch path obeys the plan");
}
