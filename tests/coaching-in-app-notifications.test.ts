import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const submitRouteSource = readFileSync(
  new URL("../app/api/coaching/reports/[id]/submit/route.ts", import.meta.url),
  "utf8",
);
const notificationSource = readFileSync(
  new URL("../src/lib/notifications/in-app.ts", import.meta.url),
  "utf8",
);
const templateServiceSource = readFileSync(
  new URL("../src/lib/email-templates/service.ts", import.meta.url),
  "utf8",
);
// placeholderHints now derives from token-registry.ts (2026-07-23 consolidation) rather than
// hand-listing each token's string literal in service.ts itself.
const tokenRegistrySource = readFileSync(
  new URL("../src/lib/email-templates/token-registry.ts", import.meta.url),
  "utf8",
);
const coachingEmailMigrationSource = readFileSync(
  new URL("../supabase/_migrations_archive/pre-baseline-2026-07-11/20260619153900_coaching_report_email_score_table.sql", import.meta.url),
  "utf8",
);

export function runCoachingInAppNotificationTests() {
  assert.match(
    submitRouteSource,
    /submitCoachingReport\(id, submitInput\(payload\), access\)/,
    "Coaching notification must run after successful submit service call.",
  );
  assert.match(
    submitRouteSource,
    /createSystemNotification\(\{/,
    "Coaching submit route must create notifications through the central engine.",
  );
  assert.match(
    submitRouteSource,
    /recipientHrId: report\.report\.medical_rep_hr_id/,
    "Coaching notification recipient must come from submitted report medical_rep_hr_id.",
  );
  assert.match(
    submitRouteSource,
    /category: "coaching_report"/,
    "Coaching notification category must be coaching_report.",
  );
  assert.match(
    submitRouteSource,
    /idempotencyKey: `coaching_report_submitted:\$\{report\.report\.id\}:\$\{report\.report\.medical_rep_hr_id\}`/,
    "Coaching notification must use report and employee HR_ID dedupe key.",
  );
  assert.match(
    submitRouteSource,
    /actionUrl: `\/employee-portals\/coaching\/\$\{report\.report\.id\}`/,
    "Coaching notification must link to the employee coaching review route.",
  );
  assert.match(
    submitRouteSource,
    /templateContext: scoreContext/,
    "Coaching notification email must pass the score table context to the templated email.",
  );
  assert.match(
    submitRouteSource,
    /Metric<\/th><th[\s\S]*Score<\/th>/,
    "Coaching notification email table must include Metric and Score columns.",
  );
  assert.match(
    tokenRegistrySource,
    /"scoreTable"/,
    "Coaching score table must be registered as an email template placeholder.",
  );
  assert.match(
    templateServiceSource,
    /\{\{scoreTable\}\}/,
    "Coaching report email template must render the score table token.",
  );
  assert.match(
    coachingEmailMigrationSource,
    /where\s+(?:email_templates\.)?template_key = 'coaching_report'/i,
    "A migration must update the stored coaching_report template row.",
  );
  assert.match(
    notificationSource,
    /\.from\("notification_events"\)/,
    "In-app notifications must use the existing notification_events table.",
  );
  assert.match(
    notificationSource,
    /event_key: eventKey/,
    "In-app notifications must store the dedupe key as event_key.",
  );
  assert.doesNotMatch(
    notificationSource,
    /recipients\.cs\.\[/,
    "In-app notification reads must not hand-build invalid text[] contains filters.",
  );
  assert.match(
    notificationSource,
    /\.overlaps\("recipients"/,
    "In-app notification reads must use Supabase's array filter builder for recipient matching.",
  );
}
