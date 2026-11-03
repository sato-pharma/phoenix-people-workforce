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

const CLIENT = "src/lib/phoenix-crm/first-read.ts";
const SERVER = "src/lib/phoenix-crm/server/first-read.ts";
const mutants = [
  {
    name: "remembered by the object again, the old code",
    file: CLIENT,
    edits: [
      ["const firstMet = new Map<string, number>();", "const firstMet = new WeakMap<CrmFirstRead, number>();"],
      ["firstMet.get(firstRead.id)", "firstMet.get(firstRead)"],
      ["firstMet.set(firstRead.id, met)", "firstMet.set(firstRead, met)"],
      ["firstMet.set(firstRead.id, Number.NEGATIVE_INFINITY)", "firstMet.set(firstRead, Number.NEGATIVE_INFINITY)"],
    ],
    expect: "RED Back restores the read in a new object",
  },
  {
    name: "the page stamps no id",
    file: SERVER,
    edits: [["id: randomUUID(), ", ""]],
    expect: "RED every read the page starts carries its own id",
  },
  {
    name: "a drawn read is never marked used",
    file: CLIENT,
    edits: [["firstMet.set(firstRead.id, Number.NEGATIVE_INFINITY);", ""]],
    expect: "RED browser Back must read afresh",
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
  if (broken.status !== 0 && output.includes(mutant.expect)) console.log(`CAUGHT ${mutant.name}: ${mutant.expect}`);
  else {
    console.log(`SURVIVED ${mutant.name}, exit ${broken.status}\n${output.slice(0, 800)}`);
    notCaught += 1;
  }
}
console.log(`mutants: ${mutants.length}, not caught: ${notCaught}`);
process.exitCode = notCaught === 0 ? 0 : 1;
