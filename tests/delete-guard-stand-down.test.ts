import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The owner's never-delete guard must not quietly loosen.
 *
 * `~/.claude/hooks/scratchpad-guard.mjs` refuses any command that deletes an HTML, PDF, spreadsheet,
 * Word or SVG file, anywhere on the laptop. It guards EVERY folder, so it cannot live in one
 * repository — and that is precisely why nothing anywhere could go red when it weakened. On
 * 2026-10-06 it gained its first stand-down, `PHX_DELETE_OK=<filename>`, because the owner told a
 * session to delete a duplicate PDF and the hook refused him; the hatch is deliberately NOT the
 * `=1` shape every other guard here uses, since a blanket off switch is what a session talks itself
 * into. That makes its decision table exactly the kind of code that must be pinned.
 *
 * WHAT THIS CAN AND CANNOT PROVE. `scripts/sync-cloud-context.mjs` mirrors the hook to
 * `.claude/cloud-context/laptop-hooks/`, and this test pins THAT COPY. So it catches a weakening
 * that reaches the repository, and it is worth exactly what the copy's freshness is worth: a live
 * hook weakened and never mirrored would leave this green about a file nobody runs. The live side is
 * closed separately — `~/.claude/scripts/claude-scripts-backup.mjs` runs the hook's own `selftest`
 * hourly, on the machine where the real file is. Neither half is sufficient alone; say so rather
 * than reporting this test as proof the laptop is safe.
 *
 * It never imports the hook. The module dispatches on `process.argv[2]` and calls `process.exit` for
 * `pre`, `sweep` and `selftest`, so importing it into the suite would let a stray argv exit out of
 * the middle of a test run — reporting a prefix of the suite as the whole of it. Every case below
 * runs it as a child process with argv controlled.
 *
 * It also never lets the hook touch a filesystem. The deny path only appends to a log inside a
 * try/catch, and the one allow case names a file that does not exist, which the hook skips — so
 * nothing here creates the `F:/Claude Scratchpad Archive` tree that a Windows-rooted path would
 * otherwise produce inside the repo on a Linux runner.
 */

const HOOK = ".claude/cloud-context/laptop-hooks/scratchpad-guard.mjs";

/** The hook's own `pre` mode, asked for a decision. Returns "allow" when it emits nothing. */
function decide(command: string, cwd = ".") {
  const r = spawnSync(process.execPath, [HOOK, "pre"], {
    input: JSON.stringify({ tool_input: { command }, cwd, hook_event_name: "PreToolUse" }),
    encoding: "utf8",
  });
  const out = String(r.stdout ?? "").trim();
  if (!out) return { decision: "allow", reason: "" };
  const parsed = JSON.parse(out) as {
    hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
  };
  return {
    decision: parsed.hookSpecificOutput?.permissionDecision ?? "allow",
    reason: parsed.hookSpecificOutput?.permissionDecisionReason ?? "",
  };
}

/** `standDown()` over many commands in ONE child process — pure, no I/O, no argv dispatch. */
function standDownAll(commands: string[]) {
  const probe =
    `import { standDown } from ${JSON.stringify(pathToFileURL(path.resolve(HOOK)).href)};\n` +
    `const cases = ${JSON.stringify(commands)};\n` +
    `console.log(JSON.stringify(cases.map((c) => { const r = standDown(c, {}); ` +
    `return { ok: r.ok, present: r.present, value: r.value, why: r.why, files: r.files ?? [] }; })));\n`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8" });
  assert.equal(r.status, 0, `the stand-down probe failed to run: ${r.stderr?.slice(0, 400)}`);
  return JSON.parse(String(r.stdout)) as {
    ok: boolean;
    present: boolean;
    value: string;
    why: string;
    files: string[];
  }[];
}

export function runDeleteGuardStandDownTests() {
  assert.ok(
    existsSync(HOOK),
    `${HOOK} is missing — \`node scripts/sync-cloud-context.mjs\` is the only thing that writes it, ` +
      "and without it nothing in CI pins the owner's never-delete guard at all",
  );

  const source = readFileSync(HOOK, "utf8");

  // ---- the hatch must NAME the file -------------------------------------------------------------
  // Each blanket shape below is one a session would reach for first, and each must stay refused.
  const blanket = [
    // This one FIRST and deliberately: the filename contains the blanket value, so the name-match
    // test below cannot refuse it by accident. Remove the vague check and this case alone turns
    // `ok: true` — measured while breaking the guard on purpose, 2026-10-06. Every other case here
    // was still refused by the name match, which would have let a real weakening read as caught.
    "PHX_DELETE_OK=1 rm 'a/report-1.pdf'",
    "PHX_DELETE_OK=1 rm 'a/report.pdf'",
    "PHX_DELETE_OK=0 rm 'a/report.pdf'",
    "PHX_DELETE_OK=yes rm 'a/report.pdf'",
    "PHX_DELETE_OK=true rm 'a/report.pdf'",
    "PHX_DELETE_OK=all rm 'a/report.pdf'",
    "PHX_DELETE_OK=any rm 'a/report.pdf'",
    "PHX_DELETE_OK=* rm 'a/report.pdf'",
    'PHX_DELETE_OK="" rm \'a/report.pdf\'',
    "PHX_DELETE_OK=rep rm 'a/report.pdf'",
  ];
  for (const [i, r] of standDownAll(blanket).entries()) {
    assert.equal(r.ok, false, `a blanket marker must never stand the guard down: ${blanket[i]}`);
    assert.match(
      r.why,
      /must NAME the file/i,
      "a refused blanket marker has to say WHY, or the session tries the next spelling instead of asking him",
    );
  }

  // ---- a real name, in every form he or a session would write it ---------------------------------
  const named = standDownAll([
    "PHX_DELETE_OK=report.pdf rm 'a/report.pdf'",
    'PHX_DELETE_OK="report.pdf" rm "a/report.pdf"',
    "$env:PHX_DELETE_OK='report.pdf'; Remove-Item 'a/report.pdf'",
    "PHX_DELETE_OK=report.pdf rm 'a/report.pdf' 'b/report.pdf'",
  ]);
  for (const [i, r] of named.entries()) {
    assert.equal(r.ok, true, `a named yes must be honoured (case ${i}) — his instruction cannot reach the machine otherwise`);
  }

  // ---- one yes authorises one file --------------------------------------------------------------
  const scoped = standDownAll([
    "PHX_DELETE_OK=invoice.pdf rm 'a/report.pdf'",
    "PHX_DELETE_OK=report.pdf rm 'a/report.pdf' 'a/other.pdf'",
    "PHX_DELETE_OK=report.pdf rm 'a/notes.txt'",
    "PHX_DELETE_OK=report.pdf rm -rf 'a/somedir'",
    "rm 'a/report.pdf'",
  ]);
  assert.equal(scoped[0].ok, false, "a marker naming a different file authorises nothing");
  assert.equal(scoped[1].ok, false, "a second, unnamed protected file in the same command voids the yes");
  assert.match(scoped[1].why, /also deletes 1 file/i, "and it names how many it did not cover");
  assert.equal(scoped[2].ok, false, "a marker applies to nothing when the command names no protected file");
  // The marker is itself a token ending in `.pdf`. Counting it as one of the covered files made a yes
  // that matched no real file read as "every file matches", so a marker beside a directory delete
  // sailed through. The hook strips the marker before scanning; this is what proves it still does.
  assert.equal(scoped[3].ok, false, "the marker must not count as one of the files it authorises");
  assert.deepEqual(
    standDownAll(["PHX_DELETE_OK=report.pdf rm 'a/report.pdf'"])[0].files,
    ["a/report.pdf"],
    "exactly the real file is covered — not the marker token beside it",
  );
  assert.equal(scoped[4].present, false, "no marker at all is not a stand-down");

  // ---- what the hook actually EMITS, which is the half the logic above cannot see ----------------
  const plain = decide("rm './no-such-file-anywhere.pdf'");
  assert.equal(plain.decision, "deny", "a protected delete with no yes from him is refused");
  assert.match(
    plain.reason,
    /PHX_DELETE_OK=<filename>/,
    "the refusal names the hatch, so a session that HAS his yes does not conclude there is no way through",
  );
  assert.match(plain.reason, /ask the owner in chat first/i, "and still sends the session to him first");

  assert.equal(
    decide("PHX_DELETE_OK=1 rm './no-such-file-anywhere.pdf'").decision,
    "deny",
    "the blanket marker is refused by the hook itself, not only by its helper",
  );

  // The two absolute folders. His yes does not reach them, by his own wording, and a hatch that
  // covered the archive would let an approved delete take the last copy of itself with it.
  for (const target of [
    "F:/Claude Scratchpad Archive/pdf/2026-10-06/anything.pdf",
    "F:/Hiring Posts/anything.pdf",
  ]) {
    const r = decide(`PHX_DELETE_OK=anything.pdf rm '${target}'`);
    assert.equal(r.decision, "deny", `${target} has no stand-down and must refuse even a named yes`);
    assert.match(r.reason, /NO stand-down/, "and says so, rather than reading as a marker that was spelled wrong");
  }

  // A named yes for a file that does not exist: the decision is reached, and the hook archives
  // nothing because there is nothing to lose. This is the allow path, exercised without any I/O.
  assert.equal(
    decide("PHX_DELETE_OK=no-such-file-anywhere.pdf rm './no-such-file-anywhere.pdf'").decision,
    "allow",
    "his named yes reaches the machine — the whole point of the 2026-10-06 change",
  );

  assert.equal(decide("rm './scratch-notes.txt'").decision, "allow", "an unprotected type was never this guard's business");

  // ---- clauses a weakening could remove while every assertion above still passed -----------------
  // Each of these is load-bearing in a way the decision table cannot observe.
  assert.match(
    source,
    /const absolute = ARCHIVE_PATH\.test\(cmd\) \|\| HIRING_POSTS\.test\(cmd\)/,
    "the archive and Hiring Posts are decided BEFORE the stand-down is consulted — reordering this is how a hatch would reach them",
  );
  assert.match(
    source,
    /permissionDecision': ?'deny'|permissionDecision: 'deny'/,
    "the deny branch still emits a deny decision",
  );
  assert.ok(
    /catch \(e\) \{[\s\S]{0,400}?STAND-DOWN REFUSED \(archive copy failed\)/.test(source),
    "a failed archive copy still DENIES the delete — that one step fails closed, so an approved delete never takes the last copy",
  );
  assert.match(
    source,
    /value\.length < 5/,
    "a marker shorter than five characters is still too vague to be one file's name",
  );
  assert.ok(
    !/PHX_DELETE_OK\s*\|\|\s*['"]1['"]|PHX_DELETE_OK\s*===\s*['"]1['"]/.test(source),
    "nothing may reintroduce the `=1` shape this hatch was deliberately built not to have",
  );
}
