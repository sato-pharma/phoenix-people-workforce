// Pins the Recruitment workspace's SCREEN (owner, 19–20 Oct 2026: the workspace rebuilt from scratch,
// "PERFECT, seen in a PREMIUM POLISHED way") — the words and colours it prints, the URL it writes, and
// the house rules its source must keep.
//
// Why each case matters:
//   * `cairoStamp` is how every row says when a CV arrived. Cairo wall-clock, the owner's "19 Oct ·
//     17:32", the year only when it is not this year — and a UTC evening on 31 Dec is already New
//     Year's Day in Cairo, which is exactly the slip a UTC formatter makes.
//   * `answerEditKey` is the key an in-place answer edit writes. The chip's "role" is the bot's
//     `job_title` step; a wrong key saves the answer onto a question nobody asked.
//   * Every status has an edge colour and a tone — a status without one paints a row with no edge.
//   * A search looks across EVERY tab ("one search box for everything"): the routes are asked without
//     a tab or a place while one is typed, and the opened CV never travels in the list query.
//   * The source pins are the house rules: square edges, nothing cut off with an ellipsis, no sideways
//     scroll, no type under 11px, no browser confirm box, Arabic text set `dir="auto"`, nothing kept in
//     the browser's storage, no page reload after a press, and the page gated by the workspace's own
//     named rule (the CEO reads it without the pool's grant).

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  answerEditKey,
  cairoStamp,
  filterQuery,
  listFilters,
  pageQuery,
  statusEdgeClassName,
  statusTone,
} from "../src/components/recruitment/workspace/workspace-format.ts";
import { managerWorkspaceRow } from "../src/components/recruitment/workspace/manager-row.ts";
import { candidateStatuses } from "../src/lib/recruitment/candidate-status.ts";
import type { Candidate } from "../src/lib/recruitment/types.ts";
import { emptyWorkspaceFilters } from "../src/lib/recruitment/workspace/filters.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE_DIR = path.join(ROOT, "src/components/recruitment/workspace");
const PAGE = path.join(ROOT, "app/(admin)/recruitment/page.tsx");
const PREVIOUS_PAGE = path.join(ROOT, "app/(admin)/recruitment/previous/page.tsx");
const MANAGER_PORTAL = path.join(ROOT, "src/components/employee-portal/recruitment-candidates-portal.tsx");

/** Source with comments blanked, so a rule quoted in prose is never read as code. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function workspaceFiles(): string[] {
  return readdirSync(WORKSPACE_DIR)
    .filter((name) => /\.(ts|tsx)$/.test(name))
    .map((name) => path.join(WORKSPACE_DIR, name));
}

function cairoStampTests(): void {
  assert.equal(cairoStamp("2026-10-19T14:32:00Z", "2026-10-20"), "19 Oct · 17:32", "October is summer time in Cairo: UTC+3");
  assert.equal(
    cairoStamp("2025-12-31T22:30:00Z", "2026-10-20"),
    "1 Jan · 00:30",
    "a UTC evening on 31 Dec is already New Year's Day in Cairo (UTC+2 in winter) — and this year, so no year",
  );
  assert.equal(cairoStamp("2025-06-01T09:05:00Z", "2026-10-20"), "1 Jun 2025 · 12:05", "another year carries its year");
  assert.equal(cairoStamp(null, "2026-10-20"), "", "no date prints nothing, never 'Invalid Date'");
  assert.equal(cairoStamp("not a date", "2026-10-20"), "", "a malformed date prints nothing");
}

function answerKeyTests(): void {
  assert.equal(answerEditKey("role"), "job_title", "the chip's role is the bot's job_title step");
  for (const key of ["background", "region", "area", "experience", "salary"]) {
    assert.equal(answerEditKey(key), key, `the built-in ${key} keeps its name`);
  }
  assert.equal(answerEditKey("graduated_in"), "extra:graduated_in", "an admin-defined question is written as extra:<key>");
}

function statusTests(): void {
  for (const status of candidateStatuses) {
    assert.match(statusEdgeClassName[status] ?? "", /^bg-[a-z]+-\d{3}$/, `${status} has a 3px edge colour`);
    assert.ok(statusTone[status], `${status} has a pill tone`);
  }
  assert.equal(statusEdgeClassName.new, "bg-sky-600", "new is sky, as on the Interview Calendar");
  assert.equal(statusEdgeClassName.rejected, "bg-red-600", "rejected is red");
}

function queryTests(): void {
  const filters = {
    ...emptyWorkspaceFilters(),
    area: "ALX-1",
    candidate: "0f8fad5b-d9cb-469f-a165-70867728950e",
    region: "alexandria",
    tab: "medical_rep" as const,
  };
  const list = new URLSearchParams(filterQuery(filters));
  assert.equal(list.get("candidate"), null, "the opened CV never travels in the list query");
  assert.equal(list.get("tab"), "medical_rep", "without a search the list stays in its tab");
  assert.equal(list.get("region"), "alexandria");
  assert.equal(new URLSearchParams(pageQuery(filters)).get("candidate"), filters.candidate, "the page URL keeps the opened CV");

  const searching = { ...filters, search: "Mona" };
  const across = new URLSearchParams(filterQuery(searching));
  assert.equal(across.get("tab"), null, "a search looks across every tab — the routes are asked without one");
  assert.equal(across.get("region"), null, "and without a place");
  assert.equal(across.get("area"), null);
  assert.equal(across.get("q"), "Mona");
  assert.equal(listFilters(searching).tab, null);
  assert.equal(new URLSearchParams(pageQuery(searching)).get("tab"), "medical_rep", "the address bar keeps the tab, so clearing the search lands back in it");
}

function sourcePins(): void {
  const files = [...workspaceFiles(), PAGE];
  assert.ok(files.length >= 20, `expected the workspace's components, read ${files.length} files`);
  const banned: Array<[RegExp, string]> = [
    [/\brounded(?!-none)(-[a-z0-9]+)?\b/, "a rounded corner (the square-edge golden rule)"],
    [/\btruncate\b|\bline-clamp-|\btext-ellipsis\b/, "text cut off with an ellipsis"],
    [/\boverflow-x-(auto|scroll)\b/, "a sideways scroll (the fits-the-screen golden rule)"],
    [/\btext-phx-2xs\b|\btext-\[(?:[0-9]|10)px\]/, "type under 11px"],
    [/\bwindow\.confirm\b|\bconfirm\(/, "a browser confirm box — confirms are in the page"],
    [/\blocalStorage\b|\bsessionStorage\b/, "browser storage — the URL is the only state that outlives a press"],
    [/\blocation\.reload\b|\brouter\.refresh\b/, "a reload after a press — rows change in place"],
  ];
  const offenders: string[] = [];
  for (const file of files) {
    const source = code(file);
    for (const [pattern, why] of banned) {
      const match = source.match(pattern);
      if (match) offenders.push(`${path.relative(ROOT, file)}: "${match[0]}" — ${why}`);
    }
  }
  assert.deepEqual(offenders, [], `the workspace broke a house rule:\n  ${offenders.join("\n  ")}`);

  for (const name of ["candidate-row.tsx", "answer-chip.tsx", "opened-cv.tsx"]) {
    assert.match(code(path.join(WORKSPACE_DIR, name)), /dir="auto"/, `${name} sets Arabic answers and names dir="auto"`);
  }

  // The question is said once (owner, 7 Nov 2026: "remove the duplicated question label in both
  // places"). The opened CV's answer row names it, so the chip in that row does not say it again.
  const chipSource = code(path.join(WORKSPACE_DIR, "answer-chip.tsx"));
  const spokenLabels = chipSource.match(/>\{chip\.label\}</g) ?? [];
  const gatedLabels = chipSource.match(/withLabel \? (?:\(\s*<>\s*)?<span[^>]*>\{chip\.label\}</g) ?? [];
  assert.equal(spokenLabels.length, 3, "the chip prints its question in three places: at rest, missing, and in the editor");
  assert.equal(gatedLabels.length, spokenLabels.length, "and every one of them only when withLabel is on");
  assert.match(
    code(path.join(WORKSPACE_DIR, "opened-cv.tsx")),
    /<AnswerChip [^>]*withLabel=\{false\}/,
    "the opened CV's answer row names the question, so its chip does not repeat it",
  );

  const page = code(PAGE);
  assert.match(page, /workspaceViewer\(access\)/, "the page is gated by the workspace's own named rule");
  assert.match(page, /if \(!viewer\.canRead\) redirect\("\/employee-portals"\)/, "and sends everyone else away");
  assert.doesNotMatch(page, /canAccess\(access, "candidates", "read"\)/, "never by candidates:read — the CEO reads this screen without it");
  assert.match(page, /<RoleWorkspace\b/, "the page renders the new workspace");
  assert.match(page, /\/recruitment\/previous\?/, "the hire hand-back link goes on to the previous workspace");

  const previous = code(PREVIOUS_PAGE);
  assert.match(previous, /<RecruitmentWorkspace\b/, "the previous workspace is the old screen, moved as it was");
}

function managerPortalTests(): void {
  // The manager's lists arrive REDACTED from the server; the adapter must hand the phone through as
  // it was given — a hidden number stays hidden — and never invent a status the row cannot colour.
  const candidate = {
    createdAt: "2026-10-19T14:32:00Z",
    email: "applicant@example.com",
    fullName: "Mona Adel",
    id: "0f8fad5b-d9cb-469f-a165-70867728950e",
    managerNotified: { areaName: null, hrId: "M-1", jobTitle: null, name: "A Manager", regionName: null, sentAt: "2026-10-19T15:00:00Z" },
    offerId: null,
    phone: null,
    source: "WhatsApp",
    status: "Sent To Manager",
    statusChangedAt: null,
  } as unknown as Candidate;
  const row = managerWorkspaceRow(candidate, { hasCvFile: true });
  assert.equal(row.phone, null, "a phone the server hid stays hidden on the manager's row");
  assert.equal(row.source, "whatsapp");
  assert.ok((candidateStatuses as readonly string[]).includes(row.status), "the row's status is one the edge and the pill can colour");
  assert.deepEqual(row.placements, [], "a manager is never shown HR's placements");
  assert.equal(row.latestSend?.managerName, "A Manager");

  const portal = code(MANAGER_PORTAL);
  assert.match(portal, /<CandidateRow[^>]*mode="manager"/, "the manager portal draws the workspace's own row, in manager mode");
  assert.match(portal, /<OpenedCv[\s\S]*?mode="manager"/, "and opens the workspace's own CV, in manager mode");
  assert.match(portal, /showPhoneNumbers=\{call\.mine\}/, "the CV document keeps the I-will-call gate");
}

export function runRecruitmentWorkspaceScreenTests(): void {
  cairoStampTests();
  answerKeyTests();
  statusTests();
  queryTests();
  sourcePins();
  managerPortalTests();
}
