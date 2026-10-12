import { permissionMatrix, createAccessContext, filterEmployeesForAccess, getSalesScope, isActiveDirectoryEmployee, isEmploymentAccessRevoked } from './phoenix-policy.mjs';
import { Denied, type Identity, type Principal, type Employee, type ReadStore, type ToolName } from './contracts.mts';
import type { Config } from './config.mts';

const resources = {
  get_workforce_summary:'employees', get_active_employee_count:'employees',
  get_open_vacancies:'vacancies', get_organizational_structure:'organogram', get_published_sales_summary:'sales',
} as const;
export class Authorizer {
  constructor(private readonly store: ReadStore, private readonly owner: Config['owner']) {}
  async verify(subject: string, previous?: Principal): Promise<Identity> {
    if (subject !== this.owner.subject) throw new Denied();
    const row = await this.store.identity(subject); // No cache or fallback.
    if (!row || !row.active || row.testPersona || row.subject !== subject ||
        row.loginId !== this.owner.loginId || row.role !== this.owner.role ||
        (previous && (row.sessionVersion !== previous.sessionVersion || row.role !== previous.role || row.loginId !== previous.loginId))) throw new Denied();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date());
    if (isEmploymentAccessRevoked({employmentStatus:row.employmentStatus,lastWorkingDate:row.lastWorkingDate,todayCairo:today})) throw new Denied();
    return row;
  }
  async tool(principal: Principal, name: ToolName): Promise<Identity> {
    const row = await this.verify(principal.subject, principal);
    const resource = resources[name];
    // Narrower than the web app: a live deny/lock always wins, even for the owner.
    // Grant-only overrides never widen the reviewed baseline.
    if (!permissionMatrix[row.role][resource]?.includes('read') ||
        row.permissions.some(p => p.resource === resource && !p.allowed) || row.locks.includes(resource)) throw new Denied();
    const ctx = context(row);
    if (name === 'get_published_sales_summary' && getSalesScope(ctx) !== 'COMPANY') throw new Denied();
    if ((name === 'get_open_vacancies' || name === 'get_organizational_structure') && !['company','system'].includes(ctx.scope)) throw new Denied();
    return row;
  }
}
export const context = (i: Identity) => createAccessContext({role:i.role,hrId:i.hrId,loginId:i.loginId,source:'session'});
export function activeEmployees(rows: Employee[], i: Identity) {
  return filterEmployeesForAccess(rows, context(i)).filter(isActiveDirectoryEmployee);
}
