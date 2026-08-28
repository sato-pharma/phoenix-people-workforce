import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { hrBundleGrants, HR_ROLE_BUNDLES, type HrBundleName } from "../src/lib/auth/hr-functions.ts";
import type { PermissionAction, PermissionResource } from "../src/lib/auth/permissions.ts";

/**
 * HR SEAT ROUTE COHERENCE — "nothing they are offered will bounce them".
 *
 * A permission matrix is checked one resource:action pair at a time, but a route handler is not
 * gated one pair at a time: POST /api/employees/[hrId]/resign asserts employees:update AND
 * resignations:create AND vacancies:create, all three, before it does anything. A seat holding two
 * of the three does not get two thirds of a resignation — it gets a 403, from a page its own
 * sidebar offered it.
 *
 * That is exactly what shipped. HR Operations owns offboarding (ops 6) and held
 * employees:update + resignations:create; HR Advisory held vacancies:create through recruiting.
 * NEITHER seat could record a single resignation, and no per-pair test could see it, because every
 * individual grant was correct on its own. The defect lived in the gap between them.
 *
 * So this test reads the ROUTES rather than the matrix: for every HTTP handler in app/api, if a
 * seat holds SOME of the permissions that handler asserts, it must hold ALL of them. Holding NONE
 * is fine and is the normal case — that is a boundary doing its job. Holding SOME is the bug shape.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Comments and string CONTENTS replaced by spaces, LENGTH PRESERVED, so offsets computed on the
 * blanked text still index the original. Without this a brace inside a string or a comment ends a
 * handler body early and its assertions land under the wrong HTTP method.
 */
function blankOut(source: string): string {
  const chars = source.split("");
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") {
        chars[i] = " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] !== "\n") chars[i] = " ";
        i += 1;
      }
      if (i < n) {
        chars[i] = " ";
        chars[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      chars[i] = " ";
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          chars[i] = " ";
          if (i + 1 < n && source[i + 1] !== "\n") chars[i + 1] = " ";
          i += 2;
          continue;
        }
        if (source[i] === c) {
          chars[i] = " ";
          i += 1;
          break;
        }
        if (source[i] !== "\n") chars[i] = " ";
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return chars.join("");
}

type Handler = { method: string; body: string };

function handlers(source: string): Handler[] {
  const blank = blankOut(source);
  const found: Handler[] = [];
  const re = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(blank))) {
    let i = match.index + match[0].length - 1;
    let parens = 0;
    for (; i < blank.length; i += 1) {
      if (blank[i] === "(") parens += 1;
      else if (blank[i] === ")") {
        parens -= 1;
        if (parens === 0) {
          i += 1;
          break;
        }
      }
    }
    while (i < blank.length && blank[i] !== "{") i += 1;
    const start = i;
    let braces = 0;
    for (; i < blank.length; i += 1) {
      if (blank[i] === "{") braces += 1;
      else if (blank[i] === "}") {
        braces -= 1;
        if (braces === 0) {
          i += 1;
          break;
        }
      }
    }
    found.push({ method: match[1], body: source.slice(start, i) });
  }
  return found;
}

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

/**
 * Handlers whose assertions are NOT one hard gate, so "some but not all" is correct there. Each
 * entry names a specific file and its reason — never a pattern, so a new offender cannot hide
 * behind an existing exemption.
 */
const NOT_A_HARD_GATE: Record<string, string> = {
  "app/api/approvals/badge-counts/route.ts":
    "every domain runs inside Promise.allSettled and a rejected assertion falls back to {count: 0}, " +
    "so a seat missing one of the three reads gets an unbadged row, never a 403",
};

export async function runHrSeatRouteCoherenceTests() {
  const apiRoot = path.join(REPO_ROOT, "app", "api");
  const files = routeFiles(apiRoot);
  assert.ok(files.length > 300, `expected the whole api tree, found ${files.length} route files`);

  const seats = Object.keys(HR_ROLE_BUNDLES) as HrBundleName[];
  const held = new Map<HrBundleName, Set<string>>();
  for (const seat of seats) {
    const grants = hrBundleGrants(seat);
    const keys = new Set<string>();
    for (const [resource, actions] of Object.entries(grants)) {
      for (const action of actions ?? []) keys.add(`${resource as PermissionResource}:${action as PermissionAction}`);
    }
    held.set(seat, keys);
  }

  let handlersScanned = 0;
  let gatedHandlers = 0;
  let multiGrantHandlers = 0;
  const failures: string[] = [];

  for (const file of files) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    const source = readFileSync(file, "utf8");
    for (const handler of handlers(source)) {
      handlersScanned += 1;
      const required = new Set<string>();
      const re = /assertPermission\(\s*[A-Za-z_$][\w$]*\s*,\s*"([a-z_]+)"\s*,\s*"([a-z_]+)"\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(handler.body))) {
        required.add(`${match[1]}:${match[2]}`);
      }
      if (required.size === 0) continue;
      gatedHandlers += 1;
      if (required.size < 2) continue;
      multiGrantHandlers += 1;
      if (NOT_A_HARD_GATE[relative]) continue;

      for (const seat of seats) {
        const seatKeys = held.get(seat)!;
        const has = [...required].filter((key) => seatKeys.has(key));
        if (has.length === 0 || has.length === required.size) continue;
        const missing = [...required].filter((key) => !seatKeys.has(key));
        failures.push(
          `${relative} ${handler.method} requires ${[...required].sort().join(" + ")} — ` +
            `"${seat}" holds ${has.sort().join(", ")} but NOT ${missing.sort().join(", ")}, ` +
            "so a page offered to that seat 403s halfway",
        );
      }
    }
  }

  // Floors, so a walk that silently stopped finding routes cannot pass by scanning nothing.
  assert.ok(handlersScanned > 400, `expected the api handlers, found ${handlersScanned}`);
  assert.ok(gatedHandlers > 200, `expected assertPermission-gated handlers, found ${gatedHandlers}`);
  assert.ok(
    multiGrantHandlers >= 2,
    `expected handlers asserting more than one permission, found ${multiGrantHandlers}`,
  );

  assert.deepEqual(
    failures,
    [],
    `HR seat(s) hold PART of a route's permission set:\n  ${failures.join("\n  ")}`,
  );

  // The resignation route is why this test exists. Pin it by name so a refactor that moves the
  // third grant elsewhere cannot quietly take this test's only real subject away.
  const resign = readFileSync(path.join(apiRoot, "employees", "[hrId]", "resign", "route.ts"), "utf8");
  for (const resource of ["employees", "resignations", "vacancies"]) {
    assert.ok(
      resign.includes(`assertPermission(access, "${resource}"`),
      `the resignation route no longer asserts ${resource} — re-check which seat can record a departure`,
    );
  }
  const opsKeys = held.get("HR Operations" as HrBundleName)!;
  for (const key of ["employees:update", "resignations:create", "vacancies:create"]) {
    assert.ok(opsKeys.has(key), `HR Operations owns offboarding but lacks ${key}`);
  }
}
