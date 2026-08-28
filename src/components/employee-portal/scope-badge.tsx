import { Building2, CircleSlash, Layers, Network, User, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { AccessScope } from "@/lib/auth/permissions";

import { scopeBadgeLabels } from "./scope-badge-labels";

type ScopeBadgeProps = {
  className?: string;
  scope: AccessScope;
};

const scopeIcons: Record<AccessScope, LucideIcon> = {
  self: User,
  team: Users,
  hierarchy: Network,
  line: Layers,
  company: Building2,
  system: Building2,
  none: CircleSlash,
};

export function ScopeBadge({ className, scope }: ScopeBadgeProps) {
  const view = scopeBadgeLabels[scope];
  const Icon = scopeIcons[scope];
  if (!view || !Icon) return null;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-phx-xs font-semibold uppercase tracking-[0.08em] ${view.toneClass}${className ? ` ${className}` : ""}`}
      title={view.description}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span>{view.label}</span>
    </span>
  );
}
