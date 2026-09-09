import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { systemNotificationEmailText } from "@/config/system-settings.ts";

/**
 * Owner rule, 2026-09-10: never "Dear Team" — say who is being addressed.
 *
 * There are two sources of it and the second is easy to miss. A template can hold the words
 * literally in its greeting; but {{recipientName}} ALSO fell back to "Phoenix Team" whenever no
 * name resolved, so a greeting that looks personalised still rendered as "Dear Phoenix Team,".
 * Fixing only the literal half leaves the fallback quietly producing it.
 */
export function runEmailGreetingNamesTheAudienceTests() {
  // --- The last-resort fallbacks must not address an unnamed group --------------------
  for (const [name, value] of [
    ["teamGreeting", systemNotificationEmailText.teamGreeting],
    ["teamRecipientName", systemNotificationEmailText.teamRecipientName],
  ] as const) {
    assert.ok(value && value.trim().length > 0, `${name} must not be empty — the greeting would read "Dear ,"`);
    assert.doesNotMatch(
      value,
      /\bteam\b/i,
      `${name} is "${value}" — it must not address an unnamed team; say who is being written to`,
    );
  }

  // --- No template default may greet an unnamed team ----------------------------------
  // Read as source: service.ts pulls in the JSX layout and the Supabase admin client, so this
  // runner cannot import it. Only the greeting lines are inspected, so a comment mentioning the
  // phrase (there is one, recording the rule) cannot make this pass or fail by accident.
  const service = readFileSync("src/lib/email-templates/service.ts", "utf8");
  const greetings = [...service.matchAll(/^ {4}greeting: "([^"]*)",$/gm)].map((m) => m[1]);

  assert.ok(greetings.length > 20, `expected every template to declare a greeting, found ${greetings.length}`);

  for (const greeting of greetings) {
    assert.doesNotMatch(
      greeting,
      /\bteam\b/i,
      `template greeting "${greeting}" addresses an unnamed team — name the audience, or greet the recipient with {{recipientName}}`,
    );
    assert.ok(
      greeting.trim().length > 0,
      "a template greeting must not be empty",
    );
  }

  // --- The two shapes that DO satisfy the rule ----------------------------------------
  // Either the greeting names the person it reaches, or it names the audience concretely
  // (the Monthly Closing template's "Dear {{line}} Leaders," is the owner-approved example).
  const named = greetings.filter((g) => g.includes("{{recipientName}}") || g.includes("{{line}}"));
  assert.ok(
    named.length > 0,
    "at least some greetings must resolve a name or a line — otherwise nothing is addressing anybody",
  );
}
