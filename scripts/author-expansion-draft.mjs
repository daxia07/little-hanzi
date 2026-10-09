/** Expand original editorial rows against exact licensed archive bytes. No network or service access. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const root=fileURLToPath(new URL('..',import.meta.url));
const args=process.argv.slice(2);
if(args[0]!=='--archive'||!args[1]||args.length>3||(args[2]&&args[2]!=='--check')) throw Error('Use --archive PATH [--check]');
const check=args[2]==='--check';
const bytes=fs.readFileSync(path.resolve(args[1]));
const archiveSha256='46d3b24796ace4deb459896e688836e6a98fe12a6dcb5116d8a3f02049389059';
if(createHash('sha256').update(bytes).digest('hex')!==archiveSha256)throw Error('Exact pinned CC-CEDICT archive required');
const normalize=p=>p.toLowerCase().replaceAll('u:','v');
const entries=new Map();
for(const line of gunzipSync(bytes).toString('utf8').split(/\r?\n/)) {
  const m=line.match(/^([^ ]+) ([^ ]+) \[([^\]]+)\] \/(.+)\/$/);if(!m)continue;
  const e={traditional:m[1],simplified:m[2],numberedPinyin:normalize(m[3]),archivePinyin:m[3],kind:'dictionary-entry',glosses:m[4].split('/')};
  const list=entries.get(e.simplified)??[];list.push(e);entries.set(e.simplified,list);
}
const preferred=list=>[...list].sort((a,b)=>{
  const rank=e=>Number(/[A-Z]/.test(e.archivePinyin))*4+Number(e.glosses.some(g=>g.startsWith('variant')||g.startsWith('old variant')))*2+Number(e.glosses.some(g=>g.startsWith('surname')));
  return rank(a)-rank(b);
})[0];
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const frames=read('content/authoring/expansion-reader-frames-v1.json').frames;
const compositions=read('content/authoring/expansion-compositional-readings-v1.json').phrases;
const used=new Map();
const bind=e=>{used.set(`${e.simplified}/${e.numberedPinyin}`,e);return e;};
const dictionary=(text,py)=>{
  const list=(entries.get(text)??[]).filter(e=>e.numberedPinyin===py);
  if(!list.length)throw Error(`Exact source tuple missing: ${text}/${py}`);
  return preferred(list);
};
const components=(text,py)=>{
  const syllables=py.split(' '),parts=[];let index=0;
  while(index<text.length) {
    let found=null;
    for(let length=text.length-index;length>0;length--) {
      const t=text.slice(index,index+length),p=syllables.slice(index,index+length).join(' ');
      const list=(entries.get(t)??[]).filter(e=>e.numberedPinyin===p);
      if(list.length){found=preferred(list);break;}
    }
    if(!found)throw Error(`Compositional component lacks dictionary facts: ${text}/${py}`);
    parts.push(found);index+=found.simplified.length;
  }
  return parts;
};
function toneMarks(py) {
  return py.split(' ').map(s=>{
    const tone=Number(s.at(-1));let b=s.slice(0,-1).replaceAll('v','ü');
    if(tone<5) {
      let at=b.indexOf('a');if(at<0)at=b.indexOf('e');if(at<0&&b.includes('ou'))at=b.indexOf('o');
      if(at<0)at=Math.max(...'aeiouü'.split('').map(c=>b.lastIndexOf(c)));
      if(at<0)throw Error(`Unsupported tonal syllable: ${s}`);
      b=b.slice(0,at)+{a:'āáǎà',e:'ēéěè',i:'īíǐì',o:'ōóǒò',u:'ūúǔù',ü:'ǖǘǚǜ'}[b[at]][tone-1]+b.slice(at+1);
    }
    return b;
  }).join(' ');
}
const rows=fs.readFileSync(path.join(root,'content/authoring/expansion-original-contexts-v1.tsv'),'utf8').trim().split('\n');
const chars=[];
for(const row of rows) {
  const fields=row.split('|');if(fields.length!==6)throw Error('Six editorial columns required');
  const [hanzi,numberedPinyin,meaning,hint,...wordRows]=fields;bind(dictionary(hanzi,numberedPinyin));
  const words=wordRows.map(w=>{
    const fields=w.split('~'),[text,english,context]=fields;let sentence,translation;
    if(fields.length===3&&context.startsWith('@')) {
      if(/;|one's|\bsth\b|\bsb\b/.test(english)) throw Error('Dictionary-style gloss needs an explicitly authored finite English context');
      const frame=frames[context.slice(1)];if(!frame)throw Error('Unknown original frame');
      [sentence,translation]=frame.map(s=>s.replaceAll('{word}',text).replaceAll('{english}',english));
    } else if(fields.length===4) [sentence,translation]=fields.slice(2);else throw Error('Invalid editorial word row');
    const index=text.indexOf(hanzi);if(index<0||!sentence.includes(text))throw Error('Target and original word context required');
    let e;
    if(entries.has(text)) {
      const matching=entries.get(text).filter(e=>e.numberedPinyin.split(' ')[index]===numberedPinyin);
      if(!matching.length)throw Error(`Word changes selected target reading: ${hanzi}/${text}`);
      e=preferred(matching);
    } else {
      const py=compositions[text];if(!py)throw Error(`Original phrase needs explicit readings: ${text}`);
      e={simplified:text,numberedPinyin:py,kind:'compositional-phrase',humanReviewed:false,components:components(text,py),note:'Original word/phrase, not represented as a dictionary headword; pinned component facts retained.'};
    }
    if(e.numberedPinyin.split(' ')[index]!==numberedPinyin)throw Error('Compositional target reading changed');
    bind(e);
    return {text,numberedPinyin:e.numberedPinyin,pinyin:toneMarks(e.numberedPinyin),english,sentence,translation};
  });
  if(new Set(words.map(w=>w.text)).size!==2)throw Error('Distinct useful words required');
  chars.push({hanzi,numberedPinyin,pinyin:toneMarks(numberedPinyin),meaning,hint,words});
}
const roster=read('content/authoring/expansion-target-roster-v1.json').targets.slice(20);
const compare=(a,b)=>a<b?-1:a>b?1:0;
if(chars.length!==280||new Set(chars.map(c=>c.hanzi)).size!==280||JSON.stringify(chars.map(c=>c.hanzi).sort(compare))!==JSON.stringify([...roster].sort(compare)))throw Error('Exact 280-target roster required');
const themes=[
  'Useful connecting words','Moving and doing','Questions, learning and helping',
  'Friends and positions','Directions and time','Seasons, weather and water',
  'Streams, plants and fields','Metals, fruit and cooking','Meals and containers',
  'Home and our neighbourhood','School words and shapes',
  'Art, music and games','Helping hands and tidying','Kinds, measures and collections',
];
const lessons=[];
for(let i=0;i<140;i++) {
  const pair=chars.slice(i*2,i*2+2);
  if(pair[0].numberedPinyin===pair[1].numberedPinyin)throw Error(`Ambiguous sound pair: ${pair.map(c=>c.hanzi).join("/")}`);
  const id=`expansion-${String(i+1).padStart(3,'0')}`;
  const theme=themes[Math.floor(i/10)];
  const title=`${theme}: ${pair.map(c=>c.hanzi).join(' and ')}`;
  const welcome=`Read two short word examples for ${pair[0].hanzi} and ${pair[1].hanzi} with our capybara. Then try the characters in ordinary print.`;
  lessons.push({lessonId:id,lessonVersion:`${id}-v1`,sequence:61+i,title,welcome,readerTitle:title,characters:pair});
}
const draft={schemaVersion:'expansion-authoring-draft-1',status:'unreviewed',author:'Little Hanzi assisted original editorial draft; attributed Mandarin and child-suitability review pending',sourceEvidence:'content/sources/expansion-cc-cedict-20261008.json',lessons};
const facts=[...used.values()];
const source={schemaVersion:'expansion-dictionary-evidence-1',source:'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz',archiveSha256,accessedAt:'2026-10-08',normalization:'Dictionary u: is represented as v in numbered pinyin; uppercase surname/loanword markers normalized to lowercase. Original archive spelling retained.',license:'CC-BY-SA-4.0',licenseUrl:'https://creativecommons.org/licenses/by-sa/4.0/',attribution:'CC-CEDICT contributors, published by MDBG; selected dictionary facts and adapted curriculum with original Little Hanzi contexts. Human review pending.',humanReviewed:false,dictionaryEntryCount:facts.filter(e=>e.kind==='dictionary-entry').length,compositionalPhraseCount:facts.filter(e=>e.kind==='compositional-phrase').length,entries:facts};
// The separately frozen literal word oracle is reviewed as a test input;
// this authoring command never rewrites it to accommodate editorial drift.
const outputs={'content/authoring/expansion-draft-v1.json':draft,'content/sources/expansion-cc-cedict-20261008.json':source};
for(const [name,value] of Object.entries(outputs)) {
  const file=path.join(root,name),text=JSON.stringify(value,null,2)+'\n';
  if(check){if(fs.readFileSync(file,'utf8')!==text)throw Error(`Editorial drift: ${name}`);}
  else {fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
}
console.log(JSON.stringify({targets:chars.length,lessons:lessons.length,dictionaryEntries:source.dictionaryEntryCount,compositionalPhrases:source.compositionalPhraseCount,archiveSha256,humanReview:false,publication:false}));
