import type postgres from 'postgres';
import { createHash } from 'node:crypto';
import { employeeSchema,organizationSchema,vacancySchema,salesSchema,freshnessSchema,Unavailable,type Projection } from './contracts.mts';
import type { Config } from './config.mts';

// Source-side component only. This module is absent from the MCP runtime entry point.
// The publisher credential can write only disposable reporting projections, not Phoenix.
export async function publishProjection(sql:postgres.Sql,c:Pick<Config,'owner'|'contractRevision'>,dataset:'employees'|'vacancies'|'organization'|'published_sales',period:string,projection:Projection<unknown>){
 const schemas={employees:employeeSchema,vacancies:vacancySchema,organization:organizationSchema,published_sales:salesSchema};
 const rows=projection.map(r=>schemas[dataset].parse(r)),freshness=freshnessSchema.parse(projection.freshness);
 if(rows.length>2000||Buffer.byteLength(JSON.stringify(rows))>1_000_000)throw new Unavailable();
 if(dataset==='published_sales'?(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(period)||!rows.length||rows.some(r=>!('period'in r)||r.period!==period)):period!=='')throw new Unavailable();
 await sql.begin(async tx=>{
  const [role]=await tx`select current_user as name`;if(role.name!=='phoenix_mcp_publisher')throw new Unavailable();
  const contract=await tx`select * from phoenix_mcp.contract`;
  if(contract.length!==1||contract[0].version!==2||contract[0].owner_subject!==c.owner.subject||contract[0].source_revision!==c.contractRevision)throw new Unavailable();
  await tx`set local statement_timeout='3s'`;await tx`set local lock_timeout='500ms'`;
  // Serialize publishers for this dataset and swap rows+manifest in one transaction.
  await tx`select pg_advisory_xact_lock(hashtext(${dataset+period}))`;
  const keyOf=(row:typeof rows[number])=>'key'in row?row.key:row.hrId;
  rows.sort((a,b)=>keyOf(a)<keyOf(b)?-1:keyOf(a)>keyOf(b)?1:0);
  const contentHash=createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const [previous]=await tx`select payload from phoenix_mcp.snapshots where subject=${c.owner.subject} and dataset=${dataset} and period=${period}`;
  if(previous&&Date.parse(previous.payload.sourceObservedAt)>Date.parse(freshness.sourceObservedAt))throw new Unavailable();
  if(previous?.payload.contentHash===contentHash){
   // Fresh observation, identical approved content: keep the traversal and change time stable.
   await tx`update phoenix_mcp.snapshots set payload=${tx.json({...freshness,snapshotId:previous.payload.snapshotId,sourceUpdatedAt:previous.payload.sourceUpdatedAt,contentHash})} where subject=${c.owner.subject} and dataset=${dataset} and period=${period}`;
   return;
  }
  if(dataset==='published_sales')await tx`delete from phoenix_mcp.published_sales where subject=${c.owner.subject} and period=${period}`;
  else await tx`delete from ${tx('phoenix_mcp.'+dataset)} where subject=${c.owner.subject}`;
  for(const row of rows){
   const key='key'in row?row.key:row.hrId;
   if(dataset==='published_sales')await tx`insert into phoenix_mcp.published_sales values(${c.owner.subject},${period},${key},${tx.json(row)})`;
   else await tx`insert into ${tx('phoenix_mcp.'+dataset)} values(${c.owner.subject},${key},${tx.json(row)})`;
  }
  await tx`insert into phoenix_mcp.snapshots values(${c.owner.subject},${dataset},${period},${tx.json({...freshness,contentHash})}) on conflict(subject,dataset,period) do update set payload=excluded.payload`;
 });
}
export async function invalidateProjection(sql:postgres.Sql,subject:string,dataset:string,period:string){
 await sql.begin(async tx=>{
  const [role]=await tx`select current_user as name`;if(role.name!=='phoenix_mcp_publisher')throw new Unavailable();
  await tx`set local statement_timeout='3s'`;await tx`set local lock_timeout='500ms'`;
  await tx`select pg_advisory_xact_lock(hashtext(${dataset+period}))`;
  await tx`delete from phoenix_mcp.snapshots where subject=${subject} and dataset=${dataset} and period=${period}`;
 });
}
