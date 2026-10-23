import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Performance phase 2 (2026-10-23): the manager's Command Center paints before its slow reads land.
//
//   1. A District, Regional or National Sales Manager and the Marketing Manager get their role extras
//      (team / region / national figures, rankings, the CRM first-visit board, the marketing inbox)
//      handed back STILL RUNNING on `snapshot.roleCards`; each section that needs them fills under its
//      own Suspense, and the identity band, pending actions and dashboards grid paint without them.
//   2. The latest payslip (batch, then this employee's record) is one chain started beside the
//      pending counts, not a second sequential wave in front of the page.
//   3. The CRM sidebar no longer asks the manager plan-switch question nobody reads — it cost every
//      district manager a third sequential wave on every portal page.
//
// Each pin below names what it holds, and each one is handed a broken copy and must fire.
// ─────────────────────────────────────────────────────────────────────────────

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const code = (source: string) => stripComments(source).replace(/\r\n/g, "\n");

/** What makes the CRM sidebar still ask the dead plan-switch question. */
export function sidebarPlanSwitchFound(source: string): string[] {
  const text = code(source);
  const found: string[] = [];
  if (text.includes("dmPlansInPhoenixCrm")) found.push("dmPlansInPhoenixCrm is still called by the sidebar");
  if (/\bmanagerPlans\b/.test(text)) found.push("the sidebar entries still carry managerPlans");
  return found;
}

const STREAMED_ROLES = ["District Manager", "National Sales Manager", "Regional Manager", "Marketing Manager"];

/** What is missing from home-snapshot.ts's phase-2 shape. */
export function snapshotPhase2Missing(source: string): string[] {
  const text = code(source);
  const missing: string[] = [];

  const set = text.match(/const STREAM_ROLE_EXTRAS_ROLES = new Set\(\[([\s\S]*?)\]\);/);
  if (!set) {
    missing.push("the STREAM_ROLE_EXTRAS_ROLES set");
  } else {
    const roles = [...set[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    if (JSON.stringify(roles) !== JSON.stringify([...STREAMED_ROLES].sort())) {
      missing.push(`the streamed roles, spelled exactly (${STREAMED_ROLES.join(", ")}) — found ${roles.join(", ")}`);
    }
  }
  if (!text.includes("const streamRoleExtras = options?.streamRoleExtras === true && STREAM_ROLE_EXTRAS_ROLES.has(role);")) {
    missing.push("streamRoleExtras gated on the caller's opt-in AND the role set");
  }
  if (!text.includes("streamRoleExtras ? Promise.resolve(emptyRoleExtras) : roleExtrasPromise,")) {
    missing.push("the final Promise.all skips the role extras only when they stream");
  }
  if (!text.includes("roleCards: streamRoleExtras ? roleExtrasPromise : null,")) {
    missing.push("the snapshot hands the still-running role extras back on roleCards");
  }

  // The payslip chain: started before the counts are awaited, outside that wave, awaited last.
  const counts = text.indexOf("= await devSafePromiseAllSettled([");
  const chain = text.indexOf("const latestPayslipPromise");
  if (counts < 0) missing.push("the pending-counts devSafePromiseAllSettled wave");
  if (chain < 0) missing.push("the latestPayslipPromise chain");
  if (counts >= 0 && chain >= 0 && chain > counts) missing.push("latestPayslipPromise is started before the counts are awaited");
  if (counts >= 0) {
    const waveEnd = text.indexOf("]);", counts);
    if (text.slice(counts, waveEnd).includes("salary_batches")) missing.push("salary_batches sits outside the pending-counts wave");
  }
  const finalAll = text.match(/const \[roleExtras,[^\]]*latestPayslip\] =\s*await Promise\.all\(\[([\s\S]*?)\]\);/);
  if (!finalAll || !/\blatestPayslipPromise,/.test(finalAll[1])) {
    missing.push("latestPayslipPromise is awaited in the final Promise.all");
  }
  return missing;
}

/** Does the landing page opt in to streaming the role extras? */
export function pageStreamsRoleExtras(source: string): boolean {
  return /getPortalHomeSnapshot\(access,\s*\{[^}]*\bstreamRoleExtras: true[^}]*\}\)/.test(code(source));
}

/** The exported dashboard's body, from its declaration to the next top-level function or the end. */
function componentBody(text: string, name: string): string {
  const start = text.indexOf(`export function ${name}(`);
  if (start < 0) return "";
  const next = text.slice(start + 1).search(/\n(?:export )?(?:async )?function /);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

/**
 * What makes a manager dashboard read its slow role fields before paint: each one is read ONLY inside
 * an `<AwaitRoleExtras extras={extras}>` that sits under its own `<Suspense fallback=…>`.
 */
export function dashboardStreamMissing(source: string, component: string, fields: string[], sections: number): string[] {
  const text = code(source);
  const missing: string[] = [];
  const body = componentBody(text, component);
  if (!body) return [`export function ${component}(`];
  if (!body.includes("const extras = roleExtrasOf(snapshot);")) missing.push("const extras = roleExtrasOf(snapshot);");

  const opens = [...body.matchAll(/<AwaitRoleExtras extras=\{extras\}>/g)].map((m) => m.index ?? 0);
  if (opens.length < sections) missing.push(`${sections} AwaitRoleExtras sections (found ${opens.length})`);
  for (const at of opens) {
    const suspense = body.lastIndexOf("<Suspense fallback=", at);
    const closed = body.lastIndexOf("</Suspense>", at);
    if (suspense < 0 || closed > suspense) missing.push(`an AwaitRoleExtras at offset ${at} outside its own Suspense`);
  }

  const outside = body.replace(/<AwaitRoleExtras extras=\{extras\}>[\s\S]*?<\/AwaitRoleExtras>/g, "");
  for (const field of fields) {
    if (new RegExp(`\\b${field}\\b`).test(outside)) missing.push(`${field} is read before paint, outside AwaitRoleExtras`);
  }
  return missing;
}

const DASHBOARDS = [
  { file: "dsm-command-center.tsx", component: "DsmCommandCenter", fields: ["dsmTeam"], sections: 3 },
  { file: "nsm-command-center.tsx", component: "NsmCommandCenter", fields: ["nsmNational", "nsmBoard"], sections: 3 },
  { file: "rm-command-center.tsx", component: "RmCommandCenter", fields: ["rmRegional"], sections: 3 },
  { file: "marketing-manager-command-center.tsx", component: "MarketingManagerCommandCenter", fields: ["mmOverview"], sections: 3 },
];

export async function runPerformancePhase2Tests() {
  // ── 3. The CRM sidebar ────────────────────────────────────────────────────────────────────────
  const sidebar = read("../src/lib/phoenix-crm/server/sidebar-entries.ts");
  assert.deepEqual(sidebarPlanSwitchFound(sidebar), [], "the CRM sidebar asks no plan-switch question");
  assert.ok(
    sidebarPlanSwitchFound(
      `${sidebar}\nimport { dmPlansInPhoenixCrm } from "@/lib/phoenix-crm/server/manager-plan-switch";\nconst e = { managerPlans: true };`,
    ).length === 2,
    "broken copy: the plan-switch pin must fire on both the import and the field",
  );

  // ── 1 + 2. The snapshot ───────────────────────────────────────────────────────────────────────
  const snapshot = read("../src/lib/employee-portal/home-snapshot.ts");
  assert.deepEqual(snapshotPhase2Missing(snapshot), [], "home-snapshot.ts streams the role extras and runs the payslip chain beside the counts");
  for (const [label, broken] of [
    ["a role spelled in the wrong case", snapshot.replace('  "Regional Manager",\n  "Marketing Manager",\n]);', '  "Regional manager",\n  "Marketing Manager",\n]);')],
    ["a fifth role streamed", snapshot.replace('  "Marketing Manager",\n]);', '  "Marketing Manager",\n  "Product Manager",\n]);')],
    ["streaming without the opt-in", snapshot.replace("options?.streamRoleExtras === true && STREAM_ROLE_EXTRAS_ROLES.has(role)", "STREAM_ROLE_EXTRAS_ROLES.has(role)")],
    ["the extras awaited anyway", snapshot.replace("streamRoleExtras ? Promise.resolve(emptyRoleExtras) : roleExtrasPromise,", "roleExtrasPromise,")],
    ["no roleCards handed back", snapshot.replace("roleCards: streamRoleExtras ? roleExtrasPromise : null,", "roleCards: null,")],
    ["the batch read back in the counts wave", snapshot.replace("= await devSafePromiseAllSettled([", '= await devSafePromiseAllSettled([\n    () => wrapPromise(supabase.from("salary_batches").select("id")),')],
    ["the payslip chain not awaited", snapshot.replace("      latestPayslipPromise,\n    ]);", "      Promise.resolve(null),\n    ]);")],
  ] as const) {
    assert.notEqual(broken, snapshot, `broken copy did not change the source: ${label}`);
    assert.ok(snapshotPhase2Missing(broken).length > 0, `broken copy must fire: ${label}`);
  }

  const page = read("../app/employee-portals/page.tsx");
  assert.ok(pageStreamsRoleExtras(page), "the landing page asks for the role extras to stream");
  assert.ok(!pageStreamsRoleExtras(page.replace("streamRoleExtras: true,", "")), "broken copy: the page pin must fire without the opt-in");

  // ── The four manager dashboards ───────────────────────────────────────────────────────────────
  for (const { file, component, fields, sections } of DASHBOARDS) {
    const source = read(`../src/components/employee-portal/dashboards/${file}`);
    assert.deepEqual(dashboardStreamMissing(source, component, fields, sections), [], `${file} reads its role extras only under Suspense`);

    const unwrapped = source.replace(/<Suspense fallback=\{[^}]*\}>\s*(<AwaitRoleExtras extras=\{extras\}>)/, "<>$1").replace("</AwaitRoleExtras>\n      </Suspense>", "</AwaitRoleExtras>\n      </>");
    assert.notEqual(unwrapped, source, `${file}: broken copy did not change the source`);
    assert.ok(dashboardStreamMissing(unwrapped, component, fields, sections).length > 0, `${file}: a section outside its Suspense must fire`);

    const eager = source.replace("const extras = roleExtrasOf(snapshot);", `const extras = roleExtrasOf(snapshot);\n  const { ${fields[0]} } = snapshot;`);
    assert.ok(dashboardStreamMissing(eager, component, fields, sections).length > 0, `${file}: a field read before paint must fire`);
  }

  // ── The stream helper ─────────────────────────────────────────────────────────────────────────
  const stream = code(read("../src/components/employee-portal/dashboards/role-extras-stream.tsx"));
  assert.ok(stream.includes("if (snapshot.roleCards) return snapshot.roleCards;"), "roleExtrasOf hands back the streamed promise when there is one");
  assert.ok(stream.includes("return <>{children(await extras)}</>;"), "AwaitRoleExtras waits for the extras before drawing its section");
  for (const field of ["pmMarketing", "mmOverview", "dsmTeam", "nsmNational", "nsmBoard", "rmRegional"]) {
    assert.ok(stream.includes(`${field}: snapshot.${field},`), `roleExtrasOf falls back to the snapshot's own ${field}`);
  }
}
