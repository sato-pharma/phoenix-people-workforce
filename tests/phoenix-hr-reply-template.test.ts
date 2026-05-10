import assert from "node:assert/strict";

import {
  buildPhoenixHrReplyEmail,
  phoenixHrEmailSignatureHostedUrl,
} from "../src/lib/email/phoenix-hr-reply-template.ts";

export function runPhoenixHrReplyTemplateTests() {
  const result = buildPhoenixHrReplyEmail({
    cc: "hr@satopharma.com",
    recipientName: "Omar",
    replyMessage: "Please review <policy>.\n\nSecond line.",
    senderName: "HR Operations",
    subject: "Re: Request",
    to: "omar.anwar@satopharma.com",
    tone: "firm",
  });

  assert.match(result.html, /Phoenix Workforce HR System/);
  assert.match(result.html, /Official HR Response/);
  assert.match(result.html, new RegExp(phoenixHrEmailSignatureHostedUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.html, /<img/);
  assert.match(result.html, /width="112"/);
  assert.match(result.html, /text-align:left/);
  assert.doesNotMatch(result.html, /src="\/assets/);
  assert.doesNotMatch(result.html, /localhost/);
  assert.doesNotMatch(result.html, /phoenix-email-ember-line\.gif/);
  assert.match(result.html, /@media screen and \(max-width: 640px\)/);
  assert.match(result.html, /@keyframes phoenixGlow/);
  assert.match(result.html, /@keyframes phoenixSweep/);
  assert.match(result.html, /@keyframes phoenixFloat/);
  assert.match(result.html, /role="presentation"/);
  assert.match(result.html, /background:#ffffff!important/);
  assert.match(result.html, /background-image:linear-gradient\(#ffffff,#ffffff\)/);
  assert.match(result.html, /color:#0f172a!important/);
  assert.doesNotMatch(result.html, />To</);
  assert.doesNotMatch(result.html, />CC</);
  assert.doesNotMatch(result.html, />Subject</);
  assert.doesNotMatch(result.html, /omar\.anwar@satopharma\.com/);
  assert.doesNotMatch(result.html, /hr@satopharma\.com/);
  assert.match(result.html, /Please review &lt;policy&gt;\./);
  assert.doesNotMatch(result.html, /Sato Pharma/);
  assert.doesNotMatch(result.html, /Please review recipients, CC, subject, and content before sending/);
  assert.match(result.plainText, /To: omar\.anwar@satopharma\.com/);
  assert.match(result.plainText, /CC: hr@satopharma\.com/);
  assert.match(result.plainText, /Best regards,\nHR Operations/);
  assert.doesNotMatch(result.plainText, /Sato Pharma/);
}
