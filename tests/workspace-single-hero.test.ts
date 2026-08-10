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
