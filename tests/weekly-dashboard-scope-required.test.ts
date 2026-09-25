import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { requireWeeklyAccessScope, type WeeklyAccessScope } from "../src/lib/sales/weekly/access.ts";
import { loadWeeklyDashboard } from "../src/lib/sales/weekly/service.ts";
import { stripComments } from "./support/comment-strip.ts";

// 🔴 THE WEEKLY DASHBOARD LOADER DEFAULTED TO "FULL ACCESS, RESTRICTED PRODUCTS REVEALED" — found 2026-09-20.
//
// loadWeeklyDashboard read `filters?.accessScope ?? { tier: "full", canViewRestricted: true, ... }`: a caller
// that left the scope out was answered with every restricted product (Lacto Basic 1 and 2, Satoslim) in the
// rows, the KPIs, the option lists and the exports. The read runs on the service-role client, which bypasses
// RLS, so the scope IS the boundary. Every caller passed one on the day it was audited — which is exactly the
// state a fail-open default hides until the first caller that forgets. The next dashboard, export or portal
// screen would have shipped the leak without a single test going red.
//
// The scope is now a required argument, a missing or unrecognised one throws before anything is read, and
// every call site is pinned to pass one. The type alone is not the pin: a cast, a spread of an untyped object
// or a non-TypeScript caller walks straight past it, so the behaviour and the sources are judged too.

const EVERY_TIER: { label: string; scope: WeeklyAccessScope }[] = [
  { label: "full, restricted revealed (CEO, Super Admin)", scope: { tier: "full", canViewRestricted: true, canViewHeadOffice: true } },
  { label: "full, restricted hidden (SFE Manager)", scope: { tier: "full", canViewRestricted: false, canViewHeadOffice: false } },
  { label: "product", scope: { tier: "product", productCodes: new Set(["LA001"]), canViewHeadOffice: false } },
  {
    label: "territory",
    scope: { tier: "territory", allowedLineNames: null, allowedRegionCodes: null, allowedAreaCodes: null, canViewHeadOffice: false },
  },
  { label: "none", scope: { tier: "none", canViewHeadOffice: false } },
];

// Things that are not a scope. Each is what a forgotten, mistyped or half-built argument looks like.
const NOT_A_SCOPE: { label: string; value: unknown }[] = [
  { label: "undefined", value: undefined },
  { label: "null", value: null },
  { label: "an empty object", value: {} },
  { label: "a tier that does not exist", value: { tier: "everyone", canViewHeadOffice: true } },
  { label: "a tier that is not a string", value: { tier: 1, canViewHeadOffice: true } },
  { label: "a string", value: "full" },
];

const SCOPE_MESSAGE = /access scope/i;

/** Comments out, so an explanation that names a call cannot satisfy or trip a source check. */
function code(source: string): string {
  return stripComments(source);
}

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

/** The text between the parentheses of every call to `name(` in one source, the definition excluded. */
function callArguments(source: string, name: string): string[] {
  const calls: string[] = [];
  const needle = `${name}(`;
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + needle.length)) {
    if (/function\s+$/.test(source.slice(Math.max(0, at - 20), at))) continue;
    let depth = 0;
    let end = -1;
    for (let index = at + name.length; index < source.length; index += 1) {
      const char = source[index];
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    assert.notEqual(end, -1, `${name}( is closed`);
    calls.push(source.slice(at + needle.length, end));
  }
  return calls;
}

/** Every .ts/.tsx source under app/ and src/ that calls the loader. */
function callersOfTheLoader(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && /\bloadWeeklyDashboard\(/.test(code(readFileSync(full, "utf8")))) {
        found.push(relative(process.cwd(), full).split(sep).join("/"));
      }
    }
  };
  walk(join(process.cwd(), "app"));
  walk(join(process.cwd(), "src"));
  // service.ts holds the definition, which is not a call.
  return found.filter((rel) => rel !== "src/lib/sales/weekly/service.ts").sort();
}

export async function runWeeklyDashboardScopeRequiredTests() {
  // ── requireWeeklyAccessScope: every real tier passes through untouched ───────────────────────────
  for (const { label, scope } of EVERY_TIER) {
    assert.equal(requireWeeklyAccessScope(scope), scope, `${label}: the scope comes back as the same object`);
  }

  // ── ...and everything that is not a scope is refused, loudly ─────────────────────────────────────
  for (const { label, value } of NOT_A_SCOPE) {
    assert.throws(
      () => requireWeeklyAccessScope(value as never),
      SCOPE_MESSAGE,
      `${label} is refused: there is no default scope to fall back to`,
    );
  }

  // ── The loader itself refuses, and does so before it reads anything ──────────────────────────────
  // Judged on the message: a loader that reached the database first would fail on something else (or, with
  // credentials, would answer with every product) and never say the scope was missing.
  const badCalls: { label: string; call: () => Promise<unknown> }[] = [
    { label: "no argument at all", call: () => loadWeeklyDashboard(undefined as never) },
    { label: "an empty filter object", call: () => loadWeeklyDashboard({} as never) },
    { label: "filters with no scope", call: () => loadWeeklyDashboard({ allWeeks: true, lineCodes: ["Head Office"] } as never) },
    { label: "an explicitly undefined scope", call: () => loadWeeklyDashboard({ allWeeks: true, accessScope: undefined } as never) },
    { label: "a scope with an unknown tier", call: () => loadWeeklyDashboard({ accessScope: { tier: "everyone" } } as never) },
  ];
  for (const { label, call } of badCalls) {
    await assert.rejects(call, SCOPE_MESSAGE, `loadWeeklyDashboard refuses ${label} before reading anything`);
  }

  // ── The sources: no default can come back, and every call site passes a scope ────────────────────
  const service = code(read("src/lib/sales/weekly/service.ts"));
  assert.match(
    service,
    /export async function loadWeeklyDashboard\(filters: \{/,
    "the loader takes a REQUIRED filters object (filters?: would let a caller pass nothing)",
  );
  assert.match(service, /\n\s{2}accessScope: WeeklyAccessScope;/, "accessScope is a required member of the filters");
  assert.doesNotMatch(service, /accessScope\?\s*:/, "accessScope is never optional");
  assert.doesNotMatch(service, /accessScope\s*\?\?/, "no `accessScope ?? …` fallback stands in for a missing scope");
  assert.doesNotMatch(service, /accessScope\?\.tier/, "no read of `accessScope?.tier` treats a missing scope as a tier");
  assert.doesNotMatch(
    service,
    /tier:\s*"full",\s*canViewRestricted:\s*true/,
    'the loader builds no "full access, restricted revealed" scope of its own',
  );
  assert.match(
    service,
    /\}\): Promise<WeeklyDashboard> \{\s*const accessScope = requireWeeklyAccessScope\(filters\?\.accessScope\);\s*const supabase = getSupabaseAdmin\(\);/,
    "the scope is checked as the FIRST statement, ahead of the first read",
  );

  const callers = callersOfTheLoader();
  assert.ok(callers.length >= 8, `the scan finds the loader's callers (${callers.length})`);
  for (const rel of callers) {
    const source = code(read(rel));
    const calls = callArguments(source, "loadWeeklyDashboard");
    assert.ok(calls.length > 0, `${rel}: at least one call is found`);
    for (const args of calls) {
      const carriesScope = /\baccessScope\b/.test(args);
      // summary-export builds one shared filter object and spreads it into every load; the scope must be in it.
      const spreadsSharedFilters =
        /\.\.\.sharedFilters\b/.test(args) && /const sharedFilters = \{[\s\S]*?\baccessScope\b[\s\S]*?\} as const/.test(source);
      assert.ok(carriesScope || spreadsSharedFilters, `${rel}: every loadWeeklyDashboard call passes the viewer's accessScope`);
    }
  }
}
