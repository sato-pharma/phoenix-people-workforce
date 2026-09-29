import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { stripComments } from "./support/comment-strip.ts";

/**
 * The portal's route-loading layer.
 *
 * WHY IT EXISTS. Measured at the start of the sweep, 2026-09-29: **98 of the portal's 126 routes
 * had no `loading.tsx` at all**, so they showed nothing whatever between the tap and the server
 * render — on pages that routinely take seconds. Of the 28 that did have one, 24 rendered
 * `DashboardSkeleton` whatever the page behind it was, and two REAL pages — `payslips` and
 * `profile`, the latter 345 lines of the employee's own record — fronted themselves with
 * `RedirectSkeleton`, a spinner whose whole meaning is "you are being sent somewhere else".
 *
 * A skeleton of the WRONG shape is worse than none: the page appears to settle, then relays out
 * under the reader. So this pins three things — that all six shapes exist and are reachable through
 * one door, that the door has no default, and that every route has a loading state.
 */

const TEMPLATES = "src/components/employee-portal/skeleton-templates.tsx";

export function runPortalRouteSkeletonTests() {
  const source = stripComments(readFileSync(TEMPLATES, "utf8"));

  // ── One door, six shapes ───────────────────────────────────────────────────
  for (const shape of ["calendar", "dashboard", "detail", "form", "redirect", "table"]) {
    assert.match(
      source,
      new RegExp(`"${shape}"`),
      `PortalRouteShape must still offer "${shape}" — a route with no shape that fits ends up with the wrong one`,
    );
  }
  for (const template of [
    "CalendarSkeleton",
    "DashboardSkeleton",
    "DetailSkeleton",
    "FormSkeleton",
    "RedirectSkeleton",
    "TableSkeleton",
  ]) {
    assert.match(source, new RegExp(`export function ${template}\\(`), `${template} must stay exported`);
  }
  // A month grid is seven equal fractions, never a fixed column — a calendar placeholder is the
  // one shape that could widen a phone if it were written with pixel columns.
  assert.match(
    source,
    /grid grid-cols-7 gap-1/,
    "CalendarSkeleton's grid must stay grid-cols-7, so it cannot push a 360px screen sideways",
  );

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

  // ── ONE DOOR: no loading.tsx reaches past PortalRouteSkeleton to a template ─
  // This is how the generic-dashboard drift happened and how it would come back. Fifteen loading
  // files imported `DashboardSkeleton` (or `FormSkeleton`, or `RedirectSkeleton`) directly, and
  // NOTHING looked at them — the count above only sees routes with NO loading.tsx, so a file with
  // the wrong shape was invisible to it for as long as it existed. Twelve of the fifteen were a
  // dashboard placeholder in front of a list, a single record or a database.
  //
  // Going through PortalRouteSkeleton is what makes the shape a named, reviewable decision instead
  // of whichever template was nearest to hand. A page-shaped skeleton built from `Pulse` and
  // `HeroSkeleton` is still welcome — better than a generic one — which is why those two are not on
  // this list.
  const RAW_TEMPLATES = [
    "CalendarSkeleton",
    "DashboardSkeleton",
    "DetailSkeleton",
    "FormSkeleton",
    "RedirectSkeleton",
    "TableSkeleton",
  ];
  const rawImporters: string[] = [];
  const doorStack = ["app/employee-portals"];
  while (doorStack.length > 0) {
    const current = doorStack.pop() as string;
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        doorStack.push(full);
        continue;
      }
      if (entry !== "loading.tsx") continue;
      const body = stripComments(readFileSync(full, "utf8"));
      const used = RAW_TEMPLATES.filter((name) => new RegExp(`\\b${name}\\b`).test(body));
      if (used.length > 0) {
        rawImporters.push(`${full.split(path.sep).join("/")} (${used.join(", ")})`);
      }
    }
  }
  assert.deepEqual(
    rawImporters,
    [],
    `these loading.tsx files render a raw skeleton template instead of going through ` +
      `PortalRouteSkeleton: ${rawImporters.join(", ")}. Use ` +
      `<PortalRouteSkeleton shape="…" /> so the shape is a decision someone made about that page, ` +
      `not whichever template was nearest. A hand-built skeleton from Pulse/HeroSkeleton is fine.`,
  );

  // ── EVERY portal route has a loading state. An ABSOLUTE since 2026-09-29 ───
  // This began as a ratchet, because 98 of 126 routes showed nothing whatever between the tap and
  // the server render. The sweep walked it down — 90 after PR 0, 71 after iReports 360, 60 after
  // Marketing & ROI, 57 after Performance, 49 after Approvals Hub, 40 after Sales Data, and **0**
  // in the tail PR, which covered the 31 routes no sidebar section reached (visual-aids,
  // vacation-control, resignations, the recruitment sub-tree, offers, employees, contracts and the
  // rest) plus the six redirect stubs.
  //
  // It is an absolute rather than a ratchet now because there is no number left to argue about: a
  // route with no loading.tsx is a route that flashes blank, and one added tomorrow fails here on
  // the day it is written. That was always the ratchet's purpose; reaching zero is what lets the
  // guard stop carrying a figure every PR had to re-measure, re-baseline and then conflict on.
  //
  // What this does NOT demand is a particular SHAPE. That choice belongs to whoever writes the
  // route, and a blanket `shape="dashboard"` is the very defect the shapes exist to prevent — 24 of
  // the original 28 loading files were exactly that, and two real pages (payslips, profile) fronted
  // themselves with a redirect spinner. The no-default rule above enforces that a shape is chosen;
  // this assertion enforces only that a loading state exists at all.
  const bare: string[] = [];
  let routes = 0;
  const routeStack = ["app/employee-portals"];
  while (routeStack.length > 0) {
    const current = routeStack.pop() as string;
    const entries = readdirSync(current);
    if (entries.includes("page.tsx")) {
      routes += 1;
      if (!entries.includes("loading.tsx")) bare.push(current.split(path.sep).join("/"));
    }
    for (const entry of entries) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) routeStack.push(full);
    }
  }

  assert.ok(routes >= 100, `the portal should still have its full route set; found ${routes}`);
  assert.deepEqual(
    bare,
    [],
    `these portal routes have no loading.tsx, so they show NOTHING between the tap and the server ` +
      `render: ${bare.join(", ")}. Add a three-line loading.tsx returning ` +
      `<PortalRouteSkeleton shape="…" />, choosing the shape from what the page actually renders — ` +
      `"table" for a list or a PortalResponsiveDataList, "dashboard" for cards and charts, ` +
      `"detail" for one record, "form" for an input-led page, "calendar" for a month grid, and ` +
      `"redirect" ONLY when the page's whole body is a redirect().`,
  );
}
