export type HrCalendarEmployee = {
  areaName: string;
  birthDate: string;
  fullName: string;
  hireDate: string;
  hrId: string;
  jobTitle: string;
  lineName: string;
  managerName: string;
  workEmail: string | null;
};

export type HrCalendarEventType = "anniversary" | "birthday" | "first_month" | "new_hire";

export type HrCalendarEvent = {
  date: string;
  employee: HrCalendarEmployee;
  eventType: HrCalendarEventType;
  tenureYears: number;
  /**
   * The milestone period this row can be printed as — `0d` for the arrival (the first day as a
   * member of the family), `1m`, `5y`, `b4` — or null when the row has no card (a birthday or
   * anniversary with no usable date). A calendar chip is a link only when this is set.
   */
  spec: string | null;
};

export type HrWeeklyOffMode = "working" | "am_only" | "pm_only" | "full_day";

export type HrWeeklyOffPolicy = {
  friday: HrWeeklyOffMode;
  saturday: HrWeeklyOffMode;
  thursday: HrWeeklyOffMode;
};
