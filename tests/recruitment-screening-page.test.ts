import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  matchesScreeningNarrowing,
  screeningAreaOptions,
  screeningSourceOptions,
  type ScreeningFilterCandidateRow,
} from "../src/lib/recruitment/screening-filter.ts";
import {
  parseScreeningFilters,
  screeningHref,
  screeningShellPoolHref,
} from "../src/lib/recruitment/screening-link.ts";
import { isAfter } from "../src/lib/recruitment/manager-sends.ts";

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

  // Sent-to-a-manager is the same kind of three-way as seen/unseen, added 2026-08-31 for "sent a
  // week ago... sent to manager or not" — the owner's request, verbatim.
  assert.equal(
    screeningHref("/recruitment", { notified: "sent" }),
    "/recruitment/screening?sent=1",
    "already sent to a manager is its own bookmarkable link",
  );
  assert.equal(
    screeningHref("/recruitment", { notified: "unsent" }),
    "/recruitment/screening?unsent=1",
    "and so is never sent",
  );
  assert.equal(
    screeningHref("/recruitment", { notified: "any" }),
    "/recruitment/screening",
    "sent and not sent together is the plain link",
  );
  // How long ago the CV arrived — the other half of the same request.
  assert.equal(
    screeningHref("/recruitment", { received: "hour" }),
    "/recruitment/screening?received=hour",
    "how recently the CV arrived is linkable too",
  );
  assert.equal(
    screeningHref("/recruitment", { received: "week" }),
    "/recruitment/screening?received=week",
    "every window in the scale is its own link",
  );
  assert.equal(
    screeningHref("/recruitment", { source: "WhatsApp" }),
    "/recruitment/screening?source=WhatsApp",
    "and so is the channel the CV arrived on",
  );

  // Every filter on the bar is a LINK, and the whole point is that they compose: "the New Medical
  // Rep CVs in Tanta I have not read yet" has to be one address a person can bookmark.
  assert.equal(
    screeningHref("/recruitment", {
      area: "Gharbia 1 (Tanta)",
      region: "D1",
      role: "medical_rep",
      seen: "unseen",
      status: "shortlisted",
    }),
    "/recruitment/screening?unseen=1&status=shortlisted&role=medical_rep&region=D1&area=Gharbia+1+%28Tanta%29",
    "every filter travels in one link, and an area with spaces and brackets survives the round trip",
  );
  assert.equal(
    screeningHref("/recruitment", { area: "unknown", region: "unknown", role: "unknown" }),
    "/recruitment/screening?role=unknown&region=unknown&area=unknown",
    "the three we-were-never-told buckets are linkable too",
  );
  assert.equal(
    screeningHref("/recruitment", { area: null, region: null, role: null }),
    "/recruitment/screening",
    "an explicitly empty narrowing is the plain link, not a query string of nulls",
  );
  // THE DECISION TAB rides on `status` (owner, 2026-09-18). The plain link is "Not decided yet", so
  // that tab is never spelled out; "All" is, because its absence now means the other thing.
  assert.equal(screeningHref("/recruitment", { status: "new" }), "/recruitment/screening", "Not decided yet is the plain link");
  assert.equal(screeningHref("/recruitment", { status: null }), "/recruitment/screening?status=all", "All is spelled out");

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
  const nothing = {
    area: null,
    notified: "any",
    rating: null,
    received: null,
    region: null,
    role: null,
    seen: "any",
    source: null,
    // The one narrowing a bare link carries: every screen opens on the "Not decided yet" tab.
    status: "new",
    vacancy: null,
    whatsapp: null,
  };
  assert.deepEqual(parseScreeningFilters({}), nothing, "a bare link narrows nothing but the tab");
  assert.deepEqual(parseScreeningFilters(), nothing, "no params at all narrows nothing but the tab");
  // THE VACANT SEAT travels in the link like every other narrowing, so "screen Menoufia 1" can be
  // bookmarked and pasted to the other screener. It is the one filter carrying an id: two seats can
  // share a job title AND an area and differ only by line, so no name identifies one.
  assert.equal(parseScreeningFilters({ vacancy: "501" }).vacancy, 501, "a seat id is read off the link");
  assert.equal(parseScreeningFilters({ vacancy: "0" }).vacancy, null, "zero is not a seat");
  assert.equal(parseScreeningFilters({ vacancy: "abc" }).vacancy, null, "an edited address bar narrows nothing rather than throwing");
  assert.equal(parseScreeningFilters({ vacancy: "-3" }).vacancy, null, "and neither does a negative one");
  assert.equal(screeningHref("/recruitment", { vacancy: 501 }), "/recruitment/screening?vacancy=501", "and the link carries it back");
  for (const truthy of ["1", "true", "TRUE", "yes"]) {
    assert.equal(parseScreeningFilters({ unseen: truthy }).seen, "unseen", `${truthy} means unseen only`);
    assert.equal(parseScreeningFilters({ seen: truthy }).seen, "seen", `${truthy} on the other half means seen only`);
    assert.equal(parseScreeningFilters({ sent: truthy }).notified, "sent", `${truthy} means sent to a manager only`);
    assert.equal(
      parseScreeningFilters({ unsent: truthy }).notified,
      "unsent",
      `${truthy} on the other half means never sent to a manager`,
    );
  }
  for (const falsy of ["0", "false", "no", "", "  "]) {
    assert.equal(parseScreeningFilters({ unseen: falsy }).seen, "any", `${falsy} does not mean unseen only`);
    assert.equal(parseScreeningFilters({ seen: falsy }).seen, "any", `${falsy} does not mean seen only`);
    assert.equal(parseScreeningFilters({ sent: falsy }).notified, "any", `${falsy} does not mean sent only`);
    assert.equal(parseScreeningFilters({ unsent: falsy }).notified, "any", `${falsy} does not mean unsent only`);
  }
  // Somebody editing an address bar, not an attack. Unseen wins because it is the link that already
  // exists in bookmarks and in the pool's own button.
  assert.equal(
    parseScreeningFilters({ seen: "1", unseen: "1" }).seen,
    "unseen",
    "asking for both halves at once resolves to the one that already had a link",
  );
  // Same rule, same reason, for the other three-way added 2026-08-31.
  assert.equal(
    parseScreeningFilters({ sent: "1", unsent: "1" }).notified,
    "sent",
    "asking for both halves of sent/unsent at once resolves to the narrower half",
  );
  // Next.js hands a repeated query param through as an array. Take the first and ignore the rest
  // rather than throwing — `?unseen=1&unseen=0` is a person editing an address bar, not an attack.
  assert.equal(
    parseScreeningFilters({ unseen: ["1", "0"] }).seen,
    "unseen",
    "a repeated param takes the first value",
  );
  assert.equal(parseScreeningFilters({ unseen: [] }).seen, "any", "an empty array narrows nothing");

  // How long ago the CV arrived, and its source channel — the owner's request of 2026-08-31,
  // verbatim: "sent a week ago, a months ago, one day ago, one hour ago... sent to manager or not
  // ... filter in this page on everything." Same rule as role/region/status: unrecognised is
  // IGNORED, never guessed at.
  assert.equal(parseScreeningFilters({ received: "hour" }).received, "hour", "the narrowest window narrows");
  assert.equal(parseScreeningFilters({ received: "day" }).received, "day", "a day narrows");
  assert.equal(parseScreeningFilters({ received: "week" }).received, "week", "a week narrows");
  assert.equal(parseScreeningFilters({ received: "month" }).received, "month", "a month narrows");
  assert.equal(parseScreeningFilters({ received: "HOUR" }).received, "hour", "received matching is case-blind");
  assert.equal(parseScreeningFilters({ received: "banana" }).received, null, "an unknown window narrows nothing");
  assert.equal(parseScreeningFilters({ received: "" }).received, null, "an empty received narrows nothing");

  // Source is free text resolved off a fixed set of channel badges, so — like area — it cannot be
  // validated here and passes through verbatim, trimmed but not cased.
  assert.equal(parseScreeningFilters({ source: "WhatsApp" }).source, "WhatsApp", "a source survives verbatim");
  assert.equal(parseScreeningFilters({ source: "  Email  " }).source, "Email", "a source is trimmed, not mangled");
  assert.equal(parseScreeningFilters({ source: "" }).source, null, "an empty source narrows nothing");

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
  // An unrecognised status is IGNORED, never guessed at and never thrown on — it opens the default
  // tab, like a link with no status at all. A screening link that 500s because somebody edited the
  // address bar is a worse outcome than one showing the undecided CVs.
  assert.equal(parseScreeningFilters({ status: "banana" }).status, "new", "an unknown status opens Not decided yet");
  assert.equal(parseScreeningFilters({ status: "" }).status, "new", "and so does an empty one");
  assert.equal(parseScreeningFilters({ status: "all" }).status, null, "status=all is the All tab");
  assert.equal(parseScreeningFilters({ status: "ALL" }).status, null, "in any case");
  // The retired `decided=1` asked a WhatsApp pile to keep its decided CVs. Such a link opens on All,
  // the tab that keeps them, rather than quietly hiding what it was saved to show.
  assert.equal(parseScreeningFilters({ decided: "1" }).status, null, "an old decided=1 link opens on All");
  assert.equal(parseScreeningFilters({ decided: "1", status: "hired" }).status, "hired", "a status it also names wins");
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
  // Fixed instant every "how recently" assertion below is measured against — the same role the
  // server's own `Date.now()` stamp plays in loadScreeningQueue, just pinned so the test never flakes.
  const asOf = Date.parse("2026-08-30T12:00:00.000Z");
  const rep: ScreeningFilterCandidateRow = {
    // Title only in the CV reader's hedged answer, never in the column. Reading `currentJobTitle`
    // alone classifies this person as nothing at all.
    createdAt: "2026-08-30T11:30:00.000Z", // 30 minutes before asOf
    cvUnconfirmed: { currentJobTitle: "Medical Representative", governorate: "Tanta" },
    fullName: "Fixture Rep",
    id: "rep",
    preferredAreaName: "Gharbia 1 (Tanta)",
    source: "whatsapp",
    status: "new",
  };
  const managerAbroad: ScreeningFilterCandidateRow = {
    createdAt: "2026-08-30T07:00:00.000Z", // 5 hours before asOf
    currentJobTitle: "District Sales Manager",
    fullName: "Fixture Manager",
    governorate: "Dubai",
    id: "manager",
    managerNotified: { sentAt: "2026-08-29T09:00:00.000Z" },
    status: "shortlisted",
  };
  // Nothing on file at all: no title, no governorate, no declared area. All three unknown buckets.
  const blank: ScreeningFilterCandidateRow = {
    createdAt: "2026-08-27T12:00:00.000Z", // 3 days before asOf
    fullName: "Fixture Blank",
    id: "blank",
    status: "new",
  };
  // The role comes only off what they ASKED for — the last rung of the ladder the row displays.
  const applicant: ScreeningFilterCandidateRow = {
    appliedForJobTitle: "Medical Rep",
    createdAt: "2026-08-10T12:00:00.000Z", // 20 days before asOf
    fullName: "Fixture Applicant",
    governorate: "Gharbia",
    id: "applicant",
    preferredAreaName: "gharbia 1 (tanta)",
    sourceContext: { channel: "email", detailLines: [], shortLabel: "Subject: CV" },
    status: "new",
  };
  const everyone = [rep, managerAbroad, blank, applicant];

  // On the "All" tab unless the query names a status, so each filter below is tested on its own.
  const keeps = (query: Parameters<typeof parseScreeningFilters>[0], seenIds: string[] = []) =>
    everyone
      .filter((candidate) =>
        matchesScreeningNarrowing(candidate, parseScreeningFilters({ status: "all", ...query }), {
          asOf,
          seenByViewer: seenIds.includes(candidate.id),
        }),
      )
      .map((candidate) => candidate.id);

  assert.deepEqual(keeps({}), ["rep", "manager", "blank", "applicant"], "the All tab keeps everyone");
  // The tabs themselves: a bare link is "Not decided yet", which leaves out the shortlisted manager.
  assert.deepEqual(
    everyone
      .filter((candidate) => matchesScreeningNarrowing(candidate, parseScreeningFilters({}), { asOf, seenByViewer: false }))
      .map((candidate) => candidate.id),
    ["rep", "blank", "applicant"],
    "a bare link opens on Not decided yet",
  );
  assert.deepEqual(keeps({ status: "shortlisted" }), ["manager"], "and the Shortlisted tab holds only him");

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

  // Sent to a manager — a plain presence check on `managerNotified`, added 2026-08-31.
  assert.deepEqual(keeps({ sent: "1" }), ["manager"], "sent keeps only the one CV actually pushed to a manager");
  assert.deepEqual(
    keeps({ unsent: "1" }),
    ["rep", "blank", "applicant"],
    "unsent keeps everyone never pushed to a manager",
  );
  assert.deepEqual(keeps({}), ["rep", "manager", "blank", "applicant"], "neither half of sent/unsent excludes anyone");

  // Received — a rolling window off `createdAt`, measured against the fixed `asOf` above. Each
  // fixture sits in exactly one more window than the last, so widening the window picks up exactly
  // one more person at a time.
  assert.deepEqual(keeps({ received: "hour" }), ["rep"], "only the CV from 30 minutes ago is within the last hour");
  assert.deepEqual(keeps({ received: "day" }), ["rep", "manager"], "5 hours ago is within the last day too");
  assert.deepEqual(keeps({ received: "week" }), ["rep", "manager", "blank"], "3 days ago is within the last week");
  assert.deepEqual(
    keeps({ received: "month" }),
    ["rep", "manager", "blank", "applicant"],
    "20 days ago is within the last month, and nothing here is older than that",
  );
  assert.deepEqual(
    keeps({ received: "banana" }),
    ["rep", "manager", "blank", "applicant"],
    "an unrecognised window is ignored, same as an unrecognised role or region",
  );

  // Source — resolved through the SAME channel badge the pool's own Source column reads, never the
  // raw column alone, for the reason this file's header already gives for role/region/area: a NULL
  // `source` column still resolves to "Manual".
  assert.deepEqual(keeps({ source: "WhatsApp" }), ["rep"], "the WhatsApp arrival is found by its resolved badge");
  assert.deepEqual(keeps({ source: "whatsapp" }), ["rep"], "source matching is case-blind, like area");
  assert.deepEqual(
    keeps({ source: "Manual" }),
    ["manager", "blank"],
    "a NULL source column resolves to Manual, not to nothing",
  );
  assert.deepEqual(keeps({ source: "Email" }), ["applicant"], "sourceContext alone is enough when the column is NULL");
  assert.deepEqual(keeps({ source: "Referral" }), [], "a source nobody arrived through is empty, not everybody");

  // And the new filters compose with the old ones, same as every filter on this bar.
  assert.deepEqual(
    keeps({ received: "day", source: "WhatsApp", unseen: "1" }),
    ["rep"],
    "received, source and unseen all narrow together",
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

  // The Source dropdown offers the resolved badges this pool actually has, sorted the way a reader
  // scans them — never a raw column value, for the same reason the area list reads the resolved fact.
  assert.deepEqual(
    screeningSourceOptions(everyone),
    ["Email", "Manual", "WhatsApp"],
    "every channel actually present, alphabetised",
  );
  assert.deepEqual(
    screeningSourceOptions([blank]),
    ["Manual"],
    "a candidate with no source column and no source context still offers Manual",
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
  // rather than by forwarding the raw query, so an edited address bar cannot ride the redirect. The
  // open CV rides with them since 2026-09-18: a CV pressed in the list opens on its own page, and a
  // link to that page bounced through here would otherwise land on the whole list instead.
  assert.match(
    portalPage,
    /redirect\(\s*screeningHref\("\/recruitment", \{\s*\.\.\.parseScreeningFilters\(filters\),\s*candidate: parseOpenCandidateId\(filters\.candidate\),\s*\}\),\s*\)/,
    "the shell redirect must carry the filters and the open CV, or every filtered link is dead for HR Advisory",
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
    // THIS ONE IS LIVE, AND IT LOOKS DEAD — do not "simplify" it away. `recruitment` and
    // `candidates` share one hard boundary and one HR function, so no ROLE holds the first without
    // the second, and production carries a single role_permission_overrides row that touches
    // neither. Read only those two and this gate is unreachable; an audit reached exactly that
    // conclusion on 2026-09-05 and was wrong.
    //
    // `canAccess` has a THIRD gate: a per-account module lock, checked per RESOURCE
    // (auth/module-locks.ts). A lock on `candidates` alone leaves `recruitment: read` true, so the
    // caller clears the gate above and lands in this fallback. Not hypothetical — hr-009 had
    // `payroll`, `payslips` and `deductions` locked over 30 Aug – 3 Sep 2026.
    assert.match(
      source,
      /canAccess\(access, "candidates", "read"\)/,
      `the ${name} screening page must require the candidate read grant before loading a CV`,
    );
    // Re-cut 2026-08-27. This used to require the call to END after `filters`, which stopped being
    // the shape when the loader grew a third argument for the manager list. The PROPERTY is
    // unchanged and is the only thing that matters — the viewer id is the caller's, never a URL
    // parameter — so the pin asserts the first two arguments and stops counting the rest.
    //
    // Re-cut again 2026-09-04, when the page moved from `loadScreeningQueue` to
    // `loadScreeningWorkspace` for the review workstation. The LOADER changed; the property this
    // line exists to hold did not. "Have I read this CV" is a question about the person asking it,
    // so a viewer id arriving from a URL would let one person open a link that reports somebody
    // else's reading as their own.
    assert.match(
      source,
      /loadScreeningWorkspace\(access\.hrId, filters[,)]/,
      `the ${name} screening page must load the view history of the CALLER, not of a URL parameter`,
    );
    // Sending a CV is `recruitment: update` — the grant the send route itself enforces — and so is
    // writing a note, which the notes route enforces on POST. Both pages must decide this, because
    // the loader cannot: only a page holds the AccessContext. Asserted as the two halves it is now
    // written in, so neither the grant nor the wiring can drift on its own.
    assert.match(
      source,
      /const canUpdate = await canAccess\(access, "recruitment", "update"\)/,
      `the ${name} screening page must read the same grant the send and note routes require`,
    );
    assert.match(
      source,
      /canSendToManagers: canUpdate/,
      `the ${name} screening page must gate the manager picker on that grant, not on something looser`,
    );
    assert.match(
      source,
      /canWriteNotes=\{canUpdate\}/,
      `the ${name} screening page must gate the note box on that same grant`,
    );
    // The filter bar is only as good as what reaches it, and the two pages are kept in sync BY
    // HAND — so a filter added to one and forgotten on the other is the exact failure this pair of
    // files keeps producing. Every narrowing the loader resolved has to be handed over on both, or
    // the control renders blank on the shell nobody was looking at.
    for (const prop of [
      "area",
      "areaOptions",
      "notified",
      "received",
      "region",
      "role",
      "seen",
      "source",
      "sourceOptions",
      "status",
    ]) {
      assert.match(
        source,
        new RegExp(`${prop}=\\{workspace\\.${prop}\\}`),
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
    /screeningHref\(screeningBasePath, \{ seen: "unseen", status: statusFilterForDecisionTab\(decisionTab\) \}\)/,
    "the pool must link to the screening page, opening on the unread pile of the tab the pool is on",
  );
  assert.match(
    workspaceSource,
    /poolPathname\?\.startsWith\("\/employee-portals"\)/,
    "the screening link must resolve to the shell the caller is actually in",
  );

  // The overlay button survives alongside it on purpose: it carries every filter on the toolbar
  // exactly, which a URL cannot, while the link is bookmarkable. Losing either is a regression.
  assert.match(workspaceSource, /setScreeningQueue\(inDecisionTab\)/, "the in-place screening button must remain");
  // It hands over the decision tab's pile BEFORE the red split, and that argument IS the assertion —
  // not a detail. The queue owns its own Active/Red tabs, so passing the already-split list would give
  // it a Red-flagged tab that read zero however many red CVs the toolbar had actually turned up; and
  // passing the whole filtered pool would screen the decided CVs the tab strip had just put away.
  // This pin read `visibleCandidates` until the split was built, then `filteredCandidates` until the
  // decision tabs (2026-09-18); both renames are deliberate.
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
  // ── THE FILTER BAR HAS TWO HOMES, AND A FIX TO ONE IS HALF A FIX ───────────────────────
  //
  // `ScreeningFilterBar` is drawn by this page AND by the workstation, and both push a URL and wait
  // seconds for the server. Reported 2026-09-12 as "the filters are not working": the `<select>` is
  // controlled by the value the server last sent, so it snapped back to its old value the instant it
  // was clicked. The workstation was fixed first and this caller was found only because `pending`
  // became a required prop and the types went red — which is luck, not a guard. `shown.*` is not
  // load-bearing to the compiler, so it is pinned here.
  const poolScreen = read("src/components/recruitment/screening-page-client.tsx");
  assert.match(
    poolScreen,
    /const \[shown, showImmediately\] = useOptimistic\(/,
    "this screen's dropdowns must show what was just picked, not what the server last answered",
  );
  assert.match(
    poolScreen,
    /startTransition\(\(\) => \{\s+showImmediately\(next\);\s+router\.push\(href\);\s+\}\)/,
    "and inside the same transition as the navigation, or React drops it on the next render",
  );
  assert.match(
    poolScreen,
    /<ScreeningFilterBar\s+area=\{shown\.area\}/,
    "and the bar has to be handed those optimistic values, not the server's own props",
  );

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
  // The allowlist is four VOCABULARIES, and it is an allowlist rather than a count for a reason:
  // the Role and Region filters added 2026-08-30 need the same lists of role families and region
  // codes the pool's own filters use, and re-declaring either here would be two copies of a
  // vocabulary that drifts in one. Each of the three is verified below to import NOTHING itself, so
  // the chain this file exists to keep short stays exactly one link long. Anything else added here
  // must pass that same check first.
  const linkImports = [...linkSource.matchAll(/^import[\s\S]*?from "([^"]+)";$/gm)].map((match) => match[1]);
  const allowedLinkImports = [
    // The star ladder, added 2026-09-12 with the Stars filter. It passes the same test as the other
    // three below: candidate-rating.ts is numbers, labels and two type guards, and imports nothing.
    "@/lib/recruitment/candidate-rating",
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
  // Pinned on screening-workspace.ts, the loader the page actually calls. It named screening-queue.ts
  // until 2026-09-05, which had had no callers since the workstation shipped — so "the loader uses
  // the shared rule" was being proved about a file nothing ran.
  assert.match(
    read("src/lib/recruitment/screening-workspace.ts"),
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
      /hiringManagers=\{workspace\.hiringManagers\}/,
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
  // blurry one and silently change the modal, where the document already fitted. The arithmetic moved
  // to `cv-fit-zoom.ts` on 2026-10-20, when the workspace's half-page CV began fitting page 1 DOWN as
  // well as across; the cap at 1 is the same rule, and the viewer must fit through that one function.
  const fitZoom = read("src/components/recruitment/cv-fit-zoom.ts");
  assert.match(
    fitZoom,
    /return clampZoom\(Math\.min\(1, across, down\)\);/,
    "fitting must never enlarge a document on its own — that is what the + button is for",
  );
  assert.match(viewer, /\bcvFitZoom\(\{/, "the viewer fits through cvFitZoom, never a second copy of the arithmetic");
  // The PAGE element, not the container's scrollWidth. scrollWidth is the wrong number here and
  // misleadingly close to the right one: measured live, an 816px page in a 637px pane reported 727.
  // `.cv-text-page` joined the list on 2026-09-27: a Word 97-2003 .doc read as text is dressed at the
  // same fixed 816px width, so it must be fitted by this same pass or it overflows its column.
  assert.match(
    viewer,
    /querySelectorAll<HTMLElement>\("\.docx, \.cv-text-page, canvas"\)/,
    "the width must be measured from the rendered page, never inferred from the scroll box",
  );

  // And the cause, not only the symptom: the page can borrow the overlay's full width on demand.
  assert.match(session, /const fullBleed = variant === "overlay" \|\| expanded;/, "the page must be able to go full-bleed");

  // ── 8 · A send is read from the TRAIL, not from the overwritten column ─────
  //
  // `manager_notified_*` on the candidate row is the pre-2026-08-30 single-manager record: the next
  // send overwrites it. Production carries rows where it disagrees with ats_candidate_manager_sends
  // outright — a CV sent to Saad Salama on 31 Aug 2026 whose candidate columns are both NULL, so the
  // Manager-feedback pile that exists to chase it could not see it at all, five days on; and one
  // sent to Ali Moh Ali on 30 Aug and re-sent to Dr Anwar Gaweesh on 1 Sep, where the row still
  // names the first. `listCandidatesSentToManager` has unioned both sources since the table shipped,
  // for exactly this reason; the screening loader had not.
  assert.equal(isAfter("2026-09-01T10:20:57.147+00:00", "2026-08-29T22:42:45.734+00:00"), true, "a later send wins");
  assert.equal(isAfter("2026-08-29T22:42:45.734+00:00", "2026-09-01T10:20:57.147+00:00"), false, "an earlier send does not");
  // The live NULL-column case: with nothing on the row, any recorded send is the newer fact.
  assert.equal(isAfter("2026-08-30T21:15:02.093+00:00", null), true, "a send beats an absent stamp");
  // Equal stamps are the ordinary case — the same send recorded in both places. It must NOT flip,
  // or every load would rewrite the stamp with an identical one and the comparison would be noise.
  assert.equal(isAfter("2026-08-30T21:15:02.093+00:00", "2026-08-30T21:15:02.093+00:00"), false, "the same send is not newer than itself");
  // Compared as INSTANTS. A plain `timestamp` renders with no offset, and on a STRING compare
  // "2026-09-01T10:20:57.147" sorts BELOW "2026-08-29T22:42:45.734+00:00" — picking the older send
  // as the newer one, silently, which is the whole bug in a different disguise.
  assert.equal(isAfter("2026-09-01T10:20:57.147", "2026-08-29T22:42:45.734+00:00"), true, "the compare must be by instant, not by string order");
  assert.equal(isAfter("not a date", "2026-08-29T22:42:45.734+00:00"), false, "an unreadable stamp never wins");

  // ── THE OVERLAY LIVES IN listCandidates, FOR EVERY SCREEN ─────────────────
  //
  // It was in the screening loader alone, so the candidate pool — which reads the same
  // listCandidates — answered "was this sent, and to whom" from the old column while this page
  // answered from the trail. One pool, two truths, and nothing on either screen to say which was
  // right. Moved 2026-09-05 to the one place both go through.
  const workspace = read("src/lib/recruitment/screening-workspace.ts");
  const candidatesLoader = read("src/lib/recruitment/candidates.ts");
  const overlayAt = candidatesLoader.indexOf("latestSends.get(candidate.id)");
  assert.ok(overlayAt >= 0, "listCandidates must overlay the send trail for every caller");
  // And exactly ONE copy of it. A second overlay in the page loader is how the two screens drifted
  // apart in the first place.
  assert.ok(
    !workspace.includes("latestSends.get(candidate.id)"),
    "the screening loader must not keep a second copy of the overlay — listCandidates owns it",
  );

  // THE SEAT MOVES ONLY WHEN THE NEWER SEND HAS ONE, and the guard is the whole assertion.
  //
  // This pinned the UNGUARDED `candidate.sentFor = stamp.sentFor`, on the argument that carrying an
  // old position onto a newer send files it under a folder nobody chose. True when the new send
  // names a seat; the reverse when it names none — and 24 of the 72 sends in production carry no
  // position, so for those the assignment did not move the seat, it ERASED one, taking the row's
  // "sent for" label and its vacancy attribution with it.
  //
  // `hiring-manager-notify.ts` is the authority: `position = input.position ? {…} : {}`, so a
  // position-less send omits the sent_for_* columns and the previous ones STAND. Without this guard
  // the loader contradicts the row it is reading.
  //
  // Only WHITESPACE may precede it. An earlier cut of this pin was a bare match, so commenting the
  // line out left it green — it was pinning the words, not the statement.
  assert.match(
    candidatesLoader,
    /\n[ \t]*if \(stamp\.sentFor\) candidate\.sentFor = stamp\.sentFor;/,
    "a newer send with NO position must not erase the seat an earlier one recorded",
  );

  // ── 9 · The pool read leaves the repeating CV blocks behind ────────────────
  //
  // Measured on production 2026-09-05: `select("*")` over 744 candidates moves 2,053 kB, of which
  // 1,221 kB (59.4%) is position_specific_fields — read by nothing in this page's derive chain. The
  // workstation already refused to ship that column to the browser; this is the same refusal one hop
  // earlier, on the read that crosses from Frankfurt to Amsterdam.
  const candidatesSource = read("src/lib/recruitment/candidates.ts");
  const declared = candidatesSource
    .slice(candidatesSource.indexOf("CANDIDATE_COLUMNS_WITHOUT_REPEATING_BLOCKS ="))
    .split(";")[0];
  // The chunks are JOINED first and split once, which reproduces the runtime string exactly rather
  // than approximating it. That order matters: a chunk missing its trailing comma would glue two
  // column names into one nonexistent column, and splitting per chunk would hide it.
  const declaredColumns = [...declared.matchAll(/"([^"]+)"/g)]
    .map((match) => match[1])
    .join("")
    .split(",");

  // Re-derived from mapCandidate's OWN source, so the two cannot drift. The failure this guards is
  // silent: a column added by a later migration and mapped in db.ts but missing from the list does
  // not error — mapCandidate reads `undefined`, maps it to null, and the field is quietly blank on
  // every screen fed by the slim read.
  const dbSource = read("src/lib/recruitment/db.ts");
  const mapCandidateBody = dbSource.slice(
    dbSource.indexOf("export function mapCandidate"),
    dbSource.indexOf("export function mapApplication"),
  );
  const mapped = [...mapCandidateBody.matchAll(/row\.([a-z0-9_]+)/g)].map((match) => match[1]);
  const expected = [...new Set(mapped)].filter((column) => column !== "position_specific_fields").sort();

  assert.deepEqual(
    [...new Set(declaredColumns)].sort(),
    expected,
    "the slim column list must name every column mapCandidate reads, except the repeating blocks",
  );
  assert.ok(
    !declaredColumns.includes("position_specific_fields"),
    "the one column the slim read exists to omit must not be in it",
  );
  // Opt-IN, both ways round: the default read is unchanged for every caller that renders those
  // blocks, and the screening loader is the one that asks to go without them.
  assert.match(
    candidatesSource,
    /options\.withRepeatingCvBlocks === false \? CANDIDATE_COLUMNS_WITHOUT_REPEATING_BLOCKS : "\*"/,
    "omitting the blocks must be opt-in — a caller that renders them must keep select(*)",
  );
  assert.match(
    workspace,
    /listCandidates\(\{ withRepeatingCvBlocks: false \}\)/,
    "the screening loader must be the caller that opts out",
  );

  // ── 10 · "Have I read this" survives the pool passing 1000 ────────────────
  //
  // The view map was one unbounded `.select()`, on the argument that a viewer's history is bounded
  // by the pool — true at 434 candidates, and the pool passed 700 on 2026-09-03 at roughly 90 CVs a
  // day. PostgREST caps a request at 1000 rows and says nothing: no error, no marker, just the
  // oldest CVs this person has already read coming back as unread. `?unseen=1` — the bookmarked
  // link — would fill up with CVs the owner read weeks earlier, which is the exact complaint the
  // module was written to end.
  const views = read("src/lib/recruitment/candidate-views.ts");
  assert.match(views, /\.range\(from, from \+ VIEW_PAGE_SIZE - 1\)/, "the view history must page");
  // An explicit, unique order. `.range()` without one is served in whatever order the planner chose
  // for THAT request, so page two can repeat page one's rows and omit others — paging over an
  // unordered read loses rows without erroring, the same silent shape as the cap itself.
  assert.match(views, /\.order\("candidate_id", \{ ascending: true \}\)/, "paging needs a stable order or it loses rows");
  assert.match(
    views,
    /Refusing to report read CVs as unread/,
    "past the guard it must throw, not return a short map — a truncated view map is the bug, not a degradation",
  );

  // ── 11 · Square corners, the owner's 2026-09-04 rule ──────────────────────
  //
  // No round or semi-round corners anywhere: cards, buttons, tags, inputs, bars, avatars, badges.
  // Pinned rather than eyeballed because a 4px radius is invisible in a screenshot and survives
  // review — the rule's own instruction is to count computed radii, never to look.
  //
  // (The permission fallbacks these pages carry are asserted further up, in the both-shells loop,
  // where the comment records why the candidates gate is reachable despite looking dead.)
  for (const shell of [
    "app/(admin)/recruitment/screening/page.tsx",
    "app/employee-portals/recruitment/screening/page.tsx",
  ]) {
    assert.doesNotMatch(read(shell), /\brounded[a-z0-9-]*/, `${shell} must have no rounded corners`);
  }

  // The filter bar this page renders is the other half of that rule. It was squared on 2026-09-05:
  // `rounded-md` had been added to the eight selects, the bar, the count pill and the Clear button on
  // 2026-08-31 to match the candidate pool's toolbar — four days before the rule landed — leaving one
  // screen rendering a rounded bar on top of square panes. Comments may still say the word; classes
  // may not.
  const filterBar = read("src/components/recruitment/screening-page-client.tsx").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(
    filterBar,
    /\brounded[a-z0-9-]*/,
    "the screening filter bar must be square — tokens.css defaults to 4px, so copying a sibling reintroduces this silently",
  );

  // ── 12 · One batch size, in one place ─────────────────────────────────────
  //
  // Both comment reads spelled their own `index += 50` while db-batch.ts already owned the number
  // and the reasoning behind it (100: ~3.8KB of ids, inside undici's ~16KB header cap). Half the
  // size is twice the round trips, and the screening loader calls the summariser with the WHOLE
  // pool before filtering — 15 sequential crossings to eu-central-1 to read a table holding 8 rows.
  const comments = read("src/lib/recruitment/candidate-comments.ts");
  // BOTH reads, counted. `assert.match` is satisfied by ONE occurrence, so with two batching loops
  // in this file it stays green while half the fix is reverted — proved by breaking exactly that.
  assert.equal(
    [...comments.matchAll(/for \(const batch of chunkIds\(ids\)\)/g)].length,
    2,
    "both comment reads must batch through chunkIds — the counter and the summariser",
  );
  assert.doesNotMatch(
    comments,
    /index \+= \d+/,
    "a hand-rolled batch size is a second copy of a number that already has an owner in db-batch.ts",
  );

  // ── 13 · A second press must not notify the manager twice ─────────────────
  //
  // The only guard was `busy`, which goes false the moment the last request returns, and nothing
  // cleared the picker — so the panel came back enabled with the same managers still selected. A
  // second click was a second REAL notification: candidateAlertIdempotencyKey is built from the send
  // timestamp, so it does not dedupe, and a manager was told twice about one CV.
  //
  // Guarded per (candidate, manager) rather than by clearing the picker, because the picker keeping
  // its selection across candidates IS the batch workflow — screening a pile for one seat. Clearing
  // it would have fixed the double press by breaking that.
  const workstation = read("src/components/recruitment/workstation/screening-workstation.tsx");
  // SCOPED TO THE SEND PATH, not to the whole file.
  //
  // These three offsets are compared against each other, so all three must be measured inside the
  // one function whose ordering is being pinned. Read with a bare `indexOf` over the file they are
  // not: `if (!res.ok) throw new Error(data.message` now appears FOUR times in this component — the
  // bulk decision, the undo, the send and the seen-marker — and `indexOf` returns whichever sits
  // highest in the file. Adding the bulk-decision handler above the send on 2026-09-05 therefore
  // pointed `confirmAt` at a completely unrelated function and failed this assertion while the send
  // path was untouched and still correctly ordered.
  //
  // The window starts at the `sentPairs` ref, which is declared immediately above the send and is
  // unique in the file, so everything measured below belongs to the send.
  const sendRegionAt = workstation.indexOf("const sentPairs = useRef<");
  assert.ok(
    sendRegionAt >= 0,
    "the send path must still be anchored by the sentPairs ref — without it the three offsets below " +
      "are measured against the whole file again and stop meaning anything",
  );
  const sendRegion = workstation.slice(sendRegionAt);
  const guardAt = sendRegion.indexOf("sentPairs.current.has(");
  const recordAt = sendRegion.indexOf("sentPairs.current.add(");
  const confirmAt = sendRegion.indexOf("if (!res.ok) throw new Error(data.message");
  assert.ok(guardAt >= 0, "the send must skip managers this CV already reached in this session");
  assert.ok(recordAt >= 0, "a confirmed send must be recorded so the next press can see it");
  assert.ok(confirmAt >= 0, "the send must still check res.ok before believing it succeeded");
  // RECORDED ONLY AFTER THE RESPONSE IS BELIEVED. Marking the pair before the ok-check would turn
  // one network blip into a CV that can never be sent to that manager again without a reload.
  assert.ok(
    confirmAt < recordAt,
    "the pair must be recorded AFTER the response is confirmed, so a failed send stays retryable",
  );
  // The guard runs before any request goes out, not inside the loop.
  assert.ok(guardAt < confirmAt, "the already-sent check must run before the first request");

  // ── 14 · The dead loader is gone, and its pins moved to the live one ──────
  //
  // screening-queue.ts had no callers from the day the workstation shipped (2026-09-04), but two
  // invariants were still pinned ON it — including "the loader must judge seen-ness from the
  // caller's own view map", which is a PRIVACY property. screening-workspace.ts carried the
  // identical line and nothing tested it, so the guarantee was being proved about a file that never
  // ran. Deleted 2026-09-05; both pins now name the loader the page actually calls.
  assert.ok(
    !existsSync(path.join(process.cwd(), "src/lib/recruitment/screening-queue.ts")),
    "screening-queue.ts is the dead loader — do not bring it back; screening-workspace.ts is the live one",
  );

  // ── 15 · A selection that has dropped out of the list is not a selection ───
  //
  // `selected` searched `rows` — the whole server-filtered pool — so a candidate the CLIENT
  // narrowing had hidden stayed "selected": the list rendered its empty state while the pane beside
  // it showed a person, with a live Shortlist / Reject / Send header for somebody not in the pile
  // being looked at. `queue` defaults to "new" and the correcting effect deliberately bails on an
  // empty list, so "Interviews today" — 0 in production, and structurally 0 while no interview
  // carries a scheduled_at — reproduced it in one click.
  //
  // Only the DERIVED value changed. `selectedId` is still remembered, so switching to an empty pile
  // blanks the pane and switching back restores the same CV.
  assert.match(
    workstation,
    /const selected = useMemo\(\s*\(\) => visible\.find\(\(row\) => row\.id === selectedId\)/,
    "the selection must come from the VISIBLE list, not from every row the server sent",
  );
  // And the two writes must go through it. Reading `selectedId` directly is what let a decision land
  // on a candidate the list in front of the reader was not showing.
  for (const [handler, marker] of [
    ["decide", "      // `selected`, not `selectedId`: a decision must never land on a candidate the list in front of"],
    ["send", "    // Same rule as `decide`: never send a CV the visible list is not showing."],
  ] as const) {
    const at = workstation.indexOf(marker);
    assert.ok(at >= 0, `${handler} must resolve its target from the visible selection`);
    // The shadowing const is what makes it safe: every line inside the handler then refers to the
    // visible selection, so a missed rename cannot silently reach the outer remembered id.
    assert.match(
      workstation.slice(at, at + 400),
      /const selectedId = selected\?\.id;/,
      `${handler} must take its id from \`selected\`, so it cannot act on a hidden candidate`,
    );
  }

  // ── 16 · The verdict buttons are SQUARE ─────────────────────────────────
  //
  // The square-edge golden rule: no round or semi-round corners, anywhere. Shortlist and Reject
  // carried `rounded-md` from the day the overlay shipped.
  //
  // WHY A SOURCE PIN IS WORTH HAVING EVEN THOUGH THE SHELLS ALREADY WIN. Both hosts wrap this
  // overlay in a shell whose stylesheet zeroes the radius of anything matching `[class*="rounded"]`
  // with `!important` (globals.css RULE 1, twice: `.admin-shell` and `.employee-portal-shell`), so
  // the corners were already square ON SCREEN. That is exactly what makes the class dangerous
  // rather than harmless: it reads as an intended radius to everyone who opens the file, it is
  // invisible to any audit done by looking at the rendered page, and it is one un-shelled ancestor
  // away from becoming real. A radius that only a stylesheet sweep is holding down is a radius.
  //
  // Pinned at the SOURCE for that reason -- the emitted-artifact rule says check what renders, and
  // what renders here is square either way. The thing being defended is the class not coming back.
  // 🔴 ANCHORED ON THE TOKEN, NOT THE COLOUR, SINCE 2026-10-07. The owner asked for an
  // approve-green button token and then for it to go on every decision pair, so these two buttons
  // no longer name `bg-emerald-600`/`bg-rose-600` themselves -- they wear
  // `phxButtonApproveClassName` and `phxButtonDangerClassName`. The square pin did not weaken: the
  // tokens are themselves asserted to carry no radius by `tests/form-design-system.test.ts`
  // (`identityTests`), and what is checked HERE is the only part that can still go wrong locally,
  // which is a radius added in the per-call override beside the token.
  for (const [label, anchor] of [
    ["Shortlist", "phxButtonApproveClassName"],
    ["Reject", "phxButtonDangerClassName"],
  ] as const) {
    // The FIRST occurrence is the import, so walk the occurrences and take the one that is
    // actually inside a className -- anchoring on the import would pass with no button at all.
    let at = -1;
    let start = -1;
    for (let from = session.indexOf(anchor); from >= 0; from = session.indexOf(anchor, from + 1)) {
      const open = session.lastIndexOf("className=", from);
      if (open >= 0 && from - open < 200) {
        at = from;
        start = open;
        break;
      }
    }
    assert.ok(
      at >= 0,
      `the ${label} button must still wear ${anchor} in its own className -- if it has gone back ` +
        `to a hand-written colour, form-design-system.test.ts section 6 fails first`,
    );
    const classExpression = session.slice(start, session.indexOf("}", at) + 1);
    assert.ok(
      !classExpression.includes("rounded"),
      `${label} must have no rounded-* class -- the square-edge golden rule, and a shell sweep ` +
        `holding a corner down is not the same as the corner not being there`,
    );
  }

  // AND THE WHOLE FILE, not just the two buttons the owner named. He asked for Shortlist and Reject,
  // saw the rest listed, and said "do the rest of the file too" -- so the screen is square in its
  // source as well as on screen, and this assertion is what keeps it that way. It is deliberately a
  // plain substring search for the Tailwind prefix: a corner comes back as `rounded-md` on a pasted
  // block far more often than it comes back as a hand-written radius.
  //
  // THE ONE EXEMPTION IF THIS EVER FIRES FAIRLY: `[&::-webkit-scrollbar-thumb]:rounded-full`. That
  // utility contains the substring "rounded" but aims it at a scrollbar pseudo-element, whose
  // corners were never what the golden rule is about. There is none in this file today. Add the
  // exemption narrowly if one ever arrives -- do not widen this check into uselessness.
  const roundedInSession = [...session.matchAll(/\brounded(?:-[a-z0-9]+)?\b/g)].map((hit) => hit[0]);
  assert.deepEqual(
    roundedInSession,
    [],
    `the screening overlay must carry no rounded-* class at all -- the square-edge golden rule. ` +
      `Found: ${roundedInSession.join(", ")}`,
  );

  // ── The stat strip fits the screen, because `shrink-0` is not on it ───────
  //
  // MEASURED ON PRODUCTION, 2026-09-18, at 375px: main reported scrollWidth 480 against clientWidth
  // 375, and the one element past the right edge was WorkHeader's figures strip -- 464px wide,
  // right edge at 480, holding "1079 in the pool / 868 you have not opened / +189 this week".
  // It carried `flex-wrap`, so it looked like it should have wrapped. It could not: `shrink-0` pins
  // a flex item at its own content width, so the strip was never made narrow enough to need a
  // second line and pushed the page sideways instead. That is the failure the fits-the-screen
  // golden rule names in as many words -- `shrink-0` makes an inner `flex-wrap` inert.
  //
  // Removing it cost nothing above the fold, measured the same day at 1440px with and without:
  // 371px wide, 13px tall, left edge 1043 -- byte-identical, because `flex-shrink` does nothing
  // until there is no room. Afterwards main read 375 of 375 on the phone.
  //
  // WHY THIS IS A SOURCE PIN AND NOT A MEASUREMENT. The real check is scrollWidth > clientWidth in a
  // browser at 375px, and this suite has no browser. So it pins the CAUSE instead of the symptom,
  // which is only worth anything because the cause was measured rather than guessed: the class that
  // did it is named, and the two classes that do the wrapping are required to stay.
  const workHeader = read("src/components/recruitment/workstation/workstation-look.tsx");
  const figuresStrip = /<div className="(flex[^"]*)">\{figures\}<\/div>/.exec(workHeader);
  assert.ok(figuresStrip, "WorkHeader must still render its figures in one classed flex strip");
  const stripClasses = figuresStrip[1].split(/\s+/);

  assert.ok(
    !stripClasses.includes("shrink-0"),
    "the figures strip must carry NO shrink-0 -- it pinned the strip at 464px inside a 375px " +
      "viewport and scrolled the screening page sideways. Classes found: " + figuresStrip[1],
  );
  // The two that do the work. Dropping either brings the overflow straight back: without
  // `flex-wrap` there is no second line to wrap onto, and without `min-w-0` the strip cannot be
  // sized below the min-content width of its own line, which is the same 464px floor by another
  // route.
  for (const required of ["flex-wrap", "min-w-0"] as const) {
    assert.ok(
      stripClasses.includes(required),
      "the figures strip must keep " + required + " -- it is what lets three figures become two " +
        "lines on a phone instead of one line wider than the phone. Classes found: " + figuresStrip[1],
    );
  }

  // AND THE GENERAL FORM, so the same mistake cannot land on a sibling of that strip. Any element in
  // this file that asks to wrap and refuses to shrink is the identical bug wearing a different name.
  const inertWraps = [...workHeader.matchAll(/className="([^"]*\bflex-wrap\b[^"]*)"/g)]
    .map((hit) => hit[1])
    .filter((classes) => classes.split(/\s+/).includes("shrink-0"));
  assert.deepEqual(
    inertWraps,
    [],
    "no element in workstation-look.tsx may pair flex-wrap with shrink-0 -- the wrap is inert and " +
      "the page scrolls sideways. Found: " + inertWraps.join(" | "),
  );
}
