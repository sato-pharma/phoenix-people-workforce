import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

export function runEmailAdminControlCenterTests() {
  const adminService = source("src/lib/notifications/email-admin.ts");
  const page = source("app/(admin)/admin/notifications/email/page.tsx");
  const component = source("src/components/admin/email-admin-control-center.tsx");
  const navigation = source("src/config/system-navigation.ts");

  assert.match(adminService, /export async function getEmailAdminControlCenter/);
  assert.match(adminService, /\.eq\("channel", "email"\)/, "delivery queries must scope to the email channel");
  assert.match(adminService, /head: true/, "status counts must use head:true (count only, no rows) rather than fetching every row");
  assert.match(adminService, /sentCount/);
  assert.match(adminService, /pendingCount/);
  assert.match(adminService, /failedCount/);
  assert.match(adminService, /skippedCount/);
  assert.match(adminService, /retryingCount/);
  assert.match(adminService, /hasMoreDeliveries|hasMore/, "listing must expose whether results were capped");
  assert.doesNotMatch(
    adminService,
    /select\(\s*"id,attempts,last_error,next_attempt_at,recipient_address,recipient_hr_id,sent_at,status,updated_at,metadata/,
    "delivery listing must not select raw delivery metadata payloads",
  );
  assert.match(adminService, /tableMissing/, "must fail closed (empty result) rather than throw when the table is missing");

  assert.match(page, /canAccess\(access, "communication", "read"\)/, "page must reuse the communication permission resource, same as the Telegram admin page");
  assert.match(page, /getEmailAdminControlCenter\(\)/);
  assert.match(page, /data\.summary\.sentCount/);
  assert.match(page, /data\.summary\.pendingCount/);
  assert.match(page, /redirect\("\/admin"\)/, "unauthorized viewers must be redirected, not shown a broken page");

  assert.match(component, /EmailAdminControlCenterView/);
  assert.match(component, /STATUS_FILTERS/);
  assert.match(component, /Not sent = pending, retrying, failed, or skipped/);
  assert.doesNotMatch(component, /process\.env/, "client UI must never read or expose raw environment values");
  // Read-only by design: no mutation/retry endpoint exists for this page (see the
  // architecture note in email-admin.ts), so the component must never issue a
  // write request the way the Telegram admin component does.
  assert.doesNotMatch(component, /fetch\(["'`]\/api\/admin\/notifications\/email/, "email delivery status page is read-only and must not call a mutation API");
  assert.doesNotMatch(component, /method:\s*["'](POST|PATCH|DELETE)["']/, "email delivery status page must not perform write requests");

  assert.match(navigation, /href: "\/admin\/notifications\/email"/);
  assert.match(navigation, /label: "Email Delivery"/);
}
