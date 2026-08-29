import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { hrNamespaceRemainder, isHrRewritablePath, toHrNamespacePath } from "@/lib/navigation/shell-headers";

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
// AND SO DOES THE SECOND SPELLING OF THE SAME PAGE
// The HR seats reach admin pages through an /hr address that middleware rewrites
// onto the real route: the sidebar links /hr/admin/hr-command-center, and the
// page serving it is app/(admin)/admin/hr-command-center/page.tsx. A scan
// matching only the filesystem route therefore reads a page linked ONLY by its
// /hr spelling as reachable by nobody. That is how this file first went red, on
// a page that was linked from the HR rail and was every HR seat's own landing
// destination. A mention of the /hr spelling counts as a mention.
//
// The alias is built from the rewrite contract itself (isHrRewritablePath,
// toHrNamespacePath, hrNamespaceRemainder in src/lib/navigation/shell-headers)
// rather than by pasting the prefix, so if that contract changes this follows it
// instead of quietly counting an address that no longer resolves. It corrects a
// blind spot rather than hiding a strand, and that is measurable: applied to the
// tree at eccf0920 the count is still 11, exactly as it was without it. The
// alias moves nothing that was already counted honestly.
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
 *
 * 11 -> 10 on 2026-08-28, and NOT because anything was delisted. Retiring Doctor
 * Coverage and Rep Doctor Lists turned two pages into bare redirect stubs, which
 * isRetiredRedirectStub now excludes on the reasoning documented at that helper.
 * Applying that rule found a THIRD such stub that had been in this count all
 * along: /admin/workflow-registry, seven lines forwarding to
 * /admin/workflow-control. It was never a stranded page — it renders nothing to
 * strand — so the honest figure was always 10, and the two retirements net to
 * zero. That is why this moves DOWN in the same change that removed two pages
 * from the nav, which would otherwise look like exactly the accounting trick the
 * paragraph above forbids.
 */
const BASELINE = 10;

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

/**
 * A page whose entire body is a redirect is not a page anyone can be stranded on — it holds no
 * content to reach, and its only job is to forward a bookmark or a history hit somewhere real. Two
 * such stubs appeared on 2026-08-28, when the owner retired Doctor Coverage and Rep Doctor Lists.
 *
 * They are skipped STRUCTURALLY rather than by path, for two reasons. A hardcoded list of routes
 * would have to be taken on trust, and would be the obvious place to quietly park a page someone
 * did strand. This regex cannot be argued with: it matches only a file reduced to an import, an
 * optional dynamic export, and one redirect call — no JSX, no branches, no logic of any kind. And
 * it self-maintains. The moment real content returns to such a file it stops matching, re-enters
 * the count, and the ratchet fires again if nothing links to it.
 *
 * This is deliberately NOT a raise of BASELINE, which this file forbids and is right to forbid. A
 * raise would assert 'two more pages are unreachable, accept it'. This asserts something narrower
 * and checkable: those two routes no longer render a page at all.
 */
const REDIRECT_STUB_BODY =
  /^(?:export const dynamic = "force-dynamic";)? ?export default async function \w+\(\) \{ redirect\("\/[a-z0-9/_-]*"\); \}$/i;

function isRetiredRedirectStub(file: string): boolean {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/^\s*import[^;]*;/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
  return REDIRECT_STUB_BODY.test(stripped);
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
    if (isRetiredRedirectStub(unix)) continue;
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

  // Both addresses that resolve to this page: its own route, and the /hr spelling
  // middleware rewrites onto it. Round-tripped through the contract rather than
  // assumed, so an /hr address the rewrite would refuse is never counted as a link.
  const spellingsOf = (route: string): string[] => {
    const prefixed = toHrNamespacePath(route);
    if (prefixed === route) return [route];
    if (!isHrRewritablePath(prefixed) || hrNamespaceRemainder(prefixed) !== route) return [route];
    return [route, prefixed];
  };

  // A page mentioning its own path does not make it reachable.
  const unreachable = [...pageFileOf.entries()]
    .filter(
      ([route, own]) =>
        spellingsOf(route)
          .flatMap((spelling) => [...(mentionedIn.get(spelling) ?? [])])
          .filter((f) => f !== own).length === 0,
    )
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
