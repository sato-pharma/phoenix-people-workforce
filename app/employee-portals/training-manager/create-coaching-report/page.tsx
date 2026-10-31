import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// The old coaching report form takes no new reports (owner, 2026-10-31): the Team Coaching Skills Survey
// replaced it, and its "Create Coaching Report" row left the Training Manager's sidebar. A saved link
// lands on the survey. Her old reports stay readable under Field Coaching.
export default function TrainingManagerCreateCoachingReportPage() {
  redirect("/employee-portals/coaching-skills-survey");
}
