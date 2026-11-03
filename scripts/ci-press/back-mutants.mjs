// One-off, never merged: runs the first-read test on the fixed code, then breaks the fix each way and watches its own assertion fire.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const run = () => {
  const env = { ...process.env, PHOENIX_LOG_LEVEL: "error" };
  delete env.NEXT_PUBLIC_SUPABASE_URL;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  return spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-strip-types",
      "--experimental-specifier-resolution=node",
      "--experimental-loader",
      "./tests/alias-loader.mjs",
      "--input-type=module",
      "-e",
      "const m = await import('./tests/phoenix-crm-first-read.test.ts'); await m.runPhoenixCrmFirstReadTests(); console.log('all passed');",
    ],
    { encoding: "utf8", env, timeout: 240_000 },
  );
};

const LIB = "src/lib/phoenix-crm/first-read.ts";
const PROVIDER = "src/components/phoenix-crm/first-read.ts";
const SERVER = "src/lib/phoenix-crm/server/first-read.ts";
const mutants = [
  {
    name: "a read under a screen already up is not marked",
    file: LIB,
    edits: [["if (arriving !== null && arriving !== held) firstReadSpent(arriving);", ""]],
    expect: "RED a read that arrived under a screen already up",
  },
  {
    name: "the screen's own first read gets marked too",
    file: LIB,
    edits: [["if (arriving !== null && arriving !== held) firstReadSpent(arriving);", "if (arriving !== null) firstReadSpent(arriving);"]],
    expect: "the screen's own first read is left alone",
  },
  {
    name: "the provider never reports an arrival",
    file: PROVIDER,
    edits: [["firstReadArrived(held, firstRead);", ""]],
    expect: "RED a read arriving under a screen already up is marked",
  },
  {
    name: "no age check on a read met for the first time",
    file: LIB,
    edits: [["if (now - firstRead.startedAt > FIRST_READ_LIFETIME_MS) return null;", ""]],
    expect: "RED a read this old is refused",
  },
  {
    name: "the page does not say when it started the read",
    file: SERVER,
    edits: [["startedAt: Date.now(), ", ""]],
    expect: "RED every read the page starts says when",
  },
  {
    name: "a drawn read is never marked used",
    file: LIB,
    edits: [["firstMet.set(firstRead, Number.NEGATIVE_INFINITY);", ""]],
    expect: "RED browser Back must read afresh",
  },
  {
    name: "a check on Next's hidden marks comes back",
    file: SERVER,
    edits: [["const target = phoenixCrmFirstReadTarget(overview, requested, surface);", 'void "next-router-state-tree"; const target = phoenixCrmFirstReadTarget(overview, requested, surface);']],
    expect: "RED a check on Next's request marks can never fire",
  },
];

const clean = run();
const passed = clean.status === 0 && clean.stdout.includes("all passed");
console.log(passed ? "PASS the unbroken code" : `FAIL the unbroken code\n${clean.stdout}\n${clean.stderr}`.slice(0, 3000));
let notCaught = passed ? 0 : 1;

for (const mutant of mutants) {
  const original = readFileSync(mutant.file, "utf8");
  let changed = original;
  let applied = true;
  for (const [from, to] of mutant.edits) {
    if (!changed.includes(from)) applied = false;
    changed = changed.replace(from, () => to);
  }
  if (!applied) {
    console.log(`NOT APPLIED ${mutant.name}`);
    notCaught += 1;
    continue;
  }
  writeFileSync(mutant.file, changed);
  const broken = run();
  writeFileSync(mutant.file, original);
  const output = `${broken.stdout}\n${broken.stderr}`;
  // The message must come from a failed assertion: a crash prints the source line too, and would read as caught.
  if (broken.status !== 0 && output.includes("AssertionError") && output.includes(mutant.expect)) console.log(`CAUGHT ${mutant.name}: ${mutant.expect}`);
  else {
    console.log(`SURVIVED ${mutant.name}, exit ${broken.status}\n${output.slice(0, 800)}`);
    notCaught += 1;
  }
}
console.log(`mutants: ${mutants.length}, not caught: ${notCaught}`);
process.exitCode = notCaught === 0 ? 0 : 1;
