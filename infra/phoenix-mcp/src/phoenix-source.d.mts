export type RecordedRead = {key:string;method:string;relation:string|null;kind:'table'|'rpc';status:number|null;ok:boolean;limited:boolean;rangeStart:number|null;rangeEnd:number|null;total:number|null};
export function installReadRecorder():void;
export function runWithReadRecorder<T>(work:()=>Promise<T>):Promise<{ok:true;value:T;reads:RecordedRead[]}|{ok:false;error:unknown;reads:RecordedRead[]}>;
export type WatermarkEntry = {rows:number|null;stamp:string|null;digest:string|null};
export type Watermark = Record<string,WatermarkEntry>;
export type SourceSpec = {dataset:string;watched:readonly string[];coverage:Readonly<Record<string,readonly string[]>>;required:readonly (string|RegExp)[]};
export type VerifiedProof = Readonly<{dataset:string;period:string;startedAt:string;observedAt:string;updatedAt:string;requests:number;relations:readonly string[];sources:Readonly<Watermark>}>;
export class SourceProofError extends Error { readonly reason:string; readonly detail:string }
export function verifySourceProof(input:{spec:SourceSpec;period:string;startedAt:string;finishedAt:string;reads:readonly RecordedRead[];before:Watermark;after:Watermark;maxRows?:number}):VerifiedProof;
export function assertVerifiedProof(value:unknown):VerifiedProof;
export function isVerifiedProof(value:unknown):value is VerifiedProof;
export function sealFreshness(proof:VerifiedProof,rows:readonly unknown[]):{snapshotId:string;sourceUpdatedAt:string;sourceObservedAt:string};
export function contentSnapshotId(dataset:string,period:string,rows:readonly unknown[]):string;
export function summarizeReads(reads:readonly RecordedRead[],maxRows?:number):{requests:number;failed:string[];truncated:string[];relations:string[]};
export type WatermarkReader = (sources:readonly string[],period:string|null)=>Promise<Watermark>;
export function provenRead<T>(spec:SourceSpec,period:string,work:()=>Promise<T>,deps:{watermark:WatermarkReader;now?:()=>Date;attempts?:number}):Promise<{value:T;proof:VerifiedProof}>;
export function withChangeClock(inner:WatermarkReader,now?:()=>Date):WatermarkReader;
export function createRpcWatermarkReader(db:unknown):WatermarkReader;
export const SALES_PUBLICATION_SPEC:SourceSpec;
export const SPECS:{employees:SourceSpec;organization:SourceSpec;vacancies:SourceSpec;published_sales:SourceSpec};
export type LiveInputs = {subject:string;accounts:readonly {login_id:string|null;role:string|null;hr_id:string|null;is_active:boolean|null;is_test_persona:boolean|null;session_version:number|null}[];authUser:{exists:boolean;bannedUntil:string|null;deletedAt:string|null};employee:{employment_status:string|null;last_working_date:string|null}|null;matrix:Record<string,Partial<Record<string,readonly string[]>>>;locks:readonly {login_id:string|null;hr_id:string|null;module_key:string|null;unlock_at:string|null}[];now:Date};
export function decideLiveIdentity(input:LiveInputs):unknown;
export type LiveSources = {accounts(s:string):Promise<LiveInputs['accounts'][number][]>;authUser(s:string):Promise<LiveInputs['authUser']>;employee(h:string):Promise<LiveInputs['employee']>;matrix():Promise<LiveInputs['matrix']>;locks():Promise<LiveInputs['locks'][number][]>;now():Date};
export function loadLiveIdentity(subject:string,sources:LiveSources):Promise<unknown>;
export class LiveAuthorizationError extends Error { readonly reason:string }
