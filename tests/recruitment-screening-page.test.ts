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
  assert.equal(
    screeningHref("/recruitment", { unseenOnly: true }),
    "/recruitment/screening?unseen=1",
    "the link the owner asked for: open straight into what has never been read",
  );
  assert.equal(
    screeningHref("/employee-portals/recruitment", { unseenOnly: true }),
    "/employee-portals/recruitment/screening?unseen=1",
    "the portal twin's link, which is what HR Advisory must get",
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
  }

  // ── 4 · The pool still links to it ────────────────────────────────────────
  //
  // A route nobody can find is the same as no route. The pool's link is shell-aware for the reason
  // in section 3: a hard-coded /recruitment/screening in the portal bounces HR Advisory out.
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
