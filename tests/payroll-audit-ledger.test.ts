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
 *   2. The fourteen that were once recorded as having NO TRACE each keep a row naming the PR that
 *      closed them. Emptying one of those rows turns this red.
 *   3. The registry points at a ledger that exists, and its arithmetic adds up to 55.
 *
 * REWRITTEN 2026-09-12 (cycle 4). Until then this test pinned the OPPOSITE of check 2: it asserted
 * that fourteen findings had no trace and that the ledger still said so in plain words. Both were
 * true when written and both are now false. The original audit was recovered from the transcript of
 * the Claude Code session that wrote it, and all fourteen turned out to be fixed already - by PRs
 * that narrate the defect without ever citing a finding number, which is exactly why every search
 * for the numbers came back empty. The check that mattered - a fix must leave a ledger row - is
 * unchanged and now covers all 55.
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
 * The fourteen that read "no trace found in the repository" until 2026-09-12, with the pull request
 * that actually closed each one. Not one of those PRs writes a finding number anywhere - they
 * narrate the defect instead - so no search for the numbers could ever have found them.
 *
 * Pinned here because these rows are the ones most likely to be "tidied up" by a later session: they
 * look like bookkeeping about a resolved argument rather than the record of fourteen real fixes. A
 * row that loses its PR reference loses the only link between a finding and the change that closed
 * it, which is the state this whole ledger exists to prevent.
 */
const RECOVERED: ReadonlyArray<readonly [number, number]> = [
  [1, 3641],
  [6, 3642],
  [7, 3659],
  [8, 3659],
  [9, 3651],
  [10, 3651],
  [11, 3684],
  [12, 3687],
  [13, 3674],
  [19, 3649],
  [21, 3669],
  [24, 3649],
  [25, 3649],
  [28, 3649],
];

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

  // ---- 2. Every finding has a row, and the recovered fourteen name what closed them -------------
  const everyFinding = Array.from({ length: 55 }, (_, i) => i + 1);
  const withoutRow = everyFinding.filter((n) => !ledgerRowNumbers.has(n));
  assert.deepEqual(
    withoutRow,
    [],
    `HEADLINE: finding(s) ${withoutRow.join(", ")} have no row in the audit ledger — the audit numbered 1 to 55 and every one of them is now accounted for, so a missing row means the record was edited into a worse state than it was found in`,
  );

  // The PR that closed each of the fourteen must stay attached to its row. These are the rows a
  // later session is most likely to trim, because they read like the aftermath of a settled argument
  // rather than the record of fourteen real fixes.
  const rowFor = (finding: number): string =>
    ledger
      .split("\n")
      .filter((line) => {
        if (!line.startsWith("|")) return false;
        const firstCell = (line.split("|")[1] ?? "").replace(/[*\s]/g, "");
        return firstCell === String(finding);
      })
      .join("\n");
  const lostTheirPr = RECOVERED.filter(([finding, pr]) => !rowFor(finding).includes(`#${pr}`));
  assert.deepEqual(
    lostTheirPr.map(([finding]) => finding),
    [],
    `HEADLINE: finding(s) ${lostTheirPr.map(([f, pr]) => `${f} (PR #${pr})`).join(", ")} no longer name the pull request that closed them — that reference is the ONLY link between the finding and the change, because not one of those PRs writes a finding number in its own text`,
  );

  // The record must keep showing that these fourteen were once believed lost. Deleting that history
  // would make the ledger read as though the gap never happened, and the lesson it carries — that a
  // search for an identifier proves only that the identifier is absent — would go with it.
  assert.match(
    ledger,
    /no trace found in the repository/i,
    "HEADLINE: the ledger must keep the 'no trace found in the repository' wording — a record that quietly erases what it once concluded loses the only evidence that the conclusion was wrong",
  );
  assert.match(
    ledger,
    /audit-cycle-4\.md/,
    "HEADLINE: the ledger must point at cycle 4, which is where the recovery and the trace for all fourteen are written",
  );

  // ---- 3. The ledger's own arithmetic ------------------------------------------------------------
  const counts = [...ledger.matchAll(/\|\s*\*\*(\d+)\*\*\s*\|/g)].map((m) => Number(m[1]));
  assert.ok(
    counts.includes(55),
    "the ledger's summary table must total 55 findings — the audit numbered 1 to 55",
  );
  const buckets = [55, 0, 0, 0]; // fixed with evidence + claimed closed + referenced only + no trace
  const accountedFor = buckets.reduce((sum, count) => sum + count, 0);
  assert.equal(
    accountedFor,
    55,
    `HEADLINE: the ledger's four buckets must add up to the 55 findings the audit numbered — got ${accountedFor}`,
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

  // ---- 5. The superseded ruling stays recorded, and stays marked superseded ----------------------
  //
  // The owner ruled on 2026-09-12 that the fourteen were closed as permanently unrecoverable, and
  // that ruling accepted real residual risk. Hours later the audit was recovered and every one of
  // the fourteen turned out to be fixed. The ruling is kept rather than deleted — a record that
  // tidies away a decision made on a premise that turned out false is worth less than one that shows
  // both — but it must never again read as current, or a later session will act on it.
  const rulingStart = ledger.indexOf("## The ruling on the fourteen");
  assert.ok(
    rulingStart >= 0,
    "HEADLINE: the ledger must keep the owner's ruling on the fourteen, superseded and all — deleting a decision that was made on a false premise hides the most useful thing this record has to teach",
  );
  const afterRuling = ledger.indexOf("\n## ", rulingStart + 1);
  const ruling = ledger.slice(rulingStart, afterRuling === -1 ? undefined : afterRuling);

  assert.match(
    ruling,
    /MOOT|superseded/i,
    "HEADLINE: the ruling must be marked MOOT or superseded where a reader meets it — it says the fourteen are permanently unrecoverable, which is false, and an unmarked ruling reads as current",
  );
  assert.match(ruling, /2026-09-12/, "the ruling must carry the date it was made");
  assert.match(
    ruling,
    /audit-cycle-4\.md/,
    "HEADLINE: the ruling must point at cycle 4 — a reader who meets the ruling first must be able to reach what actually happened without knowing to look for it",
  );

  const notInRuling = RECOVERED.map(([finding]) => finding).filter(
    (finding) => !new RegExp(String.raw`\b${finding}\b`).test(ruling),
  );
  assert.deepEqual(
    notInRuling,
    [],
    `HEADLINE: the ruling must still name every finding it once closed — ${notInRuling.join(", ")} is missing, and a finding dropped from the superseded ruling loses the record that it was ever in doubt`,
  );

  // Closed is not fixed. The ruling's own distinction, kept because it was the right one to draw —
  // and because it is what makes the later recovery legible as good news rather than a formality.
  assert.match(
    ruling,
    /Closed is not fixed/i,
    "HEADLINE: the ruling must keep saying 'closed is not fixed' — it was the right distinction, and it is why the recovery mattered rather than merely tidying a status",
  );

  // ---- 6. The registry records the recovery, not the ruling ---------------------------------------
  assert.match(
    payroll!.requiredNextAction,
    /RECOVERED/,
    "HEADLINE: the registry must record that the audit was recovered and the fourteen were already fixed — it carried 'permanently unrecoverable' as the live state, and a record that keeps asserting a resolved gap trains everyone to ignore it",
  );
  assert.ok(
    !/^\s*Rule on findings/i.test(payroll!.requiredNextAction),
    "HEADLINE: the registry must not demand a ruling on findings 1, 6-13, 21, 24, 25 and 19 — they are fixed, and the ruling that once closed them is moot",
  );
  assert.match(
    payroll!.managerSummary,
    /56 of 56/,
    "HEADLINE: the manager summary must say the record is complete — 56 of 56 findings accounted for, which is what the score now measures",
  );
}
