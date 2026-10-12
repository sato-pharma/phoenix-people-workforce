// Source-side ONLY. This is not imported/bundled into the MCP reader or deployed.
// It binds Phoenix's EXISTING report loaders to the completeness-aware collector. Every loader runs
// under the read recorder and a before/after change watermark (src/lib/mcp-source), so a report that
// merely "returned" is never enough: swallowed failures, caches, truncation, unwatched reads and
// concurrent changes are refused. Never give the reader the source process's credentials.
import { getEmployeeDirectory,invalidateEmployeeDirectoryCache } from '../../../src/lib/employees/employee-directory.ts';
import { getOrganogramReport,getScopedVacancyReport } from '../../../src/lib/reports/organogram.ts';
import { loadPortalMonthlyClosing,resolvePortalClosingScope } from '../../../src/lib/sales/monthly-closing-portal.ts';
import { normalizeClosingLine } from '../../../src/lib/sales/monthly-closing-publication.ts';
import { getSupabaseAdmin } from '../../../src/lib/supabase/server.ts';
import { loadPermissionMatrixUncached } from '../../../src/lib/auth/permissions.ts';
import { context } from '../src/policy.mts';
import { identitySchema } from '../src/contracts.mts';
import { createCollector } from '../src/source-collect.mts';
import { createRpcWatermarkReader,withChangeClock,loadLiveIdentity } from '../src/phoenix-source.mjs';
import { createSupabaseLiveSources } from '../../../src/lib/mcp-source/live-authorization.ts';

// The owner's identity, read LIVE every cycle through the same decision the reader's bridge uses. A
// denied or undecidable owner means nothing is collected at all.
export async function liveOwnerIdentity(subject){
 const db=getSupabaseAdmin();
 const identity=await loadLiveIdentity(subject,createSupabaseLiveSources(db,loadPermissionMatrixUncached));
 return identity===null?null:identitySchema.parse(identity);
}

export function createPhoenixCollector(identity){
 const access=context(identity);
 const db=getSupabaseAdmin();
 const loaders={
  async employees(){
   // Uncached by construction: drop the 30-second directory cache so the read is issued, and with the
   // cache empty there is no stale copy to fall back to. The proof independently refuses a cache hit.
   invalidateEmployeeDirectoryCache();
   const directory=await getEmployeeDirectory();
   return directory.employees.map(e=>({...e,department:e.department??e.departmentName??null,line:e.line??e.lineName??null,
    positionTitle:e.positionTitle??null,nodeType:e.nodeType??null,recordType:e.recordType??null,businessType:e.businessType??null,employeeType:e.employeeType??null}));
  },
  organization:()=>getOrganogramReport(access),
  // getScopedVacancyReport already reconciles occupied seats, replacements and offers.
  vacancies:()=>getScopedVacancyReport(access),
  async lines(){return (await resolvePortalClosingScope(access)).allowedLines;},
  // STRICT, unlike isClosingPublished (which answers false for any database error): null only when
  // the read succeeded and there is no live publication row.
  async publication(line,period){
   const {data,error}=await db.from('monthly_closing_publications').select('id,published_at').eq('normalized_line',normalizeClosingLine(line)).eq('period',period).is('unpublished_at',null).limit(2);
   if(error)throw new Error('publication read failed');
   if(data.length>1)throw new Error('ambiguous publication');
   return data[0]?{publishedAt:new Date(data[0].published_at).toISOString(),revision:String(data[0].id)}:null;
  },
  closing:(line,period)=>loadPortalMonthlyClosing({access,line,period}),
 };
 const watermark=withChangeClock(createRpcWatermarkReader(db));
 return createCollector({loaders,identity,watermark});
}
