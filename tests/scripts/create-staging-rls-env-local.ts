import { copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const examplePath = ".env.staging.rls.example";
const localPath = ".env.staging.rls.local";
const force = process.argv.includes("--force");

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function assertGitIgnored(path: string) {
  const result = spawnSync("git", ["check-ignore", path], {
    encoding: "utf8",
    shell: false,
  });

  if (result.status !== 0) {
    fail(`${path} is not ignored by git. Add it to .gitignore before creating local staging secrets.`);
  }
}

if (!existsSync(examplePath)) {
  fail(`${examplePath} does not exist.`);
}

assertGitIgnored(localPath);

if (existsSync(localPath) && !force) {
  fail(`${localPath} already exists. Re-run with --force only if you intentionally want to replace it.`);
}

const example = await readFile(examplePath, "utf8");
const header = [
  "# LOCAL STAGING ONLY - DO NOT COMMIT - DO NOT USE PRODUCTION",
  "# Fill this file with staging-only values on your machine.",
  "# Existing process.env values still take precedence when the runner executes.",
  "",
].join("\n");

if (force && existsSync(localPath)) {
  await writeFile(localPath, `${header}${example}`);
} else {
  await copyFile(examplePath, localPath);
  const copied = await readFile(localPath, "utf8");
  await writeFile(localPath, `${header}${copied}`);
}

console.log(`PASS created ${localPath}`);
console.log(`PASS confirmed ${localPath} is ignored by git`);
console.log("No real secrets were inserted or printed.");
