// Written by /doctor on 2026-10-23. Applies the two settings changes the doctor run proposed:
//   1. skillOverrides["anthropic-skills:sato-brick-area-mapper"] = "off"  (stale duplicate skill)
//   2. the UserPromptSubmit task-rules-reminder hook timeout: 5 -> 30 seconds
// Idempotent: safe to run twice. Backs the file up first and writes UTF-8 with no BOM.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const file = path.join(os.homedir(), ".claude", "settings.json");
const backup = file + ".bak-doctor-2026-10-23";

const raw = fs.readFileSync(file, "utf8");
JSON.parse(raw); // refuse to touch a file that is already broken
if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw);

const j = JSON.parse(raw);

// --- change 1: the stale duplicate skill
j.skillOverrides = j.skillOverrides || {};
const SKILL = "anthropic-skills:sato-brick-area-mapper";
const skillBefore = j.skillOverrides[SKILL] ?? "(not set)";
j.skillOverrides[SKILL] = "off";

// --- change 2: the 5-second budget on a hook whose real work is reading a 3 KB file
let patched = 0;
const timeouts = [];
for (const group of j.hooks?.UserPromptSubmit ?? []) {
  for (const h of group.hooks ?? []) {
    const args = (h.args ?? []).join(" ");
    if (args.includes("task-rules-reminder.mjs prompt")) {
      timeouts.push(h.timeout ?? "(default)");
      h.timeout = 30;
      patched++;
    }
  }
}

fs.writeFileSync(file, JSON.stringify(j, null, 2), { encoding: "utf8" });

// prove it: re-read from disk and parse
const after = JSON.parse(fs.readFileSync(file, "utf8"));
let liveTimeout = null;
for (const group of after.hooks?.UserPromptSubmit ?? [])
  for (const h of group.hooks ?? [])
    if ((h.args ?? []).join(" ").includes("task-rules-reminder.mjs prompt")) liveTimeout = h.timeout;

console.log("");
console.log("  settings.json re-read and parsed OK");
console.log(`  skill override      ${SKILL}: ${skillBefore} -> ${after.skillOverrides[SKILL]}`);
console.log(`  task-rules timeout  ${timeouts.join(", ") || "(hook not found)"} -> ${liveTimeout}s   (hooks patched: ${patched})`);
console.log(`  backup              ${backup}`);
console.log("");
console.log(patched === 1 && after.skillOverrides[SKILL] === "off" ? "  DONE - both changes live." : "  CHECK THE LINES ABOVE - something did not match.");
console.log("");
