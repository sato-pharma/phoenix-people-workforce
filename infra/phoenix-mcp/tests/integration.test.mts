import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile,writeFile } from 'node:fs/promises';
import { generateKeyPair,exportJWK,SignJWT } from 'jose';
import { setTimeout } from 'node:timers/promises';
import { postgresFixture } from './postgres-fixture.mts';
import { config,fixtureStore,subject } from './fixtures.mts';
import { createReadStore,queries } from '../src/database.mts';
import { createIdentityProvider } from '../src/oauth.mts';
import { createLiveAuthorization } from '../src/live-authorization.mts';
import { ToolService,assertFreshness } from '../src/tools.mts';
import { Authorizer } from '../src/policy.mts';
import { StateStore } from '../src/state.mts';
import { toolNames } from '../src/contracts.mts';
import { publishProjection } from '../src/publisher.mts';
import { workforceAdapter,vacancyAdapter,organizationAdapter,salesAdapter,seal } from '../src/source-adapters.mts';
import { proofFor } from './proofs.mts';
import { seatKeysOfActiveEmployees,reconcileVacancyRowsAgainstOccupancy,stripRestrictedColumns } from '../src/phoenix-policy.mjs';

test('real createReadStore over verified TLS PostgreSQL: all tools, RLS, freshness, writes, live revocation',async()=>{
 const pg=await postgresFixture(true),fixture=fixtureStore(),state=new StateStore(':memory:');
 await pg.exec('create database phoenix_mcp_reporting');
 const admin=pg.connect('phoenix_mcp_reporting');
 const db=createReadStore({...config,databaseUrl:pg.url,databaseCa:pg.ca},fixture.db.identity);
 try{
  const ddl=(await readFile('proposal/install.sql','utf8')).replaceAll('OWNER_SUBJECT',subject).replaceAll('SOURCE_REVISION',config.contractRevision);
  await admin.unsafe(ddl).simple();
  for(const [dataset,period,rows] of [
   ['employees','',await fixture.db.employees(subject)],['vacancies','',await fixture.db.vacancies(subject,'',50)],
   ['organization','',await fixture.db.organization(subject,'',50)],['published_sales','2026-09',await fixture.db.sales(subject,'2026-09','',50)],
  ] as const){
   await admin.unsafe('set role phoenix_mcp_publisher');
   await publishProjection(admin,config,dataset,period,seal(dataset,period,[...rows],proofFor(dataset,period)));
   await admin.unsafe('reset role');
  }
  await db.ready();assertFreshness((await db.employees(subject)).freshness);const auth=new Authorizer(db,config.owner),service=new ToolService(db,auth,state,()=>{},config.nodeIdKey);
  for(const name of toolNames){await auth.tool(fixture.identity(),name);const r=await service.execute(name,name==='get_published_sales_summary'?{period:'2026-09'}:{},fixture.identity()).catch(e=>{throw new Error(name,{cause:e});});assert.ok(r.sourceObservedAt);}
  assert.equal((await service.execute('get_active_employee_count',{},fixture.identity())).activeEmployeeCount,2);
  await assert.rejects(service.execute('get_published_sales_summary',{period:'2026-08'},fixture.identity()));
  await assert.rejects(db.employees('22222222-2222-4222-8222-222222222222'));
  await admin`update phoenix_mcp.organization set payload=jsonb_set(payload,'{parentKey}','"1"') where record_key='2'`;
  const org=await service.execute('get_organizational_structure',{},fixture.identity());
  const nodes=org.items as {nodeId:string;parentNodeId:string|null}[];
  assert.equal(nodes[1].parentNodeId,nodes[0].nodeId);assert.notEqual(nodes[0].nodeId,nodes[1].nodeId);assert.equal(nodes[0].nodeId.length,43);
  const page=await service.execute('get_open_vacancies',{limit:1},fixture.identity());
  await admin`update phoenix_mcp.snapshots set payload=jsonb_set(payload,'{snapshotId}','"22222222-2222-4222-8222-222222222222"') where dataset='vacancies'`;
  await assert.rejects(service.execute('get_open_vacancies',{cursor:page.nextCursor},fixture.identity()));
  await admin`update phoenix_mcp.snapshots set payload=jsonb_set(payload,'{sourceObservedAt}','"2000-01-01T00:00:00Z"') where dataset='employees'`;
  await assert.rejects(service.execute('get_active_employee_count',{},fixture.identity()));
  fixture.setIdentity({active:false});await assert.rejects(auth.verify(subject));
  fixture.setIdentity({active:true,role:'CEO'});await assert.rejects(auth.verify(subject));
  fixture.fail();await assert.rejects(auth.verify(subject));
  // Exercise the actual reader login, including explicit attempts to turn off read-only.
  const reader=pg.connect('phoenix_mcp_reporting');
  try{
   await reader.unsafe('set role phoenix_mcp_reader; set default_transaction_read_only=off').simple();
   for(const statement of ['update phoenix_mcp.employees set record_key=record_key','delete from phoenix_mcp.employees','create table public.evil(id int)','create temp table evil(id int)'])await assert.rejects(reader.unsafe(statement));
   assert.equal((await reader`select * from phoenix_mcp.employees`).length,0,'no identity GUC returns no data');
   await reader`select set_config('phoenix_mcp.subject','someone-else',false)`;
   assert.equal((await reader`select * from phoenix_mcp.employees`).length,0);
  }finally{await reader.end();}
  // Save real EXPLAIN evidence, with synthetic rows only. Tiny fixture may choose a seq scan.
  const plans:Record<string,unknown>={};
  await admin.unsafe('set role phoenix_mcp_reader');await admin`select set_config('phoenix_mcp.subject',${subject},false)`;
  for(const [name,query] of Object.entries(queries)){
   const args=name==='employees'?[subject]:name==='sales'?[subject,'2026-09','',51]:[subject,'',51];
   plans[name]=await admin.unsafe(`explain (analyze,buffers,format json) ${query}`,args);
  }
  await writeFile('dist/query-plans.json',JSON.stringify(plans,null,2));
  await admin.unsafe('reset role');
 }finally{await db.close();await admin.end();state.close();await pg.close();}
});

test('createIdentityProvider verifies signed synthetic OIDC proofs and rotates JWKS',async()=>{
 const first=await generateKeyPair('RS256'),second=await generateKeyPair('RS256'),attacker=await generateKeyPair('RS256');
 let key=first,kid='one',claim:Record<string,unknown>={},badSignature=false,jwksReads=0;
 const request:typeof fetch=async(input,init)=>{
  const url=String(input);
  if(url.endsWith('openid-configuration'))return Response.json({issuer:config.oidcIssuer,authorization_endpoint:config.oidcIssuer+'/authorize',token_endpoint:config.oidcIssuer+'/token',jwks_uri:config.oidcIssuer+'/jwks',code_challenge_methods_supported:['S256']});
  if(url.endsWith('/jwks')){jwksReads++;return Response.json({keys:[{...await exportJWK(key.publicKey),kid,alg:'RS256',use:'sig'}]});}
  assert.equal(url,config.oidcIssuer+'/token');
  const body=new URLSearchParams(String(init?.body));assert.equal(body.get('code_verifier'),'verifier');assert.equal(body.get('redirect_uri'),config.callback);
  const now=Math.floor(Date.now()/1000);
  const token=await new SignJWT({sub:subject,iss:config.oidcIssuer,aud:config.oidcClientId,iat:now,exp:now+120,nonce:'nonce',...claim}).setProtectedHeader({alg:'RS256',kid}).sign((badSignature?attacker:key).privateKey);
  return Response.json({id_token:token});
 };
 const provider=await createIdentityProvider(config,request);
 assert.equal(await provider.exchange('code','verifier','nonce'),subject);
 for(const patch of [{iss:'https://attacker.test'},{aud:'other'},{aud:[config.oidcClientId,'other']},{nonce:'other'},{exp:1},{iat:1},{azp:'other'}]){claim=patch;await assert.rejects(provider.exchange('code','verifier','nonce'));}
 claim={};badSignature=true;await assert.rejects(provider.exchange('code','verifier','nonce'));badSignature=false;
 await setTimeout(1100);key=second;kid='two';assert.equal(await provider.exchange('code','verifier','nonce'),subject);assert.equal(jwksReads,2);
 const authorization=new URL(provider.authorization({state:'state',nonce:'nonce',challenge:'challenge'}));assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');
});

test('freshness rejects missing, stale, future and inconsistent metadata; live authorization has no fallback',async()=>{
 const now=Date.now(),iso=(offset:number)=>new Date(now+offset).toISOString();
 for(const f of [{snapshotId:subject,sourceObservedAt:iso(-61000),sourceUpdatedAt:iso(-62000)},{snapshotId:subject,sourceObservedAt:iso(6000),sourceUpdatedAt:iso(0)},{snapshotId:subject,sourceObservedAt:iso(0),sourceUpdatedAt:iso(1)}])assert.throws(()=>assertFreshness(f,now));
 let calls=0;
 const live=createLiveAuthorization(config,async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));return Response.json({nonce:body.nonce,identity:fixtureStore().identity()});});
 await live(subject);await live(subject);assert.equal(calls,2);
 await assert.rejects(createLiveAuthorization(config,async()=>Response.json({nonce:'replayed',identity:fixtureStore().identity()}))(subject));
});

test('canonical workforce, occupancy and closing policies agree with source adapters on synthetic reports',async()=>{
 const fixture=fixtureStore();
 assert.equal(workforceAdapter(fixture.employees,fixture.identity()).length,2);
 assert.throws(()=>seal('employees','',[],{} as never),'a hand-built proof is refused');
 const org=[{hrId:'root',seatId:'seat-root',managerHrId:null,jobTitle:'District Manager',positionTitle:'District Manager',fullName:'Fixture Manager',displayName:'Fixture Manager',departmentName:'Sales',lineName:'CNS',areaName:'Fixture',type:'employee'},
  {hrId:'rep',seatId:'seat-rep',managerHrId:'root',jobTitle:'Medical Rep',positionTitle:'Medical Rep',fullName:'Fixture Rep',displayName:'Fixture Rep',departmentName:'Sales',lineName:'CNS',areaName:'Fixture',type:'employee'}];
 const raw=[{id:1,status:'open',jobTitle:'Medical Rep',positionTitle:'Medical Rep',departmentName:'Sales',lineName:'CNS',areaName:'Fixture',managerHrId:'root'},
  {id:2,status:'open',jobTitle:'Medical Rep',positionTitle:'Medical Rep',departmentName:'Sales',lineName:'CNS',areaName:'Unoccupied',managerHrId:'root'}];
 const canonical=reconcileVacancyRowsAgainstOccupancy(raw,seatKeysOfActiveEmployees(org));
 assert.equal(canonical.length,1,'actual Phoenix report reconciliation removes the occupied seat');
 assert.deepEqual(vacancyAdapter({rows:canonical}).map(r=>r.area),['Unoccupied']);
 const hierarchy=organizationAdapter({organogramRows:org});assert.equal(hierarchy.find(r=>r.key==='seat:seat-rep')?.parentKey,'seat:seat-root');
 assert.throws(()=>organizationAdapter({organogramRows:[...org,{...org[0],seatId:'ambiguous-parent'}]}));
 assert.throws(()=>organizationAdapter({organogramRows:org.map(r=>({...r,managerHrId:'missing'}))}));
 const cell={salesUnits:10,salesValue:1500,targetUnits:20,targetValue:2000,achievementPct:75};
 const matrix={line:'CNS',period:'2026-09',availableLines:['CNS'],availablePeriods:['2026-09'],columns:[],regions:[],grandTotal:{kind:'grandTotal',cells:[],rowTotal:cell}};
 const canonicalMatrix=stripRestrictedColumns(matrix);
 const source={publication:async()=>({publishedAt:'2026-10-01T00:00:00Z',revision:'fixture-1'}),closing:async()=>({line:'CNS',selectedPeriod:'2026-09',awaitingPublish:false,matrix:canonicalMatrix})};
 const sales=await salesAdapter('2026-09',['CNS'],source);
 assert.equal(sales[0].salesValue,canonicalMatrix.grandTotal.rowTotal.salesValue);assert.equal(sales[0].targetValue,canonicalMatrix.grandTotal.rowTotal.targetValue);
 await assert.rejects(salesAdapter('2026-08',['CNS'],source),'fallback month refused');
 let called=false;await assert.rejects(salesAdapter('2026-09',['CNS'],{publication:async()=>null,closing:async()=>{called=true;return matrix;}}));assert.equal(called,false);
 await assert.rejects(salesAdapter('2026-09',['Pedia'],source),'fallback line refused');
});
