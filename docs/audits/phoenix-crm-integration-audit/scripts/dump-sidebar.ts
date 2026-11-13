/**
 * Read-only diagnostic for the integration audit: prints the canonical sidebar exactly as the
 * navigation config builds it, so every module name used in the audit can be checked against source.
 *
 * It imports the two navigation config files and nothing else — no database, no network, no write
 * other than the two files named below, both inside this audit folder.
 *
 * Run from the repo root (from a worktree, through node — never pnpm):
 *   node --experimental-strip-types --experimental-specifier-resolution=node \
 *     --experimental-loader ./tests/alias-loader.mjs \
 *     docs/audits/phoenix-crm-integration-audit/scripts/dump-sidebar.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { adminSidebarDomains } from "../../../../src/config/sidebar-domains.ts";
import {
  adminNavigationSections,
  employeePortalNavigationSections,
  hrNavigationSections,
  type NavigationSection,
  type NavigationSectionItem,
} from "../../../../src/config/system-navigation.ts";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..");

type Row = {
  shell: string;
  domain: string;
  heading: string;
  sectionId: string;
  sectionLabel: string;
  label: string;
  labelByRole: string;
  href: string;
  roles: string;
  excludedRoles: string;
  permissions: string;
};

function gateText(item: NavigationSectionItem) {
  return {
    roles: (item.roles ?? []).join(" | "),
    excludedRoles: (item.excludedRoles ?? []).join(" | "),
    permissions: (item.permissions ?? [])
      .map((permission) => (permission.action ? `${permission.resource}:${permission.action}` : permission.resource))
      .join(" | "),
    labelByRole: Object.entries(item.labelByRole ?? {})
      .map(([role, label]) => `${role} → ${label}`)
      .join(" | "),
  };
}

function rowsOf(shell: string, sections: readonly NavigationSection[], place: (section: NavigationSection) => { domain: string; heading: string }): Row[] {
  return sections.flatMap((section) =>
    section.items.map((item) => ({
      shell,
      ...place(section),
      sectionId: section.id,
      sectionLabel: section.label,
      label: item.label,
      href: item.href,
      ...gateText(item),
    })),
  );
}

const adminPlace = new Map<string, { domain: string; heading: string }>();
for (const domain of adminSidebarDomains) {
  for (const group of domain.groups) {
    for (const sectionId of group.sectionIds) adminPlace.set(sectionId, { domain: domain.name, heading: group.heading });
  }
}

const rows: Row[] = [
  ...rowsOf("admin", adminNavigationSections, (section) => adminPlace.get(section.id) ?? { domain: "More", heading: section.label }),
  ...rowsOf("hr", hrNavigationSections, (section) => ({ domain: "(HR shell — no domain layer)", heading: section.label })),
  ...rowsOf("employee-portal", employeePortalNavigationSections, (section) => ({ domain: "(Portal — no domain layer)", heading: section.label })),
];

const csvCell = (value: string) => `"${value.replaceAll('"', '""')}"`;
const header: (keyof Row)[] = ["shell", "domain", "heading", "sectionId", "sectionLabel", "label", "labelByRole", "href", "roles", "excludedRoles", "permissions"];
writeFileSync(
  join(outDir, "sidebar_inventory.csv"),
  [header.join(","), ...rows.map((row) => header.map((key) => csvCell(row[key])).join(","))].join("\n") + "\n",
  "utf8",
);

const lines: string[] = [];
for (const shell of ["admin", "hr", "employee-portal"]) {
  const shellRows = rows.filter((row) => row.shell === shell);
  lines.push(`## ${shell} — ${shellRows.length} rows`);
  let lastDomain = "";
  let lastHeading = "";
  for (const row of shellRows) {
    if (row.domain !== lastDomain) {
      lines.push(`### ${row.domain}`);
      lastDomain = row.domain;
      lastHeading = "";
    }
    if (row.heading !== lastHeading) {
      lines.push(`- **${row.heading}**`);
      lastHeading = row.heading;
    }
    const gates = [
      row.roles && `roles: ${row.roles}`,
      row.excludedRoles && `not: ${row.excludedRoles}`,
      row.permissions && `perm: ${row.permissions}`,
      row.labelByRole && `renamed: ${row.labelByRole}`,
    ]
      .filter(Boolean)
      .join("; ");
    lines.push(`  - ${row.label} — \`${row.href}\`${gates ? ` (${gates})` : ""}`);
  }
}
writeFileSync(join(outDir, "sidebar_inventory.generated.txt"), lines.join("\n") + "\n", "utf8");
console.log(`rows: ${rows.length}; admin ${rows.filter((r) => r.shell === "admin").length}, hr ${rows.filter((r) => r.shell === "hr").length}, portal ${rows.filter((r) => r.shell === "employee-portal").length}`);
console.log(`distinct labels: ${new Set(rows.map((r) => r.label)).size}; distinct hrefs: ${new Set(rows.map((r) => r.href)).size}`);
