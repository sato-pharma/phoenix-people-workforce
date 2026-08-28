import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * THIS is the `cn` the application actually runs, not `src/lib/utils.ts`.
 *
 * tsconfig maps `"@/*": ["./*", "./src/*"]`, and `./` is tried FIRST — so every
 * `import { cn } from "@/lib/utils"` in the codebase resolves to this file and
 * `src/lib/utils.ts` (a byte-identical twin) is shadowed and never loaded. Both
 * files existed with the same contents, so the shadowing was invisible until a
 * change was made to the wrong one. `src/lib/utils.ts` now re-exports from here
 * precisely so the two can never diverge again.
 *
 * ---
 *
 * The Phoenix font-size scale is declared as Tailwind v4 theme keys
 * (`--text-phx-*` in app/globals.css, resolving to `--phx-fs-*` in
 * src/styles/tokens.css). Those names MUST be registered with tailwind-merge.
 *
 * Tailwind v4 reads the scale from CSS at build time; tailwind-merge is a plain
 * JS library that never sees that CSS, so its default config only knows the stock
 * names (xs, sm, base, lg...). Confronted with `text-phx-md` it falls through the
 * font-size check and files the class under `text-color` instead — where it then
 * CONFLICTS with any real colour class in the same `cn()` call and one of the two
 * is silently dropped.
 *
 * That is not theoretical. The admin sidebar's nav links are built as
 *   cn("... text-phx-md font-semibold ...", active ? "..." : "text-slate-400 ...")
 * so `text-phx-md` (13px) was stripped by `text-slate-400` and every label fell
 * back to the inherited root size of 16px. The alarm badges lost `text-phx-2xs`
 * (10px) to `text-white` the same way and rendered at 16px/900 — which is what
 * made them read as oversized and shouting.
 *
 * The renaming sweep that introduced these names swapped `text-[13px]` for
 * `text-phx-md` app-wide. `text-[13px]` is an arbitrary value, and tailwind-merge
 * parses the bracket contents and correctly sees a length — so the defect only
 * appeared once the arbitrary values became named ones. It is invisible in source
 * (the class is right there in the JSX) and only observable in the rendered DOM,
 * which is why it survived review.
 *
 * ~4,800 call sites across 483 files use these names. Keep this list in sync with
 * the `--text-phx-*` keys in app/globals.css.
 */
export const PHX_FONT_SIZE_NAMES = [
  "phx-4xs",
  "phx-3xs",
  "phx-2xs",
  "phx-xs",
  "phx-sm",
  "phx-md",
  "phx-base",
  "phx-lg",
  "phx-xl",
  "phx-2xl",
  "phx-3xl",
] as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...PHX_FONT_SIZE_NAMES] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatEmployeeDisplayName(
  value: string | null | undefined,
  fallback = "Employee",
  _maxParts = 2,
) {
  void _maxParts;
  const fullName = String(value ?? "").trim().replace(/\s+/g, " ");
  return fullName || fallback;
}
