import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
// 🔴 The PURE marker is inserted as TEXT, so it must never land inside a comment or a string:
// `/* @__PURE__ */` written into a docblock CLOSES that docblock, and the prose behind it is then
// parsed as code. On 2026-10-23 a comment reading "the weekly sales row cache
// (src/lib/sales/weekly/row-cache.ts), generalised:" did exactly that, and esbuild failed with
// `Expected ";" but found ":"` pointing at a line of src/lib/cache/shared-read.ts that holds no
// code at all. So the scan below walks each file once, copies comments, strings and template
// literals through untouched, and marks only real `cache(` / `unstable_cache(` CALLS. It never
// deletes and never rewrites: a call it declines to mark simply stays unmarked, which the bundle
// assertions at the bottom of this file catch — it fails closed, never open.
const PURE_CALL=/(?:cache|unstable_cache)\s*\(/y;
const IDENT=/[\w$]/;
function markPureCalls(source){
  const n=source.length;
  let out='',i=0,prev=' ';
  while(i<n){
    const c=source[i],d=source[i+1];
    if(c==='/'&&d==='/'){const e=source.indexOf('\n',i);const stop=e<0?n:e;out+=source.slice(i,stop);i=stop;prev=' ';continue;}
    if(c==='/'&&d==='*'){const e=source.indexOf('*/',i+2);const stop=e<0?n:e+2;out+=source.slice(i,stop);i=stop;prev=' ';continue;}
    // A quoted string cannot span a line, so a stray quote inside a regex literal can confuse this
    // scan for one line at most — and only ever into marking less.
    if(c==='"'||c==="'"){let j=i+1;while(j<n&&source[j]!=='\n'){if(source.charCodeAt(j)===92){j+=2;continue;}if(source[j]===c){j+=1;break;}j+=1;}out+=source.slice(i,j);i=j;prev=c;continue;}
    if(c==='`'){let j=i+1;while(j<n){if(source.charCodeAt(j)===92){j+=2;continue;}if(source[j]==='`'){j+=1;break;}j+=1;}out+=source.slice(i,j);i=j;prev=c;continue;}
    if((c==='c'||c==='u')&&!IDENT.test(prev)){PURE_CALL.lastIndex=i;const m=PURE_CALL.exec(source);if(m){out+='/* @__PURE__ */ '+m[0];i+=m[0].length;prev='(';continue;}}
    out+=c;i+=1;prev=c;
  }
  return out;
}
// Reuse PURE Phoenix policy exports. No administrative client may survive bundling.
const denyIo = {
  name: 'deny-phoenix-business-io',
  setup(b) {
    b.onLoad({filter:/\.tsx?$/},async args=>{
      if(!args.path.startsWith(path.join(root,'src')+path.sep))return;
      // These wrappers are replaced by identity functions below. Mark only their calls
      // pure so discarded exports cannot retain administrative loaders in the bundle.
      const source=await readFile(args.path,'utf8');
      return {contents:markPureCalls(source),loader:args.path.endsWith('.tsx')?'tsx':'ts'};
    });
    b.onResolve({filter:/^(next\/cache(?:\.js)?|react)$/},()=>({path:'cache',namespace:'pure-cache',sideEffects:false}));
    b.onResolve({filter:/^react\/jsx-runtime$/},()=>({path:'jsx',namespace:'no-ui',sideEffects:false}));
    b.onLoad({filter:/.*/,namespace:'no-ui'},()=>({contents:'export const jsx=()=>{throw Error("UI unavailable in MCP")}; export const jsxs=jsx; export const Fragment=Symbol();',loader:'js'}));
    b.onLoad({filter:/.*/,namespace:'pure-cache'},()=>({contents:'export const cache = f => f; export const unstable_cache = f => f; export const revalidatePath = () => { throw Error("Disabled"); }; export const revalidateTag = revalidatePath;',loader:'js'}));
    b.onResolve({filter:/^exceljs$/},()=>({path:'exceljs',external:true,sideEffects:false}));
    b.onResolve({filter:/^sanitize-html$/},()=>({path:'sanitize-html',external:true,sideEffects:false}));
    b.onResolve({ filter: /^@\/lib\/(supabase\/server|supabase-rest|observability\/log)$/ }, () => ({ path: 'denied', namespace: 'denied' }));
    b.onLoad({ filter: /.*/, namespace: 'denied' }, () => ({
      contents: `const deny = () => { throw new Error('Phoenix administrative IO is unavailable in MCP'); }; export const getSupabaseAdmin=deny, getSupabaseUserClient=deny, rpcAll=deny, supabaseRest=deny, logError=deny, logWarn=deny, logWarning=deny, logInfo=deny, toQueryError=deny;`, loader: 'js',
    }));
  },
};
const result=await build({
  absWorkingDir: here,
  entryPoints: process.argv.includes('--tests') ? ['src/main.mts', 'tests/security.test.mts','tests/integration.test.mts','tests/pipeline.test.mts'] : ['src/main.mts'],
  outdir: 'dist', outExtension: { '.js': '.mjs' }, outbase: '.',
  entryNames: '[name]', bundle: true, platform: 'node', target: 'node24', format: 'esm',
  packages: 'external', alias: { '@': path.join(root, 'src') },
  plugins: [denyIo], sourcemap: false, logLevel: 'warning', metafile:true,
});
const artifact=await readFile(path.join(here,'dist/main.mjs'),'utf8');
if(/serviceRoleKey|\/rest\/v1\/|getRequiredEnv\("SUPABASE|supabase\.co/.test(artifact))throw Error('Administrative Phoenix IO survived bundling');
for(const output of Object.values(result.metafile.outputs)){
  for(const item of output.imports){
    if(item.external&&!/^(node:|@modelcontextprotocol\/sdk\/|express$|jose$|postgres$|zod$)/.test(item.path))throw Error(`Unreviewed runtime dependency: ${item.path}`);
  }
}
await writeFile(path.join(here,'dist/build-manifest.json'),JSON.stringify(result.metafile,null,2));
