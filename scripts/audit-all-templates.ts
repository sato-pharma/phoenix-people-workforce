// Audits the LIVE merged content (DB-published override, or code default when unpublished) of
// every email template for: unresolved {{token}}s, leftover single-brace syntax that will
// never render, and hardcoded hrefs. Complements tests/email-render-harness.test.ts, which only
// scans templateDefaults' static source — a bug in a published DB row (like the two this script
// found on 2026-07-23: interview_invitation's single-brace tokens, contract_renewal's stale
// greeting) is invisible to that test. Run with:
//   node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs scripts/audit-all-templates.ts
import { emailTemplateKeys, getEmailTemplate } from "../src/lib/email-templates/service.ts";
import { contextVariables } from "../src/lib/email-templates/render-core.ts";
import { listEmailCustomVariables } from "../src/lib/email-templates/custom-variables.ts";

async function main() {
  const resolvable = new Set(Object.keys(contextVariables({}, "Team")));
  const customVariables = await listEmailCustomVariables();
  for (const v of customVariables) resolvable.add(v.token);

  const tokenPattern = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  const bracePattern = /\{[a-zA-Z][a-zA-Z0-9_]*\}/g; // single-brace leftovers

  for (const key of emailTemplateKeys) {
    const row = await getEmailTemplate(key);
    if (!row) {
      console.log(`${key}: NOT FOUND`);
      continue;
    }
    const fields: Record<string, string> = {
      subject: row.subject ?? "",
      greeting: row.greeting ?? "",
      bodyHtml: row.bodyHtml ?? "",
      bodyText: row.bodyText ?? "",
      closingText: row.closingText ?? "",
    };

    const unresolved: string[] = [];
    const singleBrace: string[] = [];
    const hrefs: string[] = [];

    for (const [field, value] of Object.entries(fields)) {
      for (const m of value.matchAll(tokenPattern)) {
        const token = m[1];
        if (!resolvable.has(token)) unresolved.push(`${field}:{{${token}}}`);
      }
      // Mask out valid {{token}} matches first so a single-brace check doesn't false-positive
      // on the inner substring of a double-brace token (e.g. "{{jobTitle}}" contains "{jobTitle}").
      const masked = value.replace(tokenPattern, "");
      for (const m of masked.matchAll(bracePattern)) {
        singleBrace.push(`${field}:${m[0]}`);
      }
      if (field === "bodyHtml") {
        for (const m of value.matchAll(/href="([^"]*)"/g)) {
          hrefs.push(m[1]);
        }
      }
    }

    const hardcodedHrefs = hrefs.filter((h) => !h.includes("{{"));

    if (unresolved.length || singleBrace.length || hardcodedHrefs.length) {
      console.log(`\n=== ${key} ===`);
      if (unresolved.length) console.log(`  UNRESOLVED TOKENS: ${unresolved.join(", ")}`);
      if (singleBrace.length) console.log(`  SINGLE-BRACE LEFTOVER: ${singleBrace.join(", ")}`);
      if (hardcodedHrefs.length) console.log(`  HARDCODED HREF: ${hardcodedHrefs.join(", ")}`);
    }
  }
  console.log("\nDone.");
}

main().catch((error) => {
  console.error("Failed:", error);
  process.exit(1);
});
