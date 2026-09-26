import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

  assert.ok(webTabs.length >= 8, `PhoenixCrmTabs must still be read as boolean fields — found ${webTabs.join(", ") || "none"}`);
  assert.deepEqual(
    [...phoneTabs].sort(),
    [...webTabs].sort(),
    "the phone's `tabs` mirror and PhoenixCrmTabs must hold the same keys — a key on one side only is a tab that silently never renders",
  );

  // The phone's own mirror is a TYPE mirror, not a rendering promise: it carries all eight keys while
  // the shell draws six. Pinning that the two manager keys are among them is what stops a trim of the
  // mirror "because the phone does not use them" from breaking B3.
  for (const key of ["team", "today", "visits", "list", "plan", "reports"]) {
    assert.ok(phoneTabs.includes(key), `the phone's tabs mirror is missing \`${key}\``);
  }

  console.log("phoenix-crm mobile mirrors: OK");
}
