import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Closeout guards for findings that were deliberately NOT fixed, so "we decided not to" cannot
// quietly become "we forgot to".
//
// analytics.sos_by_block inner-joins source_of_sales_bricks, so any fact row without a brick — the
// Direct channel among them — never survives the join and is missing from every block total. The
// view was left alone because nothing reads it: a migration to fix a report with no consumers is
// approval and risk spent for no one.
//
// That decision is only safe while it stays unread. This fails CI the moment anything starts
// consuming it, which is exactly when the join needs fixing first.
//
// Measured on production 2026-08-01: 0 TypeScript consumers. Note the audit's "drops 22.7%" is NOT
// reproducible — rows with no brick or flagged direct are 0.1% of the fact rollup. The defect is
// real, its scale was overstated, and that is another reason not to spend a migration on it yet.

const SRC = join(process.cwd(), "src");
const APP = join(process.cwd(), "app");

function sourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const rel = (p: string) => p.slice(process.cwd().length + 1).replace(/\\/g, "/");

export function runSosLatentGuardsTests() {
  // ── analytics.sos_by_block must stay unconsumed while its join is broken ────
  {
    const consumers = [...sourceFiles(SRC), ...sourceFiles(APP)]
      .filter((file) => readFileSync(file, "utf8").includes("sos_by_block"))
      .map(rel);
    assert.deepEqual(
      consumers,
      [],
      "analytics.sos_by_block inner-joins bricks, so rows without one (including Direct) are missing " +
        "from every block total. It was left unfixed ONLY because nothing reads it. Before consuming " +
        "it, change the inner join to a LEFT join with an explicit unblocked bucket. Consumers: " +
        consumers.join(", "),
    );
  }

  // ── Caps that were kept must stay disclosed, not silently truncate ──────────
  {
    const route = readFileSync(
      join(process.cwd(), "app/api/sales/monthly-import/accept-mappings/route.ts"),
      "utf8",
    );
    assert.match(
      route,
      /mappings\.length > MAX_BATCH/,
      "the 500-mapping cap is legitimate; silently slicing to it was not. It must refuse explicitly.",
    );
  }

  // ── The owner's rulings must stay recorded next to the code ────────────────
  {
    const doc = readFileSync(join(process.cwd(), "docs/source-of-sales-decisions.md"), "utf8").toLowerCase();
    for (const marker of [
      "confidential products",
      "attribution model",
      "direct channel",
      "today's wiring",
      "departed rep",
      "fail-closed scope",
    ]) {
      assert.ok(doc.includes(marker), `the decisions record must still cover: ${marker}`);
    }
    // The exact rule, not just the topic — this is the line the code implements.
    assert.ok(
      doc.includes("coalesce( occupant of the seat today , occupant of the seat at period end )"),
      "the attribution rule must be stated verbatim, so code and record cannot drift apart",
    );
  }
}
