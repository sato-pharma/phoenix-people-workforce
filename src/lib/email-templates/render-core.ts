// Pure email-template render core, extracted from service.ts so it can be unit-tested WITHOUT pulling
// in the JSX layout (@/emails/phoenix-email-layout.tsx), which the type-stripping test runner can't
// execute. This module has ZERO non-type runtime imports other than the pure token-registry module —
// the token substitution engine + the render-variable map live here and are exercised by
// tests/email-render-harness.test.ts.
//
// The map below (contextVariables) is the authoritative render whitelist: interpolate() resolves a
// {{token}} ONLY from these keys, so a token declared on EmailTemplateContext + used in a template body
// but MISSING here renders EMPTY. That gap shipped the blank probation emails (2026-07-14). Its base is
// now GENERATED from token-registry.ts's TOKEN_REGISTRY (the single source of truth for every token —
// see that file's header), so a token present on EmailTemplateContext but missing from the registry is
// the only way this can still happen; the harness test's token-registry-consistency check guards
// against every OTHER form of drift (placeholderHints, variableCatalog, htmlBlockTokens).

import type { EmailTemplateContext } from "./service";
import { HTML_BLOCK_TOKENS, TOKEN_REGISTRY } from "./token-registry";

function text(value: unknown) {
  return String(value ?? "").trim();
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Tokens whose values are trusted pre-rendered HTML blocks (system-built, e.g. the submitted-plan
 * table). They bypass per-value escaping in bodyHtml; the whole interpolated body still goes through
 * sanitizeEmailTemplateHtml afterwards. In text fields these tokens resolve to their text projection.
 */
export const htmlBlockTokens: ReadonlySet<string> = new Set(HTML_BLOCK_TOKENS);

export function interpolate(
  template: string,
  variables: Record<string, string>,
  escapeValues: boolean,
  rawHtmlTokens?: ReadonlySet<string>,
) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = variables[key] ?? "";
    return escapeValues && !rawHtmlTokens?.has(key) ? escapeHtml(value) : value;
  });
}

// Explicit return type is required, not stylistic: TypeScript's inferred return type for a
// function returning `{...indexSignatureRecord, ...literalProps}` drops the index signature
// entirely, leaving only the literal keys visible to callers (a known TS spread-inference
// limitation) — every caller that reads a plain token like variables.ctaUrl would fail to
// typecheck without this annotation, even though the value is genuinely there at runtime.
export function contextVariables(input: Partial<EmailTemplateContext>, recipientName: string): Record<string, string> {
  // Generated from TOKEN_REGISTRY — every plain token resolves to text(input.<token>) with no
  // special-casing. See the small, fixed set of genuine special cases layered on top below.
  const base: Record<string, string> = {};
  for (const t of TOKEN_REGISTRY) base[t.token] = text(input[t.token]);

  return {
    ...base,
    // ── Genuine special cases — not expressible as a plain TOKEN_REGISTRY entry ──
    ctaLabel: text(input.ctaLabel || "Open in Phoenix Workforce"),
    date: text(input.date || new Date().toISOString().slice(0, 10)),
    recipientName,
    // HTML-block tokens' plain-text projection siblings. Not separate TOKEN_REGISTRY entries —
    // they never appear literally as {{xxxText}} in a template body. See TokenDefinition.isHtmlBlock.
    detailsTableText: text(input.detailsTableText),
    planTableText: text(input.planTableText),
    digestTableText: text(input.digestTableText),
    scoreTableText: text(input.scoreTableText),
    productsTableText: text(input.productsTableText),
    returnCalloutText: text(input.returnCalloutText),
    noActivityTableText: text(input.noActivityTableText),
  };
}
