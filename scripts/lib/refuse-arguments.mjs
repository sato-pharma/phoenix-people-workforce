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
