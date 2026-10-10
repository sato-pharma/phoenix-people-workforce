import postgres from 'postgres';
import { employeeSchema, identitySchema, organizationSchema, salesSchema, vacancySchema, Unavailable, type ReadStore } from './contracts.mts';
import type { Config } from './config.mts';

// These are versioned, approval-gated read interfaces, NOT existing production tables.
// No fallback to public.*, a service key, or an arbitrary RPC is permitted.
export const queries = {
  identity: 'select payload from phoenix_mcp.identity where subject = $1 limit 2',
  employees: 'select payload from phoenix_mcp.employees where subject = $1 order by record_key limit 2001',
  vacancies: 'select payload from phoenix_mcp.vacancies where subject = $1 and record_key > $2 order by record_key limit $3',
  organization: 'select payload from phoenix_mcp.organization where subject = $1 and record_key > $2 order by record_key limit $3',
  sales: 'select payload from phoenix_mcp.published_sales where subject = $1 and period = $2 and record_key > $3 order by record_key limit $4',
} as const;
export const privilegeAuditSql = `select
 current_user as role,
 (select rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication from pg_roles where rolname=current_user) as privileged,
 exists(select 1 from pg_auth_members where member=(select oid from pg_roles where rolname=current_user)) as membership,
 has_database_privilege(current_database(),'CREATE') as db_create,
 has_database_privilege(current_database(),'TEMP') as db_temp,
 exists(select 1 from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema' and has_schema_privilege(oid,'CREATE')) as schema_create,
 exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname not like 'pg_%' and n.nspname <> 'information_schema' and c.relkind in ('r','p','v','m','f')
  and (c.relowner=(select oid from pg_roles where rolname=current_user) or
       has_table_privilege(c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))) as writes,
 exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname not like 'pg_%' and n.nspname <> 'information_schema' and c.relkind='S'
  and has_schema_privilege(n.oid,'USAGE') and case when c.relkind='S' then has_sequence_privilege(c.oid,'USAGE,UPDATE') else false end) as sequences,
 exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
  and has_schema_privilege(n.oid,'USAGE') and has_function_privilege(p.oid,'EXECUTE')) as functions,
 exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname not like 'pg_%' and n.nspname <> 'information_schema' and c.relkind in ('r','p','v','m','f')
  and has_schema_privilege(n.oid,'USAGE') and has_table_privilege(c.oid,'SELECT')
  and not (n.nspname='phoenix_mcp' and c.relname in ('contract','identity','employees','vacancies','organization','published_sales'))) as extra_reads`;
export function assertPrivileges(row: Record<string, unknown>, expectedRole: string) {
  if (row.role !== expectedRole || ['privileged','membership','db_create','db_temp','schema_create','writes','sequences','functions','extra_reads'].some(k => row[k] !== false)) throw new Unavailable();
}
export function createReadStore(c: Config): ReadStore {
  const sql = postgres(c.databaseUrl, {
    max:2, connect_timeout:5, idle_timeout:10, max_lifetime:60, prepare:false,
    ssl:{rejectUnauthorized:true},
    connection:{application_name:'phoenix-mcp-read-only',statement_timeout:3000,lock_timeout:500,idle_in_transaction_session_timeout:5000,default_transaction_read_only:true},
    onnotice:()=>{},
  });
  let running = 0;
  async function transaction<T>(subject: string | null, work: (tx: postgres.TransactionSql) => Promise<T>) {
    if (running >= 2) throw new Unavailable(); // No unbounded pool queue.
    running++;
    try {
      return await sql.begin('read only', async tx => {
        const [rights] = await tx.unsafe(privilegeAuditSql);
        assertPrivileges(rights, c.databaseRole);
        const contract = await tx`select version, source_revision, owner_subject from phoenix_mcp.contract limit 2`;
        if (contract.length !== 1 || contract[0].version !== 1 || contract[0].source_revision !== c.contractRevision || contract[0].owner_subject !== c.owner.subject) throw new Unavailable();
        if (subject !== null && subject !== c.owner.subject) throw new Unavailable();
        // Transaction-local only; a pooled connection never retains another identity.
        await tx`select set_config('phoenix_mcp.subject', ${subject ?? ''}, true)`;
        return await work(tx);
      }) as T;
    } catch { throw new Unavailable(); }
    finally { running--; }
  }
  async function read(subject: string, query: string, args: (string|number)[]) {
    return transaction(subject, async tx => {
      const result = await tx.unsafe(query,args);
      if (Buffer.byteLength(JSON.stringify(result)) > 1_000_000) throw new Unavailable();
      return result.map(r => r.payload);
    });
  }
  return {
    async identity(s) { const rows=await read(s,queries.identity,[s]); if(rows.length>1) throw new Unavailable(); return rows.length ? identitySchema.parse(rows[0]) : null; },
    async employees(s) { const rows=await read(s,queries.employees,[s]); if(rows.length>2000) throw new Unavailable(); return rows.map(r=>employeeSchema.parse(r)); },
    async vacancies(s,a,l) { return (await read(s,queries.vacancies,[s,a,l])).map(r=>vacancySchema.parse(r)); },
    async organization(s,a,l) { return (await read(s,queries.organization,[s,a,l])).map(r=>organizationSchema.parse(r)); },
    async sales(s,p,a,l) { return (await read(s,queries.sales,[s,p,a,l])).map(r=>salesSchema.parse(r)); },
    async ready() { await transaction(null,async()=>undefined); },
    async close() { await sql.end({timeout:5}); },
  };
}
