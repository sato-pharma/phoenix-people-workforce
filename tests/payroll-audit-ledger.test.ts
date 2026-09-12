import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * THE AUDIT LEDGER MUST STAY TRUE, NOT MERELY HAVE BEEN TRUE ONCE.
 *
 * The Automated Payroll audit ran 2026-09-10 to 2026-09-12 and numbered 55 findings. For three days
 * it existed ONLY as code comments and pull-request descriptions — there was no list, so "is finding
 * 28 fixed?" could not be answered by anyone, including the person who ran the audit. Thirteen
 * numbers turned out to appear nowhere at all, and nobody had noticed, because nothing was counting.
 *
 * `docs/production-audits/automated-payroll/audit-ledger.md` is that list. This test is what stops it
 * drifting back into fiction:
 *
 *   1. Every finding the payroll code CLAIMS to fix has a row in the ledger. A new fix that lands
 *      with a `finding N` comment and no ledger row turns this red — which is exactly how the last
 *      thirteen went missing.
 *   2. The findings the ledger records as UNACCOUNTED FOR really have no trace. The day somebody
 *      accounts for one, this goes red and the ledger has to be corrected rather than left stale.
 *   3. The registry points at a ledger that exists, and its arithmetic adds up to 55.
 *
 * The direct-orders re-audit has its OWN 1-24 numbering in `src/lib/direct-orders/` and in
 * `docs/direct-orders-delta-reaudit.md`. Those files are excluded here on purpose: reading them as
 * evidence for THIS audit's findings 1-6 is the single most available way to get this wrong.
 */

const LEDGER = "docs/production-audits/automated-payroll/audit-ledger.md";
const REGISTRY = "docs/production-audits/_registry/audit-registry.json";

/** Where this audit's findings live. Direct Orders is deliberately not in this list. */
const PAYROLL_ROOTS = [
  "src/lib/automated-payroll",
  "src/lib/payroll",
  "src/components/automated-payroll",
  "src/components/attendance",
  "src/components/outstation",
  "app/api/automated-payroll",
  "app/api/payroll",
  "tests",
];

/**
 * The findings this repository cannot account for, as of 2026-09-12. Thirteen have no trace at all;
 * 30 and 36 are claimed closed by PR #3717 with no code marker and no named earlier work; 19 is
 * referenced only as a comparison and was never fixed or dismissed.
 */
const NO_TRACE = [1, 6, 7, 8, 9, 10, 11, 12, 13, 21, 24, 25, 28];

/**
 * The owner ruled on 2026-09-12 that these fourteen - the thirteen with no trace, plus 19 - are
 * CLOSED as permanently unrecoverable. Closing them settled what is OWED, not what is KNOWN, and the
 * two are easy to confuse a year from now. These checks exist so that nobody can quietly reopen the
 * question, quietly drop the ruling, or - worse - "tidy up" the ledger by deleting the no-trace rows
 * on the grounds that the findings are closed. The evidence state and the decision must both survive.
 */
const RULED_CLOSED = [...NO_TRACE, 19];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

export async function runPayrollAuditLedgerTests(): Promise<void> {
  const ledger = readFileSync(LEDGER, "utf8");

  // ---- 1. Every finding the code claims is in the ledger ----------------------------------------
  const files = PAYROLL_ROOTS.flatMap((root) => walk(root));
  assert.ok(files.length > 200, `expected to scan the payroll tree, found only ${files.length} files`);

  const claimed = new Set<number>();
  for (const file of files) {
    // The direct-orders re-audit numbers its own findings 1-24 and its test sits in tests/.
    if (/direct-orders/.test(file)) continue;
    const body = readFileSync(file, "utf8");
    for (const match of body.matchAll(/\bfinding\s+(\d{1,2})\b/gi)) {
      claimed.add(Number(match[1]));
    }
  }
  assert.ok(claimed.size >= 20, `expected the payroll tree to name many findings, found ${claimed.size}`);

  // A ledger row is a table line whose FIRST cell is the finding number (or a group of them). Only
  // the first cell counts: the summary table at the top of the ledger quotes plenty of numbers in
  // later cells, and matching those would let a finding pass with no row of its own — which is
  // exactly the loophole this check exists to close.
  const ledgerRowNumbers = new Set<number>();
  for (const line of ledger.split("\n")) {
    if (!line.startsWith("|")) continue;
    const firstCell = line.split("|")[1] ?? "";
    for (const match of firstCell.matchAll(/\b(\d{1,2})[a-z]?\b/g)) ledgerRowNumbers.add(Number(match[1]));
  }

  const missingFromLedger = [...claimed].sort((a, b) => a - b).filter((n) => !ledgerRowNumbers.has(n));
  assert.deepEqual(
    missingFromLedger,
    [],
    `HEADLINE: the payroll code names finding(s) ${missingFromLedger.join(", ")} that the audit ledger does not record — a fix without a ledger row is how thirteen findings went missing in the first place`,
  );

  // ---- 2. The unaccounted-for findings really are unaccounted for -------------------------------
  const nowAccounted = NO_TRACE.filter((n) => claimed.has(n));
  assert.deepEqual(
    nowAccounted,
    [],
    `HEADLINE: finding(s) ${nowAccounted.join(", ")} are recorded in the ledger as having NO TRACE in the repository, and the payroll code now names them — the ledger is stale and must be corrected, not this test`,
  );

  for (const n of NO_TRACE) {
    assert.ok(
      new RegExp(`\\b${n}\\b`).test(ledger),
      `the ledger must still name finding ${n} among the unaccounted-for, or say what became of it`,
    );
  }
  assert.match(
    ledger,
    /No trace found in the repository/,
    "HEADLINE: the ledger must say 'no trace found' in plain words — a finding nobody can account for is worse than one that is open, because the open one is at least visible",
  );

  // ---- 3. The ledger's own arithmetic ------------------------------------------------------------
  const counts = [...ledger.matchAll(/\|\s*\*\*(\d+)\*\*\s*\|/g)].map((m) => Number(m[1]));
  assert.ok(
    counts.includes(55),
    "the ledger's summary table must total 55 findings — the audit numbered 1 to 55",
  );
  const accountedFor = 39 + 2 + 1; // fixed with evidence + claimed closed + referenced only
  assert.equal(
    accountedFor + NO_TRACE.length,
    55,
    `HEADLINE: the ledger's four buckets must add up to the 55 findings the audit numbered — got ${accountedFor + NO_TRACE.length}`,
  );

  // ---- 4. The registry points at a ledger that exists --------------------------------------------
  const registry = JSON.parse(readFileSync(REGISTRY, "utf8")) as Array<{
    moduleSlug: string;
    latestAuditFile: string | null;
    managerSummary: string;
    requiredNextAction: string;
  }>;
  const payroll = registry.find((entry) => entry.moduleSlug === "automated-payroll");
  assert.ok(payroll, "HEADLINE: the audit registry must carry a real Automated Payroll record — it held only a May 2026 'Replace Me' placeholder while 55 findings were worked through");
  // The registry points at the LATEST audit, which since cycle 2 (2026-09-12) is no longer the
  // cycle-1 ledger. What must hold is the rule that assertion was really protecting: the pointer
  // resolves, and the ledger is still reachable from it rather than orphaned. A later cycle that
  // quietly drops the link is how the finding-by-finding record for 1-55 would go missing next.
  assert.ok(payroll!.latestAuditFile, "the registry must name a latest audit file");
  let latestAudit = "";
  assert.doesNotThrow(
    () => { latestAudit = readFileSync(payroll!.latestAuditFile!, "utf8"); },
    "the file the registry names must exist on disk",
  );
  assert.ok(
    payroll!.latestAuditFile === LEDGER || latestAudit.includes("audit-ledger.md"),
    "HEADLINE: the registry's latest audit file must be the ledger or link to it — the ledger is the only finding-by-finding record of 1-55 and nothing else reproduces it",
  );

  // The registry's score measures the completeness of the RECORD, not the quality of the module, and
  // the dashboard prints it against a scale that means the opposite. The summary has to say so.
  assert.match(
    payroll!.managerSummary,
    /not a quality rating/i,
    "HEADLINE: the manager summary must say what the score measures — the dashboard prints it under 'Needs fixes before launch', which is not what 42-of-55 means",
  );
  const dashboard = readFileSync("docs/production-audits/MANAGEMENT-DASHBOARD.md", "utf8");
  assert.ok(
    dashboard.includes(payroll!.managerSummary),
    "HEADLINE: the generated dashboard must print the manager summary — a score with no sentence explaining it is how a record gets misread",
  );
  assert.ok(
    !/Modules have not been audited yet/.test(dashboard),
    "the dashboard must stop saying nothing has been audited",
  );

  // ---- 5. The ruling on the fourteen stays recorded, and stays honest -----------------------------
  const rulingStart = ledger.indexOf("## The ruling on the fourteen");
  assert.ok(
    rulingStart >= 0,
    "HEADLINE: the ledger must carry the owner's ruling on the fourteen unaccounted-for findings — without it a later session re-opens a question that was already decided, which is the exact loop this record exists to end",
  );
  const afterRuling = ledger.indexOf("\n## ", rulingStart + 1);
  const ruling = ledger.slice(rulingStart, afterRuling === -1 ? undefined : afterRuling);

  assert.match(
    ruling,
    /permanently unrecoverable/i,
    "the ruling must say in plain words that the fourteen are closed as permanently unrecoverable",
  );
  assert.match(ruling, /2026-09-12/, "the ruling must carry the date it was made");

  const notInRuling = RULED_CLOSED.filter((n) => !new RegExp(String.raw`\b${n}\b`).test(ruling));
  assert.deepEqual(
    notInRuling,
    [],
    `HEADLINE: the ruling must name every finding it closes — ${notInRuling.join(", ")} is missing, and a finding left out of the ruling is neither closed nor open, which is the state the ruling was made to eliminate`,
  );

  // Closed is not fixed. If this distinction ever goes, the record starts claiming the fourteen were
  // dealt with on their merits, which is precisely what nobody knows.
  assert.match(
    ruling,
    /Closed is not fixed/i,
    "HEADLINE: the ruling must keep saying 'closed is not fixed' — the fourteen were never verified, dismissed or repaired, and a record that blurs that is worse than the gap it closed",
  );

  // ---- 6. The registry records the decision instead of still asking for it ------------------------
  assert.match(
    payroll!.requiredNextAction,
    /permanently unrecoverable/i,
    "HEADLINE: the registry must record that the ruling was made — it asked for this decision for as long as it was owed, and a record that keeps demanding a decision already taken trains everyone to ignore it",
  );
  assert.ok(
    !/^\s*Rule on findings/i.test(payroll!.requiredNextAction),
    "HEADLINE: the registry must stop demanding a ruling on findings 1, 6-13, 21, 24, 25 and 19 — that ruling was given on 2026-09-12",
  );
  assert.match(
    payroll!.managerSummary,
    /did not move|accepted residual/i,
    "HEADLINE: the manager summary must say the score did not move when the fourteen were closed — a record that rewards itself for deciding to stop looking is how a gap gets papered over",
  );
}
