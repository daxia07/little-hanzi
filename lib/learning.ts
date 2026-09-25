export const CONTENT_VERSION = 'poc-1';
export const CHARACTERS = [
  { id: 'yi', hanzi: '一', pinyin: 'yī', raw: 'yi', tone: 1, word: '第一', meaning: '一、二、三，从一开始。', color: '#f6edd4' },
  { id: 'er', hanzi: '二', pinyin: 'èr', raw: 'er', tone: 4, word: '二月', meaning: '两只手，可以数到二。', color: '#e5eedf' },
  { id: 'san', hanzi: '三', pinyin: 'sān', raw: 'san', tone: 1, word: '三天', meaning: '一、二、三，三条横线。', color: '#f5e4db' },
  { id: 'da', hanzi: '大', pinyin: 'dà', raw: 'da', tone: 4, word: '大人', meaning: '大和小，找找有什么不同。', color: '#e7eaf2' },
  { id: 'xiao', hanzi: '小', pinyin: 'xiǎo', raw: 'xiao', tone: 3, word: '小手', meaning: '用你的小手，写一个小。', color: '#f6edd4' },
  { id: 'ren', hanzi: '人', pinyin: 'rén', raw: 'ren', tone: 2, word: '家人', meaning: '我和你，都是人。', color: '#e5eedf' },
] as const;
export type Character = typeof CHARACTERS[number];
export type Skill = 'writing' | 'pinyin' | 'recognition';
export interface Attempt { id: string; at: string; characterId: string; skill: Skill; mode: 'practice' | 'exam'; correct: boolean; assisted: boolean; mistakes: number; first: boolean; answer: string; responseMode: string; contentVersion: string; }
export interface Settings { enabled: string[]; lessonSize: number; }
export const DEFAULT_SETTINGS: Settings = { enabled: CHARACTERS.map(c => c.id), lessonSize: 3 };
export interface Session { id: string; mode: 'lesson' | 'exam'; ids: string[]; index: number; stage: 'learn' | 'write' | 'pinyin' | 'recognition' | 'done'; updatedAt: number; raw: string; tone: number; checked: boolean; correct: boolean; tries: number; heard: boolean; choice: string; writingStroke: number; writingMistakes: number; writingHelp: boolean; independent: boolean; writingDone: boolean; }
export function newId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; }
export function character(id: string) { return CHARACTERS.find(c => c.id === id) ?? CHARACTERS[0]; }
export function spell(raw: string, tone: number) {
  const text = raw.toLowerCase().replaceAll('v', 'ü');
  if (tone < 1 || tone > 4) return text;
  let i = text.indexOf('a');
  if (i < 0) i = text.indexOf('e');
  if (i < 0 && text.includes('ou')) i = text.indexOf('o');
  if (i < 0) for (let j = text.length - 1; j >= 0; j--) if ('iouü'.includes(text[j])) { i = j; break; }
  const marks: Record<string, string> = { a:'āáǎà', e:'ēéěè', i:'īíǐì', o:'ōóǒò', u:'ūúǔù', ü:'ǖǘǚǜ' };
  return i < 0 ? text : text.slice(0,i) + marks[text[i]][tone-1] + text.slice(i+1);
}
export function isPinyinCorrect(id: string, raw: string, tone: number) { const c=character(id); return raw.toLowerCase().trim()===c.raw && tone===c.tone; }
export function validSettings(v: unknown): v is Settings {
  const s=v as Settings; return !!s && Array.isArray(s.enabled) && s.enabled.length>0 && s.enabled.length<=6 && new Set(s.enabled).size===s.enabled.length && s.enabled.every(id=>CHARACTERS.some(c=>c.id===id)) && Number.isInteger(s.lessonSize) && s.lessonSize>=1 && s.lessonSize<=3;
}
export function validAttempt(v: unknown): v is Attempt {
  const a=v as Attempt; return !!a && typeof a.id==='string' && /^[a-zA-Z0-9:_-]{1,120}$/.test(a.id) && typeof a.at==='string' && Number.isFinite(Date.parse(a.at)) && CHARACTERS.some(c=>c.id===a.characterId) && ['writing','pinyin','recognition'].includes(a.skill) && ['practice','exam'].includes(a.mode) && typeof a.correct==='boolean' && typeof a.assisted==='boolean' && typeof a.first==='boolean' && Number.isInteger(a.mistakes) && a.mistakes>=0 && a.mistakes<=10000 && typeof a.answer==='string' && a.answer.length<=100 && typeof a.responseMode==='string' && a.responseMode.length<=40 && a.contentVersion===CONTENT_VERSION;
}
export function validSession(v: unknown): v is Session {
  const s=v as Session; return !!s && typeof s.id==='string' && s.id.length<=80 && ['lesson','exam'].includes(s.mode) && Array.isArray(s.ids) && s.ids.length>0 && s.ids.length<=6 && s.ids.every(id=>CHARACTERS.some(c=>c.id===id)) && Number.isInteger(s.index) && s.index>=0 && s.index<s.ids.length && ['learn','write','pinyin','recognition','done'].includes(s.stage) && Number.isFinite(s.updatedAt) && typeof s.raw==='string' && s.raw.length<=12 && Number.isInteger(s.tone) && s.tone>=0 && s.tone<=5 && ['checked','correct','heard','writingHelp','independent','writingDone'].every(k=>typeof s[k as keyof Session]==='boolean') && Number.isInteger(s.writingStroke) && s.writingStroke>=0 && s.writingStroke<=4 && Number.isInteger(s.writingMistakes) && s.writingMistakes>=0 && s.writingMistakes<=10000 && Number.isInteger(s.tries) && s.tries>=0 && typeof s.choice==='string' && s.choice.length<=30;
}
export function freshQuestion(): Pick<Session,'raw'|'tone'|'checked'|'correct'|'tries'|'heard'|'choice'|'writingStroke'|'writingMistakes'|'writingHelp'|'independent'|'writingDone'> { return { raw:'',tone:0,checked:false,correct:false,tries:0,heard:false,choice:'',writingStroke:0,writingMistakes:0,writingHelp:false,independent:false,writingDone:false }; }
export function createSession(settings: Settings, mode: Session['mode']): Session { return { ...freshQuestion(), id:newId(),mode,ids:settings.enabled.slice(0,mode==='exam'?3:settings.lessonSize),index:0,stage:mode==='lesson'?'learn':'recognition',updatedAt:Date.now() }; }
export function mergeAttempts(...groups: Attempt[][]) { const map=new Map<string,Attempt>(); for(const group of groups) for(const a of group) map.set(a.id,a); return [...map.values()].sort((a,b)=>a.at.localeCompare(b.at)); }
