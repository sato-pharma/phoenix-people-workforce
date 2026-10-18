import { LayoutTemplate } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminInsightChip } from "@/components/admin/admin-design-system";
import { RecruitmentPageHeader } from "@/components/recruitment/recruitment-premium";
import { WhatsAppTemplateManager } from "@/components/recruitment/whatsapp-template-manager";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canManageWhatsAppTemplates, canSendWhatsAppTemplate } from "@/lib/recruitment/access";
import { listWhatsAppTemplates } from "@/lib/recruitment/whatsapp-templates/store";

export const dynamic = "force-dynamic";

// The WhatsApp message templates — the wording the company sends candidates, and the place to send
// one to any number at all.
//
// TWO AUDIENCES, ONE PAGE, DIFFERENT RIGHTS. Anyone who works the pipeline can open this and send a
// message; only system scope can change what the templates SAY. The manager component is handed
// `canManage` rather than being hidden behind a second route, so a recruiter sees the wording they
// are about to send — which is the point — without an edit button that would fail server-side
// anyway. The API re-checks both gates; nothing here is the security boundary.
//
// THE RECRUITING SEAT REACHES THIS PAGE BY ITS PERMISSION KEY, NEVER ITS TITLE: `"HR Resourcing"`,
// shown as "Talent Acquisition" (`displayTitleForRole` in hr-functions.ts). `canSendWhatsAppTemplate`
// names the key, so the title needs no entry of its own — adding one would add a string that is not a
// PhoenixRole at all. The HR Business Partner (`"HR Advisory"`) reached it until the owner moved
// recruiting off her seat on 2026-10-08.
//
// THE HEADER IS `RecruitmentPageHeader`, the one header every recruitment screen opens with (owner,
// 2026-10-19: the full-module premium sweep). It was `PremiumHero` until then — the same slim rail,
// kicker, title and rule — and moved so the module has ONE header rather than two that look alike.
// The 2026-09-05 "flat" ruling this comment used to quote was reversed by the owner on 2026-09-08
// (depth is the default again); the square-edge rule still binds, so nothing here names a radius.
export default async function WhatsAppTemplatesPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }
  if (!canSendWhatsAppTemplate(access)) {
    redirect("/employee-portals");
  }

  // Read here purely so the header can state the size of the library. Best-effort on purpose: the
  // manager fetches its own list client-side and is the source of truth on screen, so a failure
  // must degrade to a header without a count rather than to an error page over a decorative number.
  const templates = await listWhatsAppTemplates({ includeInactive: true }).catch(() => null);
  const readyCount = templates?.filter((template) => template.isActive).length ?? null;
  const switchedOffCount = templates && readyCount !== null ? templates.length - readyCount : 0;
  const canManage = canManageWhatsAppTemplates(access);

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-4 sm:p-6">
      <RecruitmentPageHeader
        badges={
          <>
            {readyCount === null ? null : (
              <AdminInsightChip tone="emerald">
                <span className="inline-flex items-center gap-2">
                  {/* A square dot, not a disc — the square-edge golden rule reaches decoration too. */}
                  <span aria-hidden className="h-1.5 w-1.5 bg-[#25D366]" />
                  {readyCount === 1 ? "1 template ready" : `${readyCount} templates ready`}
                </span>
              </AdminInsightChip>
            )}
            {switchedOffCount > 0 ? (
              <AdminInsightChip tone="slate">{`${switchedOffCount} switched off`}</AdminInsightChip>
            ) : null}
            <AdminInsightChip>{canManage ? "You can edit the wording" : "Send only"}</AdminInsightChip>
          </>
        }
        description="Write a message once, then send it to a candidate in one click — or to any number, with no CV needed. Phoenix fills in the name and opens WhatsApp with the whole message written; you press send there."
        icon={<LayoutTemplate aria-hidden="true" className="h-3.5 w-3.5" />}
        title="WhatsApp Templates"
      />
      <WhatsAppTemplateManager canManage={canManageWhatsAppTemplates(access)} />
    </div>
  );
}
