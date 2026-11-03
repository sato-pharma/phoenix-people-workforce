// One-off, never merged: the double-visit panel's whole answer for every active manager, opened twice, on STAGING. Writes to the runner's disk only.
// usage: node <loader> panel-answers.mjs <out.json>     PANEL_TODAY=YYYY-MM-DD pretends today is that day.
import { writeFileSync } from "node:fs";

if (process.env.PANEL_TODAY) {
  const RealDate = Date;
  const fixed = new RealDate(`${process.env.PANEL_TODAY}T10:00:00Z`).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() {
      return fixed;
    }
  };
}

const realFetch = globalThis.fetch;
let requests = 0;
const refused = new Set();
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input.url ?? String(input)));
  const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
  const label = url.pathname.replace("/rest/v1/", "");
  if (!["GET", "HEAD"].includes(method) && url.pathname.startsWith("/rest/v1/") && !label.startsWith("rpc/")) {
    refused.add(`${method} ${label}`);
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }
  requests += 1;
  return realFetch(input, init);
};

const { createAccessContext, parseRoleStrict } = await import("@/lib/auth/permissions");
const { getDoubleVisitPortalFocus } = await import("@/lib/double-visit-analytics/service");
const { getEmployeeDirectoryRows } = await import("@/lib/employees/employee-directory");
const { resolveJobFunctionRole } = await import("@/lib/employees/job-function");

const ROLES = new Set(["District Manager", "Group Product Manager", "Marketing Manager", "National Sales Manager", "Product Manager", "Regional Manager", "SFE Manager", "Training Manager"]);
const employees = await getEmployeeDirectoryRows({ includeInactive: false });
const managers = employees
  .map((employee) => {
    const byPosition = resolveJobFunctionRole(employee.positionTitle);
    const byJob = resolveJobFunctionRole(employee.jobTitle);
    return { hrId: employee.hrId, role: ROLES.has(byPosition) ? byPosition : ROLES.has(byJob) ? byJob : null };
  })
  .filter((manager) => manager.role)
  .sort((left, right) => String(left.hrId).localeCompare(String(right.hrId)));

const open = async (access) => {
  const before = requests;
  const started = performance.now();
  try {
    const answer = await getDoubleVisitPortalFocus(access);
    return { answer, ms: Math.round(performance.now() - started), requests: requests - before };
  } catch (error) {
    return { answer: { threw: String(error?.message ?? error).slice(0, 200) }, ms: Math.round(performance.now() - started), requests: requests - before };
  }
};

const out = {};
for (const { hrId, role } of managers) {
  const access = createAccessContext({ hrId, loginId: hrId, role: parseRoleStrict(role), source: "dev-header", testPersona: false });
  out[hrId] = { first: await open(access), role, second: await open(access) };
}
writeFileSync(process.argv[2], JSON.stringify(out));
console.log(`managers ${managers.length}, requests ${requests}, refused writes: ${refused.size ? [...refused].join(" | ") : "none"}`);
process.exit(0);
