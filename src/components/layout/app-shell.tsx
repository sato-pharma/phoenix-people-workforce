import {
  BarChart3,
  Bell,
  BriefcaseBusiness,
  CalendarDays,
  ChevronDown,
  FileBarChart,
  Home,
  Mail,
  Menu,
  Search,
  Settings,
  ShieldCheck,
  TrendingUp,
  UserRound,
  UsersRound,
} from "lucide-react";

import { ThemeToggle } from "@/src/components/layout/theme-toggle";
import { Card } from "@/src/components/ui/card";
import { cn } from "@/src/lib/utils";

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

const kpis = [
  {
    label: "Total Employees",
    value: "1,248",
    change: "+ 4.3%",
    icon: UsersRound,
  },
  {
    label: "Active Employees",
    value: "1,167",
    change: "+ 3.7%",
    icon: TrendingUp,
  },
  {
    label: "Average Performance",
    value: "85%",
    change: "+ 6.2%",
    icon: BarChart3,
  },
  {
    label: "Open Positions",
    value: "18",
    change: "Stable",
    icon: BriefcaseBusiness,
  },
];

const departments = [
  { name: "Sales", value: "92%", width: "92%" },
  { name: "Operations", value: "87%", width: "87%" },
  { name: "People", value: "82%", width: "82%" },
  { name: "Finance", value: "80%", width: "80%" },
  { name: "Support", value: "75%", width: "75%" },
];

const employees = [
  ["Omar Ashraf", "Sales", "Sales Manager", "Active", "92%"],
  ["Sarah Mohamed", "Operations", "Operations Lead", "Active", "88%"],
  ["Ahmed Hassan", "People", "People Specialist", "Active", "84%"],
  ["Maya Ali", "Finance", "Financial Analyst", "Active", "90%"],
];

function PhoenixMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-50 text-orange-600 ring-1 ring-orange-100 dark:bg-orange-500/10 dark:text-orange-400 dark:ring-orange-500/20">
        <span className="text-lg font-black leading-none">P</span>
      </div>
      {!compact ? (
        <div>
          <div className="text-sm font-semibold tracking-[0.28em] text-zinc-950 dark:text-zinc-50">
            PHOENIX
          </div>
          <div className="text-[10px] font-semibold tracking-[0.34em] text-orange-600 dark:text-orange-400">
            WORKFORCE
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Sidebar() {
  return (
    <aside className="hidden w-64 shrink-0 border-r border-zinc-200 bg-white px-5 py-6 dark:border-zinc-800 dark:bg-zinc-950 lg:flex lg:flex-col">
      <PhoenixMark />

      <nav className="mt-9 space-y-1">
        {navigation.map((item) => (
          <a
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
              item.active
                ? "bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-300"
                : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-50",
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
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-orange-50 text-orange-600 dark:bg-orange-500/10 dark:text-orange-400">
          <ShieldCheck className="h-6 w-6" />
        </div>
        <p className="text-sm font-medium text-zinc-950 dark:text-zinc-50">
          A drop is not the end.
        </p>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          It is a chance to rebuild.
        </p>
        <p className="mt-4 text-xs font-medium text-orange-600 dark:text-orange-400">
          Phoenix Mindset
        </p>
      </Card>
    </aside>
  );
}

function Topbar() {
  return (
    <header className="sticky top-0 z-20 flex h-20 items-center gap-4 border-b border-zinc-200 bg-white/90 px-4 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90 sm:px-6">
      <div className="lg:hidden">
        <PhoenixMark compact />
      </div>
      <button
        aria-label="Open menu"
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-50"
        type="button"
      >
        <Menu className="h-5 w-5" />
      </button>

      <div className="hidden h-11 max-w-xl flex-1 items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-4 text-sm text-zinc-500 shadow-inner shadow-zinc-950/[0.02] dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 md:flex">
        <Search className="h-4 w-4" />
        <span>Search employees, reports, pages...</span>
      </div>

      <div className="ml-auto flex items-center gap-2 sm:gap-3">
        <ThemeToggle />
        <button className="hidden h-10 w-10 items-center justify-center rounded-lg text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900 sm:inline-flex">
          <Bell className="h-5 w-5" />
        </button>
        <button className="hidden h-10 w-10 items-center justify-center rounded-lg text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900 sm:inline-flex">
          <Mail className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-3 rounded-full border border-zinc-200 bg-white py-1 pl-1 pr-3 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="h-9 w-9 rounded-full bg-orange-100 ring-1 ring-orange-200 dark:bg-orange-500/20 dark:ring-orange-500/30" />
          <div className="hidden text-left sm:block">
            <p className="text-sm font-semibold text-zinc-950 dark:text-zinc-50">
              Omar Ashraf
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Admin</p>
          </div>
          <ChevronDown className="hidden h-4 w-4 text-zinc-500 sm:block" />
        </div>
      </div>
    </header>
  );
}

function KpiCard({
  label,
  value,
  change,
  icon: Icon,
}: (typeof kpis)[number]) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">
            {label}
          </p>
          <p className="mt-5 text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
            {value}
          </p>
        </div>
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-50 text-orange-600 dark:bg-orange-500/10 dark:text-orange-400">
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
        <span className="font-medium text-emerald-600 dark:text-emerald-400">
          {change}
        </span>{" "}
        vs last month
      </p>
    </Card>
  );
}

function PerformanceChart() {
  const points = [35, 52, 43, 61, 73, 58, 79, 88, 77, 95];

  return (
    <Card className="p-5 lg:col-span-7">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-zinc-950 dark:text-zinc-50">
          Performance Trend
        </h2>
        <button className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          6 Months
        </button>
      </div>
      <div className="mt-8 flex h-48 items-end gap-3 border-b border-l border-zinc-200 pl-4 dark:border-zinc-800">
        {points.map((height, index) => (
          <div
            className="flex h-full flex-1 flex-col justify-end"
            key={index}
          >
            <div
              className="w-full rounded-t-lg bg-orange-500/85 shadow-sm shadow-orange-500/20"
              style={{ height: `${height}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-6 text-xs text-zinc-500 dark:text-zinc-500">
        {["Jan", "Feb", "Mar", "Apr", "May", "Jun"].map((month) => (
          <span key={month}>{month}</span>
        ))}
      </div>
    </Card>
  );
}

function DepartmentCard() {
  return (
    <Card className="p-5 lg:col-span-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-zinc-950 dark:text-zinc-50">
          Department Performance
        </h2>
        <button className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
          This Month
        </button>
      </div>
      <div className="mt-8 space-y-6">
        {departments.map((department) => (
          <div className="grid grid-cols-[92px_1fr_42px] items-center gap-4" key={department.name}>
            <span className="text-sm text-zinc-700 dark:text-zinc-300">
              {department.name}
            </span>
            <span className="h-2 rounded-full bg-zinc-200 dark:bg-zinc-800">
              <span
                className="block h-full rounded-full bg-orange-500"
                style={{ width: department.width }}
              />
            </span>
            <span className="text-right text-sm font-medium text-zinc-950 dark:text-zinc-50">
              {department.value}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function EmployeeTable() {
  return (
    <Card className="overflow-hidden p-0 lg:col-span-8">
      <div className="flex flex-col gap-4 border-b border-zinc-200 p-5 dark:border-zinc-800 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-zinc-950 dark:text-zinc-50">
            Employee Directory
          </h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Manage and explore your workforce.
          </p>
        </div>
        <button className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white shadow-sm shadow-orange-600/20 hover:bg-orange-700 dark:bg-orange-500 dark:text-zinc-950 dark:hover:bg-orange-400">
          Add Employee
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900/70 dark:text-zinc-500">
            <tr>
              {["Employee", "Department", "Position", "Status", "Performance"].map(
                (heading) => (
                  <th className="px-5 py-3 font-medium" key={heading}>
                    {heading}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {employees.map(([name, department, position, status, performance]) => (
              <tr key={name}>
                <td className="px-5 py-4 font-medium text-zinc-950 dark:text-zinc-50">
                  {name}
                </td>
                <td className="px-5 py-4 text-zinc-600 dark:text-zinc-400">
                  {department}
                </td>
                <td className="px-5 py-4 text-zinc-600 dark:text-zinc-400">
                  {position}
                </td>
                <td className="px-5 py-4">
                  <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                    {status}
                  </span>
                </td>
                <td className="px-5 py-4 font-medium text-zinc-950 dark:text-zinc-50">
                  {performance}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function PreviewCards() {
  return (
    <div className="grid gap-4 lg:col-span-4">
      <Card className="p-5">
        <h2 className="text-base font-semibold text-zinc-950 dark:text-zinc-50">
          My Performance
        </h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Overview of your performance this month.
        </p>
        <div className="mt-6 flex items-center gap-5">
          <div className="grid h-28 w-28 place-items-center rounded-full border-[10px] border-orange-500 text-2xl font-semibold text-zinc-950 dark:text-zinc-50">
            88%
          </div>
          <div>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Goals Progress
            </p>
            <p className="mt-2 text-3xl font-semibold text-zinc-950 dark:text-zinc-50">
              6/8
            </p>
            <p className="mt-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
              On Track
            </p>
          </div>
        </div>
      </Card>
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-950 dark:text-zinc-50">
            Upcoming
          </h2>
          <a className="text-sm font-medium text-orange-600 dark:text-orange-400" href="#">
            View all
          </a>
        </div>
        <div className="mt-5 space-y-4">
          {["Team Meeting", "Training: Leadership", "Review Session"].map(
            (event, index) => (
              <div className="flex items-center gap-3" key={event}>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                  <CalendarDays className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-medium text-zinc-950 dark:text-zinc-50">
                    {event}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-500">
                    May {25 + index * 2}, 2026
                  </p>
                </div>
              </div>
            ),
          )}
        </div>
      </Card>
    </div>
  );
}

export function AppShell() {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50">
      <div className="flex min-h-screen">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar />
          <main className="flex-1 px-4 py-8 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-7xl">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.24em] text-orange-600 dark:text-orange-400">
                    Phoenix Workforce
                  </p>
                  <h1 className="mt-3 text-3xl font-semibold tracking-tight text-zinc-950 dark:text-zinc-50">
                    Executive Overview
                  </h1>
                  <p className="mt-2 max-w-2xl text-base text-zinc-600 dark:text-zinc-400">
                    Track, understand and empower your people with a focused
                    workforce command center.
                  </p>
                </div>
                <button className="inline-flex h-11 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-4 text-sm font-medium text-zinc-700 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300">
                  <CalendarDays className="h-4 w-4" />
                  May 1 - May 31, 2026
                </button>
              </div>

              <section className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
                {kpis.map((kpi) => (
                  <KpiCard key={kpi.label} {...kpi} />
                ))}
              </section>

              <section className="mt-5 grid gap-5 lg:grid-cols-12">
                <PerformanceChart />
                <DepartmentCard />
              </section>

              <section className="mt-5 grid gap-5 lg:grid-cols-12">
                <EmployeeTable />
                <PreviewCards />
              </section>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
