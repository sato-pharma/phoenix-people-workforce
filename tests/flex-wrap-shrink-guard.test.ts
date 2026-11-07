import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { stripComments } from "./support/comment-strip.ts";

/**
 * `shrink-0` ON A WRAPPING ROW MAKES ITS OWN `flex-wrap` INERT.
 *
 * A flex item with `flex-shrink: 0` is never handed a width narrower than its content, so a
 * `flex-wrap` on that same element is never given a reason to fire. The row simply grows past its
 * parent and the page scrolls sideways — which the fits-the-screen golden rule (AGENTS.md §4) bans
 * outright, and which `overflow-x-auto` over a `min-width` does not fix, it IS the bug.
 *
 * It bit for real on 2026-09-30. The rep's landing panel carries a chip rail in its header —
 * `ml-auto flex shrink-0 flex-wrap justify-end gap-1`. Two chips fit at every width. A THIRD, the
 * day's pharmacies, made the header 319px of content in a 284px box at 320px, and the rail could not
 * wrap because `shrink-0` had already taken that option away. The cure was `flex-wrap` on the
 * HEADER, so the rail drops to its own full-width line; above 320px nothing moved at all.
 *
 * ## The rule, measured rather than reasoned
 *
 * The pattern is NOT a defect by itself — 16 of the 17 places that carried it that day were correct.
 * Three conditions have to hold together, and they were confirmed in a browser at 320px with one
 * identical child under three parents:
 *
 *   A · flex item in a ROW that does not wrap  → chips stuck out 7px past the content edge
 *   B · flex item in a ROW that DOES wrap      → fits; the rail drops to its own line
 *   C · flex item in a COLUMN                  → fits; shrink-0 governs HEIGHT there, not width
 *
 * So `shrink-0` beside `flex-wrap` is right and worth keeping in a column — it is what stops a
 * banner being squeezed vertically — and it is right in a row that wraps. It is wrong only in a row
 * that does not.
 *
 * 🔴 AND `scrollWidth` CANNOT SEE IT. In case A the header measured 316/316 — no overflow — while
 * its own children visibly stuck out, because `scrollWidth` does not account for a flex item
 * overflowing its container. Compare the child's `getBoundingClientRect().right` against the
 * parent's content edge instead. That is why nothing in this repo caught it, and why this guard is
 * static rather than a render test.
 *
 * ## Why every `sm:` class is stripped first
 *
 * At 320px no `sm:` / `md:` / `lg:` prefix is active, so a `flex flex-col sm:flex-row` parent is a
 * COLUMN there and can never overflow sideways. Judging those at their desktop shape would fail
 * eight correct files.
 */

const ROOTS = ["src/components", "app"] as const;
/** Every responsive and container-query prefix is inactive at the width this rule is about. */
const BREAKPOINT_PREFIX = /^(sm|md|lg|xl|2xl|@[^:]+):/;

/**
 * Sites whose PARENT cannot be resolved from the file's own text — a `cn(...)` call, or a component
 * whose parent is wherever it happens to be rendered. Each was read by hand; a NEW one fails this
 * test until someone reads it and says which of A, B or C it is.
 */
const REVIEWED_UNRESOLVABLE: ReadonlyArray<{ file: string; marks: string; verdict: string }> = [
  {
    file: "src/components/recruitment/workstation/screening-workstation.tsx",
    marks: "border-phx-warn-line",
    verdict:
      "C — DuplicateBanner is the root of its own component, rendered inside the CV column "
      + '(`min-h-0 min-w-0 flex-1 flex-col lg:flex`). In a column shrink-0 protects its HEIGHT.',
  },
  {
    file: "src/components/recruitment/workstation/workstation-page-client.tsx",
    marks: "border-b border-phx-line bg-white",
    verdict: "C — a full-width bar inside the page's `flex flex-col` shell.",
  },
  {
    file: "src/components/production-planning/production-planning-workspace.tsx",
    marks: "shrink-0 flex-wrap items-center gap-1",
    verdict:
      "C — the language toggle is the root of its own component, rendered by "
      + "ProductionPlanningHeader inside `flex flex-col gap-3 pb-4 sm:flex-row …`. At the width "
      + "this rule is about the `sm:` prefix is inactive, so the parent is a COLUMN and shrink-0 "
      + "governs the toggle's HEIGHT, not its width. Above 640px the parent is a row whose other "
      + "child is `min-w-0`, so the row shrinks there instead of overflowing — measured in a "
      + "browser at 375px, 1024px and 1280px in both shells and both languages, 40 rows, no "
      + "horizontal scroll (`scripts/measure-production-planning-fit.mjs`).",
  },
];

type Site = { file: string; line: number; own: string; parent: string | null };

function tsxFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      // `.next` is build output and `node_modules` is a junction to the primary checkout.
      if (name === "node_modules" || name === ".next") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".tsx")) out.push(path);
    }
  };
  walk(root);
  return out;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** The className on an opening tag, following a `{name}` back to a string const in the same file. */
function classNameAt(source: string, lines: readonly string[], index: number): string | null {
  const chunk = lines.slice(index, index + 6).join(" ");
  const literal = /className=["`]([^"`]*)["`]/.exec(chunk);
  if (literal) return literal[1];
  const variable = /className=\{([A-Za-z_$][\w$]*)\}/.exec(chunk);
  if (variable) {
    const decl = new RegExp(`(?:const|let)\\s+${variable[1]}\\s*=\\s*["\`]([^"\`]*)["\`]`).exec(source);
    return decl ? decl[1] : null;
  }
  return null;
}

/** Only the classes that actually apply at 320px. */
function activeClasses(className: string): string[] {
  return className.split(/\s+/).filter((token) => token && !BREAKPOINT_PREFIX.test(token));
}

function collectSites(): Site[] {
  const sites: Site[] = [];
  for (const root of ROOTS) {
    for (const path of tsxFilesUnder(root)) {
      const source = stripComments(readFileSync(path, "utf8"));
      const lines = source.split("\n");
      lines.forEach((line, index) => {
        const own = /className=["`]([^"`]*)["`]/.exec(line)?.[1];
        if (!own) return;
        const active = activeClasses(own);
        if (!active.includes("shrink-0") || !active.includes("flex-wrap")) return;
        const myIndent = indentOf(line);
        let parent: string | null = null;
        for (let i = index - 1; i >= 0 && i > index - 200; i -= 1) {
          if (!lines[i].trim()) continue;
          if (indentOf(lines[i]) < myIndent && /^\s*<[a-zA-Z]/.test(lines[i])) {
            parent = classNameAt(source, lines, i);
            break;
          }
        }
        sites.push({ file: relative(process.cwd(), path).replace(/\\/g, "/"), line: index + 1, own, parent });
      });
    }
  }
  return sites;
}

export function runFlexWrapShrinkGuardTests(): void {
  const sites = collectSites();

  // The pattern is common and mostly correct, so an empty sweep would mean the detector broke rather
  // than that the codebase is clean. 17 sites carried it on 2026-09-30.
  assert.ok(
    sites.length >= 10,
    `only ${sites.length} sites carry shrink-0 beside flex-wrap — the detector has stopped finding them, not the codebase stopped using them`,
  );

  const offenders: string[] = [];
  const unreviewed: string[] = [];

  for (const site of sites) {
    if (site.parent === null) {
      const reviewed = REVIEWED_UNRESOLVABLE.some((row) => row.file === site.file && site.own.includes(row.marks));
      if (!reviewed) {
        unreviewed.push(`${site.file}:${site.line}  className="${site.own}"`);
      }
      continue;
    }
    const active = activeClasses(site.parent);
    const parentIsFlex = active.includes("flex");
    const parentIsColumn = active.includes("flex-col");
    const parentWraps = active.includes("flex-wrap");
    if (parentIsFlex && !parentIsColumn && !parentWraps) {
      offenders.push(
        `${site.file}:${site.line}\n`
        + `      this: ${site.own}\n`
        + `    parent: ${site.parent}`,
      );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "🔴 shrink-0 beside flex-wrap, inside a flex ROW that does not itself wrap — the row can never wrap "
    + "and overflows sideways at 320px, which the fits-the-screen golden rule bans. Measured 2026-09-30 "
    + "on the rep landing panel: 319px of content in a 284px header. Fix it by putting flex-wrap on the "
    + "PARENT so this block drops to its own full-width line — that is free above 320px — never by "
    + "dropping shrink-0 alone, which lets the row squash to its narrowest chip instead:\n"
    + offenders.join("\n"),
  );

  assert.deepEqual(
    unreviewed,
    [],
    "a shrink-0 + flex-wrap element whose PARENT cannot be read from the file's own text. Open it, decide "
    + "which shape it is — a non-wrapping ROW (fix it), a wrapping ROW, or a COLUMN (both fine) — and add "
    + "it to REVIEWED_UNRESOLVABLE with that verdict:\n"
    + unreviewed.join("\n"),
  );

  // The roster is not allowed to rot into a list of files that no longer carry the pattern.
  for (const row of REVIEWED_UNRESOLVABLE) {
    assert.ok(
      sites.some((site) => site.file === row.file && site.own.includes(row.marks)),
      `REVIEWED_UNRESOLVABLE names ${row.file} (${row.marks}) but nothing there carries shrink-0 beside flex-wrap any more — delete the row`,
    );
  }

  console.log(`flex-wrap/shrink-0 guard: OK (${sites.length} sites, ${REVIEWED_UNRESOLVABLE.length} reviewed by hand)`);
}
