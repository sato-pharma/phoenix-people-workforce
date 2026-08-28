import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// The one badge device.
//
// Before this, the app drew the same idea three ways: this component (gradient +
// ring + coloured drop-shadow), StatusBadge (flat fill, rounded-full), and 126
// hand-rolled spans across 55 files using 30 distinct padding/weight signatures.
// Worse, each meaning had two hues chosen at random per file — warn was `amber`
// 50 times and `orange` 49, danger was `rose` 44 and `red` 15, info was `sky` 9
// and `blue` 7.
//
// So: one device, one hue per meaning, read from the --phx-* semantic tokens.
// Every tone below has a matching -bg (fill) and -line (edge) token, which is
// exactly badge anatomy, so nothing here hardcodes a palette value.
//
// The gradients and coloured shadows are deliberately gone. A badge is a label,
// not a raised surface — and that treatment WAS the drift this device exists to
// end, so carrying it forward would defeat the point. Do not add them back.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the badge MEANS. Pick by meaning; the hue follows from the token set.
 *
 * There is deliberately no `accent` tone. The brand orange is a FILL colour —
 * `--phx-accent` (#f97316) on `--phx-accent-soft` (#fff2e8) measures 2.55:1,
 * well under the 4.5:1 WCAG AA needs for text this small, and the only ink token
 * in that family (`--phx-accent-ink`) is #ffffff, meant to sit on the fill. The
 * five tones below measure 4.89 / 5.06 / 5.94 / 5.40 / 4.98:1. "Accent" was also
 * never a status: of the 126 hand-rolled badges, the 49 orange ones all meant
 * `warn`. Do not add it back — a brand colour is not a meaning.
 */
export type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "info";

/**
 * `sm` is the dense one for table cells and list rows; `md` is for headers and
 * cards. These are the two clusters the 126 hand-rolled badges actually fell
 * into — they are not invented sizes.
 */
export type BadgeSize = "sm" | "md";

/** Superseded by `tone`. Kept so existing call sites keep compiling and rendering. */
type LegacyVariant = "neutral" | "success" | "warning" | "danger";

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  size?: BadgeSize;
  /** @deprecated use `tone` — "success" is `ok`, "warning" is `warn`. */
  variant?: LegacyVariant;
};

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-phx-surface text-phx-ink-soft ring-phx-line",
  ok: "bg-phx-ok-bg text-phx-ok ring-phx-ok-line",
  warn: "bg-phx-warn-bg text-phx-warn ring-phx-warn-line",
  danger: "bg-phx-danger-bg text-phx-danger ring-phx-danger-line",
  info: "bg-phx-info-bg text-phx-info ring-phx-info-line",
};

const SIZE: Record<BadgeSize, string> = {
  sm: "px-2 py-0.5 text-phx-3xs",
  md: "px-2.5 py-1 text-phx-2xs",
};

const LEGACY_TONE: Record<LegacyVariant, BadgeTone> = {
  neutral: "neutral",
  success: "ok",
  warning: "warn",
  danger: "danger",
};

export function Badge({ className, tone, size = "md", variant, children, ...props }: BadgeProps) {
  const resolved: BadgeTone = tone ?? (variant ? LEGACY_TONE[variant] : "neutral");

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full font-bold uppercase tracking-[0.12em] ring-1 transition-colors duration-200",
        SIZE[size],
        TONE[resolved],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
