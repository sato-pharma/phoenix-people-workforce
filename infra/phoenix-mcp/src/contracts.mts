import { z } from 'zod';

export const toolNames = ['get_workforce_summary', 'get_active_employee_count', 'get_open_vacancies', 'get_organizational_structure', 'get_published_sales_summary'] as const;
export type ToolName = typeof toolNames[number];
export const scope = 'phoenix:read';
const label=z.string().max(300);
export const identitySchema = z.object({
  subject: z.string().uuid(), loginId: z.string().min(1).max(100), hrId: z.string().nullable(),
  role: z.enum(['Super Admin', 'CEO']), active: z.boolean(), sessionVersion: z.number().int().nonnegative(),
  employmentStatus: z.string().nullable(), lastWorkingDate: z.string().nullable(),
  testPersona: z.boolean(), permissions: z.array(z.object({resource: z.string(), allowed: z.boolean()})).max(300),
  locks: z.array(z.string()).max(300),
});
export type Identity = z.infer<typeof identitySchema>;
export type Principal = Pick<Identity, 'subject' | 'loginId' | 'role' | 'sessionVersion'>;
export const employeeSchema = z.object({
  hrId: label, managerHrId: label.nullable(), fullName: label, jobTitle: label.nullable(),
  // Internal classification inputs only; never emitted by a tool.
  positionTitle: label.nullable(), nodeType: label.nullable(), recordType: label.nullable(),
  businessType: label.nullable(), employeeType: label.nullable(),
  employmentStatus: z.string().nullable(), organogramVisible: z.boolean().nullable(),
  department: label.nullable(), line: label.nullable(),
});
export const vacancySchema = z.object({
  key: label, position: label, department: label.nullable(), line: label.nullable(),
  area: label.nullable(), status: z.literal('open'),
});
export const organizationSchema = z.object({
  key: label, parentKey: label.nullable(), parentPosition: label.nullable(), position: label, employeeName: label.nullable(),
  department: label.nullable(), line: label.nullable(), area: label.nullable(), vacant: z.boolean(),
});
export const salesSchema = z.object({
  key: label, period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), line: label,
  salesValue: z.number().finite(), targetValue: z.number().finite().nonnegative().nullable(),
  currency: z.literal('EGP'), publishedAt: z.string().datetime({offset: true}),
  sourceRevision: z.string().min(1),
});
export type Employee = z.infer<typeof employeeSchema>;
export type Vacancy = z.infer<typeof vacancySchema>;
export type Organization = z.infer<typeof organizationSchema>;
export type Sales = z.infer<typeof salesSchema>;
export const freshnessSchema = z.object({
  snapshotId:z.string().uuid(), sourceUpdatedAt:z.string().datetime({offset:true}),
  sourceObservedAt:z.string().datetime({offset:true}),
});
export type Freshness = z.infer<typeof freshnessSchema>;
// `proof` exists only on projections sealed by the source host (source-adapters.mts `seal`); a
// projection read back from the reporting database carries freshness alone.
export type Projection<T> = T[] & {freshness:Freshness; proof?:unknown};
export function projection<T>(rows:T[], freshness:Freshness):Projection<T> {
  return Object.assign(rows,{freshness:freshnessSchema.parse(freshness)});
}
export interface ReadStore {
  identity(subject: string): Promise<Identity | null>;
  employees(subject: string): Promise<Projection<Employee>>;
  vacancies(subject: string, after: string, limit: number): Promise<Projection<Vacancy>>;
  organization(subject: string, after: string, limit: number): Promise<Projection<Organization>>;
  sales(subject: string, period: string, after: string, limit: number): Promise<Projection<Sales>>;
  ready(): Promise<void>;
  close(): Promise<void>;
}
export class Denied extends Error { constructor() { super('Access denied'); } }
export class Unavailable extends Error { constructor() { super('Phoenix data is unavailable'); } }
// A source that was READ SUCCESSFULLY and holds no publication. Distinct from Unavailable, which is "could not tell".
export class NotPublished extends Unavailable {}
