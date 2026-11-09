#!/usr/bin/env node
/**
 * Put an APK on the company's Headwind server and into a set of tablet rules, from the command line.
 *
 * WHY THIS EXISTS. The browser path — Rep Tablets → upload — needs a signed-in Super Admin at a
 * keyboard, and the APK is well over a hundred megabytes, which is a long time to hold a browser tab
 * open on a laptop that is also running everything else. The tablets' build is produced by CI
 * (`.github/workflows/mobile-build.yml`), so the last step should be runnable the same way: headless,
 * unattended, and from a schedule. This is that step.
 *
 * IT REUSES THE LIBRARY ON PURPOSE — `uploadHeadwindApp` is the one implementation, and it already
 * carries three traps that each cost a real afternoon and every one of which fails as an HTTP 200:
 * `type: "app"` is required on the register call, `showIcon` and `remove` are required inside the
 * link entry, and a FAILED register consumes the uploaded temp file so a retry must re-upload. A
 * second copy of that knowledge in a script would drift away from the route and take someone's day.
 * It also writes the required `audit_logs` row, which a hand-rolled script would quietly skip.
 *
 * THE CREDENTIALS ARE NEVER IN THIS FILE. `HEADWIND_MDM_BASE_URL`, `_LOGIN` and `_PASSWORD` live in
 * Railway's secret store, so run this INSIDE that environment and nothing is ever typed or printed:
 *
 *   railway run --service phoenix-people-workforce -- \
 *     node --experimental-strip-types --experimental-specifier-resolution=node \
 *          --experimental-loader ./tests/alias-loader.mjs \
 *          scripts/headwind-push-apk.ts --apk ./phoenix.apk --config rep
 *
 * 🔴 `railway run` RESOLVES ITS LINK FROM THE CURRENT DIRECTORY, and a worktree answers
 * "No linked project found" — run it from the primary checkout. And always pass
 * `--service phoenix-people-workforce`: the primary is linked to `phoenix-headwind`, so without it
 * the wrong service's variables are injected and the Headwind credentials read as absent.
 *
 * 🔴 INSTALLING IS WHAT BEING IN THE RULES MEANS. Headwind has no "install now" command. The app
 * reaches each tablet at its next check-in, which is minutes, not seconds.
 *
 * 🔴 THERE IS NO DEFAULT SET OF RULES. The rep tablets follow "Rep tablets" AND each line's copy of it
 * (runbook §8.17), so the old default — configuration 3 alone — silently left every line tablet without
 * the app. `--config rep` reaches every rep set (found by name, never by id); a comma list names sets.
 *
 *   --apk <path>        the .apk to send (required)
 *   --config <which>    required: `rep` for every rep set of rules, or ids separated by commas (3,4,5)
 *   --actor <id>        who to record in the audit row (default: "system")
 *   --dry-run           sign in and report the current state, then stop without changing anything
 */
import { basename } from "node:path";
import { readFile, stat } from "node:fs/promises";
import process from "node:process";

import { type HeadwindRulesTarget, resolveHeadwindRules } from "@/lib/devices/headwind/configurations";
import { uploadHeadwindApp } from "@/lib/devices/headwind/uploads";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "headwind-push-apk",
  entry: import.meta.url,
  known: ["--apk", "--config", "--actor", "--dry-run"],
});

const args = process.argv.slice(2);
const value = (name: string): string | null => {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return null;
  const next = args[at + 1];
  return next && !next.startsWith("--") ? next : null;
};

const apkPath = value("apk");
const configArg = value("config");
const actor = value("actor") ?? "system";
const dryRun = args.includes("--dry-run");

if (!apkPath || !configArg) {
  console.error("Say which APK to send and which rules:  --apk <path to .apk>  --config rep|<id,id,...>  [--dry-run]");
  process.exit(2);
}
const rules: HeadwindRulesTarget =
  configArg.trim() === "rep" ? "rep" : configArg.split(",").map((part) => (part.trim() ? Number(part.trim()) : Number.NaN));
if (rules !== "rep" && !rules.every((id) => Number.isInteger(id))) {
  console.error("--config takes `rep` (every rep set of rules) or whole numbers separated by commas, e.g. 3,4,5.");
  process.exit(2);
}

const fileInfo = await stat(apkPath).catch(() => null);
if (!fileInfo?.isFile()) {
  console.error(`No APK at ${apkPath}`);
  process.exit(2);
}

console.log(`apk        : ${apkPath}  (${(fileInfo.size / 1048576).toFixed(1)} MB)`);
console.log(`rules      : ${rules === "rep" ? "every rep set of rules" : rules.join(", ")}`);
console.log(`mode       : ${dryRun ? "DRY RUN — reads only" : "LIVE — this changes what the tablets install"}\n`);

// A read first, so the run says out loud which sets of rules it is about to touch, and so a bad
// credential or a wrong service fails here rather than half way through a 150 MB upload.
const targets = await resolveHeadwindRules(rules).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(3);
});
console.log(`signed in — the rules are: ${targets.map((entry) => `"${entry.name}"`).join(", ")}`);

if (dryRun) {
  console.log("\nDRY RUN — nothing was changed. Drop --dry-run to send it.");
  process.exit(0);
}

// The server reads the package name and version out of the APK itself; nothing here parses or guesses.
const bytes = await readFile(apkPath);
const file = new File([bytes], basename(apkPath), { type: "application/vnd.android.package-archive" });

const result = await uploadHeadwindApp({ file, rules: targets.map((entry) => entry.id), showIcon: true }, actor);

console.log(`\npackage : ${result.packageName ?? "(server did not name it)"}`);
console.log(`version : ${result.version ?? "(server did not name it)"}`);
console.log(`on rules: ${result.rules.length ? result.rules.join(", ") : "NO"}`);
console.log(`\n${result.message}`);

if (!result.installed) process.exit(4);
