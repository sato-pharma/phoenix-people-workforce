import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * Every workflow file must be parseable YAML — and the cheapest way to break one is a multi-line
 * shell string inside a `run: |` block.
 *
 * 🔴 WHAT THIS COST, ON 2026-09-29. `staging-hr-drift-check.yml` shipped with its Telegram message
 * written as a literal multi-line argument, so seven of its lines sat at COLUMN 0 while the block's
 * content was indented ten spaces. A YAML block scalar ends at the first line indented less than its
 * parent, so the document became invalid at `${DRIFT_SUMMARY}`.
 *
 * AN UNPARSEABLE WORKFLOW IS NOT A QUIET NO-OP. GitHub cannot read the file, so it never learns the
 * workflow's name or its triggers: it registers the workflow under its PATH and creates a FAILED run
 * on every push — even though that file declares only `schedule` and `workflow_dispatch`. Railway
 * withholds a production deploy when ANY check suite on the commit fails (AGENTS.md §2.3), so every
 * merge from then on was marked SKIPPED. Production sat on one revision for over an hour, three
 * merges deep, with nothing red in `ci.yml` to explain it. The tell was that the run's NAME was the
 * file path and it had zero jobs.
 *
 * The check below is deliberately structural rather than a real YAML parse: this repo has no YAML
 * parser in its dependencies, and adding one to catch an indentation mistake would be a heavier
 * change than the mistake. A line at column 0 that is not a top-level key, a comment, a document
 * marker or blank is the exact shape of this defect, and of nothing legitimate.
 */

const WORKFLOWS = new URL("../.github/workflows/", import.meta.url);

export function runWorkflowFilesParseTests() {
  const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
  // A filter that silently matches nothing reports a clean repo it never looked at.
  assert.ok(files.length >= 5, `expected to find the workflow files, found ${files.length}`);

  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(new URL(file, WORKFLOWS), "utf8");
    source.split("\n").forEach((line, index) => {
      if (!line.trim()) return;
      if (/^\s/.test(line)) return; // indented: inside some block, fine
      if (/^#/.test(line)) return; // comment
      if (/^---/.test(line)) return; // document marker
      if (/^[A-Za-z_][A-Za-z0-9_-]*:/.test(line)) return; // a top-level key
      offenders.push(`${file}:${index + 1}: ${line.slice(0, 80)}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    "a workflow file has a line at column 0 that is not a top-level key — if it is inside a " +
      "`run: |` block it ENDS that block and the file stops parsing, which fails a run on every " +
      "push and withholds every production deploy. Build multi-line text with printf instead:\n" +
      offenders.join("\n"),
  );

  // And the specific file this was found on must keep its message builder, not drift back to a
  // literal multi-line argument.
  const drift = readFileSync(new URL("staging-hr-drift-check.yml", WORKFLOWS), "utf8");
  assert.ok(
    /message=\$\(printf /.test(drift),
    "the drift alert must build its Telegram text with printf — the literal multi-line form is what " +
      "broke the file",
  );
  assert.ok(
    /--data-urlencode "text=\$\{message\}"/.test(drift),
    "and it must send that built message",
  );
}
