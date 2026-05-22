import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runEmailNotificationTests() {
  const source = readFileSync("src/lib/notifications/email.ts", "utf8");
  const sendPhoenixEmailSource = readFileSync("src/lib/email/send-phoenix-email.ts", "utf8");

  for (const type of ["probation", "contract_renewal", "birthday", "offer", "resignation"]) {
    assert.match(source, new RegExp(`"${type}"`));
  }
  assert.doesNotMatch(source, /"vacation"/);

  assert.match(source, /notification type is not approved for automatic Resend delivery/);
  assert.match(source, /buildEmailNotificationPreview/);
  assert.match(source, /resolveNotificationDelivery/);
  assert.match(sendPhoenixEmailSource, /PHOENIX_EMAIL_DELIVERY_MODE/);
  assert.match(sendPhoenixEmailSource, /PHOENIX_EMAIL_TEST_RECIPIENTS/);
  assert.match(sendPhoenixEmailSource, /omar\.anwar@satopharma\.com/);
  assert.match(sendPhoenixEmailSource, /phoenix@satopharma\.com/);
  assert.match(sendPhoenixEmailSource, /testingRecipients \? undefined : input\.cc/);

  const centerSource = readFileSync("src/components/admin/email-notification-center.tsx", "utf8");
  assert.match(centerSource, /<select/);
  assert.match(centerSource, /buildLiveEmailPreview/);
  assert.match(centerSource, /Preview updates live/);
  assert.match(centerSource, /Advanced targeting/);
  assert.doesNotMatch(centerSource, /policies\.map\(\(policy\) => \(\s*<div/);
}
