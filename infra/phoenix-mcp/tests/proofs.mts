import { SPECS,verifySourceProof,type RecordedRead,type VerifiedProof,type Watermark } from '../src/phoenix-source.mjs';

// Test-only: a proof built by the REAL verifier from a read log that satisfies the dataset's own
// registry (every required relation read once, all 200 OK) and an unchanged watermark. It lets tests
// that are not about the source host publish through the real publisher without a source database.
export function proofFor(dataset:keyof typeof SPECS,period:string,at=Date.now()):VerifiedProof{
 const spec=SPECS[dataset];
 const names=spec.required.map(need=>typeof need==='string'?need:Object.keys(spec.coverage).find(k=>need.test(k))!);
 const reads:RecordedRead[]=names.map(relation=>({key:`GET /rest/v1/${relation}`,method:'GET',relation,kind:'table',status:200,ok:true,limited:false,rangeStart:0,rangeEnd:9,total:null}));
 const mark:Watermark=Object.fromEntries(spec.watched.map(name=>[name,{rows:1,stamp:new Date(at-5000).toISOString(),digest:'d'}]));
 return verifySourceProof({spec,period,startedAt:new Date(at-1000).toISOString(),finishedAt:new Date(at).toISOString(),reads,before:mark,after:mark});
}
