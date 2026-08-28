import { Badge, type BadgeTone } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// StatusBadge is now a thin semantic adapter over the one Badge device, not a
// second badge. It exists to answer "what tone is `on_leave`?" — the drawing is
// Badge's job, so the two can no longer drift apart the way they had.

type StatusVariant = "completed" | "pending" | "failed" | "active" | "inactive" | "on_leave" | "probation";

type StatusBadgeProps = {
  status: StatusVariant | string;
  className?: string;
};

/** Employment/run statuses, mapped to meaning. Anything unrecognised reads neutral. */
const TONE_BY_STATUS: Record<string, BadgeTone> = {
  completed: "ok",
  active: "ok",
  pending: "warn",
  probation: "warn",
  failed: "danger",
  inactive: "danger",
  on_leave: "info",
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const normalizedStatus = status.toLowerCase().replace(" ", "_");

  return (
    <Badge tone={TONE_BY_STATUS[normalizedStatus] ?? "neutral"} size="sm" className={cn(className)}>
      {status}
    </Badge>
  );
}
