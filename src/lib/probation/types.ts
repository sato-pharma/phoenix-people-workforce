export type TrafficStatus = "critical" | "warning" | "safe";

export type ProbationRow = {
  area_name: string;
  crm_id: string;
  employment_status?: string;
  days_remaining: number;
  full_name: string;
  hire_date: string;
  hr_id: string;
  job_title: string;
  line_name: string;
  probation_end_date: string;
};
