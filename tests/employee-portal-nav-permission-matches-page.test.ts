import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  HOME_ENTRY,
  PORTAL_NAV_REGISTRY,
  PROFILE_ENTRY,
  type PortalNavEntry,
} from "@/components/employee-portal/employee-portal-nav-registry";

import { pageFileFor, permissionGateKeys } from "./support/page-gate-reader";

/**
 * B6 — a portal nav entry's `permission` equals the single permission its linked page enforces.
 *
 * ## Why this exists
 *
 * `PortalNavEntry.permission` is a copy. The permission an employee-portal destination requires is
 * decided in exactly one place that runs — the page's own entry gate, `assertPermission(access, r, a)`
 * or `!(await canAccess(access, r, a))`. The registry mirrors it so the sidebar/bottom-nav layer can
 * reason about a link's permission without importing every page, but a mirror that nothing checks is
 * the exact defect this whole program keeps paying down: one rule, two copies, nothing forcing them
 * to agree. This test forces them to agree, and it does so by RE-DERIVING the truth from the pages
 * rather than pinning a hand-written list — so it cannot rot. Change a page's gate and this fails
 * until the registry is updated; seed a wrong permission and it fails on the spot.
 *
 * ## The rule, applied uniformly to every entry the registry exports
 *
 * For each entry (the array plus the two fixed anchors), resolve the page it links to and read the
 * set of permissions its entry gate demands, using the shared page-gate reader (tests/support/
 * page-gate-reader.ts — the same reader four other navigation guards use, so a parser fix reaches
 * all of them at once):
 *
 *   · the page demands EXACTLY ONE permission  → the entry MUST carry that permission, verbatim.
 *   · the page demands ZERO or MORE THAN ONE    → the entry MUST NOT carry a `permission` (there is
 *     no single permission to mirror; its visibility is decided by a role set, an unreadable
 *     predicate, or a computed flag, none of which a lone `permission` can express).
 *
 * Measured live 2026-08-29: 37 of the ~52 array entries reach a page with exactly one permission
 * gate, ZERO reach a page with more than one, and both anchors do too — so 39 entries carry a
 * permission and nothing is ambiguous. The count is deliberately NOT asserted as a magic number
 * (a fixed page and a newly stranded one would cancel out); the identity check per entry is what
 * holds the line, with only a loose anti-vacuity floor below.
 */
export function runEmployeePortalNavPermissionMatchesPageTests() {
  const repoRoot = process.cwd();
  const entries: PortalNavEntry[] = [...PORTAL_NAV_REGISTRY, HOME_ENTRY, PROFILE_ENTRY];

  assert.ok(
    PORTAL_NAV_REGISTRY.length >= 50,
    `the portal registry should still list its destinations (saw ${PORTAL_NAV_REGISTRY.length})`,
  );

  const missingPage: string[] = [];
  const mismatches: string[] = [];
  let confirmed = 0;

  for (const entry of entries) {
    const file = pageFileFor(entry.href, { repoRoot });
    if (!file) {
      missingPage.push(entry.href);
      continue;
    }
    const keys = [...permissionGateKeys(readFileSync(file, "utf8"))].sort();
    const recorded = entry.permission
      ? `${entry.permission.resource}:${entry.permission.action}`
      : null;

    if (keys.length === 1) {
      if (recorded !== keys[0]) {
        mismatches.push(
          `${entry.href}: page enforces ${keys[0]}, registry records ${recorded ?? "(none)"}`,
        );
      } else {
        confirmed += 1;
      }
    } else if (recorded !== null) {
      mismatches.push(
        `${entry.href}: registry records ${recorded}, but the page has ${keys.length} ` +
          `machine-readable permission gates (${keys.join(", ") || "none"}) — no single ` +
          `permission to mirror, so drop the field`,
      );
    }
  }

  assert.deepEqual(
    missingPage,
    [],
    `these portal registry hrefs resolve to no page.tsx — a link to nowhere: ${missingPage.join(", ")}`,
  );
  assert.deepEqual(
    mismatches,
    [],
    `employee-portal nav permission drift — the registry copy disagrees with the page's own gate:\n  ${mismatches.join("\n  ")}`,
  );
  assert.ok(
    confirmed >= 30,
    `expected the pages to confirm the seeded permissions, but only ${confirmed} matched — ` +
      `the gate reader may have silently stopped reading portal pages`,
  );
}
