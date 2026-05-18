import { NextResponse } from "next/server";

import { buildHrCalendarEvents } from "@/lib/hr-calendar/calendar-logic";
import { safeSendNotificationEmail } from "@/lib/notifications/email";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type BirthdayEmployeeRow = {
  birth_date: string | null;
  employment_status: string | null;
  full_name: string;
  hr_id: string;
};

function cairoMonthDay() {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Africa/Cairo",
  }).formatToParts(new Date());
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${month}-${day}`;
}

function cairoYear() {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date());
}

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV === "development";
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

async function runBirthdayNotifications(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized", message: "Birthday notification run is not authorized." }, { status: 401 });
  }

  const today = cairoMonthDay();
  const year = cairoYear();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employees")
    .select("hr_id,full_name,birth_date,employment_status")
    .not("birth_date", "is", null);

  if (error) throw error;

  const activeEmployees = ((data ?? []) as BirthdayEmployeeRow[]).filter((employee) => {
    const active = !employee.employment_status || employee.employment_status === "active";
    return active && employee.birth_date;
  });
  const [monthText, dayText] = today.split("-");
  const birthdayEvents = buildHrCalendarEvents(
    activeEmployees.map((employee) => ({
      areaName: "",
      birthDate: employee.birth_date ?? "",
      fullName: employee.full_name,
      hireDate: "",
      hrId: employee.hr_id,
      jobTitle: "",
      lineName: "",
      managerName: "",
      workEmail: null,
    })),
    Number(monthText),
    Number(year),
  ).filter((event) => event.eventType === "birthday" && event.date.slice(5, 10) === `${monthText}-${dayText}`);
  const results = [];

  for (const event of birthdayEvents) {
    const employee = event.employee;
    const result = await safeSendNotificationEmail({
      ctaHref: "/hr-calendar",
      ctaLabel: "Open HR calendar",
      employeeHrId: employee.hrId,
      metrics: [
        { label: "Employee", value: `${employee.fullName} (${employee.hrId})` },
        { label: "Birthday", value: today },
        { label: "Year", value: year },
      ],
      notificationType: "birthday",
      subject: `Phoenix Birthday Reminder - ${employee.fullName} - ${year}`,
      summary: `Birthday reminder for ${employee.fullName}. Prepare a timely people-care follow-up.`,
      title: "Birthday Reminder",
      tone: "neutral",
    });
    results.push({ employeeHrId: employee.hrId, result });
  }

  return NextResponse.json({
    matched: birthdayEvents.length,
    results,
    today,
  });
}

export async function GET(request: Request) {
  try {
    return await runBirthdayNotifications(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Birthday notification run failed.";
    return NextResponse.json({ error: "birthday_notifications_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
