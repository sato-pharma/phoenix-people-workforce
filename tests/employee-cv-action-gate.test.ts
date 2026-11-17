import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * A seat that cannot open an employee's CV is never offered one — on the Employees directory and on
 * both organograms.
 *
 * WHY THIS TEST EXISTS. Production's System Audit board photographed GET /api/employees/:hrId/cv
 * answering 403 "Forbidden: your role cannot open employee CVs." 89 times between 25 Oct and 5 Nov
 * 2026: 56 from one HR Operations Specialist on /hr/employees, the rest from the Training Manager,
 * Marketing Manager, National Sales Manager, District Manager, Product Manager and the two HR seats
 * on the organograms. Each was a person opened on a screen whose CV control reads the route the
 * moment it mounts, for a viewer the route then refused.
 *
 * THE RULE. The page asks the CV route's own predicate, canDownloadEmployeeCv, on the server and
 * passes the answer down; a component mounts its CV control only when that answer is yes, and every
 * component's default is NO, so a page that forgets the prop shows no CV rather than refusing its
 * viewer once per person. Who may open a CV is NOT widened here — that is the owner's decision, and
 * the route keeps its guard unchanged.
 *
 * Asserted on source, comments stripped: nothing in this suite renders React, and the claims are
 * about which element is mounted under which condition.
 */

function code(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
}

/**
 * The guard that decides whether `mountAt` renders: the nearest `canReadEmployeeCv ? (` before the
 * mount, with no conditional closed (`) : null}`) between the two. Returns null when the mount is not
 * under such a guard.
 */
function guardBefore(source: string, mountAt: number): string | null {
  const before = source.slice(0, mountAt);
  const guardAt = before.search(/canReadEmployeeCv\s*\?\s*\(\s*(?![\s\S]*canReadEmployeeCv\s*\?\s*\()/);
  if (guardAt === -1) return null;
  const between = before.slice(guardAt);
  if (/\)\s*:\s*null\s*\}/.test(between)) return null;
  return between;
}

export function runEmployeeCvActionGateTests() {
  // ── 1. THE ROUTE'S OWN PREDICATE IS THE ONE THE PAGES ASK ─────────────────────────────────
  const route = code("app/api/employees/[hrId]/cv/route.ts");
  assert.match(
    route,
    /if \(!canDownloadEmployeeCv\(access\)\)/,
    "the CV download is still gated on canDownloadEmployeeCv — the pages must ask that same predicate",
  );

  // ── 2. BOTH EMPLOYEES PAGES DECIDE THE ANSWER ON THE SERVER ───────────────────────────────
  for (const path of ["app/(admin)/employees/page.tsx", "app/employee-portals/employees/page.tsx"]) {
    const page = code(path);
    assert.match(
      page,
      /import \{ canDownloadEmployeeCv \} from "@\/lib\/employees\/employee-cv";/,
      `${path} imports the CV route's predicate`,
    );
    assert.match(
      page,
      /<EmployeeManagement[\s\S]*?canReadEmployeeCv=\{canDownloadEmployeeCv\(access\)\}[\s\S]*?\/>/,
      `${path} must hand the directory canDownloadEmployeeCv(access), decided on the server`,
    );
  }

  // ── 3. THE DIRECTORY MOUNTS ITS CV PANEL ONLY FOR A READER ────────────────────────────────
  const directory = code("src/components/employees/employee-management.tsx");
  assert.match(
    directory,
    /canReadEmployeeCv = false,/,
    "the directory's canReadEmployeeCv defaults to false — a page that forgets it shows no CV panel",
  );
  assert.ok(
    !directory.includes("@/lib/employees/employee-cv\""),
    "the directory never decides the answer itself — it is a client component and the predicate is the server's",
  );
  const mounts = [...directory.matchAll(/<EmployeeCvManager\b/g)].map((match) => match.index ?? -1);
  assert.equal(
    mounts.length,
    2,
    "the directory mounts the CV panel in two places (the details panel and the edit form) — a new " +
      "mount must be gated too, then counted here",
  );
  for (const mountAt of mounts) {
    const guard = guardBefore(directory, mountAt);
    assert.ok(
      guard !== null,
      `the CV panel at offset ${mountAt} must sit under a canReadEmployeeCv ? ( … ) : null guard — ` +
        "it reads GET /api/employees/:hrId/cv as it mounts, and a seat outside the reader set is refused",
    );
  }

  // ── 4. EVERY ORGANOGRAM LAYER FAILS CLOSED ────────────────────────────────────────────────
  for (const path of [
    "src/components/organogram/organogram-node-detail-modal.tsx",
    "src/components/organogram/org-chart.tsx",
    "src/components/reports/organogram-report.tsx",
    "src/components/employee-portal/employee-organogram-dashboard.tsx",
  ]) {
    const source = code(path);
    assert.ok(
      /canReadEmployeeCv = false\b/.test(source) && !/canReadEmployeeCv = true\b/.test(source),
      `${path} must default canReadEmployeeCv to false — true probed the CV route for every viewer of a page that forgot the prop`,
    );
  }
  for (const path of [
    "app/employee-portals/organogram/page.tsx",
    "app/(admin)/organogram/page.tsx",
    "src/components/workspace/admin-shell-employee-pages.tsx",
  ]) {
    assert.ok(
      code(path).includes("canReadEmployeeCv={canDownloadEmployeeCv(access)}"),
      `${path} must decide the organogram's CV answer on the server with the CV route's own predicate`,
    );
  }
}
