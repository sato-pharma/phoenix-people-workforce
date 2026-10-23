// scripts/lib/refuse-arguments.mjs
// ---------------------------------------------------------------------------
// ONE GATE FOR EVERY GENERATOR THAT TAKES NO ARGUMENTS.
//
// 🔴 A flag that is IGNORED rather than rejected turns a read into a write. `sync-cloud-context.mjs`
// parsed no arguments at all until 2026-10-15, so `--check` — the flag a session reaches for to ASK
// whether something has drifted — was accepted in silence and the script did its one job: it rewrote
// the whole cloud mirror into whatever checkout the caller was standing in, then exited 0, which
// reads exactly like a clean check. It cost a dirty worktree another live session owned, and
// `git restore` on those paths is refused by the auto-mode classifier as irreversible local
// destruction, so only the owner could authorise cleaning it up.
// Account: docs/agents-session-traps.md, "`--check` on the cloud-context mirror was a full write".
//
// So every generator in this repository that takes no arguments says so, in one shape:
//   exit 0 on --help/-h, with a usage that names what to run INSTEAD of the flag you reached for
//   exit 2 on anything else, having written nothing
//   exit 1 stays what each script already used it for — a real failure
//
// 🔴 CALL IT FIRST, BEFORE ANY OTHER STATEMENT THAT CAN WRITE, AND NEVER FROM A LIBRARY. A module
// under scripts/lib/ is imported by an entry point that DOES take arguments (`new-session.mjs <task>`),
// so a library reading process.argv would refuse its own caller's arguments. Entry points only.
// ---------------------------------------------------------------------------

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * @param {object} spec
 * @param {string} spec.name     the script's own name, for the message ("sync-pdfjs-assets")
 * @param {string} spec.usage    the whole --help text, printed verbatim
 * @param {string[]} [spec.hints] lines printed under a refusal: what to run instead
 * @param {string[]} [spec.argv]  override for tests; defaults to process.argv.slice(2)
 */
export function refuseArguments(spec) {
  const { name, usage, hints = [], argv = process.argv.slice(2) } = spec;
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage);
    process.exit(0);
  }
  if (argv.length === 0) return;
  console.error(`${name}: REFUSED — this script takes no arguments, and it has no dry run.`);
  console.error(`  you passed: ${argv.join(' ')}`);
  for (const hint of hints) console.error(`  ${hint}`);
  console.error(`  to run it for real: node scripts/${name}.mjs   (no flags)`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// THE SAME DEFECT ONE LAYER UP: A SCRIPT THAT *DOES* PARSE ARGUMENTS, SILENTLY ACCEPTING ONE IT
// HAS NEVER HEARD OF.
//
// 🔴 `args.includes('--apply')` answers false for `--aply`, `--apply-all` and `--dry-run`, and the
// script then does the OTHER thing — usually the read-only one, sometimes the write — while the
// caller believes the flag took effect. Measured 2026-10-15 across the scripts here: 32 that parse
// arguments also write files, and only 5 refused an unknown flag.
//
// 🔴 `entry` IS WHAT MAKES THIS SAFE TO PUT AT A FILE'S TOP LEVEL. Several of these modules are
// imported by other entry points — `print-day.mjs` by `run-nightly.mjs`, `build.mjs` by the fold and
// by `sync-cloud-context.mjs` — and a gate that judged `process.argv` on import would refuse its
// PARENT's flags: `fold.mjs --apply` would die on `build.mjs`'s vocabulary. So pass
// `entry: import.meta.url` and the gate acts only when this file is the process entry point.
//
// Positional arguments and a flag's separate value are always allowed: only a token starting with
// `-` that the script does not know is refused, `--flag=value` compared on the part before the `=`.
// ---------------------------------------------------------------------------

/**
 * @param {object} spec
 * @param {string} spec.name     the script's own name, for the message
 * @param {string} spec.entry    import.meta.url of the calling module — the gate is a no-op on import
 * @param {string[]} spec.known  every flag this script tests for ([] when it takes positionals only)
 * @param {string[]} [spec.hints] lines printed under a refusal
 * @param {string[]} [spec.argv]  override for tests; defaults to process.argv.slice(2)
 */
export function refuseUnknownFlags(spec) {
  const { name, entry, known, hints = [], argv = process.argv.slice(2) } = spec;
  // 🔴 PHX_FLAG_GATE_PROBE=1 is how a TEST asks a real script 'what would your gate say?' WITHOUT
  // running it: the body never executes in any branch. A script that fails to detect that it is the
  // entry point exits 3 instead of returning into its body — the one failure a probe must not be able
  // to turn into a real run of `backup-source-of-sales.mjs --zzz`, whose argv[2] is a file it writes.
  //
  // PHX_FLAG_GATE_PROBE=1 is strict for EVERY gate it meets. PHX_FLAG_GATE_PROBE=<absolute path of the probed
  // script> is strict only for THAT file: a gated script that imports another gated script (validate-railway-
  // production-secrets imports sync-railway-production-secrets) must let the imported one pass quietly, while
  // the probed script's own gate still exits 3 if it cannot recognise itself.
  const probeEnv = process.env.PHX_FLAG_GATE_PROBE;
  const probe = probeEnv !== undefined && probeEnv !== "" && probeEnv !== "0";
  const probeTarget = probe && probeEnv !== "1" ? path.resolve(probeEnv).toLowerCase() : null;
  if (entry && !isEntryPoint(entry)) {
    if (probe && (probeTarget === null || path.resolve(fileURLToPath(entry)).toLowerCase() === probeTarget)) {
      console.error(`${name}: PROBE — the gate did not recognise this module as the entry point`);
      process.exit(3);
    }
    return;
  }
  // --help / -h on a script that does not define it is a QUESTION, not a mistake: answer it with the
  // vocabulary, exit 0. (.claude/settings.local.json allow-lists `node scripts/new-session.mjs --help`,
  // which printed an unrelated "give the task a short name" abort before this.)
  if ((argv.includes("--help") || argv.includes("-h")) && !known.includes("--help") && !known.includes("-h")) {
    console.log(`${name}: ${known.length ? `accepts ${known.join(" ")}` : "accepts NO flags — its arguments are positional"}`);
    for (const hint of hints) console.log(`  ${hint}`);
    process.exit(0);
  }
  // A bare `--` is the end-of-options marker (`pnpm run x -- --flag` can hand it through): it is not a
  // flag, and POSIX says everything after it is positional, so it is never judged.
  const endOfOptions = argv.indexOf('--');
  const judged = endOfOptions === -1 ? argv : argv.slice(0, endOfOptions);
  const unknownOf = (args) => args.filter((a) => a.startsWith('-') && !known.includes(a.split('=')[0]));
  const unknown = unknownOf(judged);
  if (unknown.length === 0) {
    if (probe) {
      console.log(`GATE-OK ${name}`);
      // PHX_FLAG_GATE_PROBE_BOTH=1 (tests/unknown-flag-gates.test.ts only) also answers, in this SAME
      // process, what the gate would say to one more flag nobody knows — through the same rule as a real
      // call. The test then pays one import per script instead of two (2026-10-23: ~115 s, a quarter of
      // the whole unit suite). The real exit-2 refusal is still run end to end, on the fixture.
      if (process.env.PHX_FLAG_GATE_PROBE_BOTH === "1") {
        const bogus = "--zzz-not-a-flag";
        console.log(unknownOf([...judged, bogus]).includes(bogus) ? `GATE-REFUSES ${name} ${bogus}` : `GATE-ACCEPTS ${name} ${bogus}`);
      }
      process.exit(0);
    }
    return;
  }
  console.error(`${name}: REFUSED — ${unknown.length === 1 ? 'that flag is' : 'those flags are'} not one this script knows: ${unknown.join(' ')}`);
  console.error(
    known.length
      ? `  it accepts: ${known.join(' ')}`
      : '  it accepts NO flags — its arguments are positional, and everything else is a constant in the file',
  );
  for (const hint of hints) console.error(`  ${hint}`);
  console.error('  a flag it does not know used to be ignored, which looks exactly like it working');
  process.exit(2);
}

/** True when `entry` (an import.meta.url) is the module node was started with. */
function isEntryPoint(entry) {
  const started = process.argv[1];
  if (!started) return false;
  try {
    return pathToFileURL(path.resolve(started)).href === entry;
  } catch {
    return false;
  }
}
