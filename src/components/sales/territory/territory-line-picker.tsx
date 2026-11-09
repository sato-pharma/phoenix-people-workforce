"use client";

import { useCallback, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Layers } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Line picker for the two roles that see EVERY product line — Super Admin and CEO. Every other role
 * drills its own single derived line, so this never renders for them (the page gates on
 * isTerritoryLinePickerRole). The whole skeleton is built from ONE line's seat tree, so a nationwide
 * viewer chooses which of the three seat-carrying lines to drill; picking one sets `?line=` and the
 * server component rebuilds the skeleton for that line.
 *
 * Matches the Territory data sync card's identity (same card frame, shared Button primitive) rather
 * than inventing a control — the active line is the default (filled) button, the rest are outline.
 */
export function TerritoryLinePicker({
  lines,
  activeLine,
}: {
  lines: readonly string[];
  activeLine: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const selectLine = useCallback(
    (line: string) => {
      if (line === activeLine) return;
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.set("line", line);
      startTransition(() => {
        router.replace(`${pathname}?${params.toString()}`);
      });
    },
    [activeLine, pathname, router, searchParams],
  );

  return (
    <div className="border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <Layers aria-hidden className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" />
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Product line</h3>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {lines.map((line) => (
            <Button
              key={line}
              aria-pressed={line === activeLine}
              disabled={pending}
              size="sm"
              type="button"
              variant={line === activeLine ? "default" : "outline"}
              onClick={() => selectLine(line)}
            >
              {line}
            </Button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
        Your account sees every line. Pick one to see its regions, areas and pharmacies nationwide.
      </p>
    </div>
  );
}
