import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

// Rule 7 — scheduling / rescheduling / cancelling an interview notifies all
// parties (candidate by email, interviewer in-app + email, owner in-app).
// Static-source invariant so the wiring can't silently regress.

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

export function runRecruitmentInterviewNotificationsTests() {
  const notify = read("src/lib/recruitment/interview-notifications.ts");
  assert.match(notify, /safeSendNotificationEmail/, "must email via safeSendNotificationEmail");
  assert.match(notify, /enqueueInAppNotification/, "must use in-app notifications");
  assert.match(notify, /recipientMode:\s*"candidate"/, "candidate must be emailed via recipientMode candidate");
  assert.match(notify, /candidateEmail/, "candidate email must be passed (no login)");
  assert.match(notify, /employeeHrId/, "interviewer must be emailed by hr id");
  assert.match(notify, /recruitmentOwnerHrId/, "recruitment owner must be notified");

  const interviews = read("src/lib/recruitment/interviews.ts");
  assert.match(interviews, /notifyInterview/, "interviews service must trigger notifications");
  assert.match(interviews, /"scheduled"/, "createInterview must fire a scheduled notification");
  assert.match(interviews, /"rescheduled"/, "recordInterviewOutcome must fire a rescheduled notification");
  assert.match(interviews, /export async function deleteInterview/, "cancel (deleteInterview) must exist");
  assert.match(interviews, /"cancelled"/, "deleteInterview must fire a cancelled notification");

  // Daily reminder still rides the existing cron and is enriched with details.
  const daily = read("src/lib/recruitment/notifications.ts");
  assert.match(daily, /interviewTypeLabel/, "reminder must reuse the shared interview type label");
}
