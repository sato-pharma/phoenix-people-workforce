"use client";

import { Moon, Sun } from "lucide-react";

import { useTheme } from "@/src/components/layout/theme-provider";
import { cn } from "@/src/lib/utils";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      aria-label="Toggle theme"
      aria-pressed={isDark}
      className="relative inline-flex h-10 w-[86px] items-center rounded-full border border-zinc-200 bg-zinc-100 p-1 text-zinc-500 transition-colors hover:border-orange-200 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:border-orange-900"
      onClick={toggleTheme}
      type="button"
    >
      <span
        className={cn(
          "absolute h-8 w-10 rounded-full bg-white shadow-sm transition-transform dark:bg-zinc-950",
          isDark ? "translate-x-8" : "translate-x-0",
        )}
      />
      <span className="relative z-10 flex w-10 items-center justify-center">
        <Sun
          className={cn("h-4 w-4", !isDark ? "text-orange-600" : "text-zinc-400")}
        />
      </span>
      <span className="relative z-10 flex w-10 items-center justify-center">
        <Moon
          className={cn("h-4 w-4", isDark ? "text-orange-400" : "text-zinc-400")}
        />
      </span>
    </button>
  );
}
