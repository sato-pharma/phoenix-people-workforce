import { StickyNote } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { RemindersBoard } from "@/components/hr-reminders/reminders-board";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadReminderBoard } from "@/lib/hr-reminders/service";
import { isUuid } from "@/lib/http/uuid";

// HR Reminders — shared notes for the HR team, drawn as a notes list, a week and a month.
//
// Owner, 2026-10-17: the HR Manager, HR Operations and HR Resourcing write reminders; an author
// chooses to keep one private, share it with chosen teammates or with the whole team; the HR
// Manager sees every one of them; anyone who can see a reminder can comment on it, and answer a
// comment. The rules are in @/lib/hr-reminders/logic, enforced by the service the API routes call.
//
// Served at /hr-reminders for the Super Admin and at /hr/hr-reminders for the HR seats (the /hr
// namespace is a proxy rewrite onto this same page).
export const dynamic = "force-dynamic";

export default async function HrRemindersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "hr_reminders", "read"))) {
    redirect("/admin");
  }

  const params = await searchParams;
  const open = typeof params.open === "string" && isUuid(params.open) ? params.open : null;

  // A deploy can reach production before its migration; the service answers that as an empty,
  // not-ready board. Any other failure is said plainly rather than rendered as "no reminders".
  let board: Awaited<ReturnType<typeof loadReminderBoard>> | null = null;
  let loadError: string | null = null;
  try {
    board = await loadReminderBoard(access);
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Reminders could not be loaded.";
  }

  return (
    <div className="min-h-[calc(100vh-7rem)] border border-phx-line bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-6">
        <AdminPageHero
          description="Shared notes for the HR team. Give a note a day and it lands on the week and month calendars. Keep it to yourself, share it with chosen teammates or the whole team, and talk about it underneath."
          eyebrow="HR team"
          icon={<StickyNote className="h-3.5 w-3.5" />}
          title="HR Reminders"
        />

        {board ? (
          <RemindersBoard initial={board} initialOpenId={open} />
        ) : (
          <div className="border border-amber-200 bg-amber-50 p-5 text-sm font-semibold text-amber-900">
            {loadError}
          </div>
        )}
      </div>
    </div>
  );
}
