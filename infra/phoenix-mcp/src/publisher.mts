import type postgres from 'postgres';
import { employeeSchema,organizationSchema,vacancySchema,salesSchema,freshnessSchema,Unavailable,type Projection } from './contracts.mts';
import type { Config } from './config.mts';
import { assertVerifiedProof,contentSnapshotId } from './phoenix-source.mjs';

// Source-side component only. This module is absent from the MCP runtime entry point.
// The publisher credential can write only disposable reporting projections, not Phoenix.
export type Dataset='employees'|'vacancies'|'organization'|'published_sales';
const schemas={employees:employeeSchema,vacancies:vacancySchema,organization:organizationSchema,published_sales:salesSchema};
const periodOk=(dataset:Dataset,period:string)=>dataset==='published_sales'?/^20\d{2}-(0[1-9]|1[0-2])$/.test(period):period==='';

async function guarded(sql:postgres.Sql,c:Pick<Config,'owner'|'contractRevision'>,dataset:Dataset,period:string,work:(tx:postgres.TransactionSql)=>Promise<void>){
 await sql.begin(async tx=>{
  const [role]=await tx`select current_user as name`;if(role.name!=='phoenix_mcp_publisher')throw new Unavailable();
  const contract=await tx`select * from phoenix_mcp.contract`;
  if(contract.length!==1||contract[0].version!==2||contract[0].owner_subject!==c.owner.subject||contract[0].source_revision!==c.contractRevision)throw new Unavailable();
  await tx`set local statement_timeout='3s'`;await tx`set local lock_timeout='500ms'`;
  // Serialize publishers for this dataset and swap rows+manifest in one transaction.
  await tx`select pg_advisory_xact_lock(hashtext(${dataset+period}))`;
  await work(tx);
 });
}
const rowsTable=(tx:postgres.TransactionSql,dataset:Dataset)=>tx('phoenix_mcp.'+dataset);

// Publishes one COMPLETE dataset. The projection must carry a proof the source host derived itself
// (read log + before/after change watermarks); a hand-built projection, or rows that do not match the
// snapshot identity they claim, is refused. A refusal leaves the previous snapshot untouched.
export async function publishProjection(sql:postgres.Sql,c:Pick<Config,'owner'|'contractRevision'>,dataset:Dataset,period:string,projection:Projection<unknown>){
 const rows=projection.map(r=>schemas[dataset].parse(r)),freshness=freshnessSchema.parse(projection.freshness);
 if(rows.length>2000||Buffer.byteLength(JSON.stringify(rows))>1_000_000||!periodOk(dataset,period))throw new Unavailable();
 if(dataset==='published_sales'&&(!rows.length||rows.some(r=>!('period'in r)||r.period!==period)))throw new Unavailable();
 const proof=assertVerifiedProof(projection.proof);
 if(proof.dataset!==dataset||proof.period!==period||proof.observedAt!==freshness.sourceObservedAt||proof.updatedAt!==freshness.sourceUpdatedAt)throw new Unavailable();
 if(freshness.snapshotId!==contentSnapshotId(dataset,period,rows))throw new Unavailable();
 await guarded(sql,c,dataset,period,async tx=>{
  const [existing]=await tx`select payload from phoenix_mcp.snapshots where subject=${c.owner.subject} and dataset=${dataset} and period=${period}`;
  // Unchanged contents keep their snapshot identity: only the observation moves, so a cursor that is
  // part-way through a traversal survives a refresh that changed nothing. Rows are not rewritten.
  const unchanged=existing&&freshnessSchema.safeParse(existing.payload).data?.snapshotId===freshness.snapshotId;
  if(!unchanged){
   if(dataset==='published_sales')await tx`delete from phoenix_mcp.published_sales where subject=${c.owner.subject} and period=${period}`;
   else await tx`delete from ${rowsTable(tx,dataset)} where subject=${c.owner.subject}`;
   for(const row of rows){
    const key='key'in row?row.key:row.hrId;
    if(dataset==='published_sales')await tx`insert into phoenix_mcp.published_sales values(${c.owner.subject},${period},${key},${tx.json(row)})`;
    else await tx`insert into ${rowsTable(tx,dataset)} values(${c.owner.subject},${key},${tx.json(row)})`;
   }
  }
  await tx`insert into phoenix_mcp.snapshots values(${c.owner.subject},${dataset},${period},${tx.json(freshness)}) on conflict(subject,dataset,period) do update set payload=excluded.payload`;
 });
}

// Removes a dataset's rows AND manifest in one transaction. Used only when the source has READ
// successfully and proved the publication is absent (withdrawn); a source error never withdraws.
export async function withdrawProjection(sql:postgres.Sql,c:Pick<Config,'owner'|'contractRevision'>,dataset:Dataset,period:string){
 if(!periodOk(dataset,period))throw new Unavailable();
 await guarded(sql,c,dataset,period,async tx=>{
  if(dataset==='published_sales')await tx`delete from phoenix_mcp.published_sales where subject=${c.owner.subject} and period=${period}`;
  else await tx`delete from ${rowsTable(tx,dataset)} where subject=${c.owner.subject}`;
  await tx`delete from phoenix_mcp.snapshots where subject=${c.owner.subject} and dataset=${dataset} and period=${period}`;
 });
}
