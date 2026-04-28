import {
  BarChart3,
  BriefcaseBusiness,
  CalendarDays,
  TrendingUp,
  UsersRound,
} from "lucide-react";

import { AppShell } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";

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
  { name: "Sales", value: 92 },
  { name: "Operations", value: 87 },
  { name: "People", value: 82 },
  { name: "Finance", value: 80 },
  { name: "Support", value: 75 },
];

const employees = [
  ["Omar Ashraf", "Sales", "Sales Manager", "92%"],
  ["Sarah Mohamed", "Operations", "Operations Lead", "88%"],
  ["Ahmed Hassan", "People", "People Specialist", "84%"],
  ["Maya Ali", "Finance", "Financial Analyst", "90%"],
];

function KpiCard({
  label,
  value,
  change,
  icon: Icon,
}: (typeof kpis)[number]) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-text-secondary">{label}</p>
          <p className="mt-5 text-3xl font-semibold tracking-tight text-text">
            {value}
          </p>
        </div>
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p className="mt-4 text-sm text-text-secondary">
        <span className="font-medium text-success">{change}</span> vs last
        month
      </p>
    </Card>
  );
}

function PerformanceChart() {
  const points = [35, 52, 43, 61, 73, 58, 79, 88, 77, 95];

  return (
    <Card className="lg:col-span-7">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-text">Performance Trend</h2>
        <Button variant="secondary" className="px-3 py-1.5">
          6 Months
        </Button>
      </div>
      <div className="mt-8 flex h-48 items-end gap-3 border-b border-l border-border pl-4">
        {points.map((height, index) => (
          <div
            className="flex h-full flex-1 flex-col justify-end"
            key={index}
          >
            <div
              className="w-full rounded-t-lg bg-primary shadow-sm"
              style={{ height: `${height}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-6 text-xs text-text-secondary">
        {["Jan", "Feb", "Mar", "Apr", "May", "Jun"].map((month) => (
          <span key={month}>{month}</span>
        ))}
      </div>
    </Card>
  );
}

function DepartmentCard() {
  return (
    <Card className="lg:col-span-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-text">
          Department Performance
        </h2>
        <Button variant="secondary" className="px-3 py-1.5">
          This Month
        </Button>
      </div>
      <div className="mt-8 space-y-6">
        {departments.map((department) => (
          <div
            className="grid grid-cols-[92px_1fr_42px] items-center gap-4"
            key={department.name}
          >
            <span className="text-sm text-text-secondary">
              {department.name}
            </span>
            <Progress value={department.value} />
            <span className="text-right text-sm font-medium text-text">
              {department.value}%
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
      <div className="flex flex-col gap-4 border-b border-border p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-text">
            Employee Directory
          </h2>
          <p className="mt-1 text-sm text-text-secondary">
            Manage and explore your workforce.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input placeholder="Search employees..." />
          <Button>Add Employee</Button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="bg-bg-soft text-xs uppercase tracking-wide text-text-secondary">
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
          <tbody className="divide-y divide-border">
            {employees.map(([name, department, position, performance]) => (
              <tr key={name}>
                <td className="px-5 py-4 font-medium text-text">{name}</td>
                <td className="px-5 py-4 text-text-secondary">{department}</td>
                <td className="px-5 py-4 text-text-secondary">{position}</td>
                <td className="px-5 py-4">
                  <Badge variant="success">Active</Badge>
                </td>
                <td className="px-5 py-4 font-medium text-text">
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
      <Card>
        <h2 className="text-base font-semibold text-text">My Performance</h2>
        <p className="mt-1 text-sm text-text-secondary">
          Overview of your performance this month.
        </p>
        <div className="mt-6 flex items-center gap-5">
          <div className="grid h-28 w-28 place-items-center rounded-full border-[10px] border-primary text-2xl font-semibold text-text">
            88%
          </div>
          <div>
            <p className="text-sm text-text-secondary">Goals Progress</p>
            <p className="mt-2 text-3xl font-semibold text-text">6/8</p>
            <p className="mt-2 text-sm font-medium text-success">On Track</p>
          </div>
        </div>
      </Card>
      <Card>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-text">Upcoming</h2>
          <a className="text-sm font-medium text-primary" href="#">
            View all
          </a>
        </div>
        <div className="mt-5 space-y-4">
          {["Team Meeting", "Training: Leadership", "Review Session"].map(
            (event, index) => (
              <div className="flex items-center gap-3" key={event}>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-bg-muted text-text-secondary">
                  <CalendarDays className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text">{event}</p>
                  <p className="text-xs text-text-secondary">
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

export default function Home() {
  return (
    <AppShell>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-primary">
            Phoenix Workforce
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-text">
            Executive Overview
          </h1>
          <p className="mt-2 max-w-2xl text-base text-text-secondary">
            Track, understand and empower your people with a focused workforce
            command center.
          </p>
        </div>
        <Button variant="secondary" className="h-11 gap-2">
          <CalendarDays className="h-4 w-4" />
          May 1 - May 31, 2026
        </Button>
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
    </AppShell>
  );
}
