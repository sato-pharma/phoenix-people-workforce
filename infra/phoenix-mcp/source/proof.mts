import { createHash,randomUUID } from 'node:crypto';
import { Unavailable,type Freshness } from '../src/contracts.mts';
export type Watermark={version:string;observedAt:string};
export type ReadEvidence={resource:string;query:string;start:number;count:number;total:number};
// A new instance per dataset. A swallowed loader error is still a failed proof.
export class SourceProof {
 private failed=false;
 private reads:ReadEvidence[]=[];
 constructor(private readonly watermark:()=>Promise<Watermark>,private readonly required:readonly string[]){}
 fail(){this.failed=true;}
 record(read:ReadEvidence){
  if(![read.total,read.start,read.count].every(Number.isSafeInteger)||read.total<0||read.total>100000||read.start<0||read.count<0||read.start+read.count>read.total){this.fail();throw new Unavailable();}
  this.reads.push(read);
 }
 async collect<T>(work:()=>Promise<T>):Promise<{value:T;freshness:Freshness}>{
  const before=await this.watermark();
  this.reads=[];this.failed=false;
  const value=await work();
  const reads=[...this.reads],after=await this.watermark();
  if(this.failed||!reads.length||before.version!==after.version||!before.version||!Number.isFinite(Date.parse(after.observedAt))||!Number.isFinite(Date.parse(before.observedAt))||Date.parse(before.observedAt)>Date.parse(after.observedAt))throw new Unavailable();
  if(this.required.some(resource=>!reads.some(read=>read.resource===resource)))throw new Unavailable();
  for(const query of new Set(reads.map(r=>r.query))){
   const pages=reads.filter(r=>r.query===query).sort((a,b)=>a.start-b.start),total=pages[0].total;
   let covered=0;
   for(const page of pages){if(page.total!==total||page.start>covered)throw new Unavailable();covered=Math.max(covered,page.start+page.count);}
   if(covered!==total)throw new Unavailable();
  }
  return {value,freshness:{snapshotId:randomUUID(),sourceUpdatedAt:after.observedAt,sourceObservedAt:after.observedAt,
   sourceWatermark:createHash('sha256').update(before.version).digest('hex')}};
 }
}
