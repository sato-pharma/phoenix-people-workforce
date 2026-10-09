import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { INTEGRITY_NOTE_LIMIT, readIntegritySettlement, sameIntegrityFlags } from "@/lib/phoenix-crm/integrity-settlement";
import { INTEGRITY_SOURCES, integritySourceLabel } from "@/lib/phoenix-crm/server/integrity-board";

// 🔴 `stripSqlComments`, never a line filter. A `--` written after code on the same line survives a
// line-wise strip, and a `/* … */` block survives entirely — so a negative assertion fails on the
// comment and a positive one passes on a file that no longer has the thing it pins
// (`tests/comment-strip-ratchet.test.ts` refuses the shape in the required `validate` job).
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

// SETTLING A LOCATION-INTEGRITY CASE, AND THE FIFTH DETECTOR THAT WAS NOT IN THE READER (2026-10-09).
//
// Two things ship together here, and they are the same defect seen from two sides: the board could
// only be read, so there was nowhere for the owner to record that he had looked — and the reader did
// not know every detector by name, so a case could be labelled as evidence it is not.
//
//   1. `capture_trust` WAS MISSING FROM `IntegritySource`, exactly as `signboard` had been. Both were
//      allowed by the table's `source` CHECK in migration 20261008023051 and only `signboard` was
//      added to the reader a day later. `capture_trust` escaped the same bug by accident: it files on
//      a place VALIDATION rather than on a nightly pass, so production held 0 of its rows on the 9th
//      and the first rep whose photo fix and capture pin disagreed would have had his case printed as
//      **Position**. The fix is one exported list every other piece derives from, and the pin below
//      reads the FILERS' own string literals — because the column is text and the compiler cannot.
//
//   2. SETTLING IS FOUR COLUMNS AND A COMPARISON, never a status. `settled_flags` holds the flags the
//      settlement was taken on, and a case counts as settled only while those still equal the row's.
//      So a detector filing a new finding on the same subject — the filers upsert on
//      (subject_kind, subject_id, source), replacing `flags` in place — reopens the case by itself,
//      and not one filer had to learn that settling exists. A status enum would have been the earlier
//      mistake one step along: it says a case is closed without saying WHAT was closed.

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const BOARD = read("../src/lib/phoenix-crm/server/integrity-board.ts");
const PAGE = read("../app/(admin)/admin/phoenix-crm/integrity/page.tsx");
// 🔴 OUTSIDE `src/components/phoenix-crm/`, WHICH IS THE REP'S OWN BUNDLE. Every file under that
// directory is swept by `tests/phoenix-crm-blind-half.test.ts` and may not say "integrity" at all —
// the rep must never learn the judging exists. The admin board's own button therefore lives with the
// other integrity UI, and the same reasoning puts its routes under `/api/admin/`.
const CONTROL = read("../src/components/crm-integrity/integrity-settle.tsx");
const REGISTRY = read("../src/lib/security/access-registry.ts");
const MIGRATION = read("../supabase/migrations/20261009190708_phoenix_crm_integrity_settlement.sql");

/** Every file that writes a row into `phoenix_crm_location_integrity`. */
const FILERS = [
  "../src/lib/phoenix-crm/server/location-integrity.ts",
  "../src/lib/phoenix-crm/server/photo-dupes.ts",
];

const SETTLED = {
  settledAt: "2026-10-09T18:40:00.000Z",
  settledBy: "B-10",
  settledNote: "Spoke to him; the sign is the landlord's and the plate is inside.",
};

// ── 1. Every detector that files is in the list the board reads ───────────────

function sourceUnionTests(): void {
  // 🔴 THE FILERS' OWN LITERALS, not a list written here. `source` is a text column and each filer
  // writes a string, so nothing in the type system connects the two — this is the only place the
  // connection is made, and it is why `signboard` could print as Position for a day.
  const filed = new Set<string>();
  for (const path of FILERS) {
    const source = stripComments(read(path));
    for (const match of source.matchAll(/source:\s*"([a-z_]+)"/g)) filed.add(match[1]);
  }
  assert.ok(filed.size >= 3, `no integrity filer literals were found at all — the scan is reading the wrong files (${[...filed].join(", ")})`);
  for (const source of filed) {
    assert.ok(
      (INTEGRITY_SOURCES as readonly string[]).includes(source),
      `the detector filing source: "${source}" is not in INTEGRITY_SOURCES — its cases will print as Position on the owner's board, which is what happened to signboard on 2026-10-08`,
    );
  }
  // The two the 2026-10-08 migration added, named explicitly: a scan that silently stopped finding
  // literals would otherwise pass with an empty set.
  for (const source of ["signboard", "capture_trust"]) {
    assert.ok((INTEGRITY_SOURCES as readonly string[]).includes(source), `${source} must be in INTEGRITY_SOURCES`);
  }

  // The database's own CHECK and the reader's list must hold the same five values. A value the table
  // allows but the reader does not know is a case waiting to be mislabelled; one the reader knows and
  // the table refuses is a filer that will fail at 23514.
  const check = stripSqlComments(
    read("../supabase/migrations/20261008023051_phoenix_crm_signboard_and_capture_trust.sql"),
  ).match(/check\s*\(source in \(([^)]*)\)\)/i);
  assert.ok(check, "the source CHECK is no longer readable from migration 20261008023051");
  const allowed = [...check[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  assert.deepEqual(
    [...allowed].sort(),
    [...INTEGRITY_SOURCES].sort(),
    "the table's source CHECK and INTEGRITY_SOURCES have drifted apart",
  );

  // Every member has plain English. A label that falls back to the code would print `capture_trust`
  // at the owner, who reads names and never codes.
  for (const source of INTEGRITY_SOURCES) {
    const label = integritySourceLabel(source);
    assert.notEqual(label, source, `${source} has no label of its own — the board would print the raw code`);
    assert.match(label, /^[A-Z]/, `${source}'s label should read as a word, not a code (${label})`);
  }
  assert.equal(integritySourceLabel("capture_trust"), "Capture trust");
  // 🔴 It must NOT read as a position verdict. That confusion is the whole defect being fixed.
  assert.ok(!/position/i.test(integritySourceLabel("capture_trust")), "capture trust is not position evidence");

  // The tally is derived, never a second list. The hard-coded tuple is exactly what let the breakdown
  // hide the signboard cases while the mapper hid them too.
  const board = stripComments(BOARD);
  assert.match(board, /bySource: INTEGRITY_SOURCES\.flatMap/, "the detector tally must iterate INTEGRITY_SOURCES");
  // There must be exactly ONE such array in the file: the declaration itself. The check removes it
  // first — anything of that shape left over is the second list this whole refactor exists to kill.
  const declaration = /export const INTEGRITY_SOURCES = \[[^\]]*\] as const;/;
  assert.match(board, declaration, "INTEGRITY_SOURCES must be declared as one `as const` array");
  assert.ok(
    !/\["gps", "photo", "behaviour"/.test(board.replace(declaration, "")),
    "integrity-board.ts still carries a hand-written list of detectors beside INTEGRITY_SOURCES",
  );
  // And the row's own coercion goes through the list, not a chain of ORs — the shape that swept an
  // unknown source into `gps`.
  assert.match(board, /source: isIntegritySource\(row\.source\) \? row\.source : "gps"/, "a row's source must be read through the list");
}

// ── 2. The settlement rule: stamped flags, and reopening by itself ────────────

function settlementRuleTests(): void {
  const flags = ["sign_other_name", "photo_pin_drifted"];

  const standing = readIntegritySettlement({ ...SETTLED, settledFlags: flags, flagsNow: flags });
  assert.ok(standing, "a settlement whose stamped flags still match the row must be read");
  assert.equal(standing.byHrId, "B-10");
  assert.equal(standing.note, SETTLED.settledNote);
  assert.deepEqual(standing.flagsThen, flags);

  // 🔴 THE REOPENING. A NEW finding on the same subject replaces `flags` in place (the filers upsert
  // on subject_kind, subject_id, source), and the settlement stops describing the row — so the case
  // is standing again, in the counters and in the weekly scan, with no filer and no job involved.
  assert.equal(
    readIntegritySettlement({ ...SETTLED, settledFlags: flags, flagsNow: [...flags, "device_mocked"] }),
    null,
    "a case flagged again after it was settled must read as standing",
  );
  // A flag going AWAY is a different row too, and the same answer: the settlement was taken on a
  // case that no longer exists in that shape.
  assert.equal(readIntegritySettlement({ ...SETTLED, settledFlags: flags, flagsNow: ["sign_other_name"] }), null);
  // Order is the detector's business. A filer rebuilding the same flags in a different order must
  // not look like a new finding — that would reopen every case it touched.
  assert.ok(readIntegritySettlement({ ...SETTLED, settledFlags: flags, flagsNow: [...flags].reverse() }));
  assert.ok(sameIntegrityFlags(["a", "b"], ["b", "a"]));
  assert.ok(!sameIntegrityFlags(["a", "b"], ["a", "a"]));

  // Never settled at all, and a settlement nobody owns: both are somewhere to look.
  assert.equal(readIntegritySettlement({ settledAt: null, settledBy: null, settledNote: null, settledFlags: null, flagsNow: flags }), null);
  assert.equal(readIntegritySettlement({ ...SETTLED, settledNote: null, settledFlags: flags, flagsNow: flags }), null, "a settlement with no reason is not read");
  assert.equal(readIntegritySettlement({ ...SETTLED, settledBy: null, settledFlags: flags, flagsNow: flags }), null, "a settlement with no author is not read");

  // The migration refuses a half-written settlement rather than relying on the reader above.
  assert.match(MIGRATION, /settled_at timestamptz/);
  assert.match(MIGRATION, /settled_flags text\[\]/);
  assert.match(
    MIGRATION,
    /check\s*\(\s*\(settled_at is null and settled_by is null and settled_note is null and settled_flags is null\)/,
    "the migration must refuse a settlement that is only partly written",
  );
  // 🔴 ADDITIVE ONLY. Nothing in this migration may drop, delete or rewrite a row — the evidence is
  // the point of the table, and the board's whole reason for having no resolution column before was
  // that clearing a flag meant destroying it.
  const sql = stripSqlComments(MIGRATION);
  for (const forbidden of [/\bdelete\s+from\b/i, /\bdrop\s+column\b/i, /\btruncate\b/i, /\bupdate\s+public\./i]) {
    assert.ok(!forbidden.test(sql), `the settlement migration must not ${String(forbidden)} — it only adds columns`);
  }
}

// ── 3. Who may settle, and the three gates that say so ───────────────────────

function settleGateTests(): void {
  const board = stripComments(BOARD);
  // The Super Admin alone, and not a test persona — the same shape as every other decision in the
  // module. 🔴 THE SFE MANAGER READS THIS BOARD AND DOES NOT SETTLE ON IT (owner, 2026-10-09).
  assert.match(
    board,
    /export function canSettleIntegrityCases\(viewer: PhoenixCrmViewer\): boolean \{\s*return viewer\.isSuperAdmin && viewer\.canUpdate && !viewer\.isTestPersona;/,
    "settling is the Super Admin's alone, never a test persona, and never the SFE Manager",
  );
  assert.ok(!/canSettleIntegrityCases[\s\S]{0,120}isSfeManager/.test(board), "the SFE Manager must not reach the settle gate");

  // Both mutations refuse before they read anything.
  for (const name of ["settleIntegrityCase", "reopenIntegrityCase"]) {
    const body = board.slice(board.indexOf(`export async function ${name}`));
    // 🔴 A 404, NEVER A 403 — the same refusal the board's own read uses. "Only the Super Admin
    // settles these" would tell whoever asked that the board exists and that cases are closed on it.
    assert.match(body.slice(0, 700), /if \(!canSettleIntegrityCases\(viewer\)\) throw notFoundError/, `${name} must refuse before it reads a row`);
    assert.ok(!/forbiddenError/.test(body), `${name} must not explain itself with a 403`);
  }

  // The note is required to settle and NOT to reopen: closing a case about a named person has to be
  // answerable later, deciding to look again must never be discouraged.
  const settle = board.slice(board.indexOf("export async function settleIntegrityCase"), board.indexOf("export async function reopenIntegrityCase"));
  assert.match(settle, /INTEGRITY_NOTE_REQUIRED/, "settling without a reason must be refused");
  const reopen = board.slice(board.indexOf("export async function reopenIntegrityCase"));
  assert.ok(!/INTEGRITY_NOTE_REQUIRED/.test(reopen.slice(0, 900)), "reopening must not demand a note");

  // 🔴 THE STAMPED FLAGS ARE READ FROM THE ROW, never taken from the request. A client-supplied list
  // could claim to cover flags the row does not carry, which is precisely the state that would keep a
  // case closed through a new finding.
  assert.match(settle, /\.select\("id, flags"\)/, "settling must read the row's current flags itself");
  assert.match(settle, /settled_flags: flagsNow/, "the settlement stamps the flags read from the row");
  assert.ok(!/body\.flags|raw\.flags/.test(settle), "the flags a settlement is stamped with must never come from the browser");

  // Reopening clears all four together, because the table's CHECK allows nothing else.
  assert.match(reopen, /settled_at: null, settled_by: null, settled_note: null, settled_flags: null/);

  // Neither mutation deletes or rewrites the evidence.
  for (const body of [settle, reopen.slice(0, 1200)]) {
    assert.ok(!/\.delete\(\)/.test(body), "settling never deletes a row");
    assert.ok(!/flags:|strong:|signals:/.test(body.replace(/settled_flags:/g, "")), "settling never rewrites what the detector found");
  }

  // 🔴 NEITHER ROUTE LIVES IN THE REP'S NAMESPACE. `/api/phoenix-crm/*` is the address space the
  // rep's own app calls, and nothing there may reach the evidence — `integrity-board` is a silent
  // module (`tests/phoenix-crm-blind-half.test.ts`, check 4), and the registry records why the old
  // `/api/phoenix-crm/integrity` GET was deleted in 2026-09-26: an address a curious rep can probe
  // is itself a disclosure. The admin namespace keeps that space empty.
  assert.ok(
    !REGISTRY.includes('pattern: "/api/phoenix-crm/integrity'),
    "the settle routes must not be registered in the rep's own /api/phoenix-crm namespace",
  );

  // Both routes exist, are registered as audited CSRF-guarded mutations, and ask for `update`.
  for (const pattern of ["/api/admin/phoenix-crm/integrity/settle", "/api/admin/phoenix-crm/integrity/reopen"]) {
    const line = REGISTRY.split("\n").find((entry) => entry.includes(`pattern: "${pattern}"`));
    assert.ok(line, `${pattern} is not in the access registry`);
    assert.match(line, /classification: "mutation", required: true/, `${pattern} is an audited mutation`);
    assert.match(line, /permission: \{ resource: "phoenix_crm", action: "update" \}/, `${pattern} asks for phoenix_crm.update`);
    assert.match(line, /csrfRequired: true/, `${pattern} is same-origin only`);
  }
  for (const route of ["../app/api/admin/phoenix-crm/integrity/settle/route.ts", "../app/api/admin/phoenix-crm/integrity/reopen/route.ts"]) {
    const source = stripComments(read(route));
    assert.match(source, /assertSameOriginMutation/, `${route} must assert same origin`);
    assert.match(source, /assertPermission\(access, "phoenix_crm", "update"\)/, `${route} must assert the permission`);
  }
}

// ── 4. The board and the page keep their promises ────────────────────────────

function boardAndPageTests(): void {
  const board = stripComments(BOARD);
  // A settled case leaves the live list and the counters, and the withdrawn section keeps its meaning.
  assert.match(board, /const cases = standing\.filter\(\(entry\) => entry\.settlement === null\)/, "a settled case must leave the findings");
  assert.match(board, /const settled = standing\.filter\(\(entry\) => entry\.settlement !== null\)/);
  assert.match(board, /strongCount: cases\.filter\(\(entry\) => entry\.strong\)\.length/, "the strong counter counts the live cases only");

  // 🔴 SETTLING MEANS THE SAME THING ON EVERY SURFACE THAT READS THIS TABLE. The weekly fraud scan is
  // the other one: a case he closed on the board must not arrive on Saturday as a fresh finding.
  const window = board.slice(board.indexOf("export async function loadIntegrityCasesForWindow"));
  assert.match(window, /settled_at, settled_by, settled_note, settled_flags/, "the weekly scan must read the settlement columns");
  assert.match(window, /\.filter\(\(row\) => settlementOf\(row, new Map\(\)\) === null\)/, "the weekly scan must drop settled cases by the board's own test");

  // The page: the button is the Super Admin's, the withdrawn list offers no decision, and every
  // state has a counter rather than vanishing.
  const page = stripComments(PAGE);
  assert.match(page, /const canSettle = canSettleIntegrityCases\(viewer\)/, "the page asks the same predicate the service does");
  assert.match(page, /<CaseList canSettle=\{false\} entries=\{board\.withdrawn\}/, "a withdrawn case has nothing to settle");
  assert.match(page, /<CaseList canSettle=\{canSettle\} entries=\{board\.settled\}/);
  assert.match(page, /label="Settled"/, "a settled case is counted by name, never silently absent");
  // 🔴 WHOLE TAILWIND CLASSES. A grid class assembled at runtime is never generated, and the row
  // would quietly stay one-up at every width.
  assert.match(page, /const COUNTER_GRID = \["sm:grid-cols-3", "sm:grid-cols-2 xl:grid-cols-4", "sm:grid-cols-2 xl:grid-cols-5"\]/);
  assert.ok(!/grid-cols-" \+|grid-cols-\$\{/.test(page), "the counter grid must not build a Tailwind class at runtime");

  // The control wears the system's skin — no hand-written box (the one form design, owner 2026-10-06).
  const control = stripComments(CONTROL);
  assert.match(control, /crmTextareaClassName/, "the note field uses the system's textarea token");
  assert.ok(!/className="[^"]*\bborder border-slate-300\b[^"]*bg-white/.test(control), "the settle control must not paint its own field");
  assert.match(control, /maxLength=\{INTEGRITY_NOTE_LIMIT\}/);
  assert.equal(INTEGRITY_NOTE_LIMIT, 500);
  // 🔴 NOBODY IS NOTIFIED. No rep is ever told he was flagged, so none can be told a flag about him
  // was closed — not from the control, and not from the service.
  for (const [name, source] of [["the settle control", control], ["integrity-board.ts", board]] as const) {
    assert.ok(!/createSystemNotification|sendEmail|notifyRep/.test(source), `${name} must not notify anybody about a settlement`);
  }
}

export function runPhoenixCrmIntegritySettleTests() {
  sourceUnionTests();
  settlementRuleTests();
  settleGateTests();
  boardAndPageTests();
  console.log("phoenix-crm integrity settle: OK");
}
