import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Standing owner rule (AGENTS.md §4, THE SQUARE-EDGE GOLDEN RULE): "no round or
// semi-round corners, anywhere."
//
// WHY THIS IS A THIRD SQUARE-EDGE TEST AND NOT A LINE IN EITHER EXISTING ONE
// Three different holes, three different instruments:
//
//   square-edge-golden-rule.test.ts    a hand-written `border-radius:` carries no
//                                      `rounded` class, so no sweep selects it.
//   square-edge-portal-ratchet.test.ts `createPortal(node, document.body)` mounts
//                                      outside both shells, so no sweep reaches it.
//   THIS FILE                          a whole ROUTE that is never wrapped in a
//                                      shell at all.
//
// WHY `rounded-full` AND NOTHING ELSE
// This is the one radius class in the system that no token can reach. Compiled from
// the real app/globals.css through this repo's Tailwind v4 pipeline and measured in
// a browser on 2026-10-06:
//
//     .rounded-full { border-radius: calc(infinity * 1px); }   <- a literal
//     .rounded-md   { border-radius: var(--phx-radius-sm); }   <- tokens.css sets 0
//
// Every other step — sm, md, lg, xl, 2xl, 3xl, 4xl — follows a --phx-radius-* that
// src/styles/tokens.css sets to 0, so it renders square EVERYWHERE, shell or no
// shell. `rounded-full` renders square only where globals.css RULE 1 zeroes
// `[class*="rounded"]`, and that happens in exactly two places:
//
//     .admin-shell           [class*="rounded"] { border-radius: 0 !important; }
//     .employee-portal-shell [class*="rounded"] { border-radius: 0 !important; }
//
// So counting every `rounded-*` here would be the noise the sibling test warns
// about. Counting `rounded-full` on a surface no shell wraps is the whole signal.
//
// THE BREACH THAT PROMPTED THIS, measured the same day: app/whatsapp-connect/page.tsx
// carried two `rounded-full` spans — a 10x10 icon circle and a 5x5 step bubble — and
// they were drawing as ACTUAL CIRCLES on a user-facing page. Measured 0px inside a
// shell against 33,554,432px outside one. Nothing in the repo could see it: the two
// existing square-edge tests look for other shapes, and the outstation badge fixed in
// the same PR measured 0px, so looking at the admin screen proved nothing either.
//
// WHY THE SCAN FOLLOWS IMPORTS AND STOPS AT A SHELL
// A route folder carrying no shell class does NOT mean the page is unshelled — the
// shell commonly arrives through a component the page renders. app/dev/employee-portals
// has no shell class of its own and is nevertheless swept, because it nests everything
// inside EmployeePortalChrome -> employee-portal-layout.tsx, which stamps
// `employee-portal-shell`. Reading the folder and not the import chain is what made
// this session call that badge a live pill when it measured 0px. So the walk starts at
// the unshelled routes, follows `@/...` imports, and treats any file that STAMPS a
// shell class as a boundary: everything below it is swept and is not this test's
// business.
//
// WHY A FLOOR AT ZERO AND NOT A RATCHET
// This started as a ratchet at 9, on the assumption that some sites would turn out to
// be inner elements their own styling already squares — a judgement a node test cannot
// make. Every one was then measured in a browser against the real compiled globals.css,
// and ALL TEN read `border-radius: 33554432px`. There were no false positives, so there
// was nothing to hold a ratchet open for, and they were all squared in the same PR.
//
// Zero is the stronger state and must not be given up. Raising this number is how the
// rule dies quietly: the correct response to a red run is `rounded-md`, which is square
// by token in every context, shell or no shell.
//
// WHAT THIS CANNOT DO
// It cannot prove a corner is square — only a browser can. It catches the one case
// where the CSS safety net provably does not apply.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Counted 2026-10-06 on this branch, with comments stripped, over every .tsx reachable
 * from a route that no shell wraps. Lower this when a site is genuinely retired; never
 * raise it to make a red run go green.
 *
 * ZERO. Every site was measured in a browser against the real compiled globals.css on
 * 2026-10-06 — all ten read `border-radius: 33554432px`, none was a false positive —
 * and all ten were squared in the same PR:
 *
 *   2  employee-portal/employee-portal-route-loading.tsx   (ambient glows)
 *   2  marketing-requests/marketing-request-sales-view.tsx (progress bar + fill)
 *   3  marketing-requests/marketing-sales-evidence-panel.tsx (bar, fill, badge)
 *   2  ui/switch.tsx                                       (track + thumb)
 *   1  auth/password-setup-form.tsx                        (spinner ring)
 *
 * plus app/whatsapp-connect's two and app/dev/employee-portals' one.
 *
 * Squaring ui/switch.tsx changes nothing for 10 of its 11 consumers: they render
 * inside a shell, where RULE 1 had already zeroed it. The eleventh, reached from
 * app/marketing-requests, now matches the other ten instead of being the only round
 * switch in the system.
 *
 * AT ZERO THIS IS NO LONGER A RATCHET BUT A FLOOR, which is the stronger state and
 * must not be given up: raising this number is how the rule dies quietly. A new
 * `rounded-full` on an unshelled surface is a defect, and `rounded-md` is square by
 * token in every context.
 */
const BASELINE = 0;

/** Route trees that ARE wrapped by a shell, and so are swept by RULE 1. */
const SHELLED_ROUTE_PREFIXES = ["app/(admin)/", "app/employee-portals/"];

/** Not a rendered surface at all. */
const NOT_A_SURFACE = ["app/api/"];

/**
 * A file that STAMPS a shell class is where this test's scope ends: RULE 1 covers
 * everything it renders. Matched on the class being applied rather than merely
 * mentioned, so the prose in this very file — and in globals.css's own comments —
 * is never mistaken for a stamp.
 */
const STAMPS_A_SHELL = /className=[^\n]*\b(?:admin-shell|employee-portal-shell)\b/;

/** The one class no --phx-radius-* token reaches. */
const ROUNDED_FULL = /\brounded-full\b/g;

function toPosix(absolute: string): string {
  return path.relative(ROOT, absolute).split(path.sep).join("/");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".") || entry.startsWith("_wt-")) continue;
      walk(full, out);
    } else if (/\.tsx$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Resolve an `@/...` specifier the way tsconfig paths does, to a real .tsx on disk. */
function resolveAlias(specifier: string): string | null {
  if (!specifier.startsWith("@/")) return null;
  const base = path.join(ROOT, "src", specifier.slice(2));
  for (const candidate of [`${base}.tsx`, path.join(base, "index.tsx")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * `rounded-full` occurrences in real code, with comments stripped first.
 *
 * 🔴 THIS DELIBERATELY DOES NOT FILTER ON "inside a quoted string", AND THAT MATTERED.
 * The first version of this file did, borrowing the sibling ratchet's QUOTED_STRING
 * regex — `/["'`][^"'`\n]*["'`]/g`, which cannot match a template literal that
 * interpolates, because `${` puts a `}` and more backtick-free text between the two
 * delimiters. marketing-sales-evidence-panel.tsx:127 is written exactly that way:
 *
 *     className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 ... ${
 *
 * so it was a REAL site the counter could not see — the baseline read 9 where a grep
 * read 10, and the missing one was the only pill-shaped badge of the five files. A
 * fail-open in a ratchet is worse than no ratchet: it reports a clean repo while the
 * exact construct most className logic uses goes uncounted.
 *
 * The quoted-string filter was there to keep prose from counting, and comment
 * stripping already does that job. `rounded-full` carries a hyphen, so it cannot be
 * an identifier — after comments are gone, every remaining occurrence is a class
 * application. Count them all.
 */
function countSites(source: string): number {
  return (stripComments(source).match(ROUNDED_FULL) ?? []).length;
}

/** Every .tsx reachable from a route no shell wraps, stopping at shell boundaries. */
function unshelledSurface(): { files: string[]; boundaries: string[] } {
  const routes = walk(path.join(ROOT, "app"))
    .map(toPosix)
    .filter(
      (rel) =>
        !SHELLED_ROUTE_PREFIXES.some((prefix) => rel.startsWith(prefix)) &&
        !NOT_A_SURFACE.some((prefix) => rel.startsWith(prefix)),
    );

  const seen = new Set<string>();
  const boundaries: string[] = [];
  const files: string[] = [];
  const queue = routes.map((rel) => path.join(ROOT, rel));

  while (queue.length > 0) {
    const current = queue.shift() as string;
    const rel = toPosix(current);
    if (seen.has(rel)) continue;
    seen.add(rel);

    const source = readFileSync(current, "utf8");
    if (STAMPS_A_SHELL.test(stripComments(source))) {
      boundaries.push(rel);
      continue;
    }
    files.push(rel);

    for (const match of source.matchAll(/from\s+"(@\/[^"]+)"/g)) {
      const target = resolveAlias(match[1]);
      if (target) queue.push(target);
    }
  }

  return { files, boundaries };
}

export function runSquareEdgeUnshelledRoutesTests() {
  // The detector first, so a failure below is about the repo and not about this file.
  assert.equal(
    countSites('<span className="rounded-full px-2">x</span>'),
    1,
    "a plain className must count as one site",
  );
  assert.equal(
    countSites("<span className={`p-2 rounded-full ${tone}`}>x</span>"),
    1,
    "a template-literal class string must still count — half the sites are written that way",
  );
  assert.equal(
    countSites("className={`inline-flex rounded-full px-3 ${\n  tone === 'x' ? 'a' : 'b'\n}`}"),
    1,
    "a template literal that INTERPOLATES must count — an earlier quoted-string matcher could " +
      "not span the `${`, so marketing-sales-evidence-panel.tsx:127 was a real site this " +
      "counter could not see. That is a fail-open, and it is what this check exists to stop",
  );
  assert.equal(
    countSites("// a `rounded-full` avatar used to live here\n"),
    0,
    "a line comment naming the class is prose, not a site; comments are stripped first",
  );
  assert.equal(
    countSites("/**\n * no rounded-full on the step bubble\n */\n"),
    0,
    "a block comment naming the class is prose, not a site",
  );
  assert.equal(
    countSites('<span className="rounded-md px-2">x</span>'),
    0,
    "rounded-md resolves through --phx-radius-sm, which tokens.css sets to 0 — it is square " +
      "in every context and is not what this test counts",
  );

  const { files, boundaries } = unshelledSurface();

  assert.ok(
    files.length > 0,
    "the unshelled surface came back empty — the walk is broken, which would make this test " +
      "pass by measuring nothing",
  );

  // The boundary rule is load-bearing: without it the walk crosses INTO the portal and
  // admin shells and counts their swept interiors, which is how a route folder grep
  // misreads app/dev/employee-portals as unshelled.
  assert.ok(
    boundaries.includes("src/components/layout/app-shell.tsx"),
    "app-shell.tsx stamps `admin-shell` and must be treated as a shell boundary — if it is " +
      "not, this walk descends into every admin surface and the count becomes meaningless",
  );
  assert.ok(
    boundaries.includes("src/components/employee-portal/employee-portal-layout.tsx"),
    "employee-portal-layout.tsx stamps `employee-portal-shell` and must be a shell boundary — " +
      "it is the component that makes app/dev/employee-portals swept despite its route folder " +
      "carrying no shell class",
  );

  const perFile = files
    .map((rel) => ({ rel, count: countSites(readFileSync(path.join(ROOT, rel), "utf8")) }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.rel.localeCompare(b.rel));

  const total = perFile.reduce((sum, entry) => sum + entry.count, 0);
  const inventory = perFile.map((entry) => `  ${entry.count}  ${entry.rel}`).join("\n");

  assert.ok(
    total <= BASELINE,
    `a new \`rounded-full\` is reachable from a route that no shell wraps: ${total} sites, ` +
      `baseline ${BASELINE}.\n${inventory}\n\n` +
      "`rounded-full` compiles to `border-radius: calc(infinity * 1px)` and no --phx-radius-* " +
      "token reaches it, so outside `.admin-shell` and `.employee-portal-shell` it renders as a " +
      "real pill (measured 33,554,432px). Use `rounded-md`, which is square by token in either " +
      "context. Do NOT raise the baseline to clear this.",
  );

  assert.equal(
    total,
    BASELINE,
    `the unshelled \`rounded-full\` count fell to ${total} from a baseline of ${BASELINE} — ` +
      "ground was won, so lower BASELINE in this file to lock it in.\n" +
      inventory,
  );
}
