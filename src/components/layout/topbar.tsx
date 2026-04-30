import { Bell, ChevronDown, Mail, Menu, Search } from "lucide-react";

import { PhoenixLogo } from "@/components/brand/phoenix-logo";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Input } from "@/components/ui/input";

export function Topbar() {
  return (
    <header className="sticky top-0 z-20 flex h-20 items-center gap-4 border-b border-border bg-card/90 px-4 backdrop-blur sm:px-6">
      <div className="lg:hidden">
        <PhoenixLogo compact />
      </div>
      <button
        aria-label="Open menu"
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-muted hover:text-text"
        type="button"
      >
        <Menu className="h-5 w-5" />
      </button>

      <div className="relative hidden max-w-xl flex-1 md:block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
        <Input
          aria-label="Search"
          className="bg-bg-soft pl-9"
          placeholder="Search employees, reports, pages..."
        />
      </div>

      <div className="ml-auto flex items-center gap-2 sm:gap-3">
        <ThemeToggle />
        <button className="hidden h-10 w-10 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-muted hover:text-text sm:inline-flex">
          <Bell className="h-5 w-5" />
        </button>
        <button className="hidden h-10 w-10 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-muted hover:text-text sm:inline-flex">
          <Mail className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-3 rounded-full border border-border bg-card py-1 pl-1 pr-3">
          <div className="h-9 w-9 rounded-full bg-primary/15 ring-1 ring-primary/20" />
          <div className="hidden text-left sm:block">
            <p className="text-sm font-semibold text-text">Omar Ashraf</p>
            <p className="text-xs text-text-secondary">Admin</p>
          </div>
          <ChevronDown className="hidden h-4 w-4 text-text-secondary sm:block" />
        </div>
      </div>
    </header>
  );
}
