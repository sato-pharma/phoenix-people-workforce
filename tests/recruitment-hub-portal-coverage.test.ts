import assert from "node:assert/strict";

import { existsSync, readFileSync } from "node:fs";

import {
  employeePortalNavigationSections,
  getNavigationSections,
  recruitmentHiringPageItems,
  type NavigationSection,
} from "../src/config/system-navigation.ts";
import {
  getSections,
  permissionAllowed,
  roleAllowed,
  roleNotExcluded,
  type PermissionLookup,
} from "../src/lib/navigation/active-path.ts";
import {
  createAccessContext,
  permissionActions,
  permissionMatrix,
  permissionResources,
  phoenixRoles,
  resolveNavigationMode,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";

/**
 * Every tool on the Recruitment & Hiring hub must be reachable by the seat that works it.
 *
 * THIS FILE'S PREMISE INVERTED ON 2026-08-28, on purpose, and the previous version said so in
 * as many words: "If this flips, Talent Acquisition reaches the admin hub directly and the mirrors
 * below become redundant rather than load-bearing. Deliberately pinned so that move is a decision
 * someone makes on purpose, having read this file, rather than a side effect of editing a role set."
 * It has been read, and it was a decision: the owner replaced the single Talent Acquisition seat
 * with two HR seats and placed both on the ADMIN shell.
 *
 * What the old invariant protected, and why it is gone. Talent Acquisition sat in
 * portalNavigationRoles, so resolveNavigationMode put her in the portal shell, and
 * app/(admin)/layout.tsx redirects portal-mode users out of the ENTIRE (admin) route group before
 * any page in it renders. The hub was therefore Super-Admin-only in practice however its `roles`
 * read — and nothing failed, because the config naming her was true config and the redirect was
 * somewhere else. Seven portal mirrors existed solely to route around that. Inbound Intake Health
 * was the expensive proof: it shipped with no mirror and was unreachable by the only role that
 * worked it, while carrying the retry action for dead-lettered inbound CVs — real applicants who
 * were silently never entered.
 *
 * HR Advisory is an admin-shell role, so she reaches every card directly and the mirrors are dead
 * surface rather than the route in. The invariant that replaces it is the same question asked of
 * the new shell: does the seat that owns each tool have a way to open it? Checked three ways,
 * because any one alone is passable while the tool stays unreachable:
 *   1. the seat lands in the admin shell at all (the old failure, in its new form),
 *   2. the hub button is in HER rendered sidebar — not merely in the config,
 *   3. every card's page file exists and she clears both of its gates.
 *
 * Reachability from the OTHER direction — a grant offered with no link to reach it — is
 * every-offered-link-opens.test.ts. Neither test subsumes the other.
 */

/** Where each hub href resolves on disk, inside the (admin) route group. */
function adminPageFileFor(href: string): string {
  return `app/(admin)${href}/page.tsx`;
}

/** The seat that owns recruiting. hr-functions.ts: the `recruiting` function, HR Advisory only. */
const RECRUITING_SEAT = "HR Advisory" satisfies PhoenixRole;

/**
 * The seven portal mirrors, orphaned by the shell move. Listed rather than deleted because the
 * pages are still on disk and a stale list is how the previous defect started: the map here and
 * the hub drifted apart with nothing comparing them. Phase 2 gives these tools an /hr home and
 * these files go with it. Until then the assertion below is that they are reachable by NOBODY —
 * which is correct but must stay deliberate, not become a surprise.
 */
const ORPHANED_PORTAL_MIRRORS: readonly string[] = [
  "/employee-portals/recruitment",
  "/employee-portals/cv-database",
  "/employee-portals/hiring-documents",
  "/employee-portals/hiring-pack",
  "/employee-portals/offers",
  "/employee-portals/intake-health",
  "/employee-portals/contact-review",
];

function lookupForRole(role: PhoenixRole): PermissionLookup {
  const rolePermissions = permissionMatrix[role];
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = rolePermissions[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

function hrefsFor(role: PhoenixRole, mode: "admin" | "employee-portal"): Set<string> {
  const catalog =
    mode === "employee-portal"
      ? (employeePortalNavigationSections as readonly NavigationSection[])
      : getNavigationSections(mode);
  const sections = getSections(catalog, mode, lookupForRole(role), role);
  return new Set(sections.flatMap((section) => section.items.map((item) => item.href)));
}

/** Exactly what the hub page itself renders for a role — same two gates, no replica. */
/**
 * The hub page's OWN filter, through the same three helpers it calls — never a reimplementation.
 *
 * This used to hand-write the rule, and it drifted from the page on the one detail that decides
 * every actionless clause: `permissionAllowed` resolves `{ resource: X }` to **X:read**, while the
 * copy here accepted ANY action on X. For every seat that holds a resource read-first the two agree,
 * which is why it sat unnoticed — it took a seat granted `vacancies:create` and NOT `vacancies:read`
 * (HR Operations, so she can record a resignation) to separate them, and then this file failed on a
 * CV Database card that app/(admin)/admin/recruitment-hiring/page.tsx would never have rendered.
 *
 * A test that models a gate instead of calling it can only ever be as right as the day it was
 * written. That page says the same thing about itself two comments up: "the pair is what drifted".
 */
function hubCardsFor(role: PhoenixRole) {
  const lookup = lookupForRole(role);
  return recruitmentHiringPageItems.filter(
    (item) =>
      permissionAllowed(lookup, item.permissions) &&
      roleAllowed(role, item.roles) &&
      roleNotExcluded(role, item.excludedRoles),
  );
}

export function runRecruitmentHubPortalCoverageTests() {
  // ── 1. The premise, restated for the new shell ──────────────────────────────────────────────
  // If THIS flips, the whole file is wrong again and the portal mirrors above become load-bearing
  // once more. Pinned for the same reason the old one was.
  assert.equal(
    resolveNavigationMode(createAccessContext({ hrId: "HRBP-1", role: RECRUITING_SEAT })),
    "admin",
    `${RECRUITING_SEAT} is an admin-shell role (owner decision, 2026-08-28) — she reaches the ` +
      "(admin) route group directly, which is what makes the seven portal mirrors redundant",
  );

  // ── 2. HEADLINE: the hub button is in her rendered sidebar ──────────────────────────────────
  // Break the fix — drop her from the entry's roles, or drop its permission clause so it renders
  // for a seat holding none of the cards — and this is what fires.
  assert.ok(
    hrefsFor(RECRUITING_SEAT, "admin").has("/admin/recruitment-hiring"),
    `${RECRUITING_SEAT} must have the Recruitment & Hiring button in her sidebar. She holds every ` +
      "card's grant, so the hub renders in full on request — but with no sidebar entry there is no " +
      "way to reach it, which is exactly the 2026-08-25 defect in its admin-shell form.",
  );

  // ── 3. Every card she owns opens ────────────────────────────────────────────────────────────
  const cards = hubCardsFor(RECRUITING_SEAT);
  assert.equal(
    cards.length,
    8,
    "the hub must carry exactly eight cards for the recruiting seat (Recruitment, CV Database, " +
      "Hiring Documents, Contract & Form 1, Job Offers, Inbound Intake Health, Missing Contact " +
      "Details, WhatsApp Replies) — if that count moves, decide the reachability of the new one " +
      "in the same change. " +
      `Got: ${cards.map((c) => c.href).join(", ")}`,
  );
  for (const card of cards) {
    assert.ok(
      existsSync(adminPageFileFor(card.href)),
      `"${card.label}" is offered to ${RECRUITING_SEAT} on the hub but ${adminPageFileFor(card.href)} ` +
        "does not exist — the card opens nothing",
    );
  }

  // ── 4. The other bundle must NOT get an empty hub ───────────────────────────────────────────
  // HR Operations holds no recruitment, candidates, vacancies or offers grant, so every card
  // filters out for her. A roles-only sidebar entry would still show her the button, opening a hub
  // with nothing in it — the defect already recorded for SFE Manager and Finance Manager on People
  // Management, which is why the entry carries a permission clause as well as a role list.
  // She clears the two cards gated on employee_documents — Hiring Documents and Contract & Form 1
  // — because people_records grants her that resource: hiring paperwork is genuinely shared work,
  // not recruiting. She clears NONE of the five gated on recruitment / candidates / vacancies /
  // offers, which is the separation that matters. Named individually rather than counted, so a
  // recruiting card leaking to her fails with the card in the message.
  const opsCards = hubCardsFor("HR Operations").map((c) => c.href).sort();
  assert.deepEqual(
    opsCards,
    ["/hiring-documents", "/hiring-pack"],
    "HR Operations may clear only the shared hiring-paperwork cards, never a recruiting one",
  );
  // …and those two are currently reachable ONLY from a hub she is not offered, so the grant is
  // real and the route to it is not. That is the granted-but-unreachable shape every-offered-link
  // -opens.test.ts cannot see (it walks links, and there is no link), and it is an input to Phase
  // 2: the /hr namespace must give these two an entry in HER navigation. Asserted so the gap stays
  // visible rather than being discovered by the new hire on her first day.
  assert.ok(
    !hrefsFor("HR Operations", "admin").has("/hiring-documents"),
    "if this starts failing, HR Operations has been given her own route to Hiring Documents — " +
      "delete this assertion, it has done its job",
  );
  assert.ok(
    !hrefsFor("HR Operations", "admin").has("/admin/recruitment-hiring"),
    "HR Operations must not be offered a Recruitment & Hiring button — every card on it is " +
      "filtered out for her, so the button opens an empty page",
  );

  // ── 5. The orphaned mirrors are reachable by NOBODY, and stay deliberate ────────────────────
  // Their only holder was the portal-shell seat that no longer exists. Asserted across every role
  // rather than the obvious two, because the failure this guards against is a mirror quietly
  // becoming visible to some unrelated portal role after a permission change.
  const portalSource = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  for (const mirror of ORPHANED_PORTAL_MIRRORS) {
    for (const role of phoenixRoles) {
      assert.ok(
        !hrefsFor(role, "employee-portal").has(mirror),
        `${mirror} is an orphaned portal mirror of an admin-shell tool, but it is offered to ` +
          `${role} in the portal sidebar. Either that role should not see it, or the tool has a ` +
          "portal owner again and this list is stale.",
      );
    }
    assert.ok(
      existsSync(`app${mirror}/page.tsx`),
      `${mirror} is listed as an orphaned mirror but its page file is gone — drop it from ` +
        "ORPHANED_PORTAL_MIRRORS in the same change that deletes the page",
    );
  }
  // The NAV half of the cleanup is done: the portal layout no longer renders a row for any of
  // them. It had to be, and not as tidiness — the layout is a SECOND sidebar builder, separate
  // from the catalog in system-navigation.ts, so removing the catalog sections left it still
  // emitting thirteen rows behind flags that can never be true again. employee-portal-nav-catalog
  // -sync (M12) is what compares the two and refused. What remains for Phase 2 is the page files.
  for (const mirror of ORPHANED_PORTAL_MIRRORS) {
    assert.ok(
      !portalSource.includes(`"${mirror}"`),
      `${mirror} is back in the portal layout. Either a portal role owns this tool again — in ` +
        "which case it needs a catalog entry too, or M12 fails — or the row is dead and should go.",
    );
  }

  // ── 6. The removed tools must stay removed, on BOTH surfaces ────────────────────────────────
  // The owner's ruling, 2026-08-15. Each of these had an admin page and a portal twin, and each
  // twin was wired into three separate places; a partial revert would leave a card or a sidebar row
  // pointing at a page that no longer exists.
  const hubHrefs = new Set<string>(recruitmentHiringPageItems.map((item) => item.href));
  for (const gone of ["cv-review-queue", "cv-extraction-analytics", "cv-field-settings"]) {
    assert.ok(!hubHrefs.has(`/${gone}`), `/${gone} was removed on the owner's ruling — it must not reappear on the hub`);
    assert.ok(
      !existsSync(`app/employee-portals/${gone}/page.tsx`),
      `app/employee-portals/${gone}/page.tsx was removed on the owner's ruling — a restored page has no navigation entry to reach it`,
    );
    assert.ok(
      !portalSource.includes(`/employee-portals/${gone}`),
      `${gone} is still listed in the rendered portal sidebar, so a portal role gets a row that opens nothing`,
    );
  }
}
