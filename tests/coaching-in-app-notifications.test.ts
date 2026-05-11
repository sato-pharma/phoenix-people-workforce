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

export function runCoachingInAppNotificationTests() {
  assert.match(
    submitRouteSource,
    /submitCoachingReport\(id, submitInput\(payload\), access\)/,
    "Coaching notification must run after successful submit service call.",
  );
  assert.match(
    submitRouteSource,
    /enqueueInAppNotification\(\{/,
    "Coaching submit route must enqueue an in-app notification.",
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
    /dedupeKey: `coaching_report_submitted:\$\{report\.report\.id\}:\$\{report\.report\.medical_rep_hr_id\}`/,
    "Coaching notification must use report and employee HR_ID dedupe key.",
  );
  assert.match(
    submitRouteSource,
    /href: `\/employee-portals\/coaching\/\$\{report\.report\.id\}`/,
    "Coaching notification must link to the employee coaching review route.",
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
}
