import type { AccessScope } from "@/lib/auth/permissions";

/**
 * Presentation text/tone for the Employee Portal {@link ScopeBadge}.
 *
 * This is a pure data map (no React / no icons) so it can be unit-tested
 * directly. The badge component pairs each entry with an icon and renders it.
 *
 * The label is derived purely from the already-resolved `access.scope`; it
 * computes nothing and exposes no data. "Company" is only ever produced for the
 * `company` scope.
 */
export type ScopeBadgePresentation = {
  description: string;
  label: string;
  toneClass: string;
};

export const scopeBadgeLabels: Record<AccessScope, ScopeBadgePresentation> = {
  self: {
    description: "Showing only your own data.",
    label: "My data",
    toneClass: "border-slate-200 bg-slate-50 text-slate-700",
  },
  team: {
    description: "Showing data for the people who report to you.",
    label: "My team",
    toneClass: "border-sky-200 bg-sky-50 text-sky-700",
  },
  hierarchy: {
    description: "Showing data across your reporting hierarchy.",
    label: "My hierarchy",
    toneClass: "border-indigo-200 bg-indigo-50 text-indigo-700",
  },
  line: {
    description: "Showing data for everyone in your sales line.",
    label: "My line",
    toneClass: "border-orange-200 bg-orange-50 text-orange-700",
  },
  company: {
    description: "Showing company-wide data.",
    label: "Company",
    toneClass: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  system: {
    description: "System-level access.",
    label: "System",
    toneClass: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  none: {
    description: "No data scope is currently resolved for your account.",
    label: "No scope",
    toneClass: "border-slate-200 bg-slate-100 text-slate-500",
  },
};
