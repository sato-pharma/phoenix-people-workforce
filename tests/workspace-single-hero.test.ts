import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every admin-shell workspace page wraps its body in <WorkspaceFrame>, which renders the page hero
 * (eyebrow + title + description). Several of the bodies are portal components that ALSO own a hero
 * and default `showHero` to true, because they are mounted standalone elsewhere. Inside
 * WorkspaceFrame they must be passed showHero={false}, or the page renders two stacked heroes.
 *
 * Three did not, and shipped that way: Vacation Request, Vacation Report and Organogram each drew
 * their title twice. It survived review because both heroes look correct in isolation — the page
 * just reads as though the header were part of the design.
 *
 * This derives the hero-owning components from source rather than hardcoding a list, so a NEW
 * component that grows a `showHero` prop is covered the day it is used here.
 */

const WORKSPACE_PAGES = "src/components/workspace/admin-shell-employee-pages.tsx";
const COMPONENT_ROOTS = ["src/components"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Components that declare a `showHero` prop — i.e. that draw their own hero when standalone. */
function heroOwningComponents(): Set<string> {
  const names = new Set<string>();
  for (const root of COMPONENT_ROOTS) {
    for (const file of walk(root)) {
      const source = readFileSync(file, "utf8");
      if (!/\bshowHero\b\s*\??:/.test(source)) continue;
      for (const match of source.matchAll(/export function (\w+)|export const (\w+)/g)) {
        const name = match[1] ?? match[2];
        if (name) names.add(name);
      }
    }
  }
  return names;
}

export function runWorkspaceSingleHeroTests() {
  const source = readFileSync(WORKSPACE_PAGES, "utf8");
  const heroOwners = heroOwningComponents();
  assert.ok(heroOwners.size > 0, "expected to find at least one component declaring a showHero prop");

  // Every JSX usage in the workspace page file, with its full attribute list.
  const offenders: string[] = [];
  let checked = 0;
  for (const match of source.matchAll(/<([A-Z]\w+)([^>]*?)\/?>/g)) {
    const [, name, attrs] = match;
    if (!heroOwners.has(name)) continue;
    checked += 1;
    if (!/showHero=\{false\}/.test(attrs)) {
      offenders.push(`<${name}> inside WorkspaceFrame does not pass showHero={false} — it will draw a second hero`);
    }
  }

  assert.ok(
    checked >= 3,
    `expected to find the hero-owning components used in ${WORKSPACE_PAGES}, matched ${checked} — has the file been restructured?`,
  );
  assert.deepEqual(
    offenders,
    [],
    `a workspace page renders two stacked heroes:\n  ${offenders.join("\n  ")}`,
  );
}

const HR_STRIP = "src/components/hr/hr-my-pages-strip.tsx";

/**
 * ONE personal tab strip per page, never two.
 *
 * The same defect as the double hero above, on the other piece of chrome and for the same reason:
 * two components both render the personal page list, each correct in isolation. `WorkspaceFrame`
 * has drawn `<PersonalWorkspaceTabs>` since 2026-08-30, when the fifteen `/workspace` pages were
 * given navigation they had never had. `HrMyPagesStrip` was added on 2026-09-01 at the owner's
 * instruction that the list sit under the identity banner and stay there on every page she opens —
 * and because it mounts in AppShell it is on every `/hr` route, including the ones that go through
 * WorkspaceFrame. An HR seat opening a personal page got both lists, stacked, and the lower one
 * overflowed its column: 1446px of tabs in 1082px at desktop width, which is the horizontal scroll
 * the owner's golden rule forbids.
 *
 * WHAT THIS ASSERTS is that both halves are decided by ONE predicate, `usesHrNamespace`. Not that
 * the current wiring is a particular shape — that would be a byte window that false-fails on the
 * next edit — but that neither component can be re-gated on something of its own without this
 * going red. A pathname test, an "is this under /hr" check, or a hardcoded pair of role names would
 * each put the two halves of one decision in two places, and the next seat added to
 * `hrNamespaceRoles` would silently get the duplicate back.
 */
export function runWorkspaceSingleTabStripTests() {
  const source = readFileSync(WORKSPACE_PAGES, "utf8");

  assert.ok(
    /<PersonalWorkspaceTabs\b/.test(source),
    `${WORKSPACE_PAGES} no longer renders <PersonalWorkspaceTabs> at all. If the strip moved, move ` +
      "this assertion with it — the fifteen personal pages have no other navigation, and deleting " +
      "it outright strands every non-HR role on an island (the defect fixed on 2026-08-30)",
  );

  // The whole `const tabs = …` initialiser, however it is currently written.
  const assignment = /const tabs\s*=\s*([\s\S]*?);\n/.exec(source);
  assert.ok(assignment, `${WORKSPACE_PAGES}: no \`const tabs =\` assignment found — has WorkspaceFrame been restructured?`);
  assert.match(
    assignment![1],
    /usesHrNamespace/,
    `${WORKSPACE_PAGES}: WorkspaceFrame builds its tab list without consulting usesHrNamespace, so ` +
      "the two HR seats get this strip AND the one AppShell pins under their identity banner — the " +
      "same list twice, one row apart, overflowing its column",
  );
  assert.match(
    source,
    /usesHrNamespace,?\n?[^;]*from "@\/lib\/auth\/permissions"|usesHrNamespace[^;]*from "@\/lib\/auth\/permissions"/,
    `${WORKSPACE_PAGES}: usesHrNamespace is not imported from @/lib/auth/permissions, so the gate ` +
      "above is reading some local lookalike rather than the one list of HR-namespace seats",
  );

  const strip = readFileSync(HR_STRIP, "utf8");
  assert.match(
    strip,
    /if\s*\(!usesHrNamespace\([^)]*\)\)\s*return null;/,
    `${HR_STRIP}: the strip no longer returns null for a non-HR role. Both components would then ` +
      "render for somebody, which is the duplicate this pair of assertions exists to prevent",
  );
}
