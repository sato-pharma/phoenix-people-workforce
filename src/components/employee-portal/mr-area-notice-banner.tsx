import { MrAreaNoticeList } from "@/components/employee-portal/mr-area-notice-list";
import { loadMyMrAreaNotices } from "@/lib/recruitment/mr-hiring/area-notices";

// The banner on a manager's portal home: a Medical Rep candidate HR passed for his area (owner,
// 7 Nov 2026 — "a small banner … in their overview dashboard, so when they log in, they notice").
//
// SERVER, UNDER ITS OWN SUSPENSE (app/employee-portals/page.tsx): one indexed read of his own
// undismissed notices, never awaited by the landing. No notice, no banner — and an unreadable table
// answers no notice (area-notices.ts), so the home never fails over it.

export async function MrAreaNoticeBanner({ hrId }: { hrId: string | null | undefined }) {
  const notices = await loadMyMrAreaNotices(hrId);
  if (notices.length === 0) return null;
  return <MrAreaNoticeList notices={notices} />;
}
