import { redirect } from "next/navigation";
import { LayoutGrid } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { SidebarLayoutEditor } from "@/components/admin/sidebar-layout-editor";
import { getNavigationSections } from "@/config/system-navigation";
import { buildPermissionLookup, getPermissionMatrix } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getSections } from "@/lib/navigation/active-path";
import { layoutOwnerKey } from "@/lib/navigation/personal-layout";
import { loadCompanyDefaultLayout, loadEffectiveLayout } from "@/lib/navigation/personal-layout-store";

export const dynamic = "force-dynamic";

/**
 * The free placement editor — arranging YOUR OWN sidebar.
 *
 * The catalogue handed to the editor is the output of getSections, i.e. exactly the pages this
 * viewer is already permitted to reach. That is the whole security story: the editor cannot offer a
 * page the viewer cannot open, and applyPersonalLayout cannot emit an href that was not in this
 * same set, so no arrangement made here can widen anyone's access. It also means two people opening
 * this page see different catalogues, which is correct — each is arranging their own sidebar.
 *
 * Only href and label cross to the client. The icon on a NavigationSectionItem is a React component
 * and is not serialisable, and the editor has no use for it.
 */
export default async function SidebarLayoutPage() {
  const access = await resolveAccessContextFromPage();
  if (access.source === "guest") redirect("/login");

  const matrix = await getPermissionMatrix();
  const permissionLookup = buildPermissionLookup(matrix, access.role);
  const isSystemAdministratorWorkspace = access.scope === "system" || access.role === "Super Admin";

  const gated = getSections(
    getNavigationSections("admin"),
    "admin",
    permissionLookup,
    access.role,
    isSystemAdministratorWorkspace,
  );

  const catalogue = gated.map((section) => ({
    id: section.id,
    label: section.label,
    items: section.items.map((item) => ({ href: item.href, label: item.label })),
  }));

  // Open on what this person's navigation ACTUALLY renders from -- their own layout, or the
  // company default when they have never arranged anything. Opening on their empty personal row
  // while the shell around them showed the company default would make the editor look broken.
  const { layout: savedLayout, source: layoutSource } = await loadEffectiveLayout(layoutOwnerKey(access));

  // Only a Super Admin can publish or withdraw the company default, so only a Super Admin pays for
  // the extra read that says whether one exists. Everyone else learns it for free: if their own
  // navigation resolved from the company row, there is one.
  const canManageCompanyDefault = access.role === "Super Admin";
  const companyDefaultExists = canManageCompanyDefault
    ? (await loadCompanyDefaultLayout()) !== null
    : layoutSource === "company";

  const pageCount = catalogue.reduce((total, section) => total + section.items.length, 0);

  return (
    <div className="space-y-6">
      <AdminPageHero
        description={
          canManageCompanyDefault
            ? "Put any page in the row above the page title, the row below it, the top strip, or any module — press Move to on the page, or drag it. Saving changes your own navigation. Publishing a company default changes it for everyone who has never arranged their own."
            : "Put any page in the row above the page title, the row below it, the top strip, or any module — press Move to on the page, or drag it. This changes your own navigation and nobody else's."
        }
        eyebrow="Personal"
        icon={<LayoutGrid className="h-3.5 w-3.5" />}
        title="Navigation Layout"
      />
      <SidebarLayoutEditor
        canManageCompanyDefault={canManageCompanyDefault}
        catalogue={catalogue}
        companyDefaultExists={companyDefaultExists}
        layoutSource={layoutSource}
        pageCount={pageCount}
        savedLayout={savedLayout}
      />
    </div>
  );
}
