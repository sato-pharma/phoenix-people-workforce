import { getEmployeeDirectory } from '../../../src/lib/employees/employee-directory.ts';
import { getOrganogramReport,getScopedVacancyReport } from '../../../src/lib/reports/organogram.ts';
import { loadPortalMonthlyClosing,resolvePortalClosingScope } from '../../../src/lib/sales/monthly-closing-portal.ts';
import { context } from '../src/policy.mts';
import { workforceAdapter,organizationAdapter,vacancyAdapter,salesAdapter } from '../src/source-adapters.mts';

export async function collectCanonicalDataset(identity,dataset,period,transport){
 const access=context(identity);
 const required={employees:['employees'],vacancies:['au_v_org_tree','position_vacancies'],organization:['au_v_org_tree','employees'],published_sales:['monthly_closing_publications','rpc/phx_closing_distributor_product','rpc/phx_monthly_closing_direct']};
 const proof=transport.proof(required[dataset]);
 const {value,freshness}=await proof.collect(async()=>{
  if(dataset==='employees')return (await getEmployeeDirectory()).employees;
  if(dataset==='vacancies')return getScopedVacancyReport(access);
  if(dataset==='organization')return getOrganogramReport(access);
  const scope=await resolvePortalClosingScope(access);
  const now=new Date().toISOString(),placeholder={snapshotId:'11111111-1111-4111-8111-111111111111',sourceUpdatedAt:now,sourceObservedAt:now};
  return salesAdapter(period,scope.allowedLines,{
   publication:async(line,month)=>{
    const rows=await transport.json('monthly_closing_publications?'+new URLSearchParams({select:'line,period,published_at',normalized_line:'eq.'+line.trim().toLowerCase(),period:'eq.'+month,unpublished_at:'is.null'}));
    if(rows.length===0)return null;if(rows.length!==1)throw Error('Ambiguous publication');
    return {publishedAt:rows[0].published_at,revision:JSON.stringify(rows[0])};
   },closing:(line,month)=>loadPortalMonthlyClosing({access,line,period:month}),
  },placeholder);
 });
 if(dataset==='employees')return workforceAdapter(value,identity,freshness);
 if(dataset==='vacancies')return vacancyAdapter(value,freshness);
 if(dataset==='organization')return organizationAdapter(value,freshness);
 value.freshness=freshness;return value;
}
