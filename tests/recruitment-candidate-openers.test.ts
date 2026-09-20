import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  UNNAMED_OPENER,
  buildCandidateOpeners,
  candidateOpenersHeadline,
  openerDirectoryKey,
  openerReopened,
  type CandidateViewRow,
  type OpenerDirectoryEntry,
} from "../src/lib/recruitment/candidate-openers.ts";

function read(relativePath: string): string {
  return readFileSync(relativePath, "utf8");
}

/**
 * "Any opened CV must appear on this CV — that this person, his name, opened this CV at the date and
 *  time. Especially between all district managers, because the same CV goes to the area in CNS,
 *  Anti-infective and Pedia. It must appear that someone from Sato called <name>, his title, and when
 *  exactly he viewed this CV."
 *
 * The owner, 2026-09-20.
 *
 * WHAT THIS FILE HOLDS.
 *
 * A COLLEAGUE'S OPEN REACHES THE CARD — by name, title and time. The rows behind it are canonical
 * upper case while `employees.hr_id` is mixed case (178 of 179 in production), so the join is where
 * this silently returns nobody; the fixtures below use both spellings on purpose.
 *
 * THE VIEWER IS NEVER IN HIS OWN LIST, in any casing. Showing a manager his own reading makes every
 * CV he touches look contested.
 *
 * ALL FOUR CARDS WEAR IT, AND BOTH ENTRY POINTS LOAD IT. The banner is rendered from four places and
 * loaded by three; a card or a loader that is missed reads as "nobody opened it", which is the exact
 * failure the owner reported and cannot be seen from the screen that lacks it.
 */
export async function runCandidateOpenerTests() {
  const row = (
    candidateId: string,
    viewerHrId: string,
    firstSeenAt: string,
    lastSeenAt: string = firstSeenAt,
    viewCount = 1,
  ): CandidateViewRow => ({ candidateId, firstSeenAt, lastSeenAt, viewCount, viewerHrId });

  const directory = new Map<string, OpenerDirectoryEntry>([
    ["A-12", { name: "Sayed Ahmed", title: "District Sales Manager" }],
    ["B-10", { name: "Omar Gawish", title: "HR Section Head" }],
    ["C-7", { name: "Mona Adel", title: null }],
  ]);

  // ── 1 · A colleague's open carries name, title and time ───────────────────────────────────────
  const one = buildCandidateOpeners(
    [row("cand-1", "A-12", "2026-09-19T12:58:00.000Z")],
    directory,
    "D-99",
  );
  assert.deepEqual(one["cand-1"], [
    {
      firstOpenedAt: "2026-09-19T12:58:00.000Z",
      lastOpenedAt: "2026-09-19T12:58:00.000Z",
      name: "Sayed Ahmed",
      openCount: 1,
      title: "District Sales Manager",
    },
  ]);

  // ── 2 · The viewer is never in his own list, whatever the casing ──────────────────────────────
  const withSelf = buildCandidateOpeners(
    [row("cand-1", "A-12", "2026-09-19T12:00:00.000Z"), row("cand-1", "B-10", "2026-09-19T13:00:00.000Z")],
    directory,
    "b-10",
  );
  assert.deepEqual(
    withSelf["cand-1"]?.map((opener) => opener.name),
    ["Sayed Ahmed"],
    "the viewer (given in lower case) must not see his own open",
  );
  const onlySelf = buildCandidateOpeners([row("cand-1", "B-10", "2026-09-19T13:00:00.000Z")], directory, "B-10");
  assert.equal(onlySelf["cand-1"], undefined, "a CV only the viewer opened has NO banner");

  // ── 3 · Newest reading first ──────────────────────────────────────────────────────────────────
  const ordered = buildCandidateOpeners(
    [
      row("cand-1", "A-12", "2026-09-10T08:00:00.000Z"),
      row("cand-1", "C-7", "2026-09-12T08:00:00.000Z"),
      row("cand-1", "B-10", "2026-09-11T08:00:00.000Z"),
    ],
    directory,
    "D-99",
  );
  assert.deepEqual(
    ordered["cand-1"]?.map((opener) => opener.name),
    ["Mona Adel", "Omar Gawish", "Sayed Ahmed"],
  );

  // ── 4 · A person with no employee row is "A colleague", never an HR code ──────────────────────
  const stranger = buildCandidateOpeners([row("cand-1", "Z-404", "2026-09-19T12:58:00.000Z")], directory, "D-99");
  assert.equal(stranger["cand-1"]?.[0]?.name, UNNAMED_OPENER);
  assert.doesNotMatch(JSON.stringify(stranger), /Z-404/i, "no HR code may reach the client payload");
  assert.doesNotMatch(JSON.stringify(one), /A-12/, "the opener's HR id must never travel to the browser");

  // ── 5 · Title is optional; the mapper never invents one ───────────────────────────────────────
  assert.equal(
    buildCandidateOpeners([row("cand-1", "C-7", "2026-09-19T12:58:00.000Z")], directory, "D-99")["cand-1"]?.[0]?.title,
    null,
  );

  // ── 6 · The key survives the stored casing on either side ─────────────────────────────────────
  assert.equal(openerDirectoryKey("a-12"), "A-12");
  assert.equal(openerDirectoryKey(" B-10 "), "B-10");
  assert.equal(openerDirectoryKey(null), null);
  // A row stored in lower case still finds its directory entry.
  assert.equal(
    buildCandidateOpeners([row("cand-1", "a-12", "2026-09-19T12:58:00.000Z")], directory, "D-99")["cand-1"]?.[0]?.name,
    "Sayed Ahmed",
  );

  // ── 7 · Headline counts PEOPLE, and "again" only for a real second visit ──────────────────────
  assert.equal(candidateOpenersHeadline([one["cand-1"]![0]]), "This CV was already opened by 1 colleague");
  assert.equal(candidateOpenersHeadline(ordered["cand-1"]!), "This CV was already opened by 3 colleagues");

  const base = one["cand-1"]![0];
  assert.equal(openerReopened(base), false, "a single open is not a return");
  assert.equal(
    openerReopened({ ...base, lastOpenedAt: "2026-09-19T12:58:05.000Z", openCount: 2 }),
    false,
    "two writes seconds apart are one reading",
  );
  assert.equal(
    openerReopened({ ...base, lastOpenedAt: "2026-09-20T09:30:00.000Z", openCount: 2 }),
    true,
    "a return the next day is worth a line",
  );

  // ── 8 · Wiring: the loader, the pages, the route and every card ───────────────────────────────
  const portalPage = read("app/employee-portals/recruitment-candidates/page.tsx");
  const adminPage = read("app/(admin)/recruitment/candidates/page.tsx");
  const teamRoute = read("app/api/recruitment/hiring-manager/team/[managerHrId]/candidates/route.ts");
  for (const [name, source] of [
    ["the portal page", portalPage],
    ["the admin twin page", adminPage],
  ] as const) {
    assert.match(
      source,
      /loadCandidateOpeners\(cardCandidateIds,\s*access\.hrId\)/,
      `${name} must load the openers for the viewer over the SAME ids the cards render`,
    );
    assert.match(source, /initialOpeners=\{openers\}/, `${name} must hand the openers to the screen`);
  }
  assert.match(teamRoute, /loadCandidateOpeners\(cardCandidateIds,\s*access\.hrId\)/, "the team route must load openers");
  assert.match(teamRoute, /^\s*openers,\s*$/m, "the team route must return the openers to the team screen");

  const portalSource = read("src/components/employee-portal/recruitment-candidates-portal.tsx");
  const readCardSource = read("src/components/employee-portal/candidate-read-card.tsx");
  const teamSource = read("src/components/employee-portal/team-candidates-section.tsx");
  assert.equal(
    (portalSource.match(/<CandidateOpenedNotice candidateId=\{candidate\.id\} \/>/g) ?? []).length,
    2,
    "both portal cards (open positions and sent-to-you) must wear the banner",
  );
  assert.match(readCardSource, /<CandidateOpenedNotice candidateId=\{candidate\.id\} \/>/, "the shared read card (district folders and team) must wear the banner");
  assert.match(portalSource, /<CandidateOpenersProvider openers=\{props\.initialOpeners \?\? \{\}\}>/, "the portal must provide the map to every card below it");
  assert.match(teamSource, /<CandidateOpenersProvider openers=\{openers\}>/, "the team screen carries its own map, fetched for the picked manager");
  assert.match(teamSource, /data\.openers/, "the team screen must read the openers off the route's answer");

  // ── 9 · The banner is square-edged, wraps, and never truncates ────────────────────────────────
  const noticeSource = read("src/components/employee-portal/candidate-opened-notice.tsx");
  assert.doesNotMatch(noticeSource, /rounded/, "square-edge golden rule: no rounded corner on the banner");
  assert.doesNotMatch(noticeSource, /truncate|text-ellipsis|overflow-x-auto|whitespace-nowrap/, "the names and times wrap; nothing is cut or scrolled");
  assert.match(noticeSource, /cairoDateTime\(opener\.firstOpenedAt\)/, "the time is shown in Cairo local");

  // ── 10 · The loader degrades: a banner must never take a page down ────────────────────────────
  const dbSource = read("src/lib/recruitment/candidate-openers-db.ts");
  assert.match(dbSource, /PGRST205/, "a missing relation must read as 'nobody opened it'");
  assert.match(dbSource, /catch \(error\)[\s\S]*return EMPTY_OPENERS/, "any failure returns no banner rather than throwing");
  assert.match(dbSource, /hrIdLookupKeys/, "the employee join must go through the mixed-case lookup keys");
}
