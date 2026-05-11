import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runPhoenixHrReplyTemplateTests() {
  const layout = readFileSync("src/emails/phoenix-email-layout.tsx", "utf8");
  const hrTemplate = readFileSync("src/lib/email/phoenix-hr-reply-template.ts", "utf8");
  const composer = readFileSync("src/components/admin/email-reply-composer.tsx", "utf8");

  assert.match(layout, /Phoenix Workforce HR System/);
  assert.match(layout, /phoenixGlow/);
  assert.match(layout, /phoenixSweep/);
  assert.match(layout, /phoenixFloat/);
  assert.match(layout, /background:#070b12/);
  assert.match(layout, /background:#ffffff!important/);
  assert.match(layout, /width="112"/);
  assert.match(layout, /futuretalents\.satopharma\.com/);
  assert.doesNotMatch(layout.match(/phoenixEmailSignatureHostedUrl[\s\S]*?;/)?.[0] ?? "", /localhost|\/assets/);
  assert.match(hrTemplate, /renderPhoenixEmailHtml/);
  assert.match(hrTemplate, /renderPhoenixEmailText/);
  assert.match(hrTemplate, /Phoenix HR Response/);
  assert.doesNotMatch(hrTemplate, /Sato Pharma/);
  assert.doesNotMatch(hrTemplate, /Please review recipients, CC, subject, and content before sending/);
  assert.match(composer, /bcc/);
}
