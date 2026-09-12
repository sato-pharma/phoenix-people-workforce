import { Mail } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { SatoEmailComposer } from "@/components/admin/sato-email-composer";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canUseSatoEmail } from "@/lib/sato-email/access";
import { getSatoEmailComposerOptions } from "@/lib/sato-email/service";

// The Sato Email Composer — the one screen in Phoenix where a person writes an email to a named
// audience and sends it, wearing the company's identity rather than the app's.
//
// Super Admin and the HR Business Partner. Owner 2026-09-11: "This module would be accessible for
// HR business partner and the system administrator." The gate is @/lib/sato-email/access, asserted
// again in every route behind this page — a redirect here is presentation, never the boundary.

export const dynamic = "force-dynamic";

export default async function SatoEmailPage() {
  const access = await resolveAccessContextFromPage();

  if (!canUseSatoEmail(access)) {
    redirect("/admin");
  }

  // The deploy reaches production before the migration does, and a missing table answers PGRST205
  // rather than 42P01 — so a page that let this throw would 500 for the whole window. The service
  // degrades to an empty template set with a warning instead, and the composer still works on
  // free-typed wording.
  let options: Awaited<ReturnType<typeof getSatoEmailComposerOptions>> = {
    employees: [],
    lists: [],
    templates: [],
    warnings: [],
  };
  let loadError: string | null = null;

  try {
    options = await getSatoEmailComposerOptions();
  } catch (error) {
    loadError = error instanceof Error ? error.message : "The composer could not be loaded.";
  }

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-phx-line bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
        <AdminPageHero
          description="Write an email to a distribution list or to named colleagues, from a fixed template or in your own words. It goes out in the company's identity, recipients never see each other's addresses, and nothing sends until you have seen exactly who it reaches."
          eyebrow="Email"
          icon={<Mail className="h-3.5 w-3.5" />}
          title="Sato Email Composer"
        />

        {loadError ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm font-semibold text-amber-900">
            The composer is not ready yet: {loadError}
            <span className="mt-1 block font-normal">
              If this deploy landed before its migration, the templates appear once the migration is applied.
            </span>
          </div>
        ) : (
          <SatoEmailComposer
            initialLists={options.lists}
            initialTemplates={options.templates}
            loadWarnings={options.warnings}
          />
        )}
      </div>
    </div>
  );
}
