import { z } from 'zod';
import { employeeSchema,organizationSchema,vacancySchema,salesSchema,projection,Unavailable,NotPublished,type Identity,type Projection } from './contracts.mts';
import { activeEmployees } from './policy.mts';

import { assertVerifiedProof,sealFreshness,type VerifiedProof } from './phoenix-source.mjs';

// This boundary consumes completed CANONICAL reports, never raw SQL sales/seat rows.
// Adapters are pure: they whitelist and validate rows. Completeness is NOT asserted by any caller;
// `seal` is the only way a projection gets freshness, and it requires a proof that the source host
// derived from its read log and before/after change watermarks (src/lib/mcp-source/source-proof.ts).
// Snapshot identity is a function of the rows, so an unchanged re-read keeps its identity while its
// observation time moves forward.
export function seal<T>(dataset:'employees'|'vacancies'|'organization'|'published_sales',period:string,rows:T[],proof:VerifiedProof):Projection<T>{
 const verified=assertVerifiedProof(proof);
 if(verified.dataset!==dataset||verified.period!==period)throw new Unavailable();
 return Object.assign(projection(rows,sealFreshness(verified,rows)),{proof:verified});
}
export function workforceAdapter(rows:unknown[],identity:Identity){
 if(rows.length>2000)throw new Unavailable();
 return activeEmployees(rows.map(row=>employeeSchema.parse(row)),identity);
}
const text=z.string().max(300),nullable=text.nullable();
const orgRow=z.object({hrId:text,seatId:text.nullish(),managerHrId:nullable,jobTitle:nullable,positionTitle:nullable,
 fullName:nullable,displayName:nullable,departmentName:nullable,lineName:nullable,areaName:nullable,type:z.enum(['employee','vacancy'])});
const vacancyRow=z.object({id:z.number().int(),positionTitle:nullable,jobTitle:nullable,departmentName:nullable,lineName:nullable,areaName:nullable,status:text});
export function organizationAdapter(report:{diagnostic?:unknown;organogramRows:unknown[]}){
 if(report.diagnostic||report.organogramRows.length>2000)throw new Unavailable();
 const rows=report.organogramRows.map(r=>orgRow.parse(r));
 const key=(r:z.infer<typeof orgRow>)=>r.seatId?`seat:${r.seatId}`:`node:${r.hrId}`;
 const keys=new Set(rows.map(key));if(keys.size!==rows.length)throw new Unavailable();
 const result=rows.map(row=>{
  // HR node aliases can repeat for a person holding two seats. Do not invent an edge.
  const parents=row.managerHrId===null?[]:rows.filter(r=>r.hrId===row.managerHrId);
  if(row.managerHrId!==null&&parents.length!==1)throw new Unavailable();
  const parent=parents[0];
  return organizationSchema.parse({key:key(row),parentKey:parent?key(parent):null,parentPosition:parent?.positionTitle??parent?.jobTitle??null,
   position:row.positionTitle??row.jobTitle??'Unassigned',employeeName:row.type==='employee'?(row.fullName??row.displayName):null,
   department:row.departmentName,line:row.lineName,area:row.areaName,vacant:row.type==='vacancy'});
 });
 const byKey=new Map(result.map(r=>[r.key,r]));
 for(const row of result){const seen=new Set<string>();let current:typeof row|undefined=row;while(current){if(seen.has(current.key))throw new Unavailable();seen.add(current.key);current=current.parentKey?byKey.get(current.parentKey):undefined;}}
 return result.sort((a,b)=>a.key.localeCompare(b.key));
}
export function vacancyAdapter(report:{diagnostic?:unknown;rows:unknown[]}){
 if(report.diagnostic||report.rows.length>2000)throw new Unavailable();
 // Input MUST be getScopedVacancyReport's output (already occupancy reconciled).
 const rows=report.rows.map(r=>vacancyRow.parse(r)).filter(r=>r.status==='open').map(r=>vacancySchema.parse({key:String(r.id),position:r.positionTitle??r.jobTitle??'Unassigned',department:r.departmentName,line:r.lineName,area:r.areaName,status:'open'}));
 if(new Set(rows.map(r=>r.key)).size!==rows.length)throw new Unavailable();
 return rows.sort((a,b)=>a.key.localeCompare(b.key));
}
const total=z.object({rowTotal:z.object({salesValue:z.number().finite(),targetValue:z.number().finite().nonnegative().nullable()})});
const closing=z.object({awaitingPublish:z.literal(false),selectedPeriod:text,line:text,matrix:z.object({line:text,period:text,periods:z.array(text).optional(),grandTotal:total,companyTotal:total.nullish()})});
export async function salesAdapter(period:string,lines:string[],source:{
 publication:(line:string,period:string)=>Promise<{publishedAt:string;revision:string}|null>;
 closing:(line:string,period:string)=>Promise<unknown>;
}){
 if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(period)||!lines.length||lines.length>10||new Set(lines).size!==lines.length)throw new Unavailable();
 const rows=[];
 for(const line of lines){
  if(/head\s*office/i.test(line))throw new Unavailable();
  // Check BEFORE loading: the portal intentionally falls back to the latest month.
  const before=await source.publication(line,period);if(!before)throw new NotPublished();
  const report=closing.parse(await source.closing(line,period)),matrix=report.matrix;
  if(report.selectedPeriod!==period||report.line!==line||matrix.period!==period||matrix.line!==line||matrix.periods?.some(p=>p!==period))throw new Unavailable();
  const after=await source.publication(line,period);
  if(!after||after.revision!==before.revision||after.publishedAt!==before.publishedAt)throw new Unavailable();
  // The canonical engine already computes both totals (including direct company sales).
  const cell=(matrix.companyTotal??matrix.grandTotal).rowTotal;
  rows.push(salesSchema.parse({key:line,period,line,...cell,currency:'EGP',publishedAt:after.publishedAt,sourceRevision:after.revision}));
 }
 return rows.sort((a,b)=>a.key.localeCompare(b.key));
}
