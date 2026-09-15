"use client";

// WhatsApp Inbox — the pieces of its LOOK that more than one pane draws: the avatar, the line mark,
// the empty state, and the surface classes.
//
// PREMIUM POLISH IS THE DEFAULT HERE (owner golden rule, 2026-09-08 — docs/agents-owner-rules.md):
// depth, gradients and a real hierarchy. And THE SQUARE-EDGE GOLDEN RULE STILL BINDS — not one
// radius in this file or in anything that borrows from it. Depth is carried by two-layer shadows
// (a hairline contact under a wide ambient one) and by tint, never by a rounded card.
//
// Sizes stay arbitrary (text-[13px]), never text-phx-*: cn() runs tailwind-merge, which silently
// strips custom named font sizes.

import type React from "react";
import { MessagesSquare, UserRound } from "lucide-react";

import { cn } from "@/lib/utils";

/** The recruitment line wears Phoenix orange; the HR handset wears ink. Read everywhere a line is named. */
export type LineTone = "accent" | "ink";

export function lineToneFor(label: string | null | undefined): LineTone {
  return label && /recruit/i.test(label) ? "accent" : "ink";
}

const lineMarkClass: Record<LineTone, string> = {
  accent: "bg-[linear-gradient(135deg,#FB923C_0%,#F97316_55%,#EA580C_100%)]",
  ink: "bg-[linear-gradient(135deg,#475569_0%,#1E293B_60%,#0F172A_100%)]",
};

/** A small square in the line's colour, beside its name. */
export function LineMark({ className, tone }: { className?: string; tone: LineTone }) {
  return <span aria-hidden className={cn("inline-block h-2 w-2 shrink-0", lineMarkClass[tone], className)} />;
}

/** The line's name as a chip, for a row or a chat header. */
export function LineChip({ label }: { label: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-[0.08em] text-slate-600 shadow-[0_1px_1px_rgba(15,23,42,0.04)]">
      <LineMark tone={lineToneFor(label)} />
      <span className="break-words">{label}</span>
    </span>
  );
}

/**
 * Who the chat is with, as a square block of initials in the line's colour.
 *
 * Initials only when there is a real name — a phone number or a username has no initials, and "+2"
 * in a box reads as a count. Those get a person glyph instead.
 */
export function InboxAvatar({
  name,
  size = "md",
  tone,
}: {
  name: string | null;
  size?: "md" | "lg";
  tone: LineTone;
}) {
  const initials = initialsOf(name);
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center font-black uppercase leading-none text-white shadow-[0_1px_2px_rgba(15,23,42,0.18),0_6px_14px_rgba(15,23,42,0.10)]",
        lineMarkClass[tone],
        size === "lg" ? "h-11 w-11 text-[15px]" : "h-10 w-10 text-[13px]",
      )}
    >
      {initials ? initials : <UserRound className={size === "lg" ? "h-5 w-5" : "h-4 w-4"} />}
    </span>
  );
}

function initialsOf(name: string | null): string {
  const words = (name ?? "")
    .trim()
    .split(/\s+/)
    .filter((word) => /\p{L}/u.test(word));
  if (words.length === 0) return "";
  const first = Array.from(words[0]!)[0] ?? "";
  const last = words.length > 1 ? (Array.from(words[words.length - 1]!)[0] ?? "") : "";
  return `${first}${last}`;
}

/** The quiet, centred "nothing here" state: an icon block with depth, a heading, and one sentence. */
export function InboxEmptyState({
  action,
  body,
  compact = false,
  title,
}: {
  action?: React.ReactNode;
  body: string;
  compact?: boolean;
  title: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 text-center", compact ? "px-4 py-8" : "flex-1 p-8")}>
      <span className="relative flex h-14 w-14 items-center justify-center border border-orange-200 bg-[linear-gradient(160deg,#FFFFFF_0%,#FFF4EB_100%)] text-orange-600 shadow-[0_1px_2px_rgba(15,23,42,0.06),0_14px_30px_rgba(249,115,22,0.16)]">
        <MessagesSquare aria-hidden className="h-6 w-6" />
      </span>
      <div className="max-w-sm">
        <p className="text-[15px] font-black tracking-[-0.01em] text-slate-900">{title}</p>
        <p className="mt-1 text-[12px] leading-5 text-slate-500">{body}</p>
      </div>
      {action}
    </div>
  );
}

/** The chat background: warm paper with a faint dot grid, so bubbles read as sitting on something. */
export const inboxPaperClassName =
  "bg-[#F6F3EE] [background-image:radial-gradient(rgba(15,23,42,0.055)_1px,transparent_1px)] [background-size:18px_18px]";

/** A bubble's lift: a contact line and a short ambient shadow. Nothing rounded. */
export const inboxBubbleShadowClassName = "shadow-[0_1px_1px_rgba(15,23,42,0.07),0_3px_10px_rgba(15,23,42,0.05)]";
