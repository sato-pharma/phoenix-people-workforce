import { SourceProof,type Watermark } from './proof.mts';
import { Unavailable } from '../src/contracts.mts';

// Only this source-side adapter holds a source credential. It never reaches the MCP reader.
// GET is deliberate: PostgREST executes GET in a PostgreSQL READ ONLY transaction.
export function createSourceTransport(origin:string,credential:string,request:typeof fetch=fetch){
 const base=new URL(origin);if(base.protocol!=='https:'||base.username||base.password)throw new Unavailable();
 let proof:SourceProof|undefined;
 async function get(path:string,init?:RequestInit,track=true){
  const url=new URL(path,base);if(url.origin!==base.origin||!url.pathname.startsWith('/rest/v1/'))throw new Unavailable();
  const headers=new Headers(init?.headers);headers.set('authorization',`Bearer ${credential}`);headers.set('apikey',credential);
  headers.set('prefer','count=exact');headers.set('cache-control','no-cache');
  try{
   const response=await request(url,{...init,method:'GET',body:undefined,headers,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw new Unavailable();
   // Bound decoded bytes too; Content-Length is neither mandatory nor trustworthy.
   const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
   if(reader)for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>8_000_000){await reader.cancel();throw new Unavailable();}chunks.push(part.value);}
   const buffered=new Response(Buffer.concat(chunks),{status:response.status,headers:response.headers});
   if(track){
    const body=await buffered.clone().json();
    const resource=url.pathname.slice('/rest/v1/'.length),range=response.headers.get('content-range');
    const match=range?.match(/^(?:(\d+)-(\d+)|\*)\/(\d+)$/);
    if(!match)throw new Unavailable();
    const total=Number(match[3]),start=Number(match[1]??0),count=Array.isArray(body)?body.length:body===null?0:1;
    if(count>0&&Number(match[2])-start+1!==count)throw new Unavailable();
    const key=new URL(url);key.searchParams.delete('offset');key.searchParams.delete('limit');
    proof?.record({resource,query:key.href+'|'+(headers.get('accept-profile')??'public'),start,count,total});
   }
   return buffered;
  }catch{proof?.fail();throw new Unavailable();}
 }
 const watermark=async():Promise<Watermark>=>{
  const response=await get('/rest/v1/rpc/phoenix_mcp_source_watermark',undefined,false);
  const value=await response.json();
  if(typeof value?.version!=='string'||typeof value?.observedAt!=='string')throw new Unavailable();
  return value;
 };
 return {
  proof(required:readonly string[]){proof=new SourceProof(watermark,required);return proof;},
  async json(path:string){return (await get('/rest/v1/'+path)).json();},
  fetch:async(input:RequestInfo|URL,init?:RequestInit)=>{
   const url=new URL(input instanceof Request?input.url:String(input));
   const method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
   if(input instanceof Request&&!init)throw new Unavailable();
   if(method==='POST'&&url.pathname.startsWith('/rest/v1/rpc/')){
    const args=JSON.parse(String(init?.body??'{}')) as Record<string,unknown>;
    for(const [name,value] of Object.entries(args))url.searchParams.set(name,typeof value==='string'?value:JSON.stringify(value));
   }else if(method!=='GET'){proof?.fail();throw new Unavailable();}
   return get(url.href,init);
  },
 };
}
