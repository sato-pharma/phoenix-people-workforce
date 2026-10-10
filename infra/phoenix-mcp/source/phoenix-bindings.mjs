// Source-side ONLY. This is not imported/bundled into the MCP reader or deployed.
// Bind inside an approved Phoenix source process, where report IO can be checked
// for completeness. Never give the reader the source process's credentials.
import { getEmployeeDirectory } from '../../../src/lib/employees/employee-directory.ts';
import { getOrganogramReport,getScopedVacancyReport } from '../../../src/lib/reports/organogram.ts';
import { loadPortalMonthlyClosing,resolvePortalClosingScope } from '../../../src/lib/sales/monthly-closing-portal.ts';
import { context } from '../src/policy.mts';
import { workforceAdapter,organizationAdapter,vacancyAdapter,salesAdapter,sourceMetadata } from '../src/source-adapters.mts';

export async function collectCanonicalProjection(identity,period,sourceProof){
 const access=context(identity);
 // Must bypass web report caches or attest the original read time, never fetch time.
 const before=await sourceProof.begin(identity);
 const [directory,organization,vacancies,scope]=await Promise.all([
  getEmployeeDirectory(),getOrganogramReport(access),getScopedVacancyReport(access),resolvePortalClosingScope(access),
 ]);
 // Provisional metadata is replaced after every report and publication read completes.
 const now=new Date().toISOString();
 const freshness=sourceMetadata({complete:true,sourceUpdatedAt:now,sourceObservedAt:now});
 const employees=directory.employees.map(e=>({...e,department:e.department??e.departmentName??null,line:e.line??e.lineName??null,
  positionTitle:e.positionTitle??null,nodeType:e.nodeType??null,recordType:e.recordType??null,businessType:e.businessType??null,employeeType:e.employeeType??null}));
 const result={
  employees:workforceAdapter(employees,identity,freshness),organization:organizationAdapter(organization,freshness),vacancies:vacancyAdapter(vacancies,freshness),
  published_sales:await salesAdapter(period,scope.allowedLines,{publication:sourceProof.publication,closing:(line,month)=>loadPortalMonthlyClosing({access,line,period:month})},freshness),
 };
 const verified=sourceMetadata(await sourceProof.finish(before));
 for(const projection of Object.values(result))projection.freshness=verified;
 return result;
}
