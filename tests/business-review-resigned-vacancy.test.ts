import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isResignedStatus } from "@/lib/business-review/employment-status";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Owner, 2026-09-28: resigned reps were appearing in Business Review and "Exclude vacant" did not
 * remove them. A rep who has LEFT the company no longer holds the seat, so the review must read that
 * seat VACANT — which lets "Exclude vacant" clear it — and drop the resigned person from the people
 * table under the same toggle. His sales still count in the area/line totals; vacancy is display state
 * and never changes a figure.
 */

const CANONICAL = "src/lib/business-review/canonical.ts";
const ROLES = "src/lib/business-review/sources/roles.ts";
const DASHBOARD = "src/components/business-review/dashboard.client.tsx";
const PORTAL = "src/components/business-review/portal-review.client.tsx";

export function runBusinessReviewResignedVacancyTests() {
  // ── 1. the one authority for "has left" ──────────────────────────────────────────────────────
  {
    for (const yes of ["resigned", "Resigned", "terminated", "Terminated", "exited", "contract exit"]) {
      assert.ok(isResignedStatus(yes), `"${yes}" is a leaver`);
    }
    for (const no of ["active", "Active", "probation", "on leave", "", null, undefined]) {
      assert.ok(!isResignedStatus(no), `"${no}" is NOT a leaver`);
    }
  }

  // ── 2. a resigned OCCUPANT reads the seat vacant, in canonical, for BOTH area and DM ──────────
  {
    const src = stripComments(readFileSync(CANONICAL, "utf8"));
    // The named list grew when the pack gained `leaverLabel`; what this pins is that canonical reads
    // the shared authority rather than carrying its own copy of the pattern.
    assert.match(
      src,
      /import \{[^}]*isResignedStatus[^}]*\} from "\.\/employment-status"/,
      `${CANONICAL}: must use the one leaver authority, not a private regex.`,
    );
    assert.ok(
      !/\/resign\|terminat\|exit\//.test(src),
      `${CANONICAL}: the leaver pattern itself must live only in employment-status.ts.`,
    );
    // Area vacancy is decided against the last period's occupants and their CURRENT status.
    assert.ok(
      /lastOccupants[\s\S]{0,200}isResignedStatus\(ctx\.directory\.get\(hrKey\(id\)\)\?\.employmentStatus\)/.test(src),
      `${CANONICAL}: an area whose only last-period occupant(s) have resigned must read vacant.`,
    );
    // DM vacancy folds in a resigned district manager.
    assert.ok(
      /dmResigned\s*=\s*!!dmHrId\s*&&\s*isResignedStatus/.test(src) &&
        /vacant:\s*!isUnmanaged\s*&&\s*\(!dmHrId\s*\|\|\s*dmResigned\)/.test(src),
      `${CANONICAL}: a district manager who has resigned must make the seat read vacant.`,
    );
  }

  // ── 3. the seat builder shares the same authority ────────────────────────────────────────────
  {
    const src = stripComments(readFileSync(ROLES, "utf8"));
    assert.ok(
      src.includes("isResignedStatus(entry.employmentStatus)"),
      `${ROLES}: the headcount/seat builder must use the shared leaver authority, not a copy of the regex.`,
    );
    assert.ok(
      !/\/resign\|terminat\|exit\//.test(src),
      `${ROLES}: the inline leaver regex must be gone — one authority only.`,
    );
  }

  // ── 4. "Exclude vacant" drops resigned people from the people table ──────────────────────────
  {
    const src = stripComments(readFileSync(DASHBOARD, "utf8"));
    const drops = (src.match(/excludeVacant \? [a-z.]*people\.filter\(\(p\) => !isResignedStatus\(p\.employmentStatus\)\)/g) ?? []).length;
    assert.ok(
      drops >= 2,
      `${DASHBOARD}: both the company and line people tables must drop resigned reps when "Exclude vacant" is on — found ${drops}.`,
    );
    // The toggle says what it does, in the owner's words (2026-10-29: one switch, "Hide vacant and resigned").
    assert.ok(
      (src.match(/>Hide vacant and resigned</g) ?? []).length >= 2,
      `${DASHBOARD}: both admin toggles must read "Hide vacant and resigned".`,
    );
  }

  // ── 5. The manager portal's switch hides resigned people too, and its vacant-areas list ────────
  {
    const src = stripComments(readFileSync(PORTAL, "utf8"));
    assert.ok(src.includes(">Hide vacant and resigned<"), `${PORTAL}: the portal switch must read "Hide vacant and resigned".`);
    assert.ok(!src.includes("Exclude vacant"), `${PORTAL}: the old "Exclude vacant" wording must be gone.`);
    assert.match(
      src,
      /excludeVacant \? people\.filter\(\(p\) => !isResignedStatus\(p\.employmentStatus\)\) : people/,
      `${PORTAL}: the switch must drop resigned people from the people lists.`,
    );
    const peopleProps = src.match(/people=\{[a-zA-Z]+\}/g) ?? [];
    assert.ok(
      peopleProps.length >= 2 && peopleProps.every((prop) => prop === "people={visiblePeople}"),
      `${PORTAL}: every people list must read the switched list — found ${peopleProps.join(", ")}.`,
    );
    assert.match(
      src,
      /\{excludeVacant \? null : \(\s*<PortalSection[\s\S]{0,200}title=\{\x60Vacant areas \(/,
      `${PORTAL}: the Vacant areas list must hide while the switch is on.`,
    );
  }
}
