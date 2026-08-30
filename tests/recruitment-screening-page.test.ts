import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  matchesScreeningNarrowing,
  screeningAreaOptions,
  type ScreeningFilterCandidateRow,
} from "../src/lib/recruitment/screening-filter.ts";
import {
  parseScreeningFilters,
  screeningHref,
  screeningShellPoolHref,
} from "../src/lib/recruitment/screening-link.ts";

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
 * for HR Advisory — the role that screens the most CVs. Every admin page in this module has
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
  // `seen: "unseen"` must keep emitting the EXACT URL that already exists — it is bookmarked, it is
  // what the pool's own button builds, and it is the address in the owner's request. Growing the
  // three-way must not silently re-spell it.
  assert.equal(
    screeningHref("/recruitment", { seen: "unseen" }),
    "/recruitment/screening?unseen=1",
    "the link the owner asked for: open straight into what has never been read",
  );
  assert.equal(
    screeningHref("/employee-portals/recruitment", { seen: "unseen" }),
    "/employee-portals/recruitment/screening?unseen=1",
    "the portal twin's link, which is what HR Advisory must get",
  );
  assert.equal(
    screeningHref("/recruitment", { seen: "seen" }),
    "/recruitment/screening?seen=1",
    "the other half of the three-way: the CVs this viewer has already read",
  );
  assert.equal(
    screeningHref("/recruitment/"),
    "/recruitment/screening",
    "a trailing slash must not produce a double slash",
  );
  assert.equal(
    screeningHref("/recruitment", { seen: "any" }),
    "/recruitment/screening",
    "explicitly asking for everything is the plain link",
  );

  // Every filter on the bar is a LINK, and the whole point is that they compose: "the New Medical
  // Rep CVs in Tanta I have not read yet" has to be one address a person can bookmark.
  assert.equal(
    screeningHref("/recruitment", {
      area: "Gharbia 1 (Tanta)",
      region: "D1",
      role: "medical_rep",
      seen: "unseen",
      status: "new",
    }),
    "/recruitment/screening?unseen=1&status=new&role=medical_rep&region=D1&area=Gharbia+1+%28Tanta%29",
    "every filter travels in one link, and an area with spaces and brackets survives the round trip",
  );
  assert.equal(
    screeningHref("/recruitment", { area: "unknown", region: "unknown", role: "unknown" }),
    "/recruitment/screening?role=unknown&region=unknown&area=unknown",
    "the three we-were-never-told buckets are linkable too",
  );
  assert.equal(
    screeningHref("/recruitment", { area: null, region: null, role: null, status: null }),
    "/recruitment/screening",
    "an explicitly empty narrowing is the plain link, not a query string of nulls",
  );

  // ── 1b · Which shell the filter links stay inside ─────────────────────────
  // The HR namespace is a proxy REWRITE, so the server cannot see it and hands the client the
  // (admin) pool href. Building the next link from that href throws an HR user out of their own
  // sidebar mid-task — measured on 2026-08-30 before this existed. The browser's path is the only
  // witness, which is why the rule is a pure string function rather than something you can only
  // observe by driving a browser.
  assert.equal(
    screeningShellPoolHref("/hr/recruitment/screening", "/recruitment"),
    "/hr/recruitment",
    "an HR-namespace screener keeps their /hr prefix, not the server's poolHref",
  );
  assert.equal(
    screeningShellPoolHref("/recruitment/screening", "/recruitment"),
    "/recruitment",
    "the admin shell is unchanged by this",
  );
  assert.equal(
    screeningShellPoolHref("/employee-portals/recruitment/screening", "/employee-portals/recruitment"),
    "/employee-portals/recruitment",
    "so is the portal twin",
  );
  assert.equal(
    screeningShellPoolHref(null, "/recruitment"),
    "/recruitment",
    "no pathname yet falls back to what the server passed",
  );
  assert.equal(
    screeningShellPoolHref("/recruitment/pool", "/recruitment"),
    "/recruitment",
    "a path that is not a screening page falls back too",
  );
  assert.equal(
    screeningShellPoolHref("/screening", "/recruitment"),
    "/recruitment",
    "a bare /screening does NOT become the empty string — router.push(\"\") reloads, it does not navigate",
  );
  assert.equal(
    screeningHref(screeningShellPoolHref("/hr/recruitment/screening", "/recruitment"), {
      role: "medical_rep",
      seen: "unseen",
    }),
    "/hr/recruitment/screening?unseen=1&role=medical_rep",
    "changing one filter under /hr rebuilds a /hr link",
  );

  // ── 2 · Reading the narrowing out of a link ───────────────────────────────
  const nothing = { area: null, region: null, role: null, seen: "any", status: null };
  assert.deepEqual(parseScreeningFilters({}), nothing, "a bare link narrows nothing");
  assert.deepEqual(parseScreeningFilters(), nothing, "no params at all narrows nothing");
  for (const truthy of ["1", "true", "TRUE", "yes"]) {
    assert.equal(parseScreeningFilters({ unseen: truthy }).seen, "unseen", `${truthy} means unseen only`);
    assert.equal(parseScreeningFilters({ seen: truthy }).seen, "seen", `${truthy} on the other half means seen only`);
  }
  for (const falsy of ["0", "false", "no", "", "  "]) {
    assert.equal(parseScreeningFilters({ unseen: falsy }).seen, "any", `${falsy} does not mean unseen only`);
    assert.equal(parseScreeningFilters({ seen: falsy }).seen, "any", `${falsy} does not mean seen only`);
  }
  // Somebody editing an address bar, not an attack. Unseen wins because it is the link that already
  // exists in bookmarks and in the pool's own button.
  assert.equal(
    parseScreeningFilters({ seen: "1", unseen: "1" }).seen,
    "unseen",
    "asking for both halves at once resolves to the one that already had a link",
  );
  // Next.js hands a repeated query param through as an array. Take the first and ignore the rest
  // rather than throwing — `?unseen=1&unseen=0` is a person editing an address bar, not an attack.
  assert.equal(
    parseScreeningFilters({ unseen: ["1", "0"] }).seen,
    "unseen",
    "a repeated param takes the first value",
  );
  assert.equal(parseScreeningFilters({ unseen: [] }).seen, "any", "an empty array narrows nothing");

  // Role, region and area — the three the owner asked for beside seen/unseen. Same rule as the
  // status below them: an unrecognised value is IGNORED rather than guessed at or thrown on.
  assert.equal(parseScreeningFilters({ role: "medical_rep" }).role, "medical_rep", "a real role family narrows");
  assert.equal(parseScreeningFilters({ role: "MEDICAL_REP" }).role, "medical_rep", "role matching is case-blind");
  assert.equal(parseScreeningFilters({ role: "unknown" }).role, "unknown", "no job title on file is its own bucket");
  assert.equal(parseScreeningFilters({ role: "banana" }).role, null, "an unknown role narrows nothing");
  assert.equal(parseScreeningFilters({ region: "D3" }).region, "D3", "a real region code narrows");
  assert.equal(parseScreeningFilters({ region: "d3" }).region, "D3", "a lower-cased region code still resolves");
  assert.equal(parseScreeningFilters({ region: "foreign" }).region, "foreign", "an address outside Egypt is its own bucket");
  assert.equal(parseScreeningFilters({ region: "unknown" }).region, "unknown", "no governorate on file is a third bucket");
  assert.equal(parseScreeningFilters({ region: "ZZ" }).region, null, "an unknown region narrows nothing");
  // The area is the one value that CANNOT be validated here — it is free text an applicant typed,
  // and this module may not reach a database to find out which ones exist. So it passes through as
  // written and simply matches nobody if it is nonsense.
  assert.equal(
    parseScreeningFilters({ area: "Gharbia 1 (Tanta)" }).area,
    "Gharbia 1 (Tanta)",
    "an area name survives verbatim, brackets and all",
  );
  assert.equal(parseScreeningFilters({ area: "  Alex West  " }).area, "Alex West", "an area is trimmed, not mangled");
  assert.equal(parseScreeningFilters({ area: "UNKNOWN" }).area, "unknown", "the no-area bucket is case-blind");
  assert.equal(parseScreeningFilters({ area: "" }).area, null, "an empty area narrows nothing");

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

  // ── 2b · What the narrowing actually KEEPS ────────────────────────────────
  //
  // The owner's request of 2026-08-30, verbatim: "i want to have a filter by area and by seen and
  // un seen and by role and by region". Parsing a link is half the job — this half is the rule that
  // decides who is still in the queue, and it is tested against plain rows rather than against
  // production because the loader reaches the database on its first line.
  //
  // THE RULE THAT MATTERS: role, region and area read `candidateScreeningFacts`, the SAME
  // resolution the card in the queue renders. The pool shipped a Role filter reading
  // `currentJobTitle` alone and it disagreed with its own screen — a candidate displayed as
  // "District Sales Manager" was invisible to the District Manager filter. Every fixture below has
  // its fact somewhere OTHER than the obvious column, so a regression to reading the raw column
  // fails here rather than in front of a recruiter.
  const rep: ScreeningFilterCandidateRow = {
    // Title only in the CV reader's hedged answer, never in the column. Reading `currentJobTitle`
    // alone classifies this person as nothing at all.
    cvUnconfirmed: { currentJobTitle: "Medical Representative", governorate: "Tanta" },
    fullName: "Fixture Rep",
    id: "rep",
    preferredAreaName: "Gharbia 1 (Tanta)",
    status: "new",
  };
  const managerAbroad: ScreeningFilterCandidateRow = {
    currentJobTitle: "District Sales Manager",
    fullName: "Fixture Manager",
    governorate: "Dubai",
    id: "manager",
    status: "shortlisted",
  };
  // Nothing on file at all: no title, no governorate, no declared area. All three unknown buckets.
  const blank: ScreeningFilterCandidateRow = { fullName: "Fixture Blank", id: "blank", status: "new" };
  // The role comes only off what they ASKED for — the last rung of the ladder the row displays.
  const applicant: ScreeningFilterCandidateRow = {
    appliedForJobTitle: "Medical Rep",
    fullName: "Fixture Applicant",
    governorate: "Gharbia",
    id: "applicant",
    preferredAreaName: "gharbia 1 (tanta)",
    status: "new",
  };
  const everyone = [rep, managerAbroad, blank, applicant];

  const keeps = (query: Parameters<typeof parseScreeningFilters>[0], seenIds: string[] = []) =>
    everyone
      .filter((candidate) =>
        matchesScreeningNarrowing(candidate, parseScreeningFilters(query), {
          seenByViewer: seenIds.includes(candidate.id),
        }),
      )
      .map((candidate) => candidate.id);

  assert.deepEqual(keeps({}), ["rep", "manager", "blank", "applicant"], "a bare link keeps everyone");

  // Seen / unseen — the three-way, against one viewer's reading.
  assert.deepEqual(keeps({ unseen: "1" }, ["rep"]), ["manager", "blank", "applicant"], "unseen drops what was read");
  assert.deepEqual(keeps({ seen: "1" }, ["rep"]), ["rep"], "seen keeps ONLY what was read");
  assert.deepEqual(keeps({ seen: "1" }, []), [], "seen with nothing read is honestly empty, not everyone");
  assert.deepEqual(keeps({}, ["rep"]), ["rep", "manager", "blank", "applicant"], "neither half keeps both halves");

  // Role — every one of these three is found by a fact that is NOT in `currentJobTitle`.
  assert.deepEqual(keeps({ role: "medical_rep" }), ["rep", "applicant"], "the hedged CV title and the asked-for title both count");
  assert.deepEqual(keeps({ role: "district_manager" }), ["manager"], "a district manager is one, and only one, of these");
  assert.deepEqual(keeps({ role: "unknown" }), ["blank"], "unknown means nobody ever told us — not 'Other'");

  // Region — three buckets, and `foreign` is the one that must not fall into `unknown`.
  assert.deepEqual(keeps({ region: "D1" }), ["rep", "applicant"], "Tanta and Gharbia both resolve to Delta (1)");
  assert.deepEqual(keeps({ region: "foreign" }), ["manager"], "an address outside Egypt is placed, not unknown");
  assert.deepEqual(keeps({ region: "unknown" }), ["blank"], "only the person with no address at all is unknown");
  assert.deepEqual(keeps({ region: "CA" }), [], "a region nobody is in is empty, not everybody");

  // Area — free text, matched the way a person reads it.
  assert.deepEqual(keeps({ area: "Gharbia 1 (Tanta)" }), ["rep", "applicant"], "an area matches whatever case it was typed in");
  assert.deepEqual(keeps({ area: "  gharbia 1 (tanta)  " }), ["rep", "applicant"], "and survives the spaces around it");
  assert.deepEqual(keeps({ area: "unknown" }), ["manager", "blank"], "no area on file is its own bucket");
  assert.deepEqual(keeps({ area: "Alex West" }), [], "an area nobody asked for is empty");

  // And they COMPOSE — which is the whole point of every one of them being in the link.
  assert.deepEqual(
    keeps({ area: "Gharbia 1 (Tanta)", region: "D1", role: "medical_rep", status: "new", unseen: "1" }, ["rep"]),
    ["applicant"],
    "five filters at once narrow to the one person who satisfies all five",
  );

  // The Area dropdown offers what applicants have NAMED, de-duplicated case-insensitively, first
  // spelling winning — never every area the company has, which would be ~50 options that can only
  // return an empty queue.
  assert.deepEqual(
    screeningAreaOptions(everyone),
    ["Gharbia 1 (Tanta)"],
    "two spellings of one area are one option, and the first spelling is the one offered",
  );
  assert.deepEqual(screeningAreaOptions([blank]), [], "a pool where nobody named an area offers no areas");
  assert.deepEqual(
    screeningAreaOptions([{ ...blank, preferredAreaName: "Zagazig" }, { ...blank, preferredAreaName: "Alex West" }]),
    ["Alex West", "Zagazig"],
    "the list is sorted the way a reader scans it",
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
  // ...and the NARROWING goes with them. A bare `redirect("/recruitment/screening")` dropped the
  // query string, so HR Advisory — whose navigation mode is not the portal, so this branch is the
  // one they always take — followed a filtered link and landed on the unfiltered 481-row queue,
  // with nothing on screen to say a filter had been thrown away. Rebuilt through `screeningHref`
  // rather than by forwarding the raw query, so an edited address bar cannot ride the redirect.
  assert.match(
    portalPage,
    /redirect\(screeningHref\("\/recruitment", parseScreeningFilters\(filters\)\)\)/,
    "the shell redirect must carry the filters, or every filtered link is dead for HR Advisory",
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
    // Re-cut 2026-08-27. This used to require the call to END after `filters`, which stopped being
    // the shape when the loader grew a third argument for the manager list. The PROPERTY is
    // unchanged and is the only thing that matters — the viewer id is the caller's, never a URL
    // parameter — so the pin now asserts the first two arguments and stops counting the rest.
    assert.match(
      source,
      /loadScreeningQueue\(access\.hrId, filters[,)]/,
      `the ${name} screening page must load the view history of the CALLER, not of a URL parameter`,
    );
    // Sending a CV is `recruitment: update` — the grant the send route itself enforces. Both pages
    // must decide this, because the loader cannot: only a page holds the AccessContext.
    assert.match(
      source,
      /canSendToManagers: await canAccess\(access, "recruitment", "update"\)/,
      `the ${name} screening page must gate the manager picker on the same grant the send route requires`,
    );
    // The filter bar is only as good as what reaches it, and the two pages are kept in sync BY
    // HAND — so a filter added to one and forgotten on the other is the exact failure this pair of
    // files keeps producing. Every narrowing the loader resolved has to be handed over on both, or
    // the control renders blank on the shell nobody was looking at.
    for (const prop of ["area", "areaOptions", "region", "role", "seen", "status"]) {
      assert.match(
        source,
        new RegExp(`${prop}=\\{queue\\.${prop}\\}`),
        `the ${name} screening page must pass ${prop} through, or that filter is dead in this shell`,
      );
    }
  }

  // ── 4 · The pool still links to it ────────────────────────────────────────
  //
  // A route nobody can find is the same as no route. The pool's link is shell-aware for the reason
  // in section 3: a hard-coded /recruitment/screening in the portal bounces HR Advisory out.
  const workspaceSource = read("src/components/recruitment/recruitment-workspace.tsx");
  assert.match(
    workspaceSource,
    /screeningHref\(screeningBasePath, \{ seen: "unseen" \}\)/,
    "the pool must link to the screening page, opening on the unread pile",
  );
  assert.match(
    workspaceSource,
    /poolPathname\?\.startsWith\("\/employee-portals"\)/,
    "the screening link must resolve to the shell the caller is actually in",
  );

  // The overlay button survives alongside it on purpose: it carries every filter on the toolbar
  // exactly, which a URL cannot, while the link is bookmarkable. Losing either is a regression.
  assert.match(workspaceSource, /setScreeningQueue\(filteredCandidates\)/, "the in-place screening button must remain");
  // It hands over the list BEFORE the red split, and that argument IS the assertion — not a
  // detail. The queue owns its own Active/Red tabs, so passing the already-split list would give
  // it a Red-flagged tab that read zero however many red CVs the toolbar had actually turned up.
  // This pin read `visibleCandidates` until the split was built; the rename is deliberate.
  assert.match(
    workspaceSource,
    /initialCvTab=\{cvTab\}/,
    "the overlay must open on the pile the pool is showing, or the queue disagrees with its own launch button",
  );

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
  //
  // The allowlist is three VOCABULARIES, and it is an allowlist rather than a count for a reason:
  // the Role and Region filters added 2026-08-30 need the same lists of role families and region
  // codes the pool's own filters use, and re-declaring either here would be two copies of a
  // vocabulary that drifts in one. Each of the three is verified below to import NOTHING itself, so
  // the chain this file exists to keep short stays exactly one link long. Anything else added here
  // must pass that same check first.
  const linkImports = [...linkSource.matchAll(/^import[\s\S]*?from "([^"]+)";$/gm)].map((match) => match[1]);
  const allowedLinkImports = [
    "@/lib/recruitment/candidate-region",
    "@/lib/recruitment/candidate-role-family",
    "@/lib/recruitment/candidate-status",
  ];
  assert.deepEqual(
    [...linkImports].sort(),
    allowedLinkImports,
    "screening-link may import the pure vocabularies and nothing else — every other import risks a database",
  );
  for (const allowed of allowedLinkImports) {
    const vocabulary = read(`src/lib/recruitment/${allowed.split("/").pop()}.ts`);
    assert.doesNotMatch(
      vocabulary,
      /^import\b/m,
      `${allowed} must import nothing at all, or screening-link's own purity is only one level deep`,
    );
  }

  // The narrowing RULE is split out of the loader for the same reason, plus one of its own: a rule
  // that sits beside `listCandidates` can only be exercised by loading production, which in
  // practice means it is never exercised at all. Section 2b above hands it plain rows — and it can
  // only do that while nothing in this file reaches a database.
  const filterSource = read("src/lib/recruitment/screening-filter.ts");
  for (const forbidden of ["candidates", "candidate-views", "db", "supabase", "screening-queue"]) {
    assert.doesNotMatch(
      filterSource,
      new RegExp(`from "@/lib/recruitment/${forbidden}"`),
      `screening-filter must not import ${forbidden} — it is the half that has to stay testable`,
    );
  }
  assert.match(
    read("src/lib/recruitment/screening-queue.ts"),
    /from "@\/lib\/recruitment\/screening-filter"/,
    "the loader must USE that rule rather than keeping a second copy of it",
  );

  // ── 6 · Send to a manager WITHOUT leaving the queue ───────────────────────
  //
  // The owner's words, the same day the page shipped: "I want to be able to send to a manager from
  // this place, I don't have to shortlist and go to other table, make the two options available."
  //
  // He was describing a real dead end. Screening could record yes or no and nothing else, so the
  // single most valuable outcome of reading a CV — putting it in front of the person who will
  // actually interview — meant leaving the queue, finding that one row again in a 434-line table,
  // and starting over. Shortlisting is a note to yourself; sending is what moves a hire forward.
  const session = read("src/components/recruitment/candidate-screening-session.tsx");
  assert.match(
    session,
    /\/api\/recruitment\/candidates\/\$\{current\.id\}\/notify-manager/,
    "the queue must post to the candidate-level send route, the same one the pool uses",
  );

  // BOTH options, side by side. The one thing that must never be true is that sending is a
  // consequence of shortlisting: a recruiter has to be able to send a CV to a District Manager
  // without also recording a verdict they have not reached.
  const sendBody = session.slice(session.indexOf("const sendToManager = useCallback"), session.indexOf("const decidedCount"));
  assert.ok(sendBody.includes("notify-manager"), "the slice above must be the send callback");
  for (const forbidden of ["setDecided", "setIndex", "/status"]) {
    assert.ok(
      !sendBody.includes(forbidden),
      `sending must not ${forbidden === "/status" ? "write a status" : "advance or judge"} — it is not a decision`,
    );
  }

  // A picker with nobody in it is worse than no picker, so the control is gated on the list
  // actually having arrived — and the list itself is gated on the grant the send route enforces.
  assert.match(
    session,
    /hiringManagers\.length > 0 \? \(/,
    "the send control must not render when the caller was given no managers",
  );
  const client = read("src/components/recruitment/screening-page-client.tsx");
  assert.match(client, /hiringManagers=\{hiringManagers\}/, "the page client must pass the managers through");
  for (const [name, source] of [["admin", adminPage], ["portal", portalPage]] as const) {
    assert.match(
      source,
      /hiringManagers=\{queue\.hiringManagers\}/,
      `the ${name} screening page must hand the loaded managers to the queue`,
    );
  }

  // The confirmation reads back by NAME and in Cairo time, and it survives a reload — because half
  // of it comes from the stamp on the row, not from what this component just did.
  assert.match(
    session,
    /const priorSend = current\.managerNotified;/,
    "the queue must read the recorded send, or the confirmation dies with the page",
  );
  assert.match(session, /timeZone: "Africa\/Cairo"/, "a send time is shown in Cairo, never raw UTC");
  assert.doesNotMatch(
    session,
    /Sent to \{sendManagerHrId\}/,
    "an HR_ID must never be what the screen says a CV was sent to",
  );

  // ── 7 · The CV must FIT the column it is given ────────────────────────────
  //
  // The regression the owner reported as the CV "appearing as one text". Measured on a 1366×850
  // laptop with the screening page open: the pane the document lands in is 652px and a Word page is
  // a fixed 816px, so it overflowed by 164px and the reader got a sideways scrollbar and a squeezed
  // wall of words. PDFs are worse — pdf.js rasterises at scale 1.5, so US Letter is a 918px canvas
  // in that same 652px pane. The full-screen overlay never showed it, because it covers the ~292px
  // sidebar and hands the document ~986px.
  const viewer = read("src/components/recruitment/cv-preview-modal.tsx");
  // `zoom`, not `transform: scale()`. transform does not affect layout, so the scaled document
  // keeps its original box and the scroll container either clips the last page or leaves a screen
  // of empty grey under it. zoom reflows, so the container is simply the right size.
  assert.match(viewer, /style=\{\{ zoom \}\}/, "the fit must be applied with CSS zoom, which reflows");
  // The pin must match a real STYLE, never prose. The component explains at length why it does NOT
  // use transform, and the first cut of this pin read that explanation as the violation it warns
  // against — it turned the required `validate` job red on its own head, 2026-08-27. A CSS value in
  // a JS style object is always a string, so the opening quote is exactly what separates a usage
  // from a sentence about one. Do not loosen this back to a bare string search.
  assert.doesNotMatch(
    viewer,
    /transform:\s*[`"']scale\(/,
    "transform: scale does not reflow — it scales the picture and leaves the scroll box the wrong size",
  );
  // Fit only ever SHRINKS. A pane wider than the page would otherwise blow a PDF's raster up into a
  // blurry one and silently change the modal, where the document already fitted.
  assert.match(
    viewer,
    /Math\.min\(1, paneWidth \/ naturalWidth\)/,
    "fitting must never enlarge a document on its own — that is what the + button is for",
  );
  // The PAGE element, not the container's scrollWidth. scrollWidth is the wrong number here and
  // misleadingly close to the right one: measured live, an 816px page in a 637px pane reported 727.
  assert.match(
    viewer,
    /querySelectorAll<HTMLElement>\("\.docx, canvas"\)/,
    "the width must be measured from the rendered page, never inferred from the scroll box",
  );

  // And the cause, not only the symptom: the page can borrow the overlay's full width on demand.
  assert.match(session, /const fullBleed = variant === "overlay" \|\| expanded;/, "the page must be able to go full-bleed");
}
