import {
  BriefcaseBusiness,
  CalendarDays,
  FileBarChart,
  Home,
  Settings,
  ShieldCheck,
  TrendingUp,
  UserRound,
  UsersRound,
} from "lucide-react";

import { PhoenixLogo } from "@/components/brand/phoenix-logo";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Overview", icon: Home, active: true },
  { name: "People", icon: UsersRound },
  { name: "Organization", icon: UserRound },
  { name: "Performance", icon: TrendingUp },
  { name: "Attendance", icon: CalendarDays },
  { name: "Recruitment", icon: BriefcaseBusiness },
  { name: "Reports", icon: FileBarChart },
  { name: "Settings", icon: Settings },
];

export function Sidebar() {
  return (
    <aside className="hidden w-64 shrink-0 border-r border-border bg-card px-5 py-6 lg:flex lg:flex-col">
      <PhoenixLogo />

      <nav className="mt-9 space-y-1">
        {navigation.map((item) => (
          <a
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
              item.active
                ? "bg-primary/10 text-primary"
                : "text-text-secondary hover:bg-bg-muted hover:text-text",
            )}
            href="#"
            key={item.name}
          >
            <item.icon className="h-4 w-4" />
            {item.name}
          </a>
        ))}
      </nav>

      <Card className="mt-auto p-4">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <ShieldCheck className="h-6 w-6" />
        </div>
        <p className="text-sm font-medium text-text">A drop is not the end.</p>
        <p className="mt-1 text-sm text-text-secondary">
          It is a chance to rebuild.
        </p>
        <p className="mt-4 text-xs font-medium text-primary">
          Phoenix Mindset
        </p>
      </Card>
    </aside>
  );
}
