import type { LucideIcon } from "lucide-react";

import { adminSidebarDomains, UNGROUPED_DOMAIN } from "@/config/sidebar-domains";
import type { NavigationSection } from "@/config/system-navigation";

export type RenderedDomainGroup = {
  heading: string;
  sections: NavigationSection[];
};

export type RenderedDomain = {
  id: string;
  name: string;
  sub: string;
  desc: string;
  icon: LucideIcon;
  groups: RenderedDomainGroup[];
  /** Rows this domain holds for THIS viewer, after gating. Used for the rail's count chip. */
  rowCount: number;
};

/**
 * Folds the already-gated flat section list into the seven domains.
 *
 * Runs STRICTLY AFTER `getSections`, on its output. That ordering is the whole safety argument:
 * gating, per-role relabelling, `dedupeSectionsByHref` and the flat-sidebar heading strip have all
 * happened by the time a section reaches here, so this function only ever decides WHERE a surviving
 * row is drawn — never whether it survives. It is pure, it holds no role, and it takes no lookup.
 *
 * Two properties it guarantees, both asserted in tests/sidebar-domains.test.ts across every role:
 *
 *   - No row is lost. Every section handed in comes out exactly once; one that matches no domain
 *     lands under "More" rather than being dropped. A vanished nav row is invisible in review —
 *     the page still renders, the module simply becomes unreachable — so the fallback is deliberate
 *     and the coverage test is what keeps it empty.
 *   - No row is duplicated. A section id written into two groups would otherwise render twice.
 *
 * An empty domain is omitted entirely. A Medical Rep's admin rail has nothing in Payroll, and an
 * accordion that opens onto nothing reads as a permission fault rather than as an absence.
 */
export function groupAdminSections(sections: readonly NavigationSection[]): RenderedDomain[] {
  const remaining = new Map<string, NavigationSection>();
  for (const section of sections) remaining.set(section.id, section);

  const domains: RenderedDomain[] = [];

  for (const domain of adminSidebarDomains) {
    const groups: RenderedDomainGroup[] = [];

    for (const group of domain.groups) {
      const found: NavigationSection[] = [];
      for (const id of group.sectionIds) {
        const section = remaining.get(id);
        // `delete` is what makes duplication impossible rather than merely unlikely: a section id
        // written into two groups is consumed by the first and is simply absent from the second.
        if (section) {
          found.push(section);
          remaining.delete(id);
        }
      }
      if (found.length > 0) groups.push({ heading: group.heading, sections: found });
    }

    if (groups.length > 0) domains.push(toRendered(domain, groups));
  }

  // Whatever the map did not claim. Empty in a green repo — tests/sidebar-domains.test.ts fails on
  // any admin section that reaches this point — but rendered rather than dropped if one ever does.
  if (remaining.size > 0) {
    const groups = [...remaining.values()].map((section) => ({
      heading: section.label || "Other",
      sections: [section],
    }));
    domains.push(toRendered(UNGROUPED_DOMAIN, groups));
  }

  return domains;
}

function toRendered(
  domain: { id: string; name: string; sub: string; desc: string; icon: LucideIcon },
  groups: RenderedDomainGroup[],
): RenderedDomain {
  return {
    id: domain.id,
    name: domain.name,
    sub: domain.sub,
    desc: domain.desc,
    icon: domain.icon,
    groups,
    rowCount: groups.reduce(
      (total, group) => total + group.sections.reduce((n, section) => n + section.items.length, 0),
      0,
    ),
  };
}

/** The domain holding a given href, or null. Used to open the right domain on load. */
export function domainIdForHref(domains: readonly RenderedDomain[], href: string | null): string | null {
  if (!href) return null;
  for (const domain of domains) {
    for (const group of domain.groups) {
      for (const section of group.sections) {
        if (section.items.some((item) => item.href === href)) return domain.id;
      }
    }
  }
  return null;
}
