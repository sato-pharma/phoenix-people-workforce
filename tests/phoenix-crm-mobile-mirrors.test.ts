import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { shouldWarnUnsavedVoiceNote } from "../src/lib/phoenix-crm/unsaved-voice-note.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the phone's mirrors of the web module, compared rather than trusted.
 *
 * `mobile/` is its own TypeScript project and cannot import the web module: a server service pulls a
 * database client and `node:crypto` into a phone bundle. So two things are TRANSCRIBED by hand —
 * the entry-size limits (`mobile/src/lib/crm/entry-rules.ts`) and the shape of the overview
 * (`mobile/src/lib/crm/types.ts`) — and until now **nothing compared them with their originals**.
 *
 * Both halves fail silently, which is why they are worth a test:
 *
 *   - a size limit that drifts lets the phone accept 200 characters the server then cuts to 120, and
 *     the rep loses what he typed with no error anywhere;
 *   - a tab added to `PhoenixCrmTabs` and not to the phone's mirror is a tab the app cannot render —
 *     `overview.tabs.<new>` is simply `undefined`, which is falsy, so the sub-tab never appears and
 *     nothing fails. That is exactly how a manager would have been given a Team tab on the browser
 *     and none on the phone.
 *
 * The comparison is by NAME across the web module, not against one hard-coded file, because the
 * twins genuinely live in four places — `entry-rules.ts`, `plan-rules.ts`, `unplanned-rules.ts` and
 * the list screens. Resolving by name is what lets the phone borrow a constant from wherever the web
 * happens to keep it without this test having to be edited.
 */

const ROOT = new URL("../", import.meta.url);

function read(path: string): string {
  return stripComments(readFileSync(new URL(path, ROOT), "utf8"));
}

/** The web files a phone constant may be mirrored from, each named for why it is on the list. */
const WEB_SOURCES: ReadonlyArray<string> = [
  "src/lib/phoenix-crm/entry-rules.ts", // the module's own limits
  "src/lib/phoenix-crm/plan-rules.ts", // the plan note and the decision note
  "src/lib/phoenix-crm/unplanned-rules.ts", // the off-plan decision note
  "src/components/phoenix-crm/list-screens.tsx", // SPECIALITY_TEXT_MAX, which lives beside its form
];

/** `{ from `{`, to its match }` — the text inside a brace block, comments already blanked. */
function braceBlock(source: string, anchor: string, what: string): string {
  const at = source.indexOf(anchor);
  assert.notEqual(at, -1, `${what} is still declared as \`${anchor}\` — this test resolves it by that exact text`);
  const open = source.indexOf("{", at);
  assert.notEqual(open, -1, `${what} still opens a block`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  assert.fail(`${what} has an unbalanced block`);
}

/** The boolean field names of one `tabs` literal, in the order they are written. */
function tabKeys(block: string): string[] {
  return [...block.matchAll(/(^|\n)\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*boolean\s*;/g)].map((match) => match[2]);
}

export function runPhoenixCrmMobileMirrorsTests(): void {
  // ── 1. Every size limit the phone holds equals its web twin ────────────────────────────────────

  const phoneRules = read("mobile/src/lib/crm/entry-rules.ts");
  const phoneConstants = [...phoneRules.matchAll(/export const ([A-Z][A-Z0-9_]*) = (\d+);/g)].map((match) => ({
    name: match[1],
    value: Number(match[2]),
  }));

  // A floor, so a renamed or moved phone file cannot pass by matching nothing at all.
  assert.ok(
    phoneConstants.length >= 8,
    `the phone's entry-rules must still export its size limits — found ${phoneConstants.length}, which means this test swept nothing`,
  );

  const webSources = WEB_SOURCES.map((path) => ({ path, code: read(path) }));
  for (const constant of phoneConstants) {
    const found = webSources.flatMap((source) => {
      const match = new RegExp(`(?:export )?const ${constant.name} = (\\d+);`).exec(source.code);
      return match ? [{ path: source.path, value: Number(match[1]) }] : [];
    });
    assert.equal(
      found.length > 0,
      true,
      `${constant.name} is on the phone with no web twin — a limit the phone invents is a limit the server does not enforce`,
    );
    for (const twin of found) {
      assert.equal(
        twin.value,
        constant.value,
        `${constant.name} is ${constant.value} on the phone and ${twin.value} in ${twin.path} — the phone would cap a field at a length the server does not`,
      );
    }
  }

  // The two the manager's screens brought in, named so a later trim cannot quietly drop them.
  for (const required of ["PLAN_DECISION_NOTE_MAX", "UNPLANNED_DECISION_NOTE_MAX", "DROP_REASON_MAX"]) {
    assert.ok(
      phoneConstants.some((constant) => constant.name === required),
      `${required} must stay on the phone — the manager's Return and Refuse notes are capped by it`,
    );
  }

  // ── 2. The two `tabs` literals hold exactly the same keys ──────────────────────────────────────

  const webTabs = tabKeys(braceBlock(read("src/lib/phoenix-crm/server/overview.ts"), "export type PhoenixCrmTabs", "PhoenixCrmTabs"));
  // Anchored on the `tabs` field itself, not on CrmOverview: brace-matching the whole type would sweep
  // in `viewer.isSuperAdmin`, `isRep` and the rest, which are booleans and are not tabs.
  const phoneTabs = tabKeys(braceBlock(read("mobile/src/lib/crm/types.ts"), "\n  tabs: {", "the phone's tabs mirror"));

  assert.ok(webTabs.length >= 7, `PhoenixCrmTabs must still be read as boolean fields — found ${webTabs.join(", ") || "none"}`);

  // 🔴 ONE KEY IS EXPECTED ON THE PHONE AND NOT ON THE WEB, AND IT IS NOT DRIFT.
  //
  // The owner retired the Today MODULE from Phoenix CRM on 2026-09-30 and replaced it with a panel on
  // the rep's landing page, so `today` left `PhoenixCrmTabs`. The phone's mirror still carries it, and
  // the mobile app is FROZEN (AGENTS.md §4) — it may not be edited, planned or touched until he lifts
  // that in his own words. So the two sides legitimately differ by this one key until then.
  //
  // The guard is NOT relaxed: every OTHER key must still match exactly, and the web may not carry a
  // key the phone lacks, which is the direction that makes a tab silently never render on the phone.
  const RETIRED_ON_WEB_ONLY = ["today"];

  // 🔴 AND ONE THE OTHER WAY, FOR THE SAME REASON AND FOR NO OTHER.
  //
  // The owner asked for the team calendar as its own tab on 2026-09-30, so `calendar` joined
  // `PhoenixCrmTabs`. The phone's mirror cannot follow it: the mobile app is FROZEN (AGENTS.md §4)
  // and may not be edited, planned or touched until he lifts that in his own words. So the tab does
  // not render on the phone — which is not drift, it is what the freeze MEANS for any web tab added
  // while it lasts, and the alternative is a web tab he asked for that cannot be built at all.
  //
  // 🔴 WHEN THE FREEZE LIFTS, EVERY KEY HERE GOES INTO `mobile/src/lib/crm/types.ts` AND THIS LIST
  // GOES BACK TO EMPTY. It is not a place to park a tab somebody decided the phone does not need —
  // the two checks under it make a stale entry fail rather than rot.
  // `forecast` joined on 2026-10-01 for the same reason: the owner asked for the CNS daily forecast as
  // its own module, on the web, while the freeze holds.
  // `testAccounts` joined on 2026-10-22: the Super Admin's own tab for the test personas' approvals, on
  // the web, while the freeze holds.
  const WEB_ONLY_WHILE_MOBILE_IS_FROZEN = ["calendar", "forecast", "testAccounts"];
  for (const key of WEB_ONLY_WHILE_MOBILE_IS_FROZEN) {
    assert.ok(webTabs.includes(key), `\`${key}\` is listed as web-only and is not a web tab — retire the entry`);
    assert.ok(!phoneTabs.includes(key), `\`${key}\` reached the phone — take it out of WEB_ONLY_WHILE_MOBILE_IS_FROZEN`);
  }

  assert.deepEqual(
    [...phoneTabs].filter((key) => !RETIRED_ON_WEB_ONLY.includes(key)).sort(),
    [...webTabs].filter((key) => !WEB_ONLY_WHILE_MOBILE_IS_FROZEN.includes(key)).sort(),
    "the phone's `tabs` mirror and PhoenixCrmTabs must hold the same keys — a key on one side only is a tab that silently never renders",
  );
  for (const key of webTabs) {
    if (WEB_ONLY_WHILE_MOBILE_IS_FROZEN.includes(key)) continue;
    assert.ok(phoneTabs.includes(key), `the web has \`${key}\` and the phone does not — that tab can never render there`);
  }

  // The phone's own mirror is a TYPE mirror, not a rendering promise: it carries all eight keys while
  // the shell draws six. Pinning that the two manager keys are among them is what stops a trim of the
  // mirror "because the phone does not use them" from breaking B3.
  for (const key of ["team", "today", "visits", "list", "plan", "reports"]) {
    assert.ok(phoneTabs.includes(key), `the phone's tabs mirror is missing \`${key}\``);
  }

  // ── 3. The phone's outbox rules equal the web's, line for line ────────────────────────────────
  //
  // This mirror exists because `@/*` resolves to `mobile/src/*` and nothing else, so the web
  // `outbox-rules.ts` is unreachable from the phone. `drainOutbox` takes its rules as an argument to
  // keep ONE definition — and with no mobile file able to supply them the queue shipped uncallable
  // (#4560). The mirror fixes that and this is what stops the copy drifting.
  //
  // Three kinds of drift, all silent: a bigger ceiling lets the phone hold visits the server's rules
  // never agreed to; a settled code on one side only deletes a rep's work on one side only; and a
  // reworded line breaks Golden Rule #1 in the one place the rep actually reads.
  {
    const web = read("src/lib/phoenix-crm/outbox-rules.ts");
    const phone = read("mobile/src/lib/crm/outbox-rules.ts");

    for (const name of ["OUTBOX_MAX_ITEMS", "OUTBOX_MAX_AGE_HOURS"]) {
      const webValue = new RegExp(`export const ${name} = ([^;]+);`).exec(web);
      const phoneValue = new RegExp(`export const ${name} = ([^;]+);`).exec(phone);
      assert.ok(webValue, `${name} is gone from the web outbox rules`);
      assert.ok(phoneValue, `${name} is missing from the phone's mirror`);
      assert.equal(
        phoneValue![1].trim(),
        webValue![1].trim(),
        `${name} differs between the phone and the web module — the phone would hold a queue the server's rules never sized`,
      );
    }

    const codesOf = (code: string): string[] => {
      const block = /OUTBOX_SETTLED_CODES: readonly string\[\] = \[([\s\S]*?)\]/.exec(code);
      assert.ok(block, "OUTBOX_SETTLED_CODES is no longer a literal array — this comparison reads it as one");
      return [...block![1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    };
    const webCodes = codesOf(web);
    assert.ok(webCodes.length >= 5, `the settled list was read as ${webCodes.length} codes, so this swept nothing`);
    assert.deepEqual(
      codesOf(phone),
      webCodes,
      "🔴 the settled refusal codes differ between the phone and the web module — one side would throw a rep's visit away that the other keeps",
    );

    // The exact sentences, because these are the only words about the queue a rep ever sees.
    for (const sentence of [
      "1 visit is saved on this phone. It will send itself when there is signal.",
      "This phone is holding as many visits as it can. Find signal for a moment so they can send, then carry on.",
    ]) {
      assert.ok(web.includes(sentence), `the web rules no longer say "${sentence}"`);
      assert.ok(phone.includes(sentence), `🔴 the phone's mirror no longer says "${sentence}" — the rep reads the phone's copy`);
    }
  }

  // ── 4. The unsaved voice-note warning reads the same on both ──────────────────────────────────
  //
  // THE REP READS THE PHONE'S COPY. This warning exists because a rep lost nine recordings in one
  // day, so a sentence that drifts here — or a phone whose second press never lets him out — is the
  // whole defect coming back on the platform that caused it. Compared sentence for sentence and
  // behaviour for behaviour, not merely "the file exists".
  {
    const web = read("src/lib/phoenix-crm/unsaved-voice-note.ts");
    const phone = read("mobile/src/lib/crm/unsaved-voice-note.ts");

    for (const name of [
      "UNSAVED_VOICE_NOTE_WARNING",
      "UNSAVED_VOICE_NOTE_STAY_LABEL",
      "UNSAVED_VOICE_NOTE_LEAVE_LABEL",
    ]) {
      const pattern = new RegExp(`export const ${name} =\\s*("[^"]*")`);
      const webValue = pattern.exec(web);
      const phoneValue = pattern.exec(phone);
      assert.ok(webValue, `${name} is gone from the web module`);
      assert.ok(phoneValue, `${name} is gone from the phone's mirror`);
      assert.equal(
        phoneValue![1],
        webValue![1],
        `🔴 ${name} differs between the phone and the web module — the rep reads the phone's copy`,
      );
    }

    // The words that would turn it from a fact about the app into an accusation about him. Golden
    // Rule #1: he is never made to feel caught, and "you forgot" is exactly that in miniature.
    for (const forbidden of [/you forgot/i, /\bunsaved changes\b/i, /\bwarning\b/i, /\berror\b/i]) {
      assert.ok(!forbidden.test(web), `the web warning must not say ${forbidden}`);
      assert.ok(!forbidden.test(phone), `the phone's warning must not say ${forbidden}`);
    }

    // IT WARNS, IT NEVER REFUSES — the one-shot guard, on both sides. A mirror that dropped the
    // `warned` check would show the same message on every press and trap the rep in the form.
    //
    // The web half is asked by RUNNING it, which is stronger than reading its text and is what let
    // the web guard grow a second case (a microphone still open, 2026-10-02) without this test
    // having to be loosened. The phone cannot be imported from here — it is its own TypeScript
    // project — so its copy is still read, in the shape it is written in.
    assert.equal(shouldWarnUnsavedVoiceNote({ hasVoiceNote: true, recording: true, saving: false, warned: true }), false, "the web guard is no longer one-shot — a rep could not leave");
    assert.equal(shouldWarnUnsavedVoiceNote({ hasVoiceNote: true, recording: true, saving: true, warned: false }), false, "the web guard would interrupt a save in flight");
    assert.match(phone, /if \(state\.warned\) return false;/, "the phone guard is no longer one-shot — a rep could not leave");
    assert.match(phone, /if \(state\.saving\) return false;/, "the phone guard would interrupt a save in flight");
    assert.ok(web.length > 0, "the web module is still there to compare the phone's sentences against");
  }

  console.log("phoenix-crm mobile mirrors: OK");
}
