import { Badge, type BadgeSize } from "@/components/ui/badge";
import { isSeniorRep, SENIOR_REP_BADGE_LABEL } from "@/lib/employees/senior-reps";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// The "Senior" badge — the one device that highlights a senior medical rep.
//
// It reads the roster in senior-reps.ts and renders nothing for anyone else, so
// a call site can drop it beside any rep's name unconditionally:
//
//     <span>{rep.name}</span> <SeniorRepBadge hrId={rep.hrId} />
//
// It is built on the shared Badge primitive (one badge device, house tokens) so
// it inherits the same shape and sizing as every other badge — no one-off look.
// The `info` tone is the app's highlight hue; "Senior" is a distinction, not a
// status, so it deliberately does not use ok/warn/danger.
// ─────────────────────────────────────────────────────────────────────────────

type SeniorRepBadgeProps = {
  hrId: string | null | undefined;
  size?: BadgeSize;
  className?: string;
};

export function SeniorRepBadge({ hrId, size = "sm", className }: SeniorRepBadgeProps) {
  if (!isSeniorRep(hrId)) return null;

  return (
    <Badge
      tone="info"
      size={size}
      // `rounded-none` squares the badge at the source. The shared Badge is `rounded-full`, squared
      // elsewhere only by the .admin-shell / .employee-portal-shell CSS sweep — so on any surface
      // outside those shells it would otherwise render as a real pill and break the square-edge
      // golden rule. tailwind-merge resolves rounded-full + rounded-none to rounded-none.
      className={cn("align-middle rounded-none", className)}
      title="Senior medical representative"
    >
      {SENIOR_REP_BADGE_LABEL}
    </Badge>
  );
}
