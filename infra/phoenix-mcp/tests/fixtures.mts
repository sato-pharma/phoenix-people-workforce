import type { Config } from '../src/config.mts';
import { identitySchema, employeeSchema, vacancySchema, organizationSchema, salesSchema, type ReadStore } from '../src/contracts.mts';
export const subject='11111111-1111-4111-8111-111111111111';
export const config:Config={
  resource:'https://mcp.example.test/mcp',issuer:'https://mcp.example.test',
  owner:{subject,loginId:'test-owner',role:'Super Admin'},databaseUrl:'postgresql://phoenix_mcp_reader:fixture@localhost/fixture',databaseRole:'phoenix_mcp_reader',
  contractRevision:'a'.repeat(40),clientId:'private-chatgpt',redirectUri:'https://chatgpt.com/oauth/fixture/callback',
  oidcIssuer:'https://identity.example.test',oidcClientId:'fixture-client',oidcClientSecret:'fixture-secret-not-real',callback:'https://mcp.example.test/oauth/callback',statePath:':memory:',port:8080,
};
export function fixtureStore(){
  let identity=identitySchema.parse({subject,loginId:'test-owner',hrId:'OWNER',role:'Super Admin',active:true,sessionVersion:1,employmentStatus:'active',lastWorkingDate:null,testPersona:false,permissions:[],locks:[]});
  const employees=[
    {hrId:'A-1',fullName:'Fixture Active',employmentStatus:'active'},
    {hrId:'A-2',fullName:'Fixture Leave',employmentStatus:'on_leave'},
    {hrId:'A-3',fullName:'Fixture Departed',employmentStatus:'resigned'},
    {hrId:'A-4',fullName:'Fixture Placeholder',employmentStatus:'system_placeholder'},
  ].map(row=>employeeSchema.parse({managerHrId:null,jobTitle:'Medical Rep',organogramVisible:true,department:'Sales',line:'CNS',salary:999999,nationalId:'NEVER_RETURN',...row}));
  const vacancies=[1,2,3].map(i=>vacancySchema.parse({key:String(i),position:'Medical Representative',department:'Sales',line:'CNS',area:`Fixture area ${i}`,status:'open'}));
  const organization=[1,2,3].map(i=>organizationSchema.parse({key:String(i),parentKey:null,parentPosition:'National Sales Manager',position:'Medical Representative',employeeName:'Fixture Employee',department:'Sales',line:'CNS',area:`Fixture area ${i}`,vacant:false}));
  const sales=[salesSchema.parse({key:'CNS',period:'2026-09',line:'CNS',salesValue:1500,targetValue:2000,currency:'EGP',publishedAt:'2026-10-01T00:00:00+03:00',sourceRevision:'fixture-published'})];
  const guard=(s:string)=>{if(s!==subject)throw Error('out of scope');};
  let fail=false;
  const db:ReadStore={
    async identity(s){if(fail)throw Error('offline');return s===subject?identity:null;},
    async employees(s){guard(s);return employees;},
    async vacancies(s,a,l){guard(s);return vacancies.filter(r=>r.key>a).slice(0,l);},
    async organization(s,a,l){guard(s);return organization.filter(r=>r.key>a).slice(0,l);},
    async sales(s,p,a,l){guard(s);return sales.filter(r=>r.period===p&&r.key>a).slice(0,l);},
    async ready(){if(fail)throw Error('offline');},async close(){},
  };
  return {db,identity:()=>identity,setIdentity:(patch:Partial<typeof identity>)=>{identity={...identity,...patch};},fail:()=>{fail=true;},employees};
}
