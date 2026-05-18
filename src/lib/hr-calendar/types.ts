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

export type HrCalendarEventType = "anniversary" | "birthday" | "new_hire";

export type HrCalendarEvent = {
  date: string;
  employee: HrCalendarEmployee;
  eventType: HrCalendarEventType;
  tenureYears: number;
};
