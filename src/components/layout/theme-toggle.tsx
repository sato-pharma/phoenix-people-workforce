"use client";

import { Moon, Sun } from "lucide-react";

import { useTheme } from "@/components/layout/theme-provider";
import { cn } from "@/lib/utils";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      aria-label="Toggle theme"
      aria-pressed={isDark}
      className="relative inline-flex h-10 w-[86px] items-center rounded-full border border-border bg-bg-muted p-1 text-text-secondary transition-colors hover:border-primary/40"
      onClick={toggleTheme}
      type="button"
    >
      <span
        className={cn(
          "absolute h-8 w-10 rounded-full bg-card shadow-sm transition-transform",
          isDark ? "translate-x-8" : "translate-x-0",
        )}
      />
      <span className="relative z-10 flex w-10 items-center justify-center">
        <Sun
          className={cn("h-4 w-4", !isDark ? "text-primary" : "text-text-secondary")}
        />
      </span>
      <span className="relative z-10 flex w-10 items-center justify-center">
        <Moon
          className={cn("h-4 w-4", isDark ? "text-primary" : "text-text-secondary")}
        />
      </span>
    </button>
  );
}
