import { PenLine } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { CeoEmailComposer } from "@/components/admin/ceo-email-composer";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canUseCeoEmail } from "@/lib/ceo-email/access";
import { getCeoEmailComposerOptions } from "@/lib/ceo-email/service";

// The CEO Email Composer — a letter from the chief executive to a named audience, over his own
// signature, in the house identity.
//
// Owner 2026-10-06: "a module thats called ceo email composr exactly as sato email composer copy
// paste but a more corporate templete … and the templete is wiith the signature of the ceo".
//
// The CEO and the Super Admin. The gate is @/lib/ceo-email/access, asserted again in every route
// behind this page — a redirect here is presentation, never the boundary.
//
// No /hr twin: `resolveNavigationMode` pins the CEO to the admin shell, so this address is the one
// he renders. (The Sato composer needs a /hr/admin row because an HR seat renders the hr shell and
// app-shell.tsx rewrites a bare /admin/… address into /hr/admin/…; nothing here does.)

export const dynamic = "force-dynamic";

export default async function CeoEmailPage() {
  const access = await resolveAccessContextFromPage();

  if (!canUseCeoEmail(access)) {
    redirect("/admin");
  }

  // The deploy reaches production before the migration does, and a missing table answers PGRST205
  // rather than 42P01 — so a page that let this throw would 500 for the whole window. The service
  // degrades to an empty template set with a warning instead, and the composer still works on
  // free-typed wording.
  let options: Awaited<ReturnType<typeof getCeoEmailComposerOptions>> = {
    dictationAvailable: false,
    employees: [],
    lists: [],
    signature: {
      companyAr: "",
      companyEn: "",
      fromDirectory: false,
      name: "",
      titleAr: "",
      titleEn: "",
    },
    templates: [],
    warnings: [],
  };
  let loadError: string | null = null;

  try {
    options = await getCeoEmailComposerOptions();
  } catch (error) {
    loadError = error instanceof Error ? error.message : "The composer could not be loaded.";
  }

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-phx-line bg-[radial-gradient(circle_at_top_left,rgba(10,107,166,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
        <AdminPageHero
          description={
            options.signature.name
              ? `Write to a distribution list or to named colleagues — type it, dictate it in any language, or build it from a document. It goes out on the chief executive's letterhead, signed ${options.signature.name}, ${options.signature.titleEn}. Recipients never see each other's addresses, and nothing sends until you have seen exactly who it reaches.`
              : "Write to a distribution list or to named colleagues — type it, dictate it in any language, or build it from a document. It goes out on the chief executive's letterhead, over the chief executive's signature. Recipients never see each other's addresses, and nothing sends until you have seen exactly who it reaches."
          }
          eyebrow="Office of the Chief Executive"
          icon={<PenLine className="h-3.5 w-3.5" />}
          title="CEO Email Composer"
        />

        {loadError ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm font-semibold text-amber-900">
            The composer is not ready yet: {loadError}
            <span className="mt-1 block font-normal">
              If this deploy landed before its migration, the letter templates appear once the migration is applied.
            </span>
          </div>
        ) : (
          <CeoEmailComposer
            dictationAvailable={options.dictationAvailable}
            initialLists={options.lists}
            initialTemplates={options.templates}
            loadWarnings={options.warnings}
          />
        )}
      </div>
    </div>
  );
}
