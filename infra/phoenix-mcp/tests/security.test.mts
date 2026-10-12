import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { postgresFixture } from './postgres-fixture.mts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config, fixtureStore, subject } from './fixtures.mts';
import { Authorizer, activeEmployees } from '../src/policy.mts';
import { StateStore, digest, randomToken } from '../src/state.mts';
import { OAuthProvider, type IdentityProvider } from '../src/oauth.mts';
import { ToolService, type Audit } from '../src/tools.mts';
import { toolNames, employeeSchema } from '../src/contracts.mts';
import { configFromEnv } from '../src/config.mts';
import { assertPrivileges, privilegeAuditSql } from '../src/database.mts';
import { createApp } from '../src/server.mts';

const upstream:IdentityProvider={authorization:({state})=>`https://identity.example.test/authorize?state=${state}`,exchange:async()=>subject};
function setup(){
  const f=fixtureStore(),state=new StateStore(':memory:'),auth=new Authorizer(f.db,config.owner),events:Parameters<Audit>[0][]=[];
  const service=new ToolService(f.db,auth,state,e=>events.push(e),config.nodeIdKey),provider=new OAuthProvider(config,state,auth,upstream);
  return {...f,state,auth,events,service,provider};
}
async function tokens(s:ReturnType<typeof setup>){
  const verifier=randomToken(),code=randomToken(),client=(await s.provider.clientsStore.getClient(config.clientId))!;
  s.state.put('code',code,{clientId:config.clientId,redirect:config.redirectUri,challenge:digest(verifier),principal:s.identity()},60);
  return s.provider.exchangeAuthorizationCode(client,code,verifier,config.redirectUri,new URL(config.resource));
}
test('all five tools execute and return bounded approved results',async()=>{
  const s=setup();try{
    for(const name of toolNames){const r=await s.service.execute(name,name==='get_published_sales_summary'?{period:'2026-09'}:{},s.identity());assert.ok(r.generatedAt);}
    const count=await s.service.execute('get_active_employee_count',{},s.identity());assert.equal(count.activeEmployeeCount,2);
    const sales=await s.service.execute('get_published_sales_summary',{period:'2026-09'},s.identity());assert.equal((sales.items as {achievementPercent:number}[])[0].achievementPercent,75);
    await assert.rejects(s.service.execute('get_published_sales_summary',{period:'2026-08'},s.identity()));
  }finally{s.state.close();}
});
test('owner binding, account disable, test persona and role changes fail closed',async()=>{
  for(const change of [{subject:'22222222-2222-4222-8222-222222222222'},{role:'CEO' as const},{active:false},{testPersona:true},{loginId:'other'},{employmentStatus:'terminated'}]){
    const s=setup();try{const old=s.identity();s.setIdentity(change);await assert.rejects(s.service.execute('get_workforce_summary',{},old));}finally{s.state.close();}
  }
});
test('live read denies and module locks override baseline grants',async()=>{
  for(const patch of [{permissions:[{resource:'employees',allowed:false}]},{locks:['employees']}] ){
    const s=setup();try{s.setIdentity(patch);await assert.rejects(s.service.execute('get_active_employee_count',{},s.identity()));}finally{s.state.close();}
  }
});
test('authorization source outages deny instead of using stale permissions',async()=>{
  const s=setup();try{await s.service.execute('get_active_employee_count',{},s.identity());s.fail();await assert.rejects(s.service.execute('get_active_employee_count',{},s.identity()));}finally{s.state.close();}
});
test('unknown keys, SQL inputs, invalid periods and oversized pages are refused',async()=>{
  const s=setup();try{
    for(const input of [{sql:'select * from employees'},{limit:51},{limit:0},{cursor:'forged'}])await assert.rejects(s.service.execute('get_open_vacancies',input,s.identity()));
    await assert.rejects(s.service.execute('get_published_sales_summary',{period:'2026-13'},s.identity()));
  }finally{s.state.close();}
});
test('pagination is complete and cursors are bound to tool, account and authorization version',async()=>{
  const s=setup();try{
    const first=await s.service.execute('get_open_vacancies',{limit:2},s.identity());assert.equal(first.hasMore,true);
    const second=await s.service.execute('get_open_vacancies',{limit:2,cursor:first.nextCursor},s.identity());assert.equal((second.items as unknown[]).length,1);assert.equal(second.hasMore,false);
    await assert.rejects(s.service.execute('get_organizational_structure',{cursor:first.nextCursor},s.identity()));
    s.setIdentity({sessionVersion:2});await assert.rejects(s.service.execute('get_open_vacancies',{cursor:first.nextCursor},s.identity()));
  }finally{s.state.close();}
});
test('sensitive columns are stripped and audit events contain no results or inputs',async()=>{
  const s=setup();try{
    const dirty=employeeSchema.parse({...s.employees[0],salary:99999,bankAccount:'SECRET',nationalId:'SECRET',medical:'SECRET',attachments:['SECRET']});
    assert.equal('salary'in dirty,false);
    const result=await s.service.execute('get_workforce_summary',{},s.identity());
    assert.doesNotMatch(JSON.stringify({result,events:s.events}),/SECRET|99999|Fixture Active|test-owner|11111111/);
    assert.deepEqual(Object.keys(s.events[0]).sort(),['actor','durationMs','event','outcome','tool']);
  }finally{s.state.close();}
});
test('canonical Phoenix active-directory predicate excludes hidden and system records',()=>{
  const s=setup();try{
    const hidden={...s.employees[0],organogramVisible:false};
    const admin={...s.employees[0],hrId:'ADMIN-HR',fullName:'Phoenix System Administrator',jobTitle:'System Administrator'};
    assert.equal(activeEmployees([hidden,admin,...s.employees],s.identity()).length,2);
    const explicit=employeeSchema.parse({...s.employees[0],nodeType:'non_login_aggregation_node'});
    const position=employeeSchema.parse({...s.employees[0],positionTitle:'Vacant position'});
    assert.equal(activeEmployees([explicit,position],s.identity()).length,0);
  }finally{s.state.close();}
});
test('PKCE, redirect URI, resource and single-use authorization codes are enforced',async()=>{
  const s=setup();try{
    const client=(await s.provider.clientsStore.getClient(config.clientId))!;
    for(const variant of ['pkce','redirect','resource']){
      const v=randomToken(),code=randomToken();s.state.put('code',code,{clientId:config.clientId,redirect:config.redirectUri,challenge:digest(v),principal:s.identity()},60);
      await assert.rejects(s.provider.exchangeAuthorizationCode(client,code,variant==='pkce'?randomToken():v,variant==='redirect'?'https://evil.test':config.redirectUri,new URL(variant==='resource'?'https://evil.test':config.resource)));
    }
    const t=await tokens(s);assert.ok(t.access_token);assert.equal(t.expires_in,300);
  }finally{s.state.close();}
});
test('refresh rotation detects replay and revokes the entire token family',async()=>{
  const s=setup();try{
    const t=await tokens(s),client=(await s.provider.clientsStore.getClient(config.clientId))!;
    const next=await s.provider.exchangeRefreshToken(client,t.refresh_token,[ 'phoenix:read' ],new URL(config.resource));
    await s.provider.verifyAccessToken(next.access_token);
    await assert.rejects(s.provider.exchangeRefreshToken(client,t.refresh_token,undefined,new URL(config.resource)));
    await assert.rejects(s.provider.verifyAccessToken(next.access_token));
  }finally{s.state.close();}
});
test('expiry, explicit revocation and Phoenix session-version invalidation reject tokens',async()=>{
  let now=Date.now();const state=new StateStore(':memory:',()=>now),f=fixtureStore(),auth=new Authorizer(f.db,config.owner);
  const provider=new OAuthProvider(config,state,auth,upstream);
  const s={...setup(),state,provider};
  try{
    const t=await tokens(s);now+=301000;await assert.rejects(provider.verifyAccessToken(t.access_token));
  }finally{state.close();}
  const r=setup();try{const t=await tokens(r);r.setIdentity({sessionVersion:2});await assert.rejects(r.provider.verifyAccessToken(t.access_token));}finally{r.state.close();}
  const q=setup();try{const t=await tokens(q);await q.provider.revokeToken((await q.provider.clientsStore.getClient(config.clientId))!,{token:t.access_token});await assert.rejects(q.provider.verifyAccessToken(t.access_token));}finally{q.state.close();}
});
test('database role audit refuses every escalation independently',()=>{
  const good={role:'phoenix_mcp_reader',privileged:false,membership:false,db_create:false,db_temp:false,schema_create:false,writes:false,sequences:false,functions:false,extra_reads:false};
  assert.doesNotThrow(()=>assertPrivileges(good,'phoenix_mcp_reader'));
  for(const key of Object.keys(good).filter(k=>k!=='role'))assert.throws(()=>assertPrivileges({...good,[key]:true},'phoenix_mcp_reader'));
  assert.throws(()=>assertPrivileges({...good,role:'service_role'},'phoenix_mcp_reader'));
});
test('real PostgreSQL grants prevent writes even in a READ WRITE transaction',async()=>{
  const pg=await postgresFixture();
  try{
    await pg.exec('revoke temporary on database postgres from public');
    await pg.exec(`create role phoenix_mcp_reader nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
      revoke create on schema public from public;
      create schema phoenix_mcp; grant usage on schema phoenix_mcp to phoenix_mcp_reader;
      create table phoenix_mcp.employees(subject text,record_key text,payload jsonb);
      insert into phoenix_mcp.employees values ('owner','one','{}'),('other','two','{}');
      alter table phoenix_mcp.employees enable row level security;
      create policy owner_only on phoenix_mcp.employees for select to phoenix_mcp_reader using(subject='owner' and subject=current_setting('phoenix_mcp.subject',true));
      grant select on phoenix_mcp.employees to phoenix_mcp_reader;
      set role phoenix_mcp_reader; set phoenix_mcp.subject='owner';`);
    const read=await pg.query('select * from phoenix_mcp.employees');assert.equal(read.rows.length,1);
    await pg.exec("set phoenix_mcp.subject='other'");assert.equal((await pg.query('select * from phoenix_mcp.employees')).rows.length,0,'changing a session claim cannot impersonate another owner');
    await pg.exec("set phoenix_mcp.subject='owner'");
    for(const query of ["insert into phoenix_mcp.employees values ('owner','x','{}')","update phoenix_mcp.employees set record_key='x'","delete from phoenix_mcp.employees","truncate phoenix_mcp.employees","create table public.attack(x int)"]){await assert.rejects(pg.exec(query),/permission denied/);}
    const rights=await pg.query(privilegeAuditSql);
    const row=rights.rows[0] as Record<string,unknown>;
    assert.deepEqual(Object.entries(row).filter(([k,v])=>k!=='role'&&v!==false),[], 'restricted role must have no effective escalation privileges');
    assertPrivileges(row,'phoenix_mcp_reader');
    // Deliberately break the grant boundary: the audit must detect it.
    await pg.exec('reset role; grant update on phoenix_mcp.employees to phoenix_mcp_reader; set role phoenix_mcp_reader');
    const broken=await pg.query(privilegeAuditSql);
    assert.equal(broken.rows[0].writes,true,'an accidental UPDATE grant must be detected');
    assert.throws(()=>assertPrivileges(broken.rows[0],'phoenix_mcp_reader'));
    await pg.exec('begin read only');
    await assert.rejects(pg.exec("update phoenix_mcp.employees set record_key='x'"),/read-only transaction/);
    await pg.exec('rollback; reset role; revoke update on phoenix_mcp.employees from phoenix_mcp_reader; set role phoenix_mcp_reader');
    assertPrivileges((await pg.query(privilegeAuditSql)).rows[0],'phoenix_mcp_reader');
    // A function inherited through PUBLIC is also an effective escalation path.
    await pg.exec("reset role; create function public.unsafe_function() returns int language sql as 'select 1'; set role phoenix_mcp_reader");
    assert.equal((await pg.query(privilegeAuditSql)).rows[0].functions,true);
  }finally{await pg.close();}
});
test('HTTP MCP lists exactly five read-only tools, rejects unauthenticated access, and executes through official SDK',async()=>{
  const s=setup();const {app}=createApp(config,s.db,s.state,upstream,e=>s.events.push(e));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
  const client=new Client({name:'fixture-test',version:'1'});
  try{
    const denied=await fetch(`${base}/mcp`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(denied.status,401);assert.match(denied.headers.get('www-authenticate')??'',/resource_metadata/);
    const t=await tokens(s);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${t.access_token}`}}}));
    const list=await client.listTools();assert.deepEqual(list.tools.map(t=>t.name).sort(),[...toolNames].sort());assert.ok(list.tools.every(t=>t.annotations?.readOnlyHint===true));
    const result=await client.callTool({name:'get_active_employee_count',arguments:{}});assert.equal(result.isError,undefined);assert.equal((result.structuredContent as Record<string,unknown>)?.activeEmployeeCount,2);
    assert.equal((await fetch(`${base}/mcp`,{method:'POST',headers:{Origin:'https://evil.test'}})).status,403);
    assert.equal((await fetch(`${base}/admin/sql`,{method:'POST'})).status,404);
    assert.equal((await fetch(`${base}/mcp`,{method:'POST',headers:{Authorization:`Bearer ${t.access_token}`,'content-type':'application/json'},body:JSON.stringify({padding:'x'.repeat(17000)})})).status,400);
    assert.equal((await fetch(`${base}/register`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
  }finally{await client.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));s.state.close();}
});
test('OAuth browser flow binds consent to browser, PKCE, registered callback and owner',async()=>{
  const s=setup(),{app}=createApp(config,s.db,s.state,upstream,()=>{});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}`;
  try{
    const verifier=randomToken();
    const query=new URLSearchParams({response_type:'code',client_id:config.clientId,redirect_uri:config.redirectUri,scope:'phoenix:read',resource:config.resource,state:'client-state',code_challenge:digest(verifier),code_challenge_method:'S256'});
    const begin=await fetch(`${base}/authorize?${query}`,{redirect:'manual'});assert.equal(begin.status,302);
    const cookie=begin.headers.get('set-cookie')!.split(';')[0];assert.match(begin.headers.get('set-cookie')!,/HttpOnly/);assert.match(begin.headers.get('set-cookie')!,/Secure/);
    const state=new URL(begin.headers.get('location')!).searchParams.get('state')!;
    const callback=await fetch(`${base}/oauth/callback?code=fixture&state=${state}`,{headers:{cookie},redirect:'manual'});assert.equal(callback.status,200);
    // `no-referrer` makes a browser send `Origin: null` on the consent form's same-origin POST, which
    // consent() refuses; the page must therefore keep the real Origin (measured in Chromium).
    assert.equal(callback.headers.get('referrer-policy'),'same-origin');
    const html=await callback.text(),ticket=html.match(/name="ticket" value="([A-Za-z0-9_-]+)"/)![1];
    const consent=await fetch(`${base}/oauth/consent`,{method:'POST',headers:{cookie,Origin:config.issuer,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ticket,decision:'approve'}),redirect:'manual'});assert.equal(consent.status,302);
    const redirect=new URL(consent.headers.get('location')!);assert.equal(redirect.origin,new URL(config.redirectUri).origin);assert.equal(redirect.searchParams.get('state'),'client-state');
    const body=new URLSearchParams({grant_type:'authorization_code',client_id:config.clientId,redirect_uri:config.redirectUri,resource:config.resource,code:redirect.searchParams.get('code')!,code_verifier:verifier});
    const issued=await fetch(`${base}/token`,{method:'POST',body});assert.equal(issued.status,200);const token=await issued.json() as {access_token:string};await s.provider.verifyAccessToken(token.access_token);
    assert.equal((await fetch(`${base}/token`,{method:'POST',body})).status,400,'an authorization code cannot be reused');
    assert.equal((await fetch(`${base}/oauth/consent`,{method:'POST',headers:{Origin:'https://evil.test'},body:new URLSearchParams({ticket,decision:'approve'})})).status,403);
    assert.equal((await fetch(`${base}/oauth/callback?code=fixture&state=${state}`,{redirect:'manual'})).status,403);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));s.state.close();}
});
test('a refresh during a source outage keeps the token usable and never reads as replay',async()=>{
  const s=setup();try{
    const client=(await s.provider.clientsStore.getClient(config.clientId))!,resource=new URL(config.resource);
    const first=await tokens(s);
    s.fail();
    await assert.rejects(s.provider.exchangeRefreshToken(client,first.refresh_token,undefined,resource));
    s.restore();
    const second=await s.provider.exchangeRefreshToken(client,first.refresh_token,undefined,resource);
    assert.ok(second.access_token);
    await assert.rejects(s.provider.exchangeRefreshToken(client,first.refresh_token,undefined,resource),/reused/);
    await assert.rejects(s.provider.verifyAccessToken(second.access_token),'replay revokes the family');
  }finally{s.state.close();}
});
test('revocation during a business read prevents returned data',async()=>{
  const s=setup();try{
    const original=s.db.employees;s.db.employees=async(subject)=>{const rows=await original(subject);s.setIdentity({active:false});return rows;};
    await assert.rejects(s.service.execute('get_active_employee_count',{},s.identity()));
    assert.equal(s.events.at(-1)?.outcome,'denied');
  }finally{s.state.close();}
});
test('single-owner rate budget rejects excess calls without another database query',async()=>{
  const s=setup();try{
    for(let i=0;i<30;i++)await s.service.execute('get_active_employee_count',{},s.identity());
    await assert.rejects(s.service.execute('get_active_employee_count',{},s.identity()),/unavailable/);
  }finally{s.state.close();}
});
test('configuration refuses ambient production credentials and administrative usernames',()=>{
  assert.throws(()=>configFromEnv({SUPABASE_SERVICE_ROLE_KEY:'not-a-real-key'}));
  assert.throws(()=>configFromEnv({PHOENIX_MCP_ENABLED:'false'}));
});
