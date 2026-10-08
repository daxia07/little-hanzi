import { database } from '@/lib/db';
import { env } from 'cloudflare:workers';
import { DEFAULT_SETTINGS, validAttempt, validSettings, validSession } from '@/lib/learning';
export const dynamic='force-dynamic';
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
function profile(request:Request) { const p=new URL(request.url).searchParams.get('profile')??'family'; return /^[a-z0-9-]{1,64}$/.test(p)?p:null; }
function pilotMode() { const mode=(env as unknown as {HANZI_PILOT_MODE?:string|boolean}).HANZI_PILOT_MODE; return mode===true || mode==='1' || mode==='true' || mode==='yes'; }
export async function GET(request:Request) {
  if(pilotMode())return json({error:'Not found'},404);
  const p=profile(request); if(!p)return json({error:'Invalid profile'},400);
  try {
    const db=await database();
    const [a,s,d]=await Promise.all([db.prepare('SELECT payload FROM attempts WHERE profile=? ORDER BY created_at').bind(p).all<{payload:string}>(),db.prepare('SELECT payload FROM settings WHERE profile=?').bind(p).first<{payload:string}>(),db.prepare('SELECT payload FROM drafts WHERE profile=?').bind(p).first<{payload:string}>()]);
    return json({attempts:a.results.map(x=>JSON.parse(x.payload)),settings:s?JSON.parse(s.payload):DEFAULT_SETTINGS,draft:d?JSON.parse(d.payload):null});
  } catch(error) { console.error('State read failed',error); return json({error:'Progress could not be loaded. Please retry.'},503); }
}
export async function POST(request:Request) {
  if(pilotMode())return json({error:'Not found'},404);
  const p=profile(request); if(!p)return json({error:'Invalid profile'},400);
  const origin=request.headers.get('origin'); if(origin && origin!==new URL(request.url).origin)return json({error:'Origin mismatch'},403);
  let body; try { const text=await request.text(); if(text.length>400000)return json({error:'Backup too large'},413); body=JSON.parse(text); } catch { return json({error:'Invalid JSON'},400); }
  if(!body || typeof body!=='object')return json({error:'Invalid request'},400);
  const {kind,value}=body;
  if(kind==='attempt' && !validAttempt(value) || kind==='settings' && !validSettings(value) || kind==='draft' && !validSession(value))return json({error:'Invalid record'},400);
  if(!['attempt','settings','draft','import'].includes(kind))return json({error:'Unknown operation'},400);
  if(kind==='import' && (!value || !validSettings(value.settings) || !Array.isArray(value.attempts) || value.attempts.length>1000 || !value.attempts.every(validAttempt)))return json({error:'Invalid backup (maximum 1000 attempts)'},400);
  try {
    const db=await database();
    if(kind==='attempt') await db.prepare('INSERT INTO attempts(profile,id,created_at,payload) VALUES(?,?,?,?) ON CONFLICT(profile,id) DO NOTHING').bind(p,value.id,value.at,JSON.stringify(value)).run();
    if(kind==='settings') await db.prepare('INSERT INTO settings(profile,payload) VALUES(?,?) ON CONFLICT(profile) DO UPDATE SET payload=excluded.payload').bind(p,JSON.stringify(value)).run();
    if(kind==='draft') await db.prepare('INSERT INTO drafts(profile,updated_at,payload) VALUES(?,?,?) ON CONFLICT(profile) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload WHERE excluded.updated_at>drafts.updated_at').bind(p,value.updatedAt,JSON.stringify(value)).run();
    if(kind==='import') { for(let i=0;i<value.attempts.length;i+=40) await db.batch(value.attempts.slice(i,i+40).map((a: {id:string;at:string})=>db.prepare('INSERT INTO attempts(profile,id,created_at,payload) VALUES(?,?,?,?) ON CONFLICT(profile,id) DO NOTHING').bind(p,a.id,a.at,JSON.stringify(a)))); await db.prepare('INSERT INTO settings(profile,payload) VALUES(?,?) ON CONFLICT(profile) DO UPDATE SET payload=excluded.payload').bind(p,JSON.stringify(value.settings)).run(); }
    return json({ok:true});
  } catch(error) { console.error('State write failed',error); return json({error:'Progress could not be saved. Please retry.'},503); }
}
