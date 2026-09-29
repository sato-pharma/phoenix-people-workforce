import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { stripComments } from "./support/comment-strip.ts";

/**
 * The portal's route-loading layer.
 *
 * WHY IT EXISTS. Measured 2026-09-29: **98 of the portal's 126 routes have no `loading.tsx` at
 * all**, so they show nothing whatever between the tap and the server render — on pages that
 * routinely take seconds. Of the 28 that do have one, 24 render `DashboardSkeleton` whatever the
 * page behind it is, and `payslips` — a real page — fronts itself with `RedirectSkeleton`.
 *
 * A skeleton of the WRONG shape is worse than none: the page appears to settle, then relays out
 * under the reader. So this pins two things — that all five shapes exist and are reachable through
 * one door, and that the door has no default.
 */

const TEMPLATES = "src/components/employee-portal/skeleton-templates.tsx";

export function runPortalRouteSkeletonTests() {
  const source = stripComments(readFileSync(TEMPLATES, "utf8"));

  // ── One door, five shapes ──────────────────────────────────────────────────
  for (const shape of ["dashboard", "detail", "form", "redirect", "table"]) {
    assert.match(
      source,
      new RegExp(`"${shape}"`),
      `PortalRouteShape must still offer "${shape}" — a route with no shape that fits ends up with the wrong one`,
    );
  }
  for (const template of ["DashboardSkeleton", "DetailSkeleton", "FormSkeleton", "RedirectSkeleton", "TableSkeleton"]) {
    assert.match(source, new RegExp(`export function ${template}\\(`), `${template} must stay exported`);
  }

  // ── No default shape, deliberately ─────────────────────────────────────────
  // A default is exactly how 24 of the 28 existing loading files became a dashboard regardless of
  // the page behind them. Naming the shape has to be the whole decision.
  assert.match(
    source,
    /export function PortalRouteSkeleton\(\{ shape \}: \{ shape: PortalRouteShape \}\)/,
    "PortalRouteSkeleton takes a REQUIRED shape — no default, or the wrong skeleton spreads again",
  );
  assert.doesNotMatch(
    source,
    /shape = "/,
    "PortalRouteSkeleton must not default its shape",
  );

  // ── The rows block cannot push a phone sideways ────────────────────────────
  // On a phone the real page renders CARDS, not a table, so a five-column placeholder promises a
  // layout the page never draws — and five bars plus their gaps is the one way a skeleton could
  // overflow 360px. The last two are hidden below `sm`.
  assert.match(
    source,
    /<Pulse className="hidden h-3 w-16 sm:block" \/>\s*<Pulse className="hidden h-5 w-20 sm:block" \/>/,
    "the rows placeholder must drop its last two bars below sm — a phone sees cards, not five columns",
  );

  // ── No loading.tsx declares its own Pulse ──────────────────────────────────
  // Nine of them did, each a byte-identical copy of the same four-line component — and nothing
  // kept them in step if the shimmer, the tint or the `aria-hidden` ever moved.
  //
  // Note what this does NOT demand: that every loading.tsx use one of the five templates. Several
  // of the nine draw a skeleton shaped like their own page, which is better than a generic one,
  // not worse — a placeholder that resembles the page is the entire point. What they may not do
  // is re-declare the primitive.
  const offenders: string[] = [];
  const stack = ["app/employee-portals"];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry !== "loading.tsx") continue;
      const body = stripComments(readFileSync(full, "utf8"));
      if (/function Pulse\(/.test(body) || /const Pulse =/.test(body)) {
        offenders.push(full.split(path.sep).join("/"));
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these loading.tsx files declare their own Pulse instead of importing it from ` +
      `skeleton-templates.tsx: ${offenders.join(", ")}`,
  );

  // ── And none of them still draws the retired hero ──────────────────────────
  // Nine loading files opened with a black-to-brown gradient (`#070707 → #111827 → #2C1605`) that
  // no portal page has ever rendered: the page changed COLOUR the moment the real content
  // arrived. HeroSkeleton is the real command header's own navy, so the header now stays put.
  const staleHeroes: string[] = [];
  const heroStack = ["app/employee-portals"];
  while (heroStack.length > 0) {
    const current = heroStack.pop() as string;
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        heroStack.push(full);
        continue;
      }
      if (entry !== "loading.tsx") continue;
      if (readFileSync(full, "utf8").includes("#070707")) staleHeroes.push(full.split(path.sep).join("/"));
    }
  }
  assert.deepEqual(
    staleHeroes,
    [],
    `these loading.tsx files still open with the retired black-to-brown hero, so the page changes ` +
      `colour when the real header arrives: ${staleHeroes.join(", ")}. Use <HeroSkeleton />.`,
  );
}
