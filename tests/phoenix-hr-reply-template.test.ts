import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhoenixHrReplyTemplateTests() {
  const layout = readFileSync("src/emails/phoenix-email-layout.tsx", "utf8");
  const hrTemplate = readFileSync("src/lib/email/phoenix-hr-reply-template.ts", "utf8");
  const composer = readFileSync("src/components/admin/email-reply-composer.tsx", "utf8");

  assert.match(layout, /\$\{systemIdentity\.appName\} HR System/);
  assert.match(layout, /phoenixGlow/);
  assert.match(layout, /phoenixSweep/);
  assert.match(layout, /phoenixFloat/);
  assert.match(layout, /background:#070b12/);
  assert.match(layout, /<meta name="color-scheme" content="light dark"/);
  assert.match(layout, /@media \(prefers-color-scheme: dark\)/);
  assert.match(layout, /\.phoenix-body \{ background:#18212f !important/);
  assert.match(layout, /\[data-ogsc\] \.phoenix-body/);
  assert.match(layout, /phoenix-logo-card/);
  assert.match(layout, /\.phoenix-logo-card \{ background:transparent !important; border-color:transparent !important; \}/);
  assert.match(layout, /class="phoenix-logo-card" style="display:inline-block;padding:0;background:transparent;border:0;border-radius:0;line-height:0"/);
  assert.match(layout, /width="96"/);
  assert.doesNotMatch(layout, /\.phoenix-logo-card \{ background:#ffffff/);
  assert.doesNotMatch(layout, /<meta name="color-scheme" content="light" \/>/);
  assert.match(layout, /futuretalents\.satopharma\.com/);
  assert.doesNotMatch(layout.match(/phoenixEmailSignatureHostedUrl[\s\S]*?;/)?.[0] ?? "", /localhost|\/assets/);
  assert.match(hrTemplate, /renderPhoenixEmailHtml/);
  assert.match(hrTemplate, /renderPhoenixEmailText/);
  assert.match(hrTemplate, /Phoenix HR Response/);
  assert.doesNotMatch(hrTemplate, /Sato Pharma/);
  assert.doesNotMatch(hrTemplate, /Please review recipients, CC, subject, and content before sending/);
  assert.match(composer, /bcc/);
}
