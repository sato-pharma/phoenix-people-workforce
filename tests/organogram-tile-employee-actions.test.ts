import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildEmployeeMasterHref,
  employeeMasterArrivalKey,
  employeeMasterBasePath,
  readEmployeeMasterArrival,
} from "../src/lib/employees/employee-master-link.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Every employee tile on the organogram now carries two buttons: Edit, which opens that person's
 * edit form in Employee Master, and Resign, which opens their resignation dialog there. The chart
 * holds neither form — the buttons are links, and Employee Master reads the HR id back out of the
 * URL and opens its own screens. This pins both halves of that round trip, and the places the
 * buttons must (and must not) appear.
 */
export async function runOrganogramTileEmployeeActionsTests() {
  const base = "https://phoenix-hr.satopharma.com";

  // ── The link, and what the master reads back out of it ────────────────────────────────────
  for (const action of ["edit", "resign"] as const) {
    const href = buildEmployeeMasterHref("/employees", action, "CN-0002");
    assert.equal(href, `/employees?${action}=CN-0002`, `${action} leads with its own param`);
    const arrival = readEmployeeMasterArrival((key) => new URL(href, base).searchParams.get(key));
    assert.deepEqual(
      arrival,
      { action, hrId: "CN-0002" },
      `${action}: the HR id and the action must arrive at Employee Master exactly as the tile sent them`,
    );
  }

  // The portal shell has its OWN Employee Master route — a link to /employees would bounce an
  // employee-portal viewer to the landing page.
  assert.equal(employeeMasterBasePath("/employee-portals/organogram"), "/employee-portals/employees");
  assert.equal(employeeMasterBasePath("/organogram"), "/employees");
  assert.equal(employeeMasterBasePath(null), "/employees", "no pathname falls back to the admin shell");

  // An HR id with a separator or spaces survives encoding, and padding is trimmed off the way in.
  const padded = buildEmployeeMasterHref("/employees", "edit", "  PD 0001/x  ");
  assert.equal(
    readEmployeeMasterArrival((key) => new URL(padded, base).searchParams.get(key))?.hrId,
    "PD 0001/x",
    "an unusual id round-trips unmangled and unpadded",
  );

  // An unrelated visit to Employee Master must be left completely alone.
  assert.equal(readEmployeeMasterArrival(() => null), null, "no param, no arrival");
  assert.equal(
    readEmployeeMasterArrival((key) => (key === "edit" ? "   " : null)),
    null,
    "a blank id is not an arrival — it would otherwise open a form for nobody",
  );
  assert.equal(
    readEmployeeMasterArrival((key) => (key === "hireVacancy" ? "1" : null)),
    null,
    "the seat-hire marker is a different door and must not read as an edit",
  );

  // An ambiguous link must never pick the destructive one.
  assert.equal(
    readEmployeeMasterArrival((key) => (key === "edit" || key === "resign" ? "CN-0002" : null))?.action,
    "edit",
    "with both params present, edit wins — resign is the one that ends employment",
  );

  // Once per arrival, and the same person in a different case is the same arrival (production
  // stores hr_id mixed-case, so the chart and the URL can disagree on case).
  assert.equal(
    employeeMasterArrivalKey({ action: "edit", hrId: "CN-0002" }),
    employeeMasterArrivalKey({ action: "edit", hrId: "cn-0002" }),
    "case must not reopen a form that was just closed",
  );
  assert.notEqual(
    employeeMasterArrivalKey({ action: "edit", hrId: "CN-0002" }),
    employeeMasterArrivalKey({ action: "resign", hrId: "CN-0002" }),
    "edit and resign on the same person are different arrivals",
  );

  // ── The chart: where the buttons are, and where they are not ──────────────────────────────
  const chart = stripComments(readFileSync("src/components/organogram/org-chart.tsx", "utf8"));

  assert.match(
    chart,
    /row\.type !== "employee" \|\| !row\.hrId\) return null/,
    "a vacancy has nobody to edit or resign, so it renders no buttons — its popup offers Add employee to this seat",
  );
  assert.match(
    chart,
    /mayChangeEmployees \? \{ basePath: employeeMasterBasePath\(pathname\) \} : null/,
    "the buttons exist only for a viewer who may change employees, and lead to their own shell's route",
  );
  assert.match(chart, /buildEmployeeMasterHref\(actions\.basePath, "edit", row\.hrId\)/, "Edit is wired");
  assert.match(chart, /buildEmployeeMasterHref\(actions\.basePath, "resign", row\.hrId\)/, "Resign is wired");
  assert.match(chart, /data-organogram-action/, "the buttons are marked so print and PNG export can leave them out");
  assert.match(chart, /print:hidden/, "and they do not print");
  assert.match(chart, /"organogramAction" in node\.dataset/, "and the PNG export filters them out");

  // Every kind of tile that holds a person: member card, manager lane, executive spine, RSM banner.
  const tileUses = chart.match(/<EmployeeTileActions\b/g) ?? [];
  assert.equal(
    tileUses.length,
    4,
    "the member card, the manager lane header, the CEO/NSM spine card and the RSM banner each carry the buttons",
  );
  assert.match(chart, /row=\{isVacantManagerSeat \? null : dsmRow\}/, "an open manager seat gets none");
  assert.match(chart, /<EmployeeTileActions row=\{rsmRow\} \/>/, "the regional manager's banner carries them too");

  // ── Employee Master: it opens the real screens, only for someone who may change employees ──
  const master = stripComments(readFileSync("src/components/employees/employee-management.tsx", "utf8"));
  assert.match(master, /readEmployeeMasterArrival\(\(key\) => searchParams\.get\(key\)\)/, "the master reads the arrival");
  assert.match(master, /if \(!canEdit\) \{\s*setError\(/, "a read-only viewer is told so instead of being given a form the API refuses");
  assert.match(master, /hrIdsMatch\(employee\.hrId, masterArrival\.hrId\)/, "the person is found in the directory the viewer already holds");
  // A seat that may edit but not record a departure (the HR Operations Specialist) is told so instead
  // of being handed the resignation form its API would refuse.
  assert.match(
    master,
    /masterArrival\.action === "edit"\) \{\s*startEdit\(person\);\s*\} else if \(!canStartResignation\) \{\s*setError\([^;]*\);\s*\} else \{\s*startResignation\(person\);/,
    "edit opens the edit form, resign opens the resignation dialog — or says it is not the viewer's to record",
  );
  assert.match(master, /is not in the employee directory you can open/, "somebody outside the viewer's scope is reported, never opened");
}
