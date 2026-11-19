// The drift check's REVERSE direction, pinned: every ledger row must be a file in the repository.
//
// Why it exists: public.phx_reassign_replacement_ownership(text,text,date) was changed on production
// by hand on 26 Oct 2026 (ledger row 20261026034726) with no migration file anywhere. The forward
// check ("is every file in the ledger?") stays green for that shape for ever, because a change with
// no file has nothing to be missing. The 18 Nov 2026 Supabase audit found it by hand and captured the
// live body (PR 542); scripts/check-migrations-applied.ts now asks the opposite question too.
//
// What this suite holds still, and why each part matters:
//   - the three ways a row is ACCOUNTED FOR (version, name, a file version inside the name) — drop one
//     and the nightly run goes red on rows that are fine, which teaches people to ignore it;
//   - the seven-day shelter, and that an unreadable version is NEVER sheltered;
//   - the pre-baseline archive is read, or 450 archived rows read as orphans;
//   - the frozen adoption-day list only shrinks, holds no row a file now explains, and is never
//     younger than the day it was frozen — so it cannot become a place to hide a new orphan;
//   - the script really calls all of it, and no longer exits green before the reverse half runs.
//
// The helpers live in scripts/lib/migration-inventory.ts, not in the script, because the script's
// `main()` runs on import and would open a database connection from a test process.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ACKNOWLEDGED_LEDGER_ORPHANS,
  FILENAME_RE,
  LEDGER_ORPHAN_ADOPTION_CUTOFF,
  LEDGER_ORPHAN_GRACE_MS,
  LEDGER_ORPHANS_PRESENT_AT_ADOPTION,
  type LedgerRow,
  type MigrationFile,
  ledgerFileIndex,
  ledgerOrphanKey,
  ledgerRowHasFile,
  ledgerVersionTimeMs,
  loadArchivedMigrations,
  loadLocalMigrations,
  selectLedgerOrphans,
  selectUntracedAdoptionOrphans,
} from "../scripts/lib/migration-inventory.ts";
import { stripComments } from "./support/comment-strip.ts";

// The adoption-day list held this many rows when it was frozen (19 Nov 2026). It may fall; it may
// never rise. Lower this number when entries leave, never raise it.
const ADOPTION_ORPHANS_CEILING = 78;

const NOW = Date.UTC(2026, 10, 19, 0, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function file(version: string, name: string): MigrationFile {
  return { fileName: `${version}_${name}.sql`, version, name };
}

/** A 14-digit version for an instant, in the UTC reading ledgerVersionTimeMs uses. */
function versionAt(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function versionTimeTests(): void {
  assert.equal(ledgerVersionTimeMs("20261026034726"), Date.UTC(2026, 9, 26, 3, 47, 26));
  assert.equal(ledgerVersionTimeMs("20260101000000"), Date.UTC(2026, 0, 1, 0, 0, 0));
  for (const bad of [
    "2026102603472", // 13 digits
    "202610260347261", // 15 digits
    "2026102603472a",
    "",
    "20261340000000", // month 13 — Date.UTC would roll it into the next year
    "20260230120000", // 30 February
    "20261026246000", // hour 24
    "20261026036000", // minute 60
  ]) {
    assert.equal(ledgerVersionTimeMs(bad), null, `"${bad}" is not a timestamp and must have no age`);
  }
  assert.equal(versionAt(Date.UTC(2026, 9, 26, 3, 47, 26)), "20261026034726", "the test's own helper");
}

function rowHasFileTests(): void {
  const index = ledgerFileIndex([file("20260101000000", "add_widgets")]);
  assert.ok(ledgerRowHasFile({ version: "20260101000000", name: "something_else" }, index), "by version");
  assert.ok(
    ledgerRowHasFile({ version: "20261119003733", name: "add_widgets" }, index),
    "by name — the MCP apply stamps the server's clock as the version, so only the name matches",
  );
  assert.ok(
    ledgerRowHasFile({ version: "20261119003733", name: "20260101000000_add_widgets_v2" }, index),
    "by a file version inside the name — historical rows carry a whole alternate filename there",
  );
  assert.ok(ledgerRowHasFile({ version: "20260101000000", name: null }, index), "a null name still matches by version");
  assert.ok(!ledgerRowHasFile({ version: "20261119003733", name: null }, index), "a null name matches nothing else");
  assert.ok(!ledgerRowHasFile({ version: "20261119003733", name: "hand_change" }, index), "no match is an orphan");
  assert.ok(
    !ledgerRowHasFile({ version: "20261119003733", name: "" }, ledgerFileIndex([file("20260101000000", "")])),
    "an empty name never matches an empty name — it says nothing about which change it was",
  );
  assert.equal(ledgerOrphanKey({ version: "20261026034726", name: "x_y" }), "20261026034726 x_y");
  assert.equal(ledgerOrphanKey({ version: "20261026034726", name: null }), "20261026034726 ");
}

function selectTests(): void {
  const files = [file("20261001000000", "has_a_file")];
  const old = versionAt(NOW - 30 * DAY);
  const young = versionAt(NOW - 1 * DAY);
  const exactlySeven = versionAt(NOW - LEDGER_ORPHAN_GRACE_MS);
  const [adoptionKey] = [...LEDGER_ORPHANS_PRESENT_AT_ADOPTION.keys()];
  const [ackKey] = [...ACKNOWLEDGED_LEDGER_ORPHANS.keys()];
  const fromKey = (key: string): LedgerRow => {
    const space = key.indexOf(" ");
    return { version: key.slice(0, space), name: key.slice(space + 1) };
  };

  const rows: LedgerRow[] = [
    { version: young, name: "pr_not_merged_yet" },
    { version: old, name: "hand_change" },
    { version: "20261001000000", name: "has_a_file" },
    { version: "not-a-version", name: "unreadable" },
    { version: exactlySeven, name: "seven_days_old" },
    fromKey(adoptionKey),
    fromKey(ackKey),
  ];

  const nightly = selectLedgerOrphans(rows, files, { nowMs: NOW });
  const judged = new Set(nightly.map((r) => r.name));
  // One assertion per rule, so a break names the rule it broke.
  assert.ok(!judged.has("pr_not_merged_yet"), "a row younger than seven days is sheltered — normally its pull request has not merged");
  assert.ok(judged.has("seven_days_old"), "the shelter ends at exactly seven days");
  assert.ok(judged.has("unreadable"), "a row with no readable age is NEVER sheltered — an unknown age must not silence a gap");
  assert.ok(!judged.has("has_a_file"), "a row that matches a file is accounted for");
  assert.ok(!judged.has(fromKey(adoptionKey).name), "a row on the adoption-day list is not judged again");
  assert.ok(!judged.has(fromKey(ackKey).name), "an acknowledged row is accounted for by its evidence");
  assert.ok(judged.has("hand_change"), "an old row with no file is the orphan this check exists to find");
  assert.deepEqual(
    nightly.map((r) => r.name),
    // Sorted by version as text: digits sort before letters, so the unreadable one comes last.
    ["hand_change", "seven_days_old", "unreadable"],
    "the nightly judgement: the young row is sheltered, the matched / adoption-day / acknowledged rows "
      + "are accounted for, and a row with no readable age is never sheltered",
  );

  const swept = selectLedgerOrphans(rows, files, { nowMs: NOW, ignoreGraceWindow: true });
  assert.deepEqual(
    swept.map((r) => r.name),
    ["hand_change", "seven_days_old", "pr_not_merged_yet", "unreadable"],
    "ignoreGraceWindow lists the sheltered row too, and nothing else changes",
  );

  // The archive counts as the repository's record.
  const archivedOnly = [{ version: "20250601000000", name: "pre_baseline_change" }];
  assert.equal(selectLedgerOrphans(archivedOnly, [], { nowMs: NOW }).length, 1);
  assert.equal(
    selectLedgerOrphans(archivedOnly, [file("20250601000000", "pre_baseline_change")], { nowMs: NOW }).length,
    0,
  );

  // How much of the adoption-day list is left: counted only while no file explains the row.
  const adoptionRow = fromKey(adoptionKey);
  assert.equal(selectUntracedAdoptionOrphans([adoptionRow, rows[1]], files).length, 1);
  assert.equal(
    selectUntracedAdoptionOrphans([adoptionRow], [file(adoptionRow.version, "traced_at_last")]).length,
    0,
    "a traced row stops counting even before it is taken off the list",
  );
}

function archiveTests(): void {
  const real = loadArchivedMigrations();
  assert.ok(real.length >= 400, `the pre-baseline archive should hold its 450 files, read ${real.length}`);
  for (const f of real) assert.match(f.fileName, FILENAME_RE);

  const dir = mkdtempSync(path.join(tmpdir(), "ledger-archive-"));
  try {
    mkdirSync(path.join(dir, "batch-a", "nested"), { recursive: true });
    writeFileSync(path.join(dir, "20260101000000_top.sql"), "");
    writeFileSync(path.join(dir, "batch-a", "20260102000000_middle.sql"), "");
    writeFileSync(path.join(dir, "batch-a", "nested", "20260103000000_deep.sql"), "");
    writeFileSync(path.join(dir, "batch-a", "README.md"), "");
    writeFileSync(path.join(dir, "batch-a", "notes.sql"), "");
    assert.deepEqual(
      loadArchivedMigrations(dir).map((f) => f.name).sort(),
      ["deep", "middle", "top"],
      "every folder is read, at every depth, and only migration-shaped file names count",
    );
    assert.deepEqual(loadArchivedMigrations(path.join(dir, "missing")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Entries written in a Map literal, counted from the source, because a Map silently drops a duplicate key. */
function sourceEntryCount(source: string, constName: string): number {
  const start = source.indexOf(`export const ${constName} = new Map<string, string>([`);
  assert.ok(start >= 0, `${constName} not found in the inventory`);
  const end = source.indexOf("\n]);", start);
  return (source.slice(start, end).match(/^ {2}\[\s*\n?\s*"\d{14} /gm) ?? []).length;
}

function frozenListTests(): void {
  const inventory = readFileSync("scripts/lib/migration-inventory.ts", "utf8");
  const index = ledgerFileIndex([...loadLocalMigrations(), ...loadArchivedMigrations()]);

  assert.ok(
    LEDGER_ORPHANS_PRESENT_AT_ADOPTION.size <= ADOPTION_ORPHANS_CEILING,
    `LEDGER_ORPHANS_PRESENT_AT_ADOPTION holds ${LEDGER_ORPHANS_PRESENT_AT_ADOPTION.size}, above its ceiling of `
      + `${ADOPTION_ORPHANS_CEILING}. That list only shrinks: a new orphan is the finding the check exists to raise.`,
  );
  assert.equal(
    sourceEntryCount(inventory, "LEDGER_ORPHANS_PRESENT_AT_ADOPTION"),
    LEDGER_ORPHANS_PRESENT_AT_ADOPTION.size,
    "a key written twice in LEDGER_ORPHANS_PRESENT_AT_ADOPTION",
  );
  assert.equal(
    sourceEntryCount(inventory, "ACKNOWLEDGED_LEDGER_ORPHANS"),
    ACKNOWLEDGED_LEDGER_ORPHANS.size,
    "a key written twice in ACKNOWLEDGED_LEDGER_ORPHANS",
  );

  for (const [key, where] of LEDGER_ORPHANS_PRESENT_AT_ADOPTION) {
    const m = /^(\d{14}) (.+)$/.exec(key);
    assert.ok(m, `adoption-day key "${key}" is not "<14-digit version> <name>"`);
    assert.ok(
      m[1] < LEDGER_ORPHAN_ADOPTION_CUTOFF,
      `adoption-day key "${key}" is younger than the day the list was frozen — a new orphan is never added here`,
    );
    assert.ok(
      ["production", "staging", "production + staging"].includes(where),
      `adoption-day key "${key}" names "${where}" — it must say which ledger holds it`,
    );
    assert.ok(!ACKNOWLEDGED_LEDGER_ORPHANS.has(key), `"${key}" is both acknowledged and untraced — keep only the acknowledgement`);
    assert.ok(
      !ledgerRowHasFile({ version: m[1], name: m[2] }, index),
      `adoption-day row "${key}" now matches a file — it is traced, so take it off the list and lower the ceiling`,
    );
  }

  for (const [key, evidence] of ACKNOWLEDGED_LEDGER_ORPHANS) {
    const m = /^(\d{14}) (.+)$/.exec(key);
    assert.ok(m, `acknowledged key "${key}" is not "<14-digit version> <name>"`);
    assert.ok(evidence.trim().length >= 40, `acknowledged row "${key}" needs the evidence beside it, not a word`);
    assert.ok(
      !ledgerRowHasFile({ version: m[1], name: m[2] }, index),
      `acknowledged row "${key}" now matches a file — the acknowledgement is stale, remove it`,
    );
  }
  assert.ok(
    ACKNOWLEDGED_LEDGER_ORPHANS.has("20261026034726 reassign_ownership_adopts_unowned_vacancies"),
    "the row that started this check is acknowledged with the capture that explains it",
  );
}

function wiringTests(): void {
  // Read as text on purpose: the script cannot be imported (see the header).
  const script = stripComments(readFileSync("scripts/check-migrations-applied.ts", "utf8"));
  assert.match(script, /loadArchivedMigrations\(\)/, "the reverse half must read the pre-baseline archive");
  assert.match(script, /const files = \[\.\.\.local, \.\.\.archived\]/, "the reverse half must read both file sets");
  assert.match(
    script,
    /selectLedgerOrphans\(remote\.rows, files, \{ nowMs: now \}\)/,
    "check-migrations-applied.ts must judge the ledger rows with selectLedgerOrphans, shelter on",
  );
  assert.ok(
    !/selectLedgerOrphans\([^)]*ignoreGraceWindow \}/.test(script),
    "--no-grace must not reach the reverse judgement: the nightly staging sweep runs --no-grace, and a row "
      + "inside the shelter is normally a pull request still waiting for its merge",
  );
  assert.match(script, /selectUntracedAdoptionOrphans\(remote\.rows, files\)/, "the run reports what is left to trace");
  assert.match(script, /rows,\s*\n\s*projectRef,/, "loadRemoteMigrations must hand back the rows themselves");
  assert.match(
    script,
    /process\.exit\(missing\.length > 0 \|\| orphans\.length > 0 \? 1 : 0\)/,
    "either direction failing must fail the run",
  );
  assert.ok(
    !/process\.exit\(0\)/.test(script),
    "no early green exit: the forward half used to exit 0 before anything else could run",
  );
}

export function runMigrationLedgerOrphansTests(): void {
  versionTimeTests();
  rowHasFileTests();
  selectTests();
  archiveTests();
  frozenListTests();
  wiringTests();
}
