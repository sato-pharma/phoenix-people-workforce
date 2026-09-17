import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  parseOpenCandidateId,
  parseScreeningFilters,
  screeningHref,
} from "../src/lib/recruitment/screening-link.ts";

/**
 * A CV YOU ARE READING MUST HAVE AN ADDRESS, AND A ROW MUST BE OPENABLE IN ITS OWN TAB.
 *
 * The owner's report, 2026-09-18, in his own words: "when i view cv and pushed to the end of the
 * screen and i really hustle to go back where i where why not when i press on the cv i am
 * redirected into a new tab and page with full details".
 *
 * Both halves of that were one defect. Every candidate row was a `<button>`, and a button cannot be
 * opened in a second tab by ANY means a person would reach for — ctrl-click, ⌘-click, middle-click,
 * the context menu, dragging it to the tab strip. All of them do nothing at all on a button. So
 * reading a CV could only ever happen in the one pane on the one shared scroll, and the cost of
 * every single CV was finding your place in the list again afterwards. At a thousand CVs a day that
 * is the whole job.
 *
 * The cause underneath it: the open CV was the ONE thing on this screen with no URL. Every filter
 * here is a link on purpose — the module's own comment says "screen the New Medical Rep CVs in
 * Tanta I have not read yet" should survive a reload and be pasteable to the other screener — and
 * the document being read was the exception, held in component state where no browser could reach
 * it.
 *
 * THE ONE INVARIANT THIS FILE EXISTS FOR: `candidate` says which row is OPEN, never which rows
 * EXIST. If it ever reaches the narrowing, opening a CV in a new tab hands the reader a pile of one
 * — and the pile is the entire point of opening it beside the others.
 */

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

export async function runScreeningRowLinkTests() {
  // ── 1 · THE CV HAS AN ADDRESS ─────────────────────────────────────────────────────────────────
  assert.equal(
    screeningHref("/recruitment", { candidate: "b2f1c8d4-0000-4000-8000-000000000001" }),
    "/recruitment/screening?candidate=b2f1c8d4-0000-4000-8000-000000000001",
    "one CV must be addressable on its own — it was component state, which no browser can open",
  );

  // The filters travel WITH it, so the second tab is the same pile with that CV open — not a queue
  // of one, and not the unfiltered pool either.
  const withFilters = screeningHref("/recruitment", {
    area: "Sohag 1",
    candidate: "cv-1",
    rating: "unrated",
    seen: "untouched",
    status: "new",
  });
  assert.match(withFilters, /untouched=1/, "the pile must survive into the new tab");
  assert.match(withFilters, /status=new/);
  assert.match(withFilters, /area=Sohag\+1/);
  assert.match(withFilters, /rating=unrated/);
  assert.match(withFilters, /candidate=cv-1$/, "…and the long id sits LAST, out of a reader's way");

  // A link with no candidate is byte-identical to what this function built before the change. The
  // owner has one of these bookmarked.
  assert.equal(
    screeningHref("/recruitment", { seen: "unseen" }),
    "/recruitment/screening?unseen=1",
    "the bookmarked unseen link must not gain a stray parameter",
  );
  assert.equal(screeningHref("/recruitment"), "/recruitment/screening");
  assert.equal(
    screeningHref("/recruitment", { candidate: null }),
    "/recruitment/screening",
    "no CV named means no parameter, never an empty one",
  );

  // Both shells, because the portal prefix is rewritten and a hard-coded path bounces the reader
  // out of their own namespace — screeningShellPoolHref's account.
  assert.equal(
    screeningHref("/employee-portals/recruitment", { candidate: "cv-9" }),
    "/employee-portals/recruitment/screening?candidate=cv-9",
    "the portal shell must build its own path, not the admin one",
  );

  // ── 2 · READING IT BACK ───────────────────────────────────────────────────────────────────────
  assert.equal(parseOpenCandidateId("cv-1"), "cv-1");
  assert.equal(parseOpenCandidateId(["cv-1", "cv-2"]), "cv-1", "a repeated parameter takes the first");
  assert.equal(parseOpenCandidateId("  cv-1  "), "cv-1");
  assert.equal(parseOpenCandidateId(""), null);
  assert.equal(parseOpenCandidateId("   "), null, "whitespace is not an id");
  assert.equal(parseOpenCandidateId(null), null);
  assert.equal(parseOpenCandidateId(undefined), null);

  // ── 3 · IT NARROWS NOTHING. The headline assertion of this file. ──────────────────────────────
  //
  // If this ever fails, opening a CV in a new tab shows that CV alone, which defeats the whole
  // reason for opening it in a new tab.
  assert.deepEqual(
    parseScreeningFilters({ candidate: "cv-1" }),
    parseScreeningFilters({}),
    "a candidate id must leave the QUEUE untouched — it says which row is open, not which rows exist",
  );
  assert.deepEqual(
    parseScreeningFilters({ candidate: "cv-1", status: "new", unseen: "1" }),
    parseScreeningFilters({ status: "new", unseen: "1" }),
    "…including alongside real filters, which must behave exactly as they did",
  );

  // ── 4 · THE ROW IS AN ANCHOR, AND A PLAIN CLICK IS UNCHANGED ──────────────────────────────────
  //
  // Pinned at the source: a React component's element type and its click guard cannot be reached
  // without a browser, and the browser pane reports `visibilityState: "hidden"` while collapsed,
  // which stalls React's scheduler and makes exactly this check unprovable when you need it — the
  // reason screening-link.ts keeps its own rules pure and out of hooks.
  const list = read("../src/components/recruitment/workstation/workstation-candidate-list.tsx");
  assert.match(
    list,
    /return \(\n {4}<a\n {6}aria-current=\{active \? "true" : undefined\}/,
    "the candidate row must be an ANCHOR — as a button it was unopenable in a tab by every means",
  );
  assert.match(list, /href=\{href\}/, "…carrying that CV's own address");
  assert.doesNotMatch(list, /<button\n {6}aria-current/, "and must not go back to being a button");

  // The fast path a screener uses all day: plain left-click selects in place, no navigation.
  assert.match(
    list,
    /if \(event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey \|\| event\.button !== 0\) return;\n\s*event\.preventDefault\(\);\n\s*onSelect\(\);/,
    "a MODIFIED click belongs to the browser; a plain one must still select in place with no reload",
  );

  // ── 5 · THE LINK OPENS ON THAT CV ─────────────────────────────────────────────────────────────
  const station = read("../src/components/recruitment/workstation/screening-workstation.tsx");
  assert.match(
    station,
    /useState<string \| null>\(openCandidateId \?\? rows\[0\]\?\.id \?\? null\)/,
    "the CV named in the link must be the one open on arrival, else the new tab lands on row one",
  );

  const client = read("../src/components/recruitment/workstation/workstation-page-client.tsx");
  assert.match(
    client,
    /parseOpenCandidateId\(useSearchParams\(\)\.get\("candidate"\)\)/,
    "read from the BROWSER's url — the portal prefix is a rewrite the server cannot see",
  );
  assert.match(client, /candidate: candidateId,/, "and every row's href must carry the current filters");
}
