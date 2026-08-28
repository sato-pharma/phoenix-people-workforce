import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Every nav test in this repo checks the same direction: nav -> route. Given a
// sidebar link, does a page exist? (`sfe-manager-nav-dead-links`,
// `organogram-nav-link-exists-for-every-role-that-can-open-it`, and others.)
//
// Nothing checked the REVERSE: route -> nav. Given a page that ships, can anyone
// get to it? A page can be built, merged, deployed and served, and be reachable
// by nobody, and every existing test stays green — because a page with no link
// breaks no link.
//
// That gap matters most during a navigation restructure. Regrouping 294
// destinations across two layers is exactly the operation that strands a page:
// the section holding its only link gets split, renamed or dropped, the page
// keeps working perfectly, and it silently stops existing for every user.
//
// SO WHAT COUNTS AS REACHABLE
// A page route is reachable if its path appears as a string literal in ANY other
// source file. That deliberately includes both navigation layers, which live in
// one file and were the source of an earlier miscount here:
//
//   Layer 1  *NavigationSectionSeeds     - the sidebar rail
//   Layer 2  *PageItems / hubPageItemGroups - the cards on each hub page
//
// A first pass at this measurement excluded system-navigation.ts entirely, to
// answer "not in the sidebar" — and so counted every hub-only page as
// unreachable, reporting 56 when the real figure was 11. Both layers count.
//
// WHAT THIS CANNOT SEE, AND WHY THE BASELINE IS A CEILING NOT A CENSUS
// A route assembled at runtime is invisible to a literal scan: 63 files build
// hrefs as template literals, and `direct-orders-workspace.tsx` builds its eight
// desk routes by concatenating suffix fragments ("/held", "/pharmacies", …) onto
// a base path, so those full routes appear nowhere as literals. Every such page
// is reachable in the product while looking unreachable here. The baseline is
// therefore an upper bound on a real problem, never a list of dead pages — do
// not "clean up" anything on the strength of this test alone.
//
// EXCLUDED BY DESIGN
// Routes no sidebar should ever carry: the root, /login, /privacy, /terms,
// /dev/** and /auth/**. Dynamic segments ([id]) are not directly linkable. The
// employee portal builds its own sidebar and is out of scope.
//
// This RATCHETS, in the idiom of no-ellipsis-truncation-ratchet.test.ts: the
// count may fall and may never rise.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Counted 2026-08-28 on commit eccf0920, before the navigation restructure.
 *
 * The eleven that nothing references. Several are plausibly reached from
 * outside the codebase or by a runtime-assembled href — /whatsapp-connect reads
 * like an external OAuth landing — so this is a watermark, not a to-do list.
 *
 * Lower it when a page is genuinely wired up or genuinely deleted. Never raise
 * it to make a red run go green: a rise means the restructure just stranded a
 * page that used to be reachable, which is the single failure mode this file
 * exists to catch.
 */
const BASELINE = 11;

const ROOTS = ["app", "src"];

/** Correctly absent from any sidebar — not findability defects. */
const NEVER_IN_NAV = [/^\/$/, /^\/login$/, /^\/privacy$/, /^\/terms$/, /^\/dev(\/|$)/, /^\/auth(\/|$)/];

/** A route-shaped string literal: "/admin/foo", '/sales/weekly', `/attendance`. */
const ROUTE_LITERAL = /["'`](\/[a-z0-9][a-z0-9/_-]*)["'`]/gi;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === ".next" || entry.startsWith("_wt-")) continue;
      walk(full, out);
    } else if (/\.(tsx?|jsx?)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** app/(admin)/admin/early-birds/page.tsx -> /admin/early-birds */
function routeOf(file: string): string | null {
  const unix = file.replace(/\\/g, "/");
  if (!/(^|\/)page\.tsx$/.test(unix)) return null;
  const segments = unix
    .replace(/^app\//, "")
    .replace(/(^|\/)page\.tsx$/, "")
    .split("/")
    .filter((s) => s && !/^\(.*\)$/.test(s));
  if (segments.some((s) => s.startsWith("["))) return null;
  return `/${segments.join("/")}`;
}

export function runNavigationPageFindabilityRatchetTests() {
  const files = ROOTS.flatMap((root) => walk(root));

  assert.ok(
    files.length > 1000,
    `only ${files.length} source files were scanned — the walk is not reaching the tree, so any count it reports is meaningless`,
  );

  // Every admin page route, mapped to the file that defines it.
  const pageFileOf = new Map<string, string>();
  for (const file of files) {
    const unix = file.replace(/\\/g, "/");
    if (unix.startsWith("app/employee-portals/")) continue;
    const route = routeOf(file);
    if (!route || NEVER_IN_NAV.some((re) => re.test(route))) continue;
    pageFileOf.set(route, unix);
  }

  assert.ok(
    pageFileOf.size > 150,
    `only ${pageFileOf.size} admin page routes were found — the route parser is broken, so the count below is meaningless`,
  );

  // Every route-shaped literal in the tree, and which files mention it.
  const mentionedIn = new Map<string, Set<string>>();
  for (const file of files) {
    const unix = file.replace(/\\/g, "/");
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(ROUTE_LITERAL)) {
      const route = match[1].replace(/\/$/, "");
      if (!route) continue;
      if (!mentionedIn.has(route)) mentionedIn.set(route, new Set());
      mentionedIn.get(route)!.add(unix);
    }
  }

  // A page mentioning its own path does not make it reachable.
  const unreachable = [...pageFileOf.entries()]
    .filter(([route, own]) => [...(mentionedIn.get(route) ?? [])].filter((f) => f !== own).length === 0)
    .map(([route]) => route)
    .sort();

  const count = unreachable.length;

  assert.ok(
    count <= BASELINE,
    `${count - BASELINE} admin page(s) just became unreachable — the count went ${BASELINE} -> ${count}.\n` +
      `A page with no link anywhere still builds, still deploys, and still serves — it simply stops ` +
      `existing for every user. If a restructure moved these, give each one a home in the sidebar rail ` +
      `or on a hub page.\n` +
      `Unreachable now:\n  ${unreachable.join("\n  ")}`,
  );

  assert.ok(
    count >= BASELINE,
    `Good news: unreachable admin pages dropped ${BASELINE} -> ${count}. Lower BASELINE in this file ` +
      `to ${count} so the ground that was won cannot be given back.`,
  );
}
