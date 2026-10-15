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
 *          scripts/headwind-push-apk.ts --apk ./phoenix.apk --config 3
 *
 * 🔴 `railway run` RESOLVES ITS LINK FROM THE CURRENT DIRECTORY, and a worktree answers
 * "No linked project found" — run it from the primary checkout. And always pass
 * `--service phoenix-people-workforce`: the primary is linked to `phoenix-headwind`, so without it
 * the wrong service's variables are injected and the Headwind credentials read as absent.
 *
 * 🔴 INSTALLING IS WHAT BEING IN THE RULES MEANS. Headwind has no "install now" command. The app
 * reaches each tablet at its next check-in, which is minutes, not seconds.
 *
 *   --apk <path>      the .apk to send (required)
 *   --config <id>     the configuration to put it on; 3 is "Rep tablets"
 *   --actor <id>      who to record in the audit row (default: "system")
 *   --dry-run         sign in and report the current state, then stop without changing anything
 */
import { basename } from "node:path";
import { readFile, stat } from "node:fs/promises";
import process from "node:process";

import { listHeadwindConfigurations } from "@/lib/devices/headwind/configurations";
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
const configurationId = Number(value("config") ?? "3");
const actor = value("actor") ?? "system";
const dryRun = args.includes("--dry-run");

if (!apkPath) {
  console.error("Say which APK to send:  --apk <path to .apk>  [--config 3] [--dry-run]");
  process.exit(2);
}
if (!Number.isInteger(configurationId)) {
  console.error("--config takes a whole number, e.g. 3 for the rep tablets.");
  process.exit(2);
}

const fileInfo = await stat(apkPath).catch(() => null);
if (!fileInfo?.isFile()) {
  console.error(`No APK at ${apkPath}`);
  process.exit(2);
}

console.log(`apk        : ${apkPath}  (${(fileInfo.size / 1048576).toFixed(1)} MB)`);
console.log(`configuration: ${configurationId}`);
console.log(`mode       : ${dryRun ? "DRY RUN — reads only" : "LIVE — this changes what the tablets install"}\n`);

// A read first, so the run says out loud which set of rules it is about to touch, and so a bad
// credential or a wrong service fails here rather than half way through a 150 MB upload.
const { configurations } = await listHeadwindConfigurations();
const target = configurations.find((entry) => entry.id === configurationId);
if (!target) {
  console.error(
    `There is no configuration ${configurationId} on that server. It has: ` +
      configurations.map((entry) => `${entry.id} (${entry.name})`).join(", "),
  );
  process.exit(3);
}
console.log(`signed in — target configuration is "${target.name}"`);

if (dryRun) {
  console.log("\nDRY RUN — nothing was changed. Drop --dry-run to send it.");
  process.exit(0);
}

// The server reads the package name and version out of the APK itself; nothing here parses or guesses.
const bytes = await readFile(apkPath);
const file = new File([bytes], basename(apkPath), { type: "application/vnd.android.package-archive" });

const result = await uploadHeadwindApp({ configurationId, file, showIcon: true }, actor);

console.log(`\npackage : ${result.packageName ?? "(server did not name it)"}`);
console.log(`version : ${result.version ?? "(server did not name it)"}`);
console.log(`on rules: ${result.installed ? "yes" : "NO"}`);
console.log(`\n${result.message}`);

if (!result.installed) process.exit(4);
