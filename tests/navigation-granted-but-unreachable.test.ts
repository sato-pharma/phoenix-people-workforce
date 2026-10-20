import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  getNavigationSections,
  hubPageItemGroups,
} from "@/config/system-navigation";
import {
  buildPermissionLookup,
  createAccessContext,
  permissionMatrix,
  phoenixRoles,
  resolveNavigationMode,
  type PhoenixRole,
} from "@/lib/auth/permissions";
import { resolveEmployeePortalNavVisibility } from "@/lib/employee-portal/navigation";
import { getSections, navigationItemVisible } from "@/lib/navigation/active-path";

import {
  isRedirectOnlyStub,
  isShellGated,
  permissionGateKeys,
  portalTwinRedirect,
  roleSetGates,
  unreadableGatePredicates,
} from "./support/page-gate-reader";
import {
  reverseGuardBlindSpotRoutes,
  reverseGuardRecordedRoutes,
} from "./navigation-reachability-backlog";

/**
 * THE REVERSE GUARD — a page a role can open, that no surface offers it a link to.
 *
 * Every other navigation test in this repository asks the forward question: *is every link I am
 * offered one I can actually open?* This asks the other one, and the two fail in opposite
 * directions. A forward failure is loud — you click and bounce. A reverse failure is silent: the
 * page serves perfectly, the permission is real, and nobody ever finds it. `AGENTS.md` records the
 * shape as its own hard-learned rule — *"a feature can ship green, deploy cleanly, and be reachable
 * by NOBODY — and zero usage is what both look like."*
 *
 * ## From report mode to backlog-enforced
 *
 * This guard shipped in report mode — anti-vacuity floors plus loose bucket ceilings, printing its
 * findings into the CI log but never failing on one. That was the only honest way to introduce a
 * guard whose day-one output was 52 routes: a check that goes red on merge day gets muted within a
 * week, and a muted check is worth less than none. B5 then did the triage the report existed to
 * enable — every one of those 52 is now recorded, bucketed and reasoned in
 * tests/navigation-reachability-backlog.ts — so this guard now asserts its live orphan set equals
 * exactly that record, BY IDENTITY. A ceiling (`orphans.size <= 55`) let a page that gained a link
 * and a newly stranded one cancel out; identity does not. A new orphan fails here, and a page that
 * was given a link must be removed from the backlog in the same change or the stale record fails too.
 *
 * ## What counts as OFFERED — five layers, and each one was found the hard way
 *
 * The measurement was run five times and each pass found a link layer the previous model could not
 * see. Every one of them had the same symptom: **a page doing its job read as orphaned.** They are
 * written down here because the next person to extend this will otherwise rediscover them one
 * false accusation at a time.
 *
 *   1. The sidebar — `getSections(getNavigationSections(mode), …)`, both shells.
 *   2. Hub cards, admin shell only. `command-palette-items.ts` folds `hubPageItemGroups` into Cmd+K
 *      for `navigationMode === "admin"` and nothing else, so a hub card is offered to an admin-shell
 *      role whether or not the hub page that contains it is itself reachable. That is what makes the
 *      plan's "fixpoint, 3 passes" unnecessary — there is no reachability precondition to converge.
 *   3. The portal registry, portal shell only, filtered by `resolveEmployeePortalNavVisibility`.
 *   4. **Links written by hand in components.** `app/(admin)/recruitment/screening/page.tsx` says in
 *      its own docstring: *"Deliberately NOT a card on the Recruitment & Hiring hub … a route and a
 *      link from the pool already"*. Its absence from the nav is a recorded decision, and a guard
 *      that cannot see in-page links calls it a defect. This layer subsumes the three
 *      command-center tile files the plan named separately — a tile is a literal href like any
 *      other, so one sweep covers them and cannot go stale when a fourth hand-written surface
 *      appears.
 *   5. **Deep links in notification payloads.** `deepLinkHref: "/admin/email-notifications"` in
 *      `src/lib/notifications/email-control-center.ts` is the only thing that reaches that page. A
 *      notification you click is a link; that it is spelled with a different key is not the user's
 *      problem. Hence the field name is matched as `[A-Za-z]*[Hh]ref`, which covers `href`,
 *      `ctaHref`, `deepLinkHref`, `seeAllHref` and `reportHref` — 654 sites in total.
 *
 * ## What is NOT a finding, and the number that proves it
 *
 * `canOpen ∧ ¬offered` computed per (route, role) reports **1,107 pairs across 151 routes**, and
 * almost all of it is deliberate. 106 nav entries carry a `roles:` list narrower than the set of
 * roles holding their permission — **1,048 (entry, role) pairs of product curation**. A guard
 * reporting those is a guard nobody reads.
 *
 * So the question this test asks is the sharper one: **is the route offered to ANYBODY?** A route
 * curated away from one role is a decision. A route nothing links from anywhere is an orphan.
 */

const APP_DIR = path.resolve(process.cwd(), "app");
const SRC_DIR = path.resolve(process.cwd(), "src");
const PORTAL_REGISTRY = path.join(
  SRC_DIR,
  "components/employee-portal/employee-portal-nav-registry.ts",
);

type GapKind =
  | "delisted-by-ruling"
  | "shell-mirror-of-a-linked-route"
  | "linked-from-a-component"
  | "second-gate-unreadable"
  | "no-link-anywhere";

type RouteGate = {
  href: string;
  needs: string[];
  roleSets: string[][];
  shellGated: boolean;
  portalTwin: string | null;
  unreadable: string[];
  readable: boolean;
  /** Renders nothing and forwards — a link, not a page. Exempt from the blind-spot roll-call. */
  redirectOnly: boolean;
};

function walk(dir: string, matches: (name: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, matches, out);
    else if (matches(entry.name)) out.push(full);
  }
  return out;
}

/** Every static route in `app/`, with the gate its page puts in front of a visitor. */
function readRouteGates(): RouteGate[] {
  const gates: RouteGate[] = [];
  for (const file of walk(APP_DIR, (name) => name === "page.tsx")) {
    const relative = path.relative(APP_DIR, file).replace(/\\/g, "/").replace(/\/page\.tsx$/, "");
    const segments = relative.split("/").filter((s) => s && !/^\(.*\)$/.test(s));
    // A dynamic segment has no single href to be offered a link to, so the question does not apply.
    if (segments.some((segment) => segment.includes("["))) continue;

    const source = readFileSync(file, "utf8");
    const needs = [...permissionGateKeys(source)];
    const roleSets = roleSetGates(source);
    const shellGated = isShellGated(source);
    const portalTwin = portalTwinRedirect(source);
    gates.push({
      href: `/${segments.join("/")}`,
      needs,
      roleSets,
      shellGated,
      portalTwin,
      unreadable: unreadableGatePredicates(source),
      readable: needs.length > 0 || roleSets.length > 0 || shellGated || portalTwin !== null,
      redirectOnly: isRedirectOnlyStub(source),
    });
  }
  return gates;
}

/**
 * Can this role get through the page's own gate?
 *
 * Both shell directions matter and they are not the same check. `shellGated` is an ADMIN page
 * refusing portal-shell roles; `portalTwin` is a PORTAL page bouncing admin-shell roles to its
 * admin twin. Modelling only the first — which is all the shared reader knew until this test was
 * written — makes every portal twin look open to all 17 roles.
 */
function canOpen(
  gate: RouteGate,
  role: PhoenixRole,
  lookup: Record<string, boolean>,
  mode: string,
): boolean {
  if (gate.shellGated && mode === "employee-portal") return false;
  if (gate.portalTwin !== null && mode === "admin") return false;
  for (const key of gate.needs) if (!lookup[key]) return false;
  for (const set of gate.roleSets) if (!set.includes(role)) return false;
  return true;
}

/** Layer 3: the portal registry, parsed for href and the visibility flags that gate each entry. */
function readPortalRegistry(): { href: string; flags: string[] }[] {
  const entries: { href: string; flags: string[] }[] = [];
  for (const line of readFileSync(PORTAL_REGISTRY, "utf8").split("\n")) {
    const href = /href:\s*"(\/[^"]+)"/.exec(line)?.[1];
    if (!href) continue;
    const flagBlock = /flags:\s*\[([^\]]*)\]/.exec(line)?.[1] ?? "";
    entries.push({ href, flags: [...flagBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]!) });
  }
  return entries;
}

/** Layers 4 and 5: every literal route href written anywhere in `src/` or `app/`. */
function readHandWrittenLinks(): Map<string, string[]> {
  const patterns = [
    /[A-Za-z]*[Hh]ref\s*:\s*"(\/[^"]*)"/g, // href, ctaHref, deepLinkHref, seeAllHref, reportHref
    /href="(\/[^"]*)"/g, // plain JSX
    /\brouter\.push\(\s*"(\/[^"]*)"/g,
    /\bredirect\(\s*"(\/[^"]*)"\s*\)/g, // a page that sends you somewhere is a link to there
  ];
  const linkedFrom = new Map<string, string[]>();
  const files = [
    ...walk(SRC_DIR, (name) => /\.tsx?$/.test(name)),
    ...walk(APP_DIR, (name) => /\.tsx?$/.test(name)),
  ];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const from = path.relative(process.cwd(), file).replace(/\\/g, "/");
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const href = match[1]!.split("?")[0]!.replace(/\/$/, "") || "/";
        linkedFrom.set(href, [...(linkedFrom.get(href) ?? []), from]);
      }
    }
  }
  return linkedFrom;
}

export async function runNavigationGrantedButUnreachableTests(): Promise<void> {
  const gates = readRouteGates();
  const portalRegistry = readPortalRegistry();
  const linkedFrom = readHandWrittenLinks();

  // ── what each role is OFFERED ────────────────────────────────────────────────
  const offeredByRole = new Map<PhoenixRole, { hrefs: Set<string>; mode: string }>();
  for (const role of phoenixRoles) {
    const lookup = buildPermissionLookup(permissionMatrix, role);
    const mode = resolveNavigationMode(createAccessContext({ role }));
    const hrefs = new Set<string>();
    for (const section of getSections(getNavigationSections(mode), mode, lookup, role)) {
      for (const item of section.items) hrefs.add(item.href);
    }
    if (mode === "admin") {
      // Cmd+K offers every hub card the role passes, with no requirement that the hub page
      // containing it is itself reachable — src/lib/navigation/command-palette-items.ts.
      for (const group of hubPageItemGroups) {
        for (const item of group.items) {
          if (navigationItemVisible(item, lookup, role)) hrefs.add(item.href);
        }
      }
    } else {
      const visibility = resolveEmployeePortalNavVisibility(null, role) as Record<string, unknown>;
      for (const entry of portalRegistry) {
        if (entry.flags.length === 0 || entry.flags.some((flag) => Boolean(visibility[flag]))) {
          hrefs.add(entry.href);
        }
      }
    }
    offeredByRole.set(role, { hrefs, mode });
  }

  const offeredToAnyone = new Set<string>();
  for (const role of phoenixRoles) {
    for (const href of offeredByRole.get(role)!.hrefs) offeredToAnyone.add(href);
  }

  // ── the orphans: openable by someone, offered to nobody ──────────────────────
  const orphans = new Map<string, PhoenixRole[]>();
  for (const role of phoenixRoles) {
    const { hrefs, mode } = offeredByRole.get(role)!;
    const lookup = buildPermissionLookup(permissionMatrix, role);
    for (const gate of gates) {
      if (!gate.readable) continue; // an unreadable gate cannot support a conclusion either way
      if (!canOpen(gate, role, lookup, mode)) continue;
      if (hrefs.has(gate.href) || offeredToAnyone.has(gate.href)) continue;
      orphans.set(gate.href, [...(orphans.get(gate.href) ?? []), role]);
    }
  }

  // ── bucket mechanically; only `no-link-anywhere` needs a human ───────────────
  const byHref = new Map(gates.map((gate) => [gate.href, gate]));
  const findings = [...orphans.entries()].map(([href, roles]) => {
    const gate = byHref.get(href)!;
    const linkers = (linkedFrom.get(href) ?? []).filter(
      (file) => !file.endsWith(`app${href}/page.tsx`) && !file.includes("system-navigation"),
    );
    let kind: GapKind;
    // No prefix is bucketed delisted-by-ruling any more: the one that was, the Sales Analytics module
    // (29 routes), was retired on 2026-09-17 and its pages deleted. The hub pages the backlog still
    // records as delisted-by-ruling are reported here under the bucket the lines below choose.
    if (gate.portalTwin !== null && offeredToAnyone.has(gate.portalTwin)) {
      kind = "shell-mirror-of-a-linked-route";
    } else if (linkers.length > 0) kind = "linked-from-a-component";
    else if (gate.unreadable.length > 0) kind = "second-gate-unreadable";
    else kind = "no-link-anywhere";
    return { href, roles, kind, gate, linkers };
  });

  const byKind = new Map<GapKind, typeof findings>();
  for (const finding of findings) {
    byKind.set(finding.kind, [...(byKind.get(finding.kind) ?? []), finding]);
  }

  // ── the report ───────────────────────────────────────────────────────────────
  const pairs = findings.reduce((total, finding) => total + finding.roles.length, 0);
  const lines = [
    `navigation reachability — ${orphans.size} routes openable by someone and offered to nobody (${pairs} role-pairs)`,
  ];
  for (const kind of [...byKind.keys()].sort()) {
    const rows = byKind.get(kind)!;
    lines.push(`  ${kind}: ${rows.length} routes`);
    for (const row of [...rows].sort((a, b) => b.roles.length - a.roles.length)) {
      const note =
        row.gate.portalTwin !== null
          ? ` -> ${row.gate.portalTwin}`
          : row.linkers.length > 0
            ? ` <- ${row.linkers[0]}`
            : row.gate.unreadable.length > 0
              ? ` (gated on ${row.gate.unreadable.join(", ")})`
              : "";
      lines.push(`      ${String(row.roles.length).padStart(2)} roles  ${row.href}${note}`);
    }
  }
  console.log(lines.join("\n"));

  // ── anti-vacuity: every input this verdict rests on must be non-trivial ──────
  // Measured 2026-08-29. Floors sit below the real numbers so ordinary growth does not trip them,
  // but far enough above zero that a reader returning nothing cannot pass. A guard whose inputs
  // silently emptied would otherwise report a clean bill of health, which is the failure mode this
  // whole program exists to remove.
  assert.ok(gates.length >= 300, `expected 300+ static routes, read ${gates.length} (344)`);
  assert.ok(
    gates.filter((gate) => gate.readable).length >= 150,
    `expected 150+ gate-readable routes, read ${gates.filter((g) => g.readable).length} (202)`,
  );
  // 18 since 2026-10-08 (HR Resourcing, the Talent Acquisition seat). Every floor below was re-run
  // with the new role in place and none of them moved below its threshold. 19 since 2026-10-20 (HR
  // Administration, the HR Operations Specialist seat): no floor below counts per role except the
  // Super Admin's, and a new role can only ADD to the offered set, so none of them can fall.
  assert.equal(phoenixRoles.length, 19, "the role list changed — re-measure every floor below");
  assert.ok(
    offeredByRole.get("Super Admin" as PhoenixRole)!.hrefs.size >= 100,
    `Super Admin should be offered 100+ links, got ${offeredByRole.get("Super Admin" as PhoenixRole)!.hrefs.size} (171)`,
  );
  assert.ok(portalRegistry.length >= 50, `portal registry read ${portalRegistry.length} entries (61)`);
  assert.ok(
    linkedFrom.size >= 250,
    `hand-written link sweep found ${linkedFrom.size} route targets (334) — a collapse here would
     silently reclassify every component-linked page as an orphan`,
  );
  // Both shell directions must be seen. Until 2026-08-29 the reader knew only the first, and every
  // portal twin therefore read as open to all 17 roles.
  assert.ok(
    gates.filter((gate) => gate.shellGated).length >= 50,
    `expected 50+ admin pages carrying the shell gate, read ${gates.filter((g) => g.shellGated).length} (69)`,
  );
  assert.ok(
    gates.filter((gate) => gate.portalTwin !== null).length >= 50,
    `expected 50+ portal twins, read ${gates.filter((g) => g.portalTwin !== null).length} (63)`,
  );

  // ── identity, not ceilings: the live orphan set must equal exactly what the backlog records ───
  // Report mode is over. The 52 routes this sweep measured on 2026-08-29 are recorded, bucketed and
  // reasoned in tests/navigation-reachability-backlog.ts; this asserts the live measurement still
  // matches that record exactly. The old ceilings (orphans.size <= 55, no-link-anywhere <= 2,
  // delisted-by-ruling <= 29) let a page that gained a link and a newly stranded one cancel out —
  // identity cannot. A new orphan fails; a page given a link must be dropped from the backlog in the
  // same change, or its now-stale record fails too.
  const liveOrphanRoutes = [...orphans.keys()].sort();
  const recorded = [...reverseGuardRecordedRoutes()].sort();
  const newlyStranded = liveOrphanRoutes.filter((route) => !recorded.includes(route));
  const nowReachable = recorded.filter((route) => !liveOrphanRoutes.includes(route));
  assert.deepEqual(
    liveOrphanRoutes,
    recorded,
    `the reverse guard's live orphan set no longer matches the recorded backlog.\n` +
      (newlyStranded.length
        ? `Newly openable-by-someone and offered-to-nobody — the finding this guard exists for. Give ` +
          `each a link, or record why it has none in tests/navigation-reachability-backlog.ts:\n  ` +
          `${newlyStranded.join("\n  ")}\n`
        : "") +
      (nowReachable.length
        ? `No longer stranded (good news — a page gained a link or was removed; delete each stale row ` +
          `from the backlog):\n  ${nowReachable.join("\n  ")}\n`
        : ""),
  );

  // ── THE BLIND SPOT: routes the loop above never even looked at ───────────────────────────────
  //
  // `if (!gate.readable) continue` is right for the orphan question — a gate the reader cannot parse
  // cannot say who opens the page — and it is silent for every other question. Measured 2026-09-04:
  // 137 of 356 static routes are skipped that way, so a page added tomorrow with an unparseable gate
  // joins them without a word. That is the same failure shape this file's own header warns about,
  // one level up: the guard ships green while the thing it guards goes unmeasured.
  //
  // 2026-09-05: 134 of 357. The three that left are /admin/dev-preview,
  // /admin/notification-confidence and /admin/sfe-command-center, and none of them MOVED — the
  // reader learned to read `if (access.role !== "Super Admin") redirect(…)`, so pages that were
  // being skipped are now measured, and all three turn out to be properly linked. The orphan set,
  // every route's role count and every bucket came out byte-identical across that change; only this
  // number moved. 15 more pages gained an admit list without leaving the blind spot, because they
  // already carried a readable permission or shell gate — for those the gain is that `canOpen()`
  // stopped answering true for roles the page redirects.
  //
  // The skip only HIDES something when the route is also offered to nobody, so that intersection is
  // what gets a roll-call. Redirect-only stubs are exempted mechanically rather than recorded — a
  // page that renders nothing and forwards is a link, and 18 of these are exactly that. Everything
  // left is a real page that no sidebar, hub card, portal entry, component link or notification href
  // points at, and whose gate nobody can read. Each one needs a link or a written reason.
  const blindSpot = gates.filter((gate) => !gate.readable);
  const blindAndUnlinked = blindSpot
    .filter((gate) => !gate.redirectOnly)
    .filter((gate) => !offeredToAnyone.has(gate.href))
    .filter(
      (gate) =>
        (linkedFrom.get(gate.href) ?? []).filter(
          (file) => !file.endsWith(`app${gate.href}/page.tsx`) && !file.includes("system-navigation"),
        ).length === 0,
    )
    .map((gate) => gate.href)
    .sort();

  console.log(
    `navigation reachability — blind spot: ${blindSpot.length} of ${gates.length} routes have a gate ` +
      `the reader cannot parse; ${blindSpot.filter((g) => g.redirectOnly).length} are redirect-only ` +
      `stubs; ${blindAndUnlinked.length} are real pages nothing links:\n      ${blindAndUnlinked.join("\n      ")}`,
  );

  // Anti-vacuity, same principle as the floors above. If the reader ever started parsing everything
  // the blind spot would empty and this roll-call would pass by having nothing to say — so require
  // it to still be measuring something, and require the stub exemption to still be finding stubs.
  assert.ok(
    blindSpot.length >= 50,
    `expected the unreadable-gate blind spot to still hold 50+ routes, measured ${blindSpot.length} (137 on 2026-09-04, 134 on 2026-09-05 once the reader learned role-inequality gates) — if the reader genuinely got this much better, lower this floor deliberately rather than deleting it`,
  );
  assert.ok(
    blindSpot.filter((gate) => gate.redirectOnly).length >= 10,
    `expected 10+ redirect-only stubs among them, found ${blindSpot.filter((g) => g.redirectOnly).length} (18) — a collapse here silently promotes every stub into a finding`,
  );

  const recordedBlind = [...reverseGuardBlindSpotRoutes()].sort();
  const newBlind = blindAndUnlinked.filter((route) => !recordedBlind.includes(route));
  const clearedBlind = recordedBlind.filter((route) => !blindAndUnlinked.includes(route));
  assert.deepEqual(
    blindAndUnlinked,
    recordedBlind,
    `the reverse guard's blind spot no longer matches the recorded backlog.\n` +
      (newBlind.length
        ? `A real page whose gate cannot be read AND that nothing links — the guard would have said ` +
          `nothing about these before 2026-09-04. Give each a link, or record why it has none as a ` +
          `gate-unreadable-and-unlinked row in tests/navigation-reachability-backlog.ts:\n  ` +
          `${newBlind.join("\n  ")}\n`
        : "") +
      (clearedBlind.length
        ? `No longer in the blind spot (a page gained a link, a readable gate, or was removed; delete ` +
          `each stale row from the backlog):\n  ${clearedBlind.join("\n  ")}\n`
        : ""),
  );
}
