import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, appendFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import postgres from 'postgres';

// A fresh local PostgreSQL cluster with synthetic data only. Never reads an env URL.
export async function postgresFixture(tls=false){
  const directory=mkdtempSync(join(tmpdir(),'phoenix-mcp-test-'));
  const probe=createServer();await new Promise<void>(r=>probe.listen(0,'127.0.0.1',r));
  const address=probe.address();if(!address||typeof address==='string')throw Error('No fixture port');
  const port=address.port;await new Promise<void>(r=>probe.close(()=>r()));
  const command=(name:string,args:string[])=>{
    const r=spawnSync(name,args,{encoding:'utf8',windowsHide:true,timeout:30000});
    if(r.status!==0){
      const log=join(directory,'server.log');
      throw Error(`Isolated PostgreSQL fixture ${name} failed: ${r.error?.message??r.stderr}\n${existsSync(log)?readFileSync(log,'utf8'):''}`);
    }
  };
  command('initdb',['-D',directory,'-U','fixture_admin','--auth=trust','--no-locale','--encoding=UTF8']);
  if(tls){
    const openssl=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl';
    command(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'server.key'),'-out',join(directory,'server.crt'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1']);
    chmodSync(join(directory,'server.key'),0o600);
    appendFileSync(join(directory,'postgresql.conf'),'\nssl=on\n');
  }
  // Ubuntu's default socket directory belongs to the system cluster. Use only our temp directory.
  const socket=process.platform==='win32'?'':` -k "${directory}"`;
  command('pg_ctl',['-D',directory,'-l',join(directory,'server.log'),'-o',`-h 127.0.0.1 -p ${port} -c fsync=off${socket}`,'-w','start']);
  const sql=postgres({host:'127.0.0.1',port,database:'postgres',username:'fixture_admin',max:1,prepare:false,onnotice:()=>{}});
  return {
    url:`postgresql://phoenix_mcp_reader@127.0.0.1:${port}/phoenix_mcp_reporting`,
    ca:tls?readFileSync(join(directory,'server.crt'),'utf8'):undefined,
    connect:(database:string)=>postgres({host:'127.0.0.1',port,database,username:'fixture_admin',max:1,prepare:false,onnotice:()=>{}}),
    exec:async(query:string)=>{await sql.unsafe(query).simple();},
    query:async(query:string)=>({rows:await sql.unsafe(query)}),
    async close(){await sql.end({timeout:2});command('pg_ctl',['-D',directory,'-m','immediate','-w','stop']);},
  };
}
