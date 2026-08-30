import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// A page inside app/(admin)/ can never render the employee-portal shell.
//
// app/(admin)/layout.tsx resolves the access context and redirects every
// portal-mode viewer to /employee-portals BEFORE it returns its children, so no
// page in the group ever renders for such a viewer. There are exactly two nested
// layouts under the group — the group layout itself and
// app/(admin)/admin/direct-orders/(desks)/layout.tsx — and neither overrides that
// redirect, so there is no route in the group where it does not apply.
//
// That makes any `if (mode === "admin") … else <EmployeePortalPageShell>` branch in
// a page here unreachable: it is written for a reader the layout has already sent
// away. Two of them existed on the leave-management vacation pages and were removed
// on 2026-08-30.
//
// WHY THIS IS A TEST AND NOT A NOTE
// The dead pattern kept being written for ten weeks after the layout made it
// impossible. The blanket redirect landed 2026-06-15 (f3c27801c, "block portal-mode
// users from the entire admin shell"); six pages carrying portal handling were
// created after it — three on 2026-07-05, three on 2026-07-18 — every one of them
// born dead. A convention that regenerates is not fixed by deleting its instances
// once, so the rule is enforced here instead of being written down somewhere and
// re-derived wrongly by the next author reading a neighbouring file.
//
// THE PREMISE IS ASSERTED, NOT ASSUMED
// This test is only correct while the group layout actually performs that redirect.
// If someone removes it, dual-mode pages become legitimate again and this test must
// be reconsidered rather than worked around — so the premise is checked first, and
// its failure message says exactly that.
//
// WHAT THIS DOES NOT COVER
// The six pages above still redirect portal viewers to a SPECIFIC portal twin
// (/employee-portals/approvals/plan and friends) rather than to the portal home the
// layout sends them to. Those lines are dead too, but deleting them would remove a
// stated intention without replacing it, and honouring it needs a pathname the
// layout cannot see — this app runs no middleware, so there is no request header
// carrying one. They are left alone deliberately and are not asserted about here.
// ─────────────────────────────────────────────────────────────────────────────

const ADMIN_GROUP = path.join("app", "(admin)");
const GROUP_LAYOUT = path.join(ADMIN_GROUP, "layout.tsx");

// The portal shell wrappers. A page in the admin group importing any of these is
// building a portal frame inside a shell portal users are redirected out of.
const PORTAL_SHELL_IMPORTS = ["EmployeePortalPageShell", "EmployeePortalShell"];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".") || entry.startsWith("_wt-")) continue;
      walk(full, out);
    } else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

function importsPortalShell(source: string): string[] {
  const body = stripComments(source);
  const hits: string[] = [];
  for (const match of body.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g)) {
    for (const specifier of match[1].split(",")) {
      const name = specifier.split(/\s+as\s+/)[0].trim();
      if (PORTAL_SHELL_IMPORTS.includes(name)) hits.push(name);
    }
  }
  return hits;
}

export async function runAdminGroupHasNoPortalShellTests(): Promise<void> {
  // ── The detector, checked against cases that have actually bitten here ──────
  assert.deepEqual(
    importsPortalShell('import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";'),
    ["EmployeePortalPageShell"],
    "a real import of the portal shell must be caught",
  );
  assert.deepEqual(
    importsPortalShell("// EmployeePortalPageShell lived below until 2026-08-30 and could not execute"),
    [],
    "a comment naming the shell is prose — the removal notes left in those pages must not re-trip this",
  );
  assert.deepEqual(
    importsPortalShell("/*\n * EmployeePortalPageShell\n */"),
    [],
    "a block comment naming the shell is prose",
  );
  assert.deepEqual(
    importsPortalShell('import { AppShell } from "@/components/layout/app-shell";'),
    [],
    "the admin shell is the correct import here and must never be flagged",
  );

  // ── The premise: the group layout still redirects portal-mode viewers away ──
  const layout = stripComments(readFileSync(GROUP_LAYOUT, "utf8"));
  assert.ok(
    /resolveNavigationMode\(access\)\s*===\s*"employee-portal"/.test(layout) &&
      /redirect\("\/employee-portals"\)/.test(layout),
    `${GROUP_LAYOUT} no longer redirects portal-mode viewers to /employee-portals.\n` +
      `This test asserts that no page in the (admin) group renders the employee-portal shell, and the ` +
      `ONLY reason that is true is the redirect in that layout. If the redirect was removed on purpose, ` +
      `dual-mode pages in this group are legitimate again and this test should be retired — do not ` +
      `re-add the redirect just to make it pass.`,
  );

  // ── Exactly one nested layout under the group, and it does not override ─────
  const nestedLayouts = walk(ADMIN_GROUP)
    .filter((file) => path.basename(file) === "layout.tsx" && file !== GROUP_LAYOUT)
    .map((file) => file.split(path.sep).join("/"));
  assert.deepEqual(
    nestedLayouts,
    ["app/(admin)/admin/direct-orders/(desks)/layout.tsx"],
    "a new nested layout appeared under app/(admin)/. A nested layout cannot cancel the parent's " +
      "redirect, so this is not automatically a problem — but the reasoning above enumerates the " +
      "layouts by name, so confirm the new one does not introduce a portal-mode route and add it here.",
  );

  // ── The rule ───────────────────────────────────────────────────────────────
  const offenders: string[] = [];
  for (const file of walk(ADMIN_GROUP)) {
    const hits = importsPortalShell(readFileSync(file, "utf8"));
    if (hits.length > 0) offenders.push(`${file.split(path.sep).join("/")} (${[...new Set(hits)].join(", ")})`);
  }

  assert.deepEqual(
    offenders,
    [],
    `A page inside app/(admin)/ imports the employee-portal shell, which it can never render:\n  ` +
      `${offenders.join("\n  ")}\n\n` +
      `app/(admin)/layout.tsx redirects every portal-mode viewer to /employee-portals before this page ` +
      `runs, so the portal branch is dead on arrival. Portal viewers reach their own page under ` +
      `app/employee-portals/ — build it there, and let this page render the admin body only.`,
  );
}
