import { redirect } from "next/navigation";

import { WhatsAppTemplateManager } from "@/components/recruitment/whatsapp-template-manager";
import { PremiumHero } from "@/components/ui/premium-hero";
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
// THE HEADER IS `PremiumHero`, the module-page standard, not a hand-rolled <h1>. It is flat by
// deliberate owner decision (2026-09-05, "NO MORE PREMIUM POLISH ... flat"): an accent rail, a
// kicker, the title and a hairline rule, with depth carried by borders alone. Nothing here may
// grow a gradient, a glow or a drop shadow.
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

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <PremiumHero
        badge={
          readyCount === null ? null : (
            <span className="inline-flex items-center gap-2 border border-phx-line bg-white px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-600">
              {/* A square dot, not a disc — the square-edge golden rule reaches decoration too. */}
              <span aria-hidden className="h-1.5 w-1.5 bg-[#25D366]" />
              {readyCount === 1 ? "1 template ready" : `${readyCount} templates ready`}
            </span>
          )
        }
        kicker="Recruitment"
        subtitle="Write a message once, then send it to a candidate in one click — or to any number, with no CV needed. Phoenix fills in the name and opens WhatsApp with the whole message written; you press send there."
        title="WhatsApp Templates"
      />
      <div className="pt-5">
        <WhatsAppTemplateManager canManage={canManageWhatsAppTemplates(access)} />
      </div>
    </div>
  );
}
