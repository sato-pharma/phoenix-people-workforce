/**
 * The toolbox the sender sees and the toolbox the AI knows about must be the same toolbox.
 *
 * Owner 2026-09-12: "ADD A TOOLBOX EXACTLY LIKE THE ONE IN THE EMAIL COMPOSER ... AND TRAIN THE
 * AI TOOL ON IT IN WHICH IT UNDERSTANDS WHAT I WANT AND CAN USE EVERY TOOL."
 *
 * Three ways that promise can quietly break, one assertion each:
 *
 *   1. a button is added to the toolbar and nobody tells the model — the sender presses Align
 *      right, then asks the rewrite to "keep it right-aligned", and it silently cannot;
 *   2. the model is taught markup the email sanitizer throws away — it obeys, the formatting
 *      vanishes on the way out, and it looks like the model ignored him;
 *   3. the catalogue is written but never actually reaches the prompt.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EMAIL_TOOLBAR_TOOLS, toolboxPromptLines } from "@/lib/email/toolbar-tools";
import { sanitizeEmailTemplateHtml } from "@/lib/email/email-safety";
import { SATO_POLISH_INSTRUCTIONS } from "@/lib/sato-email/polish";

const EDITOR_SOURCE = "src/components/admin/email-body-editor.tsx";

/**
 * Every control the editor renders, read from its own source rather than from a list kept
 * alongside it — a second hand-maintained list is exactly the thing that goes stale.
 *
 * Two shapes carry a control's name: `label: "Bold"` inside the toolbar action array, and
 * `aria-label="Font size"` on the selects and the two direction buttons.
 */
function toolbarControlsInSource(): string[] {
  const source = readFileSync(EDITOR_SOURCE, "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(/\blabel:\s*"([^"]+)"/g)) names.add(match[1]);
  for (const match of source.matchAll(/aria-label="([^"]+)"/g)) names.add(match[1]);
  // `label`/`aria-label` also appear on things that are not toolbar controls: the variable-chip
  // type, the colour inputs nested inside their own labelled buttons. Those two colour inputs
  // carry the same names as the buttons around them, so the set collapses them anyway.
  return Array.from(names);
}

export function runSatoEmailToolboxTests() {
  const catalogued = new Set(EMAIL_TOOLBAR_TOOLS.map((tool) => tool.label));

  // 1 — the toolbar cannot grow a button the AI has never heard of.
  const controls = toolbarControlsInSource();
  assert.ok(controls.length > 15, `expected the editor to render a real toolbar, found ${controls.length} controls`);
  const untaught = controls.filter((control) => !catalogued.has(control));
  assert.deepEqual(
    untaught,
    [],
    "every toolbar control must be in EMAIL_TOOLBAR_TOOLS so the rewrite model knows the tool exists",
  );

  // The controls this change was asked for, named explicitly — a regex that stopped matching
  // would otherwise turn assertion 1 into a check that passes on an empty list.
  for (const control of ["Bold", "Align right", "Heading", "Quote", "Remove link", "Undo", "Redo"]) {
    assert.ok(controls.includes(control), `the toolbar should offer ${control}, like Gmail and Outlook do`);
  }

  // 2 — every tool is taught markup the email sanitizer actually keeps.
  for (const tool of EMAIL_TOOLBAR_TOOLS) {
    if (tool.markup === null) {
      assert.equal(tool.survivesAs, undefined, `${tool.label} has no markup, so it cannot survive as anything`);
      continue;
    }
    assert.ok(tool.survivesAs, `${tool.label} must say what survives sanitizing`);
    const sanitized = sanitizeEmailTemplateHtml(tool.markup);
    assert.ok(
      sanitized.includes(tool.survivesAs as string),
      `${tool.label}: the sanitizer dropped what this tool produces — taught "${tool.markup}", kept "${sanitized}"`,
    );
  }

  // 3 — the catalogue reaches the model, and reaches it with the sender's own phrasing so a
  // nudge like "bold the deadline" lands on the right tool.
  const lines = toolboxPromptLines();
  assert.equal(
    lines.length,
    EMAIL_TOOLBAR_TOOLS.filter((tool) => tool.markup !== null).length,
    "every tool that produces markup must be described to the model",
  );
  for (const line of lines) {
    assert.ok(SATO_POLISH_INSTRUCTIONS.includes(line), `the rewrite prompt is missing a toolbox line: ${line}`);
  }
  assert.ok(
    SATO_POLISH_INSTRUCTIONS.includes('"bold the deadline"'),
    "the prompt must carry the sender's own phrasing, not just the tool's formal label",
  );

  // The tools that were previously forbidden outright. The old prompt told the model to write no
  // style attribute at all; if that sentence ever comes back it silently disables the toolbox.
  assert.ok(
    !SATO_POLISH_INSTRUCTIONS.includes("Do not write any style, colour, font or width attribute"),
    "the blanket style ban was replaced by the toolbox — restoring it would mute every formatting tool",
  );
}
