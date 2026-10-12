import assert from 'node:assert/strict';
import http from 'node:http';
import { after,before,test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { postgresFixture } from './postgres-fixture.mts';
import { createSourceHost } from './source-host.mts';
import { config,fixtureStore,subject } from './fixtures.mts';
import { createReadStore } from '../src/database.mts';
import { createLiveAuthorization } from '../src/live-authorization.mts';
import { ToolService } from '../src/tools.mts';
import { Authorizer } from '../src/policy.mts';
import { StateStore } from '../src/state.mts';
import { publishProjection,withdrawProjection } from '../src/publisher.mts';
import { runPublishCycle } from '../src/publish-cycle.mts';
import { createCollector,type Loaders } from '../src/source-collect.mts';
import { createRpcWatermarkReader,withChangeClock,decideLiveIdentity,loadLiveIdentity,LiveAuthorizationError,SourceProofError,type LiveInputs,type LiveSources } from '../src/phoenix-source.mjs';
import { identitySchema } from '../src/contracts.mts';

// SOURCE -> ADAPTER -> PUBLISHER -> REPORTING DATABASE -> MCP, end to end, on isolated synthetic
// PostgreSQL clusters. The source side runs the REAL read recorder, proof verifier, registry, change
// watermark function (proposal/source-watermark.sql), adapters, canonical policies and publisher; only
// Phoenix's report loaders are stand-ins (tests/source-host.mts), reading through real fetch.
let pg:Awaited<ReturnType<typeof postgresFixture>>,host:Awaited<ReturnType<typeof createSourceHost>>,admin:ReturnType<typeof pg.connect>,reader:ReturnType<typeof createReadStore>;
let service:ToolService,state:StateStore,auth:Authorizer;
const fixture=fixtureStore();
const offset={ms:0};
const clock={now:()=>Date.now()+offset.ms,date:()=>new Date(Date.now()+offset.ms),advance:(ms:number)=>{offset.ms+=ms;}};
const principal=()=>fixture.identity();
const call=(name:Parameters<ToolService['execute']>[0],args:unknown={})=>service.execute(name,args,principal());
const watermark=()=>withChangeClock(createRpcWatermarkReader(host.client),clock.date);
let collectorWatermark:ReturnType<typeof watermark>;
const collectorFor=(loaders:Loaders,attempts?:number)=>createCollector({loaders,identity:fixture.identity(),watermark:collectorWatermark,now:clock.date,attempts});
async function cycle(collect=collectorFor(host.loaders),periods:string[]=['2026-09']){
 await admin.unsafe('set role phoenix_mcp_publisher');
 try{return await runPublishCycle({collect,publish:(d,p,pr)=>publishProjection(admin,config,d,p,pr),withdraw:(d,p)=>withdrawProjection(admin,config,d,p)},periods);}
 finally{await admin.unsafe('reset role');}
}
const by=(outcomes:Awaited<ReturnType<typeof cycle>>,dataset:string)=>outcomes.find(o=>o.dataset===dataset)!;
const reasonOf=async(promise:Promise<unknown>)=>{try{await promise;}catch(error){return (error as SourceProofError).reason??`other:${(error as Error).message}`;}return 'resolved';};

before(async()=>{
 pg=await postgresFixture(true);
 host=await createSourceHost(pg);
 // Reporting database: the exact proposed SQL, installed only in this synthetic cluster.
 await pg.exec('create database phoenix_mcp_reporting');
 admin=pg.connect('phoenix_mcp_reporting');
 await admin.unsafe((await readFile('proposal/install.sql','utf8')).replaceAll('OWNER_SUBJECT',subject).replaceAll('SOURCE_REVISION',config.contractRevision)).simple();
 reader=createReadStore({...config,databaseUrl:pg.url,databaseCa:pg.ca},fixture.db.identity);
 state=new StateStore(':memory:',clock.now);
 auth=new Authorizer(reader,config.owner);
 service=new ToolService(reader,auth,state,()=>{},config.nodeIdKey,clock.now);
 host.state.clock=clock.now;
 collectorWatermark=watermark();
 // Production-shaped seed: NSM > RM > DM > reps; an ACTING DM (a rep who also manages Giza), a
 // resigned rep's seat awaiting a replacement, a stale "open" vacancy on a seat a new hire now holds,
 // the per-line "Others" pseudo-DM, a system placeholder and an on-leave employee.
 const emp=(id:string,name:string,title:string,status='active',manager:string|null=null)=>host.db`insert into public.employees(hr_id,full_name,job_title,employment_status,manager_hr_id) values(${id},${name},${title},${status},${manager})`;
 for(const [id,name,title,status] of [['OWNER','Fixture Owner','Chief Executive','active'],['NSM-1','Nadia Fixture','National Sales Manager','active'],['RM-1','Rami Fixture','Regional Manager','active'],['DM-1','Dina Fixture','District Manager','active'],['ACT-1','Amr Fixture','Medical Rep','active'],['R-1','Rep One','Medical Rep','active'],['R-2','Rep Two','Medical Rep','active'],['R-3','Rep Three','Medical Rep','active'],['R-4','Rep Four','Medical Rep','active'],['R-5','Rep Five','Medical Rep','on_leave'],['X-1','Former Rep','Medical Rep','resigned'],['S-1','Placeholder','Vacant','system_placeholder']] as const)await emp(id,name,title,status);
 for(const t of ['departments','lines','areas','positions','teams'])await host.db.unsafe(`insert into public.${t} values(1,'Sales')`);
 const seat=(id:string,parent:string|null,tier:string,area:string,pseudo=false)=>host.db`insert into au.seats(seat_id,parent_seat_id,seat_tier,line_name,area_name,is_other_pseudo_dm) values(${id},${parent},${tier},'CNS',${area},${pseudo})`;
 const occ=(id:string,hr:string,ended:string|null=null)=>host.db`insert into au.occupancy_history(seat_id,occupant_hr_id,effective_to) values(${id},${hr},${ended})`;
 await seat('seat-nsm',null,'NSM','National');await seat('seat-rm','seat-nsm','RM','Cairo Region');await seat('seat-dm','seat-rm','DM','Cairo District');
 await seat('seat-act','seat-rm','ACTING_DM','Giza District');await seat('seat-actrep','seat-act','REP','Giza 1');
 await seat('seat-r1','seat-dm','REP','Nasr City');await seat('seat-r2','seat-dm','REP','Heliopolis');await seat('seat-r3','seat-act','REP','Dokki');
 await seat('seat-repl','seat-dm','REP','Maadi');await seat('seat-stale','seat-dm','REP','Zamalek');await seat('seat-others','seat-rm','DM','Others',true);
 for(const [s,h] of [['seat-nsm','NSM-1'],['seat-rm','RM-1'],['seat-dm','DM-1'],['seat-act','ACT-1'],['seat-actrep','ACT-1'],['seat-r1','R-1'],['seat-r2','R-2'],['seat-r3','R-3'],['seat-stale','R-4']])await occ(s,h);
 await occ('seat-repl','X-1','2026-09-01');
 const vac=(id:number,area:string)=>host.db`insert into public.position_vacancies(id,status,position_title,job_title,department_name,line_name,area_name,manager_hr_id) values(${id},'open','Medical Rep','Medical Rep','Sales','CNS',${area},'DM-1')`;
 await vac(1,'Maadi');await vac(2,'Zamalek');
 await host.db`insert into public.monthly_closing_publications(line,normalized_line,period) values('CNS','cns','2026-09')`;
 for(const [channel,value] of [['distributor',1000],['office',300],['direct',200]] as const)await host.db`insert into public.source_of_sales_fact_rollup(period,line,area_code,channel,units,value) values('2026-09','CNS','A1',${channel},1,${value})`;
 await host.db`insert into au.monthly_targets(period,line_code,target_value) values('2026-09','CNS',2000)`;
});
after(async()=>{await reader?.close();await admin?.end();await host?.close();state?.close();await pg?.close();});

test('full pipeline: acting role, replacement vacancy, Office/direct sales and PRODUCTION-shaped rows reach all five tools',async()=>{
 const outcomes=await cycle();
 assert.deepEqual(outcomes.map(o=>o.status),['published','published','published','published'],JSON.stringify(outcomes));
 assert.equal((await call('get_active_employee_count')).activeEmployeeCount,10,'active + on-leave, no resigned or placeholder');
 const vacancies=await call('get_open_vacancies',{limit:50});
 assert.deepEqual((vacancies.items as {area:string}[]).map(v=>v.area),['Maadi'],'replacement seat listed; the stale open row on an occupied seat is reconciled away');
 const nodes=(await call('get_organizational_structure',{limit:50})).items as {nodeId:string;parentNodeId:string|null;employeeName:string|null;position:string;vacant:boolean}[];
 assert.equal(nodes.filter(n=>n.employeeName==='Amr Fixture').length,1,'an acting DM appears once, from the acting seat');
 const acting=nodes.find(n=>n.employeeName==='Amr Fixture')!;
 const dokki=nodes.find(n=>n.employeeName==='Rep Three')!;
 assert.equal(dokki.parentNodeId,acting.nodeId,'the rep under the acting DM hangs from the acting node');
 for(const n of nodes){const seen=new Set<string>();let cur:typeof n|undefined=n;while(cur){assert.ok(!seen.has(cur.nodeId),'no cycle');seen.add(cur.nodeId);cur=nodes.find(x=>x.nodeId===cur!.parentNodeId);}}
 assert.equal(nodes.some(n=>n.position==='District Manager'&&n.employeeName===null&&!n.vacant),false,'the Others pseudo-DM is not emitted');
 const sales=(await call('get_published_sales_summary',{period:'2026-09'})).items as {salesValue:number;targetValue:number}[];
 assert.equal(sales[0].salesValue,1500,'COMPANY total: distributor + Office + direct, counted once');
 assert.equal(sales[0].targetValue,2000);
});

test('stale caches, swallowed failures, unwatched and missing reads are refused with a named reason',async()=>{
 const collect=(dataset:'employees'|'organization'|'vacancies',loaders:Loaders=host.loaders)=>collectorFor(loaders)(dataset,'');
 // The directory cache is warm from the cycle above: the loader answers without issuing a single read.
 assert.equal(await reasonOf(collect('employees')),'no_reads');
 host.loaders.invalidate();assert.equal(await reasonOf(collect('employees')),'resolved');
 // A failed load that the loader answers from its stale cache is still a failed read.
 clock.advance(31_000);host.faults.set('employees','500');
 assert.equal(await reasonOf(collect('employees')),'read_failed');
 // The organogram swallows an unreadable employee master and still draws the chart.
 assert.equal(await reasonOf(collect('organization')),'read_failed');
 host.faults.delete('employees');host.faults.set('teams','reset');
 assert.equal(await reasonOf(collect('organization')),'read_failed','a transport failure on a soft-failing lookup');
 host.faults.delete('teams');
 assert.equal(await reasonOf(collect('organization',{...host.loaders,organization:async()=>{await host.rest('unwatched_notes');return host.loaders.organization();}})),'unwatched_read');
 assert.equal(await reasonOf(collect('vacancies',{...host.loaders,vacancies:async()=>{await host.rest('teams');return {rows:[]};}})),'required_read_missing');
 assert.equal(await reasonOf(collect('organization')),'resolved');
});

test('an unavailable sales month never blocks workforce, vacancy or organization refreshes',async()=>{
 clock.advance(5000);
 host.faults.set('phx_closing_customers','500');
 const outcomes=await cycle();
 assert.deepEqual([by(outcomes,'employees').status,by(outcomes,'vacancies').status,by(outcomes,'organization').status],['published','published','published']);
 assert.equal(by(outcomes,'published_sales').status,'failed');assert.equal(by(outcomes,'published_sales').reason,'read_failed');
 assert.equal(((await call('get_published_sales_summary',{period:'2026-09'})).items as unknown[]).length,1,'the previous complete snapshot is kept, not blanked, inside its freshness window');
 clock.advance(61_000);
 const later=await cycle();
 assert.equal(by(later,'published_sales').status,'failed');
 await assert.rejects(call('get_published_sales_summary',{period:'2026-09'}),'then it expires: unavailable, never zero');
 assert.equal((await call('get_active_employee_count')).activeEmployeeCount,10,'workforce stayed current throughout');
 host.faults.delete('phx_closing_customers');
 assert.equal(by(await cycle(),'published_sales').status,'published');
});

test('consistent watermarks: a change during the read is retried or refused; an update that touches no timestamp is still seen',async()=>{
 clock.advance(5000);
 // 1. A mutation lands mid-collection. With one attempt the collection is refused.
 let fired=false;
 host.hooks.onRead=async rel=>{if(rel==='teams'&&!fired){fired=true;await host.db`insert into public.teams values(900,'Late team')`;}};
 assert.equal(await reasonOf(collectorFor(host.loaders,1)('organization','')),'changed_during_read');
 // 2. With the default two attempts the second, stable read is accepted.
 fired=false;host.hooks.onRead=async rel=>{if(rel==='teams'&&!fired){fired=true;await host.db`insert into public.teams values(901,'Later team')`;}};
 assert.equal(await reasonOf(collectorFor(host.loaders)('organization','')),'resolved');
 // 3. Phoenix maintains no updated_at on UPDATE: a bare UPDATE (no timestamp) mid-read must still be caught.
 fired=false;
 host.hooks.onRead=async rel=>{if(rel==='phx_monthly_targets'&&!fired){fired=true;await host.db`update public.source_of_sales_fact_rollup set value=value where channel='office'`;}};
 assert.equal(await reasonOf(collectorFor(host.loaders,1)('published_sales','2026-09')),'changed_during_read');
 host.hooks.onRead=undefined;
});

test('unchanged refreshes keep snapshot identity and rows; any content change replaces both',async()=>{
 clock.advance(5000);await cycle();
 const snap=async()=>(await admin`select payload from phoenix_mcp.snapshots where dataset='organization'`)[0].payload as {snapshotId:string;sourceObservedAt:string};
 const rowVersion=async()=>(await admin`select string_agg(xmin::text,',' order by record_key) as v from phoenix_mcp.organization`)[0].v as string;
 const first=await snap(),firstRows=await rowVersion();
 clock.advance(30_000);assert.equal(by(await cycle(),'organization').status,'published');
 const second=await snap();
 assert.equal(second.snapshotId,first.snapshotId,'identity is a function of the rows');
 assert.ok(Date.parse(second.sourceObservedAt)>Date.parse(first.sourceObservedAt),'observation freshness advanced');
 assert.equal(await rowVersion(),firstRows,'rows were not rewritten');
 await host.db`update au.seats set area_name='Nasr City East' where seat_id='seat-r1'`;
 clock.advance(30_000);await cycle();
 assert.notEqual((await snap()).snapshotId,first.snapshotId);assert.notEqual(await rowVersion(),firstRows);
});

test('publication withdrawal is immediate and only on proof; an unreadable source never withdraws',async()=>{
 clock.advance(5000);
 await host.db`update public.monthly_closing_publications set unpublished_at=now() where period='2026-09'`;
 const outcomes=await cycle();
 assert.equal(by(outcomes,'published_sales').status,'withdrawn');
 await assert.rejects(call('get_published_sales_summary',{period:'2026-09'}),'withdrawn data is gone at once, not after the 60 second window');
 assert.equal((await admin`select count(*)::int as n from phoenix_mcp.published_sales`)[0].n,0);
 assert.equal((await call('get_active_employee_count')).activeEmployeeCount,10);
 await host.db`update public.monthly_closing_publications set unpublished_at=null where period='2026-09'`;
 assert.equal(by(await cycle(),'published_sales').status,'published');
 // A failing publication read is "could not tell", not "withdrawn": the snapshot is neither replaced nor deleted.
 host.faults.set('monthly_closing_publications','500');clock.advance(5000);
 const failed=by(await cycle(),'published_sales');
 assert.equal(failed.status,'failed');
 assert.equal((await admin`select count(*)::int as n from phoenix_mcp.published_sales`)[0].n,1);
 host.faults.delete('monthly_closing_publications');
});

test('2,000 organization rows: a truncated read is refused; the paged traversal completes under the refresh and rate limits',async()=>{
 const existing=(await host.loaders.organization()).organogramRows.length;
 await host.db.unsafe(`insert into au.seats select 'bulk-'||g,'seat-dm','REP','CNS','Bulk area '||g,false from generate_series(1,${2000-existing}) g`);
 await host.db.unsafe(`insert into au.occupancy_history(seat_id,occupant_hr_id) select 'bulk-'||g,'BULK-'||g from generate_series(1,${2000-existing},2) g`);
 clock.advance(5000);
 // An unpaged read comes back at the server's row cap with no limit: it may have been cut short.
 assert.equal(await reasonOf(collectorFor({...host.loaders,organization:host.loaders.unpagedOrganization})('organization','')),'truncated');
 assert.equal(by(await cycle(),'organization').status,'published');
 assert.equal((await admin`select count(*)::int as n from phoenix_mcp.organization`)[0].n,2000);
 // Walk all 2,000 rows at the maximum page size (40 calls, above the 30/minute budget if unpaced),
 // pacing like a real client (2.1 s per call) while the source host keeps refreshing every 30 s.
 const seen=new Set<string>();let cursor:string|undefined,calls=0,refreshes=0,lastRefresh=clock.now();
 do{
  if(clock.now()-lastRefresh>=30_000){assert.equal(by(await cycle(),'organization').status,'published');refreshes++;lastRefresh=clock.now();}
  const page=await call('get_organizational_structure',{limit:50,...(cursor?{cursor}:{})});calls++;
  for(const item of page.items as {nodeId:string}[]){assert.ok(!seen.has(item.nodeId),'no row twice');seen.add(item.nodeId);}
  cursor=page.nextCursor as string|undefined??undefined;clock.advance(2100);
 }while(cursor);
 assert.equal(calls,40);assert.equal(seen.size,2000);assert.ok(refreshes>=2,`refreshes during the walk: ${refreshes}`);
 // The same walk without pacing hits the budget, and a cursor survives waiting out the window.
 clock.advance(61_000);assert.equal(by(await cycle(),'organization').status,'published');
 let held:string|undefined;
 for(let i=0;i<30;i++){const p=await call('get_organizational_structure',{limit:50,...(held?{cursor:held}:{})});held=p.nextCursor as string;}
 await assert.rejects(call('get_organizational_structure',{limit:50,cursor:held}),'31st call inside a minute is refused');
 for(let i=0;i<2;i++){clock.advance(31_000);assert.equal(by(await cycle(),'organization').status,'published');}
 assert.equal(((await call('get_organizational_structure',{limit:50,cursor:held})).items as unknown[]).length,50,'the cursor outlived the wait and the unchanged refresh');
 // A REAL change mid-walk invalidates the cursor and the walk restarts.
 await host.db`update au.seats set area_name='Changed mid-walk' where seat_id='bulk-1'`;
 clock.advance(1000);await cycle();
 await assert.rejects(call('get_organizational_structure',{limit:50,cursor:held}));
});

const sources=(over:Partial<LiveSources>={}):LiveSources&{calls:Record<string,number>}=>{
 const calls:Record<string,number>={accounts:0,authUser:0,employee:0,matrix:0,locks:0};
 const count=<T,A extends unknown[]>(name:string,fn:(...a:A)=>Promise<T>)=>(...a:A)=>{calls[name]++;return fn(...a);};
 const full=['read'];
 return {calls,now:()=>new Date(),
  accounts:count('accounts',async()=>[{login_id:'test-owner',role:'Super Admin',hr_id:'OWNER',is_active:true,is_test_persona:false,session_version:1}]),
  authUser:count('authUser',async()=>({exists:true,bannedUntil:null,deletedAt:null})),
  employee:count('employee',async()=>({employment_status:'active',last_working_date:null})),
  matrix:count('matrix',async()=>({'Super Admin':{employees:full,vacancies:full,organogram:full,sales:full}})),
  locks:count('locks',async()=>[]),...over};
};
async function liveHarness(s:LiveSources){
 // The source route, in miniature: bearer + subject + nonce echo, running the REAL loadLiveIdentity.
 const server=http.createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const c of req)chunks.push(c as Buffer);
  const body=JSON.parse(Buffer.concat(chunks).toString());
  if(req.headers.authorization!==`Bearer ${config.authorizationKey}`){res.writeHead(401).end('{}');return;}
  try{const identity=await loadLiveIdentity(body.subject,s);res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify({nonce:body.nonce,identity}));}
  catch{res.writeHead(503).end('{}');}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/`;
 const live=createLiveAuthorization(config,(_u,init)=>fetch(url,init));
 const store={identity:(s:string)=>live(s)} as never;
 return {live,authorizer:new Authorizer(store,config.owner),close:()=>new Promise(r=>server.close(r))};
}

test('live authorization bridge: uncached, fails closed, and honours account, Auth, lifecycle, read-denial and module-lock changes',async()=>{
 const s=sources(),h=await liveHarness(s);
 try{
  const p=identitySchema.parse(await h.live(subject));
  await h.authorizer.tool(p,'get_published_sales_summary');await h.authorizer.tool(p,'get_active_employee_count');
  const callsAfterTwo=s.calls.accounts;await h.authorizer.tool(p,'get_open_vacancies');
  assert.equal(s.calls.accounts,callsAfterTwo+1,'every check reads the account again');assert.ok(s.calls.matrix>=3&&s.calls.locks>=3&&s.calls.authUser>=3,'matrix, locks and Auth status are read every time');
  const denied=async(over:Partial<LiveSources>,tool:Parameters<Authorizer['tool']>[1]='get_active_employee_count')=>{const x=await liveHarness(sources(over));try{await assert.rejects(x.authorizer.tool(p,tool));}finally{await x.close();}};
  await denied({accounts:async()=>[]});
  await denied({authUser:async()=>({exists:true,bannedUntil:new Date(Date.now()+3600_000).toISOString(),deletedAt:null})});
  await denied({authUser:async()=>({exists:false,bannedUntil:null,deletedAt:null})});
  await denied({authUser:async()=>({exists:true,bannedUntil:null,deletedAt:new Date().toISOString()})});
  await denied({accounts:async()=>[{login_id:'test-owner',role:'Super Admin',hr_id:'OWNER',is_active:false,is_test_persona:false,session_version:1}]});
  await denied({accounts:async()=>[{login_id:'test-owner',role:'Super Admin',hr_id:'OWNER',is_active:true,is_test_persona:false,session_version:2}]},'get_active_employee_count');
  await denied({accounts:async()=>[{login_id:'test-owner',role:'Employee',hr_id:'OWNER',is_active:true,is_test_persona:false,session_version:1}]});
  await denied({accounts:async()=>[{login_id:'test-owner',role:'Super Admin',hr_id:'OWNER',is_active:true,is_test_persona:true,session_version:1}]});
  await denied({employee:async()=>({employment_status:'resigned',last_working_date:'2026-01-01'})});
  await denied({matrix:async()=>({'Super Admin':{employees:['read'],vacancies:['read'],organogram:['read'],sales:[]}})},'get_published_sales_summary');
  await denied({locks:async()=>[{login_id:'TEST-OWNER',hr_id:null,module_key:'vacancies',unlock_at:null}]},'get_open_vacancies');
  await denied({locks:async()=>[{login_id:null,hr_id:'owner',module_key:'sales',unlock_at:null}]},'get_published_sales_summary');
  // An expired lock does not bind, a never-lockable module is ignored, someone else's lock is ignored.
  const ok=await liveHarness(sources({locks:async()=>[{login_id:'test-owner',hr_id:null,module_key:'vacancies',unlock_at:'2020-01-01T00:00:00Z'},{login_id:'test-owner',hr_id:null,module_key:'employee_profile',unlock_at:null},{login_id:'someone-else',hr_id:null,module_key:'vacancies',unlock_at:null}]}));
  try{await ok.authorizer.tool(p,'get_open_vacancies');}finally{await ok.close();}
  // Source errors are errors, never "no denials": each one fails the call.
  for(const name of ['accounts','authUser','employee','matrix','locks'] as const){
   const x=await liveHarness(sources({[name]:async()=>{throw new LiveAuthorizationError(`${name}_down`);}} as Partial<LiveSources>));
   try{await assert.rejects(x.authorizer.tool(p,'get_active_employee_count'),name);}finally{await x.close();}
  }
  // An account with an HR id whose employee row is missing cannot be decided; two accounts is ambiguous.
  const missing:LiveInputs={subject,accounts:[{login_id:'a',role:'Super Admin',hr_id:'OWNER',is_active:true,is_test_persona:false,session_version:1}],authUser:{exists:true,bannedUntil:null,deletedAt:null},employee:null,matrix:{'Super Admin':{}},locks:[],now:new Date()};
  assert.throws(()=>decideLiveIdentity(missing),LiveAuthorizationError);
  assert.throws(()=>decideLiveIdentity({...missing,accounts:[missing.accounts[0],missing.accounts[0]]}),LiveAuthorizationError);
  assert.equal(decideLiveIdentity({...missing,accounts:[]}),null);
 }finally{await h.close();}
});
