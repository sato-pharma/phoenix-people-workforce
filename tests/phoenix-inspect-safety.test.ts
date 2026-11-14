import assert from "node:assert/strict";

import { MODULES, buildPlan } from "../scripts/phoenix-inspect/explore.mjs";
import { STAGING_ORIGIN, classifyRequest } from "../scripts/phoenix-inspect/lib/fence.mjs";
import {
  RUN_BOUNDS,
  VIEWPORTS,
  assertTargetOrigin,
  classifyControl,
  createRateLimiter,
  createSingleFlight,
  validateToolInput,
} from "../scripts/phoenix-inspect/lib/safety.mjs";
import { KPIS_MODULE, addressFor, statesFor } from "../scripts/phoenix-inspect/modules/kpis.mjs";
import { planPrune } from "../scripts/phoenix-inspect/prune.mjs";
import { canSeeDoctorCoverage } from "../src/lib/crm/doctor-coverage-roles.ts";

/**
 * Phoenix Visual Intelligence: the guards around the fence. Staging is the only target (production is
 * refused); the click classifier refuses anything that could change a record; a run is bounded; the
 * tool interface accepts ids only; a persona without access is planned as a DENIED check, never
 * skipped; and the KPIs spec never names a person or reaches the export.
 */
export async function runPhoenixInspectSafetyTests() {
  // Origins.
  assert.equal(assertTargetOrigin(STAGING_ORIGIN), STAGING_ORIGIN);
  assert.throws(() => assertTargetOrigin("https://phoenix-hr.satopharma.com"), /production host is never a target/);
  assert.throws(() => assertTargetOrigin("https://example.org"), /not an allowed target/);
  assert.throws(() => assertTargetOrigin("http://127.0.0.1:4321"), /not an allowed target/, "loopback only for the self-check");
  assert.equal(assertTargetOrigin("http://127.0.0.1:4321", { allowLoopback: true }), "http://127.0.0.1:4321");
  assert.throws(() => assertTargetOrigin("https://127.0.0.1:4321", { allowLoopback: true }), /not an allowed target/);
  assert.throws(() => assertTargetOrigin("nonsense"), /not a URL/);

  // Controls: names that change things, submits, downloads, other origins and API links are refused.
  const allowed = (control: Record<string, unknown>) => classifyControl({ tag: "button", type: "button", ...control }, STAGING_ORIGIN);
  for (const name of [
    "Approve", "Reject request", "Send", "Submit plan", "Save", "Delete", "Remove", "Export XLSX", "Download",
    "Upload", "Publish", "Sign out", "Log out", "Confirm", "Apply ranges", "Pay", "Reset", "Clear all", "Request support",
  ]) {
    assert.equal(allowed({ name }).allowed, false, `"${name}" must be refused`);
  }
  for (const name of ["Advanced filters", "Call Rate", "Coverage", "AM · PM", "Weekly", "More columns", "Show doctors"]) {
    assert.equal(allowed({ name }).allowed, true, `"${name}" may be clicked`);
  }
  assert.deepEqual(allowed({ name: "Go", type: "submit" }), { allowed: false, reason: "submits a form" });
  assert.deepEqual(allowed({ name: "Go", type: null, inForm: true }), { allowed: false, reason: "a form's default (submit) button" });
  assert.deepEqual(classifyControl({ tag: "a", name: "Workbook", href: "/api/crm/kpis-export?month=2026-08" }, STAGING_ORIGIN), { allowed: false, reason: "never-touch path" });
  assert.deepEqual(classifyControl({ tag: "a", name: "Workbook", href: "/admin/kpis", download: true }, STAGING_ORIGIN), { allowed: false, reason: "downloads a file" });
  assert.deepEqual(classifyControl({ tag: "a", name: "Docs", href: "https://example.org" }, STAGING_ORIGIN), { allowed: false, reason: "leaves the target origin" });
  assert.deepEqual(classifyControl({ tag: "a", name: "Data", href: "/api/crm/visits" }, STAGING_ORIGIN), { allowed: false, reason: "an API address, not a page" });
  assert.deepEqual(classifyControl({ tag: "a", name: "Rep", href: "/admin/kpis/call-rate/x?month=2026-08" }, STAGING_ORIGIN), { allowed: true, reason: null });
  assert.equal(classifyControl({ tag: "input", type: "text", name: "Search" }, STAGING_ORIGIN).allowed, false, "typing fields are refused");

  // Rate limit and single flight.
  let clock = 0;
  const limiter = createRateLimiter(3, () => clock);
  assert.deepEqual([limiter.take(), limiter.take(), limiter.take(), limiter.take()], [true, true, true, false]);
  clock = 60_000;
  assert.equal(limiter.take(), true, "the window slides");
  const flight = createSingleFlight();
  let release: () => void = () => {};
  const first = flight.run(() => new Promise<void>((resolve) => { release = resolve; }));
  await assert.rejects(flight.run(async () => {}), /another capture is already running/);
  release();
  await first;
  await flight.run(async () => {});

  // Tool inputs: ids only.
  const modules = MODULES;
  const keys = ["module", "persona", "states", "viewports"];
  assert.equal(validateToolInput({ module: "kpi-reports", persona: "ceo", states: ["summary"], viewports: ["desktop"] }, { modules, allowedKeys: keys }).ok, true);
  const refused = (input: unknown, why: RegExp) => {
    const result = validateToolInput(input, { modules, allowedKeys: keys });
    assert.equal(result.ok, false, `refused: ${JSON.stringify(input)}`);
    assert.ok(!result.ok && result.errors.some((error: string) => why.test(error)), `${JSON.stringify(input)} -> ${JSON.stringify(result)}`);
  };
  refused({ module: "kpi-reports", persona: "ceo", url: "https://phoenix-hr.satopharma.com" }, /unknown field "url"/);
  refused({ module: "kpi-reports", persona: "superadmin", states: ["summary"] }, /persona must be one of/);
  refused({ module: "payroll", persona: "ceo" }, /module must be one of/);
  refused({ module: "kpi-reports", persona: "ceo", states: ["summary", "drop table"] }, /unknown state/);
  refused({ module: "kpi-reports", persona: "ceo", states: [] }, /states must be a list/);
  refused({ module: "kpi-reports", persona: "ceo", states: Array.from({ length: RUN_BOUNDS.maxPagesPerToolCall + 1 }, () => "summary") }, /states must be a list/);
  refused({ module: "kpi-reports", persona: "ceo", viewports: ["4k"] }, /viewports must be a list/);
  refused({ module: "kpi-reports", persona: "<script>" }, /characters that no id contains/);
  refused(["kpi-reports"], /input must be an object/);
  refused({ module: "kpi-reports", script: "document.cookie" }, /unknown field "script"/);
  refused({ module: "kpi-reports", sql: "select 1" }, /unknown field "sql"/);

  // The KPIs spec: personas match the board's real gate; the denied persona is planned, not skipped.
  for (const persona of KPIS_MODULE.personas) {
    if (persona.matrix === "denied") assert.equal(canSeeDoctorCoverage(persona.role), false, `${persona.role} is the denied-path persona`);
    else assert.equal(canSeeDoctorCoverage(persona.role), true, `${persona.role} can open the KPIs board`);
  }
  const plan = buildPlan(KPIS_MODULE, {});
  assert.ok(plan.jobs.length <= RUN_BOUNDS.maxPagesPerRun, "a run is bounded");
  assert.equal(plan.truncated, 0, "the KPIs plan fits inside the bound");
  assert.ok(plan.jobs.some((job: { denied: boolean; persona: { id: string } }) => job.denied && job.persona.id === "emp"), "the Employee persona is a denied check");
  for (const job of plan.jobs) {
    assert.ok(job.viewport in VIEWPORTS);
    const verdict = classifyRequest({ method: "GET", url: `${STAGING_ORIGIN}${job.address}` }, { origin: STAGING_ORIGIN });
    assert.deepEqual(verdict, { allow: true }, `${job.address} passes the fence`);
    assert.ok(!/[?&]rep=/.test(job.address), "no state names a person by id; drill-downs follow the page's own link");
    assert.ok(!job.address.includes("kpis-export"));
  }
  for (const persona of KPIS_MODULE.personas) {
    for (const state of statesFor(persona)) assert.ok(state.shells.includes(persona.shell), `${state.id} belongs to ${persona.shell}`);
  }
  const ceo = KPIS_MODULE.personas.find((persona: { id: string }) => persona.id === "ceo");
  const hr = KPIS_MODULE.personas.find((persona: { id: string }) => persona.id === "hrr");
  const dm = KPIS_MODULE.personas.find((persona: { id: string }) => persona.id === "dm");
  const summary = KPIS_MODULE.states.find((state: { id: string }) => state.id === "summary");
  assert.equal(addressFor(ceo, summary), "/admin/kpis?month=2026-08");
  assert.equal(addressFor(hr, summary), "/hr/admin/kpis?month=2026-08");
  assert.equal(addressFor(dm, summary), "/employee-portals/kpis?month=2026-08");
  assert.ok(KPIS_MODULE.neverTouch.some((rule: { selector: string }) => rule.selector.includes("kpis-export")));

  // Retention: only run folders with a manifest, newest five, nothing older than fourteen days.
  assert.deepEqual(planPrune("does-not-exist"), []);
}
