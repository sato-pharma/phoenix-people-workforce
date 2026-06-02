import { redirect } from "next/navigation";

import { EmailReplyComposer } from "@/components/admin/email-reply-composer";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AdminEmailReplyComposerPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "communication", "read")) {
    redirect("/employee-portals");
  }

  return <EmailReplyComposer />;
}
