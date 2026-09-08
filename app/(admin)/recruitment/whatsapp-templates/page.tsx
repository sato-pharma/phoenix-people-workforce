import { redirect } from "next/navigation";

import { WhatsAppTemplateManager } from "@/components/recruitment/whatsapp-template-manager";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canManageWhatsAppTemplates, canSendWhatsAppTemplate } from "@/lib/recruitment/access";

export const dynamic = "force-dynamic";

// The WhatsApp message templates — the wording the company sends candidates, and the place to send
// one to any number at all.
//
// TWO AUDIENCES, ONE PAGE, DIFFERENT RIGHTS. Anyone who works the pipeline can open this and send a
// message; only system scope can change what the templates SAY. The manager component is handed
// `canManage` rather than being hidden behind a second route, so a recruiter sees the wording they
// are about to send — which is the point — without an edit button that would fail server-side
// anyway. The API re-checks both gates; nothing here is the security boundary.
export default async function WhatsAppTemplatesPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  if (!canSendWhatsAppTemplate(access)) {
    redirect("/employee-portals");
  }

  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <div className="mb-4">
        <h1 className="text-lg font-semibold text-slate-900">WhatsApp Templates</h1>
        <p className="text-sm text-slate-500">
          Write a message once, then send it to any candidate in one click — or to any number, with
          no CV needed. Phoenix fills in the name and opens WhatsApp with the whole message written;
          you press send there.
        </p>
      </div>
      <WhatsAppTemplateManager canManage={canManageWhatsAppTemplates(access)} />
    </div>
  );
}
