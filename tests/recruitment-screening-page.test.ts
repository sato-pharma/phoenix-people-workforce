import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseScreeningFilters, screeningHref } from "../src/lib/recruitment/screening-link.ts";

/**
 * "I want the screening page to have a separate link, and to access it from its own page."
 *
 * The owner's first request of 2026-08-27. Screening was a full-screen layer opened from a button
 * inside the Recruitment workspace and held in one piece of React state, so it had no address at
 * all: it could not be bookmarked, could not be linked to, could not be reopened where he left it,
 * and closing the browser lost the way back in.
 *
 * Two structural facts this file holds still.
 *
 * THE PORTAL TWIN IS NOT OPTIONAL. `app/(admin)/layout.tsx` redirects portal-shell roles out of the
 * whole (admin) group before any page in it renders, so an admin-only screening route would be dead
 * for Talent Acquisition — the role that screens the most CVs. Every admin page in this module has
 * a twin under app/employee-portals/ for exactly this reason, and a link that points at the wrong
 * one bounces the user straight back out.
 *
 * THE QUERY STRING IS UNTRUSTED. It carries what to narrow to, and nothing about WHO is asking:
 * "have I seen this" is a question about the person asking it, so the viewer comes from the session
 * and a viewer id in a URL would let one person open a link that reports somebody else's reading as
 * their own.
 */

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

export async function runRecruitmentScreeningPageTests() {
  // ── 1 · The link, per shell ────────────────────────────────────────────────
  assert.equal(screeningHref("/recruitment"), "/recruitment/screening", "the admin shell's plain queue");
  assert.equal(
    screeningHref("/recruitment", { unseenOnly: true }),
    "/recruitment/screening?unseen=1",
    "the link the owner asked for: open straight into what has never been read",
  );
  assert.equal(
    screeningHref("/employee-portals/recruitment", { unseenOnly: true }),
    "/employee-portals/recruitment/screening?unseen=1",
    "the portal twin's link, which is what Talent Acquisition must get",
  );
  assert.equal(
    screeningHref("/recruitment/"),
    "/recruitment/screening",
    "a trailing slash must not produce a double slash",
  );
  assert.equal(
    screeningHref("/recruitment", { unseenOnly: false }),
    "/recruitment/screening",
    "explicitly asking for everything is the plain link",
  );

  // ── 2 · Reading the narrowing out of a link ───────────────────────────────
  assert.deepEqual(
    parseScreeningFilters({}),
    { status: null, unseenOnly: false },
    "a bare link narrows nothing",
  );
  assert.deepEqual(parseScreeningFilters(), { status: null, unseenOnly: false }, "no params at all narrows nothing");
  for (const truthy of ["1", "true", "TRUE", "yes"]) {
    assert.equal(parseScreeningFilters({ unseen: truthy }).unseenOnly, true, `${truthy} means unseen only`);
  }
  for (const falsy of ["0", "false", "no", "", "  "]) {
    assert.equal(parseScreeningFilters({ unseen: falsy }).unseenOnly, false, `${falsy} does not mean unseen only`);
  }
  // Next.js hands a repeated query param through as an array. Take the first and ignore the rest
  // rather than throwing — `?unseen=1&unseen=0` is a person editing an address bar, not an attack.
  assert.equal(
    parseScreeningFilters({ unseen: ["1", "0"] }).unseenOnly,
    true,
    "a repeated param takes the first value",
  );
  assert.equal(parseScreeningFilters({ unseen: [] }).unseenOnly, false, "an empty array narrows nothing");

  assert.equal(parseScreeningFilters({ status: "new" }).status, "new", "a real status narrows the queue");
  assert.equal(
    parseScreeningFilters({ status: "sent_to_manager" }).status,
    "sent_to_manager",
    "every status in the vocabulary is linkable",
  );
  // An unrecognised status is IGNORED, never guessed at and never thrown on. A screening link that
  // 500s because somebody edited the address bar is a worse outcome than one showing everything.
  assert.equal(parseScreeningFilters({ status: "banana" }).status, null, "an unknown status narrows nothing");
  assert.equal(parseScreeningFilters({ status: "" }).status, null, "an empty status narrows nothing");
  // The legacy spelling that predates the fixed vocabulary still resolves, so an old bookmark works.
  assert.equal(
    parseScreeningFilters({ status: "candidate created" }).status,
    "new",
    "a legacy status value still resolves rather than 404-ing an old link",
  );

  // ── 3 · Both shells exist, and each points at its own ─────────────────────
  const adminPage = read("app/(admin)/recruitment/screening/page.tsx");
  const portalPage = read("app/employee-portals/recruitment/screening/page.tsx");

  assert.match(adminPage, /poolHref="\/recruitment"/, "the admin page goes back to the admin pool");
  assert.match(
    portalPage,
    /poolHref="\/employee-portals\/recruitment"/,
    "the portal page goes back to the portal pool, not to a route that would redirect it out",
  );
  assert.match(
    portalPage,
    /resolveNavigationMode\(access\) !== "employee-portal"/,
    "an admin-shell user landing on the portal twin is sent to the admin route",
  );

  // Same gate on both, and that is not laziness: screening reads every field on every candidate, so
  // anything looser here would be a way around the Recruitment module's own gate.
  for (const [name, source] of [["admin", adminPage], ["portal", portalPage]] as const) {
    assert.match(
      source,
      /isHrAuthorityRole\(access\.role\)/,
      `the ${name} screening page must carry the module's own role gate`,
    );
    assert.match(
      source,
      /canAccess\(access, "recruitment", "read"\)/,
      `the ${name} screening page must require the recruitment read grant`,
    );
    assert.match(
      source,
      /canAccess\(access, "candidates", "read"\)/,
      `the ${name} screening page must require the candidate read grant before loading a CV`,
    );
    assert.match(
      source,
      /loadScreeningQueue\(access\.hrId, filters\)/,
      `the ${name} screening page must load the view history of the CALLER, not of a URL parameter`,
    );
  }

  // ── 4 · The pool still links to it ────────────────────────────────────────
  //
  // A route nobody can find is the same as no route. The pool's link is shell-aware for the reason
  // in section 3: a hard-coded /recruitment/screening in the portal bounces Talent Acquisition out.
  const workspaceSource = read("src/components/recruitment/recruitment-workspace.tsx");
  assert.match(
    workspaceSource,
    /screeningHref\(screeningBasePath, \{ unseenOnly: true \}\)/,
    "the pool must link to the screening page, opening on the unread pile",
  );
  assert.match(
    workspaceSource,
    /poolPathname\?\.startsWith\("\/employee-portals"\)/,
    "the screening link must resolve to the shell the caller is actually in",
  );

  // The overlay button survives alongside it on purpose: it carries every filter on the toolbar
  // exactly, which a URL cannot, while the link is bookmarkable. Losing either is a regression.
  assert.match(workspaceSource, /setScreeningQueue\(visibleCandidates\)/, "the in-place screening button must remain");

  // ── 5 · The client/server line, which cost a build the first time ─────────
  //
  // screening-queue.ts reaches the database: listCandidates -> recruitment/access -> the employee
  // directory -> employee-photo -> `node:crypto`. The candidate pool is a "use client" component,
  // so importing one pure helper from that file dragged the whole chain into the browser bundle and
  // webpack refused it outright — "Reading from node:crypto is not handled by plugins". The pure
  // half therefore lives in screening-link.ts, and the pool must import from there.
  assert.doesNotMatch(
    workspaceSource,
    /from "@\/lib\/recruitment\/screening-queue"/,
    "a client component must never import the queue loader — it pulls node:crypto into the bundle",
  );
  assert.match(
    workspaceSource,
    /from "@\/lib\/recruitment\/screening-link"/,
    "the pool builds its link from the pure module",
  );

  // And the pure module must STAY pure, or the fix above quietly undoes itself.
  const linkSource = read("src/lib/recruitment/screening-link.ts");
  for (const forbidden of ["candidates", "candidate-views", "db", "supabase"]) {
    assert.doesNotMatch(
      linkSource,
      new RegExp(`from "@/lib/recruitment/${forbidden}"`),
      `screening-link must not import ${forbidden} — anything the pool imports must reach no database`,
    );
  }
  // Imports only, not mentions — the file's own header explains this rule and says the word
  // "Supabase" while doing so, and a check that forbids explaining itself is a check nobody keeps.
  const linkImports = [...linkSource.matchAll(/^import[\s\S]*?from "([^"]+)";$/gm)].map((match) => match[1]);
  assert.deepEqual(
    linkImports,
    ["@/lib/recruitment/candidate-status"],
    "screening-link may import the status vocabulary and nothing else — every other import risks a database",
  );
}
