import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import type { Principal } from './contracts.mts';

export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
// Only OAuth metadata, hashes, and temporary PKCE secrets; never Phoenix result data.
export class StateStore {
  private db: DatabaseSync;
  constructor(path: string, private readonly now = () => Date.now()) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, kind TEXT NOT NULL, value TEXT NOT NULL, expires INTEGER NOT NULL);');
  }
  put(kind: string, key: string, value: unknown, seconds: number) {
    this.db.prepare('delete from state where expires <= ?').run(this.now());
    const count = this.db.prepare('select count(*) as n from state').get()!;
    if (Number(count.n)>=2000) throw new Error('Authorization capacity reached');
    this.db.prepare('insert into state values(?,?,?,?)').run(digest(key),kind,JSON.stringify(value),this.now()+seconds*1000);
  }
  get<T>(kind:string,key:string):T|null {
    const row=this.db.prepare('select value from state where key=? and kind=? and expires>?').get(digest(key),kind,this.now());
    return row ? JSON.parse(String(row.value)) as T : null;
  }
  take<T>(kind:string,key:string):T|null {
    // Atomic consumption, including concurrent token exchanges.
    const row=this.db.prepare('delete from state where key=? and kind=? and expires>? returning value').get(digest(key),kind,this.now());
    return row ? JSON.parse(String(row.value)) as T : null;
  }
  revokeFamily(family:string) {
    if(this.isRevoked(family)) return;
    this.put('revoked',family,true,86400);
  }
  isRevoked(family:string) { return this.get('revoked',family) !== null; }
  close(){this.db.close();}
}
export type Grant = { principal:Principal; clientId:string; resource:string; family:string; expiresAt:number; accessExpiresAt:number };
