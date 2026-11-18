// A browser test's report is never published while the repository is public (owner, 2026-11-18 "Yes,
// do both" for the production smoke test; 2026-11-19 "Guard CI's reports too" for CI's own).
//
// WHY THIS EXISTS. A failed Playwright run keeps an HTML report with screenshots and a full trace:
// page snapshots and network traffic of every page it opened, signed in. CI's login test and full
// suite run against an environment holding real HR data, and the production smoke test runs against
// production as the Super Admin synthetic account. On a public repository ANY GitHub user can
// download a workflow artifact. On 2026-11-18 thirty-five production recordings were open for
// download and had to be deleted by hand.
//
// So every step in every workflow that uploads a browser-test report must carry
// `github.event.repository.private == true` in its `if:`. When GitHub cannot say the repository is
// private the expression is false and nothing is uploaded, which is the safe way round. Making the
// repository private again brings the reports back with no edit.
//
// The scan reads every workflow file, not a list of known steps, so a NEW report upload is caught
// too. It reads the `if:` line itself with comment lines dropped, because the comment above a guarded
// step names the same expression and would satisfy a search of the whole block. CRLF is folded
// first: this laptop checks out CRLF, the runner LF.

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WORKFLOWS = ".github/workflows";

/** A path an upload names that holds a browser test's report, screenshots or trace. */
const REPORT_PATH = /playwright-report|test-results|tests\/synthetic\/report|\btraces?\b/;

/** The guard every such upload must carry in its `if:`. */
const PRIVATE_ONLY = /github\.event\.repository\.private\s*==\s*true/;

/** The report uploads known on 2026-11-19, so the scan can never silently find nothing. */
const KNOWN = [
  "ci.yml · Upload Playwright report on failure (validate)",
  "ci.yml · Upload Playwright report on failure (full-e2e)",
  "synthetic-journeys.yml · Upload Playwright report",
];

type Upload = { file: string; name: string; ifLine: string };

function reportUploads(): Upload[] {
  const found: Upload[] = [];
  for (const file of readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const source = readFileSync(join(WORKFLOWS, file), "utf8").replace(/\r\n/g, "\n");
    for (const block of source.split(/\n(?=\s*- name: )/).slice(1)) {
      const lines = block.split("\n").filter((line) => !/^\s*#/.test(line));
      if (!lines.some((line) => /uses:\s*actions\/upload-artifact@/.test(line))) continue;
      if (!lines.some((line) => REPORT_PATH.test(line))) continue;
      const name = lines[0].replace(/^\s*- name:\s*/, "").trim();
      const ifLine = lines.find((line) => /^\s*if:/.test(line))?.trim() ?? "";
      found.push({ file, name, ifLine });
    }
  }
  return found;
}

export function runBrowserTestReportsPrivateOnlyTests(): void {
  const uploads = reportUploads();

  // 1. The scan still finds the uploads it was written for. A rename of the report folder or the
  //    step would otherwise leave every assertion below with nothing to check, and pass.
  assert.ok(
    uploads.length >= KNOWN.length,
    `found ${uploads.length} browser-test report upload(s) across ${WORKFLOWS}, expected at least ` +
      `${KNOWN.length} (${KNOWN.join("; ")}). If a report folder or step was renamed, update ` +
      "REPORT_PATH here rather than leaving this test checking nothing.",
  );
  assert.equal(
    uploads.filter((u) => u.file === "ci.yml").length >= 2,
    true,
    "ci.yml no longer shows its two Playwright report uploads (the login test in validate and the " +
      "full suite in full-e2e) to this scan. Update REPORT_PATH if they moved.",
  );

  // 2. Every one of them is gated on the repository being private.
  for (const upload of uploads) {
    assert.match(
      upload.ifLine,
      PRIVATE_ONLY,
      `🔴 ${upload.file} · '${upload.name}' uploads a browser-test report without ` +
        "`github.event.repository.private == true` in its `if:` " +
        `(found: ${upload.ifLine || "no if: at all"}). While the repository is public anyone with a ` +
        "GitHub account can download it, and a failed run's report is a signed-in recording of real data.",
    );
  }
}
