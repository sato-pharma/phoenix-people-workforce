import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseCrmContactCode } from "../src/lib/crm/contact-code.ts";

// `marketing_customer_contacts.crm_code` is unconstrained text that holds a CRM contact id, and the
// portal's marketing request picker prints " - CRM linked" beside any contact whose code parses.
// Both readers parsed it with a bare `Number.parseInt`, which stops at the first non-digit: a code
// stored as "66355 (old)" answered 66355 and badged the contact as linked to a CRM row the stored
// text does not name. Measured on production 2026-09-03 every one of the 133 non-empty codes is
// pure digits, so this is latent rather than live — which is exactly why it needs a test rather
// than a fix alone. Nothing on screen would change the day a code with a suffix is typed in.
//
// The second half of this file pins the NEGATIVE finding, which is the one a future session is
// likely to undo. 40 of those 133 codes do not appear in `ireports360_contacts`, and that reads as
// "40 dead codes" until you notice that table is keyed (agent_crm_id, contact_crm_id, list_type) —
// it is one agent's contact LIST, not a contact registry. It held 9,698 contacts across 70 agents
// while visits referenced 14,858 across 212, so 47% of genuinely visited contacts are missing from
// it, including everything reachable only through a resigned rep. All 40 carry real CRM visits and
// plan entries. Gating the badge on that table would unlink 40 correct contacts and invite a
// requester to re-enter a link that was already right.

const CONTACT_CODE_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/crm/contact-code.ts", import.meta.url)),
  "utf8",
);

const SERVICE_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/marketing-requests/service.ts", import.meta.url)),
  "utf8",
);

const CONTACT_TRADE_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/crm/contact-trade.ts", import.meta.url)),
  "utf8",
);

export function runCrmContactCodeTests() {
  // 1. The codes that exist in production must keep parsing. Every non-empty code measured on
  // 2026-09-03 was pure digits, and the smallest and largest live ones are pinned here so a
  // stricter rule can never quietly unlink the real data it was written to protect.
  assert.equal(parseCrmContactCode("66355"), 66355, "a plain CRM code must parse");
  assert.equal(parseCrmContactCode("105906"), 105906, "the largest live production code must parse");
  assert.equal(parseCrmContactCode("  98197  "), 98197, "surrounding whitespace must not defeat the parse");

  // 2. THE HEADLINE. Text that merely STARTS with digits is not a CRM code. `Number.parseInt`
  // answers 66355 for all four of these and badges the contact "CRM linked" against a row the text
  // does not name — a confident wrong link, which is worse than no link at all.
  assert.equal(parseCrmContactCode("66355 (old)"), null, "a code with a trailing note must not parse to the bare number");
  assert.equal(parseCrmContactCode("66355 / 66356"), null, "a code naming two contacts must not silently resolve to the first");
  assert.equal(parseCrmContactCode("66355-old"), null, "a suffixed code must not parse to the bare number");
  assert.equal(parseCrmContactCode("66355abc"), null, "trailing text must not be discarded");

  // 3. Unset is unlinked, by every spelling. The picker asks one question of this result, so any
  // of these leaking a number would print "CRM linked" on a contact nobody ever linked.
  assert.equal(parseCrmContactCode(null), null, "null must read as unlinked");
  assert.equal(parseCrmContactCode(undefined), null, "undefined must read as unlinked");
  assert.equal(parseCrmContactCode(""), null, "an empty code must read as unlinked");
  assert.equal(parseCrmContactCode("   "), null, "a whitespace-only code must read as unlinked");

  // 4. Values that are numeric but are not ids. A negative or zero id is not something the CRM
  // issues, and past MAX_SAFE_INTEGER two different codes compare equal — which links a contact to
  // the WRONG CRM row rather than to none, the one failure mode with no visible symptom.
  assert.equal(parseCrmContactCode("0"), null, "zero is not a CRM contact id");
  assert.equal(parseCrmContactCode("-5"), null, "a negative code is not a CRM contact id");
  assert.equal(parseCrmContactCode("12.5"), null, "a decimal is not a CRM contact id");
  assert.equal(parseCrmContactCode("1e5"), null, "exponent notation is not a CRM contact id");
  assert.equal(parseCrmContactCode("9007199254740993"), null, "a code past MAX_SAFE_INTEGER must not parse");

  // 5. Neither reader may re-derive the parse. This is the leg that regenerates: the two call
  // sites drifted to the same permissive `Number.parseInt` independently, so a third reader would
  // have too. Both must go through the shared parser.
  assert.match(
    SERVICE_SOURCE,
    /const parsedCrmId = parseCrmContactCode\(row\.crm_code\);/,
    "the draft workspace must parse crm_code with the shared strict parser",
  );
  assert.match(
    CONTACT_TRADE_SOURCE,
    /const parsed = parseCrmContactCode\(row\.crm_code\);/,
    "contact-trade must parse crm_code with the shared strict parser",
  );
  for (const [label, source] of [["service.ts", SERVICE_SOURCE], ["contact-trade.ts", CONTACT_TRADE_SOURCE]] as const) {
    assert.ok(
      !/Number\.parseInt\(\(row\.crm_code/.test(source),
      `${label} must not parse crm_code with a bare Number.parseInt — it accepts trailing text`,
    );
  }

  // 6. The badge must not be gated on the agent-scoped roster. `ireports360_contacts` is one
  // agent's contact list; resolving a marketing code against it marks 40 contacts with live CRM
  // visits as unlinked. The parser's header is what stops the next session making that change, so
  // the warning has to survive in the file rather than only in a commit message.
  // Tested as a QUERY rather than as a mention of the table's name: the warning comment beside the
  // parse names `ireports360_contacts` on purpose, and an assertion that fires on the documentation
  // telling you not to do the thing is an assertion that gets deleted rather than heeded.
  assert.ok(
    !/from\(\s*["'`]ireports360_contacts["'`]\s*\)/.test(SERVICE_SOURCE),
    "the contact picker must not read ireports360_contacts to decide whether a crm_code is linked — it is a roster, not a registry",
  );
  assert.match(
    CONTACT_CODE_SOURCE,
    /ireports360_contacts` is NOT a CRM contact registry/,
    "contact-code.ts must keep the warning that the roster is not a registry",
  );
}
