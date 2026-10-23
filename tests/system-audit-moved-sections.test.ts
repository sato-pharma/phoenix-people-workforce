import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { matchLoginIdsBySearch } from "../src/lib/security/login-security.ts";
import { stripComments } from "./system-audit-routes-access.test.ts";

// The two sections the System Audit took over on 23 Oct 2026 — Login security (from System Issues
// and Monitoring) and Salary flags (from Data Health) — and the three faults they were moved to end:
//
//   · A FIGURE THAT COULD NOT BE READ SAYS "Unavailable", NEVER 0. The old tiles turned a failed
//     read into a zero, and the security lens turned one into an empty "all clear" table.
//   · NOTHING IS CUT AT A ROW LIMIT. The failed sign-in count stopped at 1,000 rows and the salary
//     flags at 500, both without saying so.
//   · RESOLVING A SALARY FLAG KEEPS THE LIST THE TOGGLE IS ON. It used to reload the unresolved list
//     under a ticked "Show resolved".
//
// Plus the owner's locked look (square edges, nothing cut, no sideways scroll, tables that switch on
// their own width), people shown by name and never by an id, and Cairo times.

const ROOT = process.cwd();
const DIR = "src/components/admin/system-audit";
const LOGIN_PANEL = `${DIR}/login-security-panel.tsx`;
const SALARY_PANEL = `${DIR}/salary-flags-panel.tsx`;
const LOGIN_SECTION = `${DIR}/login-security-section.tsx`;
const SALARY_SECTION = `${DIR}/salary-flags-section.tsx`;
const FILES = [LOGIN_PANEL, SALARY_PANEL, LOGIN_SECTION, SALARY_SECTION] as const;

const BANNED: Array<[RegExp, string]> = [
  [/(?<![\w-])rounded(?!-none(?![\w-]))(?:-[\w[\].%/]+)?(?![\w-])/, "a rounded corner (the square-edge golden rule)"],
  [/(?<![\w-])truncate(?![\w-])/, "truncate (text is never cut)"],
  [/(?<![\w-])line-clamp-[\w[\]]+/, "line-clamp (text is never cut)"],
  [/(?<![\w-])text-ellipsis(?![\w-])/, "text-ellipsis (text is never cut)"],
  [/…/, "an ellipsis character (text is never cut)"],
  [/(?<![\w-])overflow-x-(?:auto|scroll)(?![\w-])/, "a horizontal scroll"],
  [/(?<![\w-])min-w-\[/, "a fixed min-width (it forces a sideways scroll)"],
  [/(?<![\w-])(?:sm|md|lg|xl|2xl):(?:table|hidden)(?![\w-])/, "a viewport breakpoint on a table (a table switches on its container's width)"],
];

/** Modules a "use client" file may import only as `import type`. */
const SERVER_ONLY = [
  "@/lib/supabase/server",
  "@/lib/auth/server",
  "@/lib/admin/service",
  "@/lib/security/login-security",
  "@/lib/error-monitor/service",
  "@/lib/auth/ip-blocklist",
];

function raw(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}

function read(file: string): string {
  return stripComments(raw(file));
}

function lookTests() {
  for (const file of FILES) {
    const code = read(file);
    for (const [pattern, what] of BANNED) {
      const hit = pattern.exec(code);
      assert.equal(hit, null, `${file} uses ${what}: "${hit?.[0]}"`);
    }
  }

  let total = 0;
  for (const file of [LOGIN_PANEL, SALARY_PANEL]) {
    const code = read(file);
    const tableCount = (code.match(/<table[\s>]/g) ?? []).length;
    const pattern = /<table\s+className="([^"]*)"[^>]*>\s*<colgroup>([\s\S]*?)<\/colgroup>/g;
    const found = [...code.matchAll(pattern)];
    assert.equal(found.length, tableCount, `${file}: every <table> opens with a <colgroup>`);
    assert.match(code, /@container/, `${file} measures its own width with @container`);
    for (const [index, match] of found.entries()) {
      const where = `${file} table ${index + 1}`;
      const className = match[1] ?? "";
      const cols = (match[2] ?? "").match(/<col\b/g) ?? [];
      const widths = [...(match[2] ?? "").matchAll(/<col\s+className="w-\[(\d+(?:\.\d+)?)%\]"\s*\/>/g)].map((col) => Number(col[1]));
      assert.match(className, /(?<![\w-])w-full(?![\w-])/, `${where} is w-full`);
      assert.match(className, /(?<![\w-])table-fixed(?![\w-])/, `${where} is table-fixed`);
      assert.match(className, /@min-\[\d+px\]:table/, `${where} switches on its container's width`);
      assert.equal(widths.length, cols.length, `${where} sets every column's width in its colgroup`);
      const sum = widths.reduce((acc, width) => acc + width, 0);
      assert.ok(Math.abs(sum - 100) < 0.01, `${where}'s column widths add to ${sum}%, not 100%`);
    }
    // Below the table's width the same rows are cards.
    assert.match(code, /@min-\[\d+px\]:hidden/, `${file} shows cards where the table does not fit`);
    total += found.length;
  }
  assert.ok(total >= 2, "the salary flags table and the security activity table were both found");
}

function clientBoundaryTests() {
  for (const file of [LOGIN_PANEL, SALARY_PANEL]) {
    const source = raw(file);
    assert.match(source, /^\s*["']use client["'];?/, `${file} is the client half`);
    for (const match of source.matchAll(/^import\s+(type\s+)?[\s\S]*?\s+from\s+"([^"]+)";?$/gm)) {
      if (match[1]) continue;
      assert.ok(!SERVER_ONLY.includes(match[2] ?? ""), `${file} is a client component and imports the server-only ${match[2]}`);
    }
  }
  // The sections are what the page mounts with no props, like the Role coverage section: async
  // server components that read the first view and hand it to the client panel.
  const loginSection = read(LOGIN_SECTION);
  const salarySection = read(SALARY_SECTION);
  for (const [file, code] of [[LOGIN_SECTION, loginSection], [SALARY_SECTION, salarySection]] as const) {
    assert.doesNotMatch(raw(file), /^\s*["']use client["']/, `${file} renders on the server`);
    assert.match(code, /export async function \w+Section\(\)/, `${file} takes no props, so the page mounts it as it is`);
  }
  assert.match(loginSection, /await loadLoginSecurityOverview\(\)/);
  assert.match(loginSection, /<LoginSecurityPanel overview=\{overview\} \/>/);
  assert.match(salarySection, /await getSalaryFlags\(false, \{ withNames: true \}\)/, "the first view is every unresolved flag, with names");
  assert.match(salarySection, /<SalaryFlagsPanel initialFlags=\{flags\} loadError=\{loadError\} \/>/, "a failed read reaches the screen with its reason");
}

function unavailableIsNeverZeroTests() {
  const login = read(LOGIN_PANEL);
  assert.match(login, /const UNAVAILABLE = "Unavailable";/);
  assert.match(login, /value === null \? UNAVAILABLE :/, "a null count prints Unavailable, never 0");
  for (const field of ["lockedAccounts", "forcedPasswordResets", "failedSignIns24h", "distinctFailedIps24h"]) {
    assert.match(login, new RegExp(`value=\\{countValue\\(overview\\.${field}\\)\\}`), `the ${field} tile goes through countValue`);
  }
  // Each lens list has its own unavailable branch, keyed to the source that feeds it, ahead of its
  // empty state — so a list nobody could read never says "none".
  for (const flag of ["lockedDown", "attemptsDown", "locationsDown", "blockedDown"]) {
    assert.match(login, new RegExp(`\\{${flag} \\? \\(\\s*<LensUnavailable`), `${flag} shows Unavailable before any empty state`);
  }
  assert.match(login, /\{!activity \? \(\s*<LensUnavailable/, "unreadable activity says so, never 'No security activity recorded'");
  assert.match(login, /overview\.unavailable\.map\(/, "every unreadable source is named on the screen");

  const salary = read(SALARY_PANEL);
  assert.match(salary, /!data \? \(\s*<p[^>]*>Unavailable/, "unreadable salary flags say Unavailable, never 'No unresolved salary flags'");
}

function namesNeverIdsTests() {
  for (const file of [LOGIN_PANEL, SALARY_PANEL]) {
    // React keys are never shown, so they may carry an id.
    const code = read(file).replace(/key=\{`[^`]*`\}/g, "").replace(/key=\{[\w.]+\}/g, "");
    const shown = /(?:\{|\$\{)\s*[\w.]*\.(?:hrId|actorLoginId|loginId|blockedBy)\s*\}/.exec(code);
    assert.equal(shown, null, `${file} prints an id where a person's name belongs: "${shown?.[0]}"`);
  }
}

function cairoTimeTests() {
  for (const file of [LOGIN_PANEL, SALARY_PANEL]) {
    const code = read(file);
    assert.match(code, /import \{ cairoDateTime \} from "@\/lib\/format\/cairo-datetime";/, `${file} prints times through the Cairo formatter`);
    assert.doesNotMatch(code, /toLocale(?:Date|Time)String\(|toISOString\(|new Date\(/, `${file} formats a time without the Cairo formatter`);
  }
}

function salaryToggleTests() {
  const salary = read(SALARY_PANEL);
  assert.match(salary, /JSON\.stringify\(\{ id, showResolved \}\)/, "Resolve tells the route which list the toggle is on");
  assert.match(salary, /\/api\/admin\/salary-flags\?showResolved=\$\{next\}/, "the toggle re-reads the list it names");
  const route = read("app/api/admin/salary-flags/route.ts");
  assert.match(route, /getSalaryFlags\(body\.showResolved === true, \{ withNames: true \}\)/, "the PATCH re-reads the list the screen is showing");
  assert.doesNotMatch(read("src/lib/admin/service.ts"), /\.limit\(500\)/, "the salary flags are never cut at 500");
}

function loginWiringTests() {
  const login = read(LOGIN_PANEL);
  assert.match(login, /`\/api\/admin\/system-audit\/security\?\$\{params\.toString\(\)\}`/, "search and paging re-read the security route");
  assert.match(login, /"\/api\/admin\/system-audit\/block-ip"/, "Block and Unblock call the moved route");
  assert.match(login, /\{ action, days: BLOCK_DAYS, ip, reason \}/, "a block states its length, so the button and the block agree");
  assert.match(login, /window\.confirm\(/, "a block is confirmed before it is sent");

  // The loader counts exactly and pages every list: no read stops at a row limit.
  const loader = read("src/lib/security/login-security.ts");
  assert.match(loader, /count: "exact", head: true/, "the counts are exact counts");
  assert.match(loader, /fetchAllRows</, "the address and account reads are fully paged");
  assert.doesNotMatch(loader, /\.limit\(/, "nothing in the loader is capped");
}

function searchMatchTests() {
  const accounts = [
    { loginId: "admin-HR", hrId: "PHX-1", name: "Omar Gawish" },
    { loginId: "a-8", hrId: "A-8", name: "Rasha Sabry" },
    { loginId: "c-31", hrId: null, name: null },
  ];
  assert.deepEqual(matchLoginIdsBySearch(accounts, "rasha"), ["a-8"], "a person is found by name, whatever the case");
  assert.deepEqual(matchLoginIdsBySearch(accounts, "phx-1"), ["admin-HR"], "a person is found by HR id even when the login differs");
  assert.deepEqual(matchLoginIdsBySearch(accounts, "C-31"), ["c-31"], "an account with no name is still found by its login");
  assert.deepEqual(matchLoginIdsBySearch(accounts, "   "), [], "an empty search matches nobody, so it adds no filter");
  assert.deepEqual(matchLoginIdsBySearch(accounts, "nobody"), []);
}

export function runSystemAuditMovedSectionsTests() {
  lookTests();
  clientBoundaryTests();
  unavailableIsNeverZeroTests();
  namesNeverIdsTests();
  cairoTimeTests();
  salaryToggleTests();
  loginWiringTests();
  searchMatchTests();
}
