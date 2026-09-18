import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  parseOpenCandidateId,
  parseScreeningFilters,
  screeningHref,
} from "../src/lib/recruitment/screening-link.ts";
import { parseScreeningTabMessage, SCREENING_TAB_CHANNEL } from "../src/lib/recruitment/screening-tab-sync.ts";

/**
 * PRESSING A CV OPENS IT ON ITS OWN PAGE, IN A NEW TAB, AND THE LIST STAYS WHERE IT WAS.
 *
 * The owner's report, 2026-09-18, in his own words: "when i view cv and pushed to the end of the
 * screen and i really hustle to go back where i where why not when i press on the cv i am
 * redirected into a new tab and page with full details".
 *
 * THE FIRST FIX DID NOT DO THAT, AND THIS FILE SAID IT DID. It made every row an anchor — right as
 * far as it went, because a `<button>` cannot be opened in a tab by any means at all — but it went
 * on SWALLOWING the plain click (`preventDefault`, then select in place), so only a ctrl-click
 * opened a tab, and the tab it opened was the whole list again with that CV in the side pane. This
 * file's own section 4 pinned the swallow as the intended behaviour, which is how a wrong reading of
 * his request went green. He pressed a CV the way anybody presses one, nothing opened, and he said so
 * the next day: "What we do yesterday is not implemented. That I press on the CV, it jumps to another
 * page or tab."
 *
 * So what is pinned now is what he asked for, in his order: a plain press opens a NEW TAB (4); the
 * tab is the CV's OWN PAGE — the CV, its details and its decisions, with no work queue and no list
 * (6); it is the CV he pressed, whatever the list's filters say by the time it loads (7); and the
 * list he goes back to already shows what he decided there (8, 9).
 *
 * THE INVARIANT FROM BEFORE STILL HOLDS: `candidate` says which CV is OPEN, never which CVs EXIST.
 * The own page gets its CV through a field of its own, never by narrowing the pile to one.
 */

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

export async function runScreeningRowLinkTests() {
  // ── 1 · THE CV HAS AN ADDRESS ─────────────────────────────────────────────────────────────────
  assert.equal(
    screeningHref("/recruitment", { candidate: "b2f1c8d4-0000-4000-8000-000000000001" }),
    "/recruitment/screening?candidate=b2f1c8d4-0000-4000-8000-000000000001",
    "one CV must be addressable on its own — it was component state, which no browser can open",
  );

  // The filters travel WITH it, so the CV's own page goes back to the same pile the reader was in —
  // not the unfiltered pool.
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

  // ── 3 · IT NARROWS NOTHING ────────────────────────────────────────────────────────────────────
  //
  // The CV's own page is handed its CV through `openRow` (section 7). If the id ever reached the
  // narrowing as well, every count the server takes over the pile would be taken over one CV.
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

  // ── 4 · A PLAIN PRESS OPENS A NEW TAB. The headline assertion of this file. ───────────────────
  //
  // Pinned at the source: a React component's element type and its click handling cannot be reached
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
  assert.match(
    list,
    /target="_blank"/,
    "a PLAIN press on a CV must open a new tab — he pressed one the ordinary way and nothing opened",
  );
  assert.doesNotMatch(
    list,
    /event\.preventDefault\(\)/,
    "nothing may swallow the press: that swallow is what shipped as 'implemented' on 2026-09-18 and was not",
  );
  assert.match(list, /rel="noopener"/, "the new tab has no business reaching back into the list's tab");
  assert.match(
    list,
    /onClick=\{onSelect\}/,
    "the list tab still marks the row that was opened, so the reader comes back to it highlighted",
  );

  // …and in the list's tab that press only MARKS the row. Switching the phone's pane to the CV, as
  // the old select-in-place did, would take the list tab off the very list whose place he is keeping.
  const station = read("../src/components/recruitment/workstation/screening-workstation.tsx");
  assert.match(station, /onSelect=\{markOpened\}/, "a press in the list must go through markOpened");
  const markOpenedAt = station.indexOf("const markOpened = useCallback(");
  assert.ok(markOpenedAt >= 0, "markOpened must exist");
  assert.doesNotMatch(
    station.slice(markOpenedAt, station.indexOf("}, []);", markOpenedAt)),
    /setMobilePane/,
    "a press in the list must not move the list tab off its list",
  );

  // ── 5 · THE LINK OPENS ON THAT CV ─────────────────────────────────────────────────────────────
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

  // ── 6 · THE NEW TAB IS THE CV'S OWN PAGE ──────────────────────────────────────────────────────
  //
  // "a new tab and page with full details": the CV, its details and its decisions — and none of the
  // list's machinery, whose absence is the reason the tab is worth opening.
  assert.match(client, /const ownPage = openCandidateId !== null;/, "a link naming a CV IS that CV's own page");
  assert.match(client, /ownPage=\{ownPage\}/, "and the workstation must be told");
  assert.match(
    client,
    /rows=\{ownPage \? \(openRow \? \[openRow\] : \[\]\) : rows\}/,
    "the own page is handed the pressed CV and nothing else — never the pile with that CV somewhere in it",
  );
  assert.match(
    client,
    /\{focus \|\| fullBleed \|\| ownPage \? null : \(/,
    "no header of pile figures on a page that is one CV",
  );
  assert.match(
    client,
    /const filtersOpen = filtersRemembered && !ownPage;/,
    "no filter bar either — and the remembered choice is left alone for the list's tab",
  );
  assert.match(client, /href=\{listHref\}/, "a link opened on its own still needs a way to the list");
  assert.match(client, /Screening list/);

  assert.match(
    station,
    /if \(ownPage\) return rows\.filter\(\(row\) => !archived\[row\.id\]\);/,
    "the pressed CV must show whatever pile the list was on — the 'New CVs' default would hide a decided one",
  );
  assert.match(
    station,
    /\{ownPage \? null : \(\s*<>\s*<div\s+className=\{cn\(\s*"z-20 w-\[212px\] shrink-0",/,
    "no work queue on the CV's own page",
  );
  assert.match(
    station,
    /\{ownPage \? null : \(\s*<>\s*<div\s+className=\{cn\(\s*"min-h-0 w-full shrink-0 lg:flex lg:w-\[288px\]",/,
    "and no list — the list is still open in the tab this one was opened from",
  );
  assert.match(
    station,
    /useState<MobilePane>\(ownPage \? "cv" : "list"\)/,
    "on a phone the own page opens on the CV, not on a list it does not have",
  );
  assert.match(station, /onNext=\{ownPage \? null : goToNext\}/, "no 'Next candidate' where there is no queue");
  assert.match(
    station,
    /if \(!ownPage && \(key === "j" \|\| event\.key === "ArrowDown"\)\) \{/,
    "and the arrows are left to scroll the page, instead of being swallowed for a queue that is not there",
  );

  const header = read("../src/components/recruitment/workstation/workstation-review-header.tsx");
  assert.match(header, /onNext: \(\(\) => void\) \| null;/, "the review header must accept no queue");
  assert.match(
    header,
    /\{onNext \? \(\s*<DecisionButton\s+disabled=\{busy\}\s+hotkey="J"/,
    "…and then draw no button that would do nothing",
  );

  // ── 7 · IT IS THE CV THAT WAS PRESSED ─────────────────────────────────────────────────────────
  //
  // Between the press and the load the CV can leave the pile the link names: reading it takes it out
  // of "not opened yet", a decision takes it out of "New", filing takes it off the pool. Looked up in
  // the pile, the tab would open on a neighbour, or on nothing.
  const loader = read("../src/lib/recruitment/screening-workspace.ts");
  assert.match(
    loader,
    /allCandidates\.find\(\(candidate\) => candidate\.id === openCandidateId\)/,
    "the CV the link opens is looked up in EVERY candidate, never in the pile",
  );
  assert.match(
    loader,
    /openRow = rowsById\.get\(openCandidate\.id\) \?\? rowFor\(openCandidate\);/,
    "…and built by the same rowFor as every list row, so the page reads exactly as the row did",
  );
  assert.match(loader, /const rows = visible\.map\(rowFor\);/, "while the list itself stays the pile, unchanged");

  const adminShell = read("../app/(admin)/recruitment/screening/page.tsx");
  const portalShell = read("../app/employee-portals/recruitment/screening/page.tsx");
  for (const [name, shell] of [
    ["admin", adminShell],
    ["portal", portalShell],
  ] as const) {
    assert.match(shell, /openRow=\{workspace\.openRow\}/, `the ${name} shell must hand the pressed CV over`);
    assert.match(
      shell,
      /rows=\{parseOpenCandidateId\(filters\.candidate\) \? \[\] : workspace\.rows\}/,
      `the ${name} shell must not send a thousand list rows to a page that draws one CV`,
    );
  }
  assert.match(
    portalShell,
    /candidate: parseOpenCandidateId\(filters\.candidate\),/,
    "a link to one CV bounced through the portal must still land on that CV, not on the list",
  );

  // ── 8 · WHAT THE TABS TELL EACH OTHER ─────────────────────────────────────────────────────────
  //
  // Whatever arrives on the channel is parsed, never trusted: an older tab and a newer deploy can be
  // open side by side, and a shape one of them does not know must be dropped, not half-applied.
  assert.equal(SCREENING_TAB_CHANNEL, "phoenix.screening.tabs", "one channel name for both shells");
  const roundTrip = (message: unknown) => parseScreeningTabMessage(JSON.parse(JSON.stringify(message)));
  assert.deepEqual(
    roundTrip({ id: "cv-1", kind: "decided", note: "Strong on calls", status: "shortlisted" }),
    { id: "cv-1", kind: "decided", note: "Strong on calls", status: "shortlisted" },
  );
  assert.deepEqual(roundTrip({ id: "cv-1", kind: "decided", note: null, status: "rejected" }), {
    id: "cv-1",
    kind: "decided",
    note: null,
    status: "rejected",
  });
  assert.deepEqual(roundTrip({ id: "cv-1", kind: "rated", rating: 3 }), { id: "cv-1", kind: "rated", rating: 3 });
  assert.deepEqual(
    roundTrip({ id: "cv-1", kind: "rated", rating: null }),
    { id: "cv-1", kind: "rated", rating: null },
    "a star taken OFF is a real message, not a malformed one",
  );
  assert.deepEqual(
    roundTrip({ id: "cv-1", kind: "sent", managerHrIds: ["hr-1", "hr-2"], names: "First Manager, Second Manager" }),
    { id: "cv-1", kind: "sent", managerHrIds: ["hr-1", "hr-2"], names: "First Manager, Second Manager" },
  );
  assert.deepEqual(roundTrip({ count: 0, id: "cv-1", kind: "notes" }), { count: 0, id: "cv-1", kind: "notes" });
  assert.deepEqual(roundTrip({ count: 4, id: "cv-1", kind: "notes" }), { count: 4, id: "cv-1", kind: "notes" });

  const dropped: Array<[unknown, string]> = [
    [null, "null"],
    ["decided", "a bare string"],
    [42, "a number"],
    [{ kind: "decided", note: null, status: "shortlisted" }, "no id"],
    [{ id: "", kind: "decided", note: null, status: "shortlisted" }, "an empty id"],
    [{ id: "   ", kind: "decided", note: null, status: "shortlisted" }, "a blank id"],
    [{ id: "cv-1", kind: "decided", note: null, status: "maybe" }, "a status outside the vocabulary"],
    [{ id: "cv-1", kind: "decided", note: 7, status: "rejected" }, "a note that is not text"],
    [{ id: "cv-1", kind: "decided", status: "rejected" }, "a decision with its note missing"],
    [{ id: "cv-1", kind: "rated", rating: 5 }, "a star off the ladder"],
    [{ id: "cv-1", kind: "rated", rating: "2" }, "a star as text"],
    [{ id: "cv-1", kind: "rated", rating: 0 }, "a zero, which the ladder does not have"],
    [{ id: "cv-1", kind: "rated" }, "a rating with no star at all"],
    [{ id: "cv-1", kind: "sent", managerHrIds: ["hr-1"], names: "" }, "a send to nobody by name"],
    [{ id: "cv-1", kind: "sent", managerHrIds: ["hr-1", 7], names: "First Manager" }, "a manager id that is not text"],
    [{ id: "cv-1", kind: "sent", managerHrIds: ["hr-1", ""], names: "First Manager" }, "an empty manager id"],
    [{ id: "cv-1", kind: "sent", managerHrIds: "hr-1", names: "First Manager" }, "manager ids not in a list"],
    [{ count: -1, id: "cv-1", kind: "notes" }, "a negative note count"],
    [{ count: 1.5, id: "cv-1", kind: "notes" }, "a fractional note count"],
    [{ count: "3", id: "cv-1", kind: "notes" }, "a note count as text"],
    [{ id: "cv-1", kind: "archived" }, "a kind this build does not know"],
  ];
  for (const [message, why] of dropped) {
    assert.equal(parseScreeningTabMessage(message), null, `must be dropped: ${why}`);
  }

  // ── 9 · EVERY CONFIRMED WRITE IS REPORTED, AND HEARD ──────────────────────────────────────────
  //
  // Without these the list he goes back to still reads "New" on a CV he shortlisted in its own tab,
  // and the natural next move — open it again to check — is the wasted CV this change removes.
  const decide = station.slice(station.indexOf("const decide = useCallback("));
  assert.ok(
    decide.slice(0, decide.indexOf("[busy,")).includes('tabs.current?.post({ id: selectedId, kind: "decided", note, status });'),
    "a verdict must be reported to the other tabs",
  );
  assert.match(
    station,
    /tabs\.current\?\.post\(\{ id: row\.id, kind: "rated", rating: stored \}\)/,
    "a star must be reported — the one the server stored, not the one asked for",
  );
  assert.match(
    station,
    /for \(const row of moved\) tabs\.current\?\.post\(\{ id: row\.id, kind: "decided", note: null, status \}\)/,
    "a bulk verdict must report every CV it moved",
  );
  assert.match(
    station,
    /kind: "decided", note: noteById\.get\(row\.id\) \?\? null, status: row\.status/,
    "and an undo must report the verdict going back",
  );
  assert.match(
    station,
    /tabs\.current\?\.post\(\{ count, id: selected\.id, kind: "notes" \}\)/,
    "a note must be reported, or the list's note count lags the CV's own page",
  );
  assert.match(
    station,
    /tabs\.current\?\.post\(\{ id: selectedId, kind: "sent", managerHrIds: sentTo, names: sent\.join\(", "\) \}\)/,
    "a send must be reported",
  );
  // ONE CV, ONE NOTIFICATION PER MANAGER — across tabs too. The list's tab very likely has the same
  // CV and the same manager still picked; without this, one press there is a second real message.
  assert.match(
    station,
    /sentPairs\.current\.add\(`\$\{selectedId\}:\$\{managerHrId\}`\);\s*sentTo\.push\(managerHrId\);/,
    "only a CONFIRMED send is reported — a failed one must stay retryable",
  );
  assert.match(
    station,
    /sentPairs\.current\.add\(`\$\{message\.id\}:\$\{hrId\}`\)/,
    "a send made in another tab must block the same send from this one",
  );
  assert.match(station, /openScreeningTabChannel\(receive\)/, "and every workstation must be listening");
  // Archiving is NOT reported: it takes a row out of the list, and a list that shrinks while the
  // reader is away snaps back to the top — the lost place this whole change exists to remove.
  assert.doesNotMatch(station, /kind: "archived"/, "an archive must not shrink the list behind the reader's back");
}
