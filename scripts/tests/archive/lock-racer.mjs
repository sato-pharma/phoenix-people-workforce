// One racer: sweeps the repository named on the command line, so the lock is held for real work
// (about 1,300 documents hashed) and the processes genuinely overlap.
import { sweepRepos, repoFor } from "file:///C:/Users/satoh/.claude/scripts/repo-archive.mjs";

const target = process.argv[2];
const r = repoFor(target);
if (!r) { process.stdout.write("no-repo"); process.exit(2); }
const started = Date.now();
const counts = sweepRepos({ only: [r] });
process.stdout.write(counts === null ? "skipped" : `ran seen=${counts.seen} ms=${Date.now() - started}`);
