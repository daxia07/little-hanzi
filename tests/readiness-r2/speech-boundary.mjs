// Declared browser speech boundary only; app/UI/HTTP/database stay real.
export function browserSpeechFixture(){
 const state={mode:'normal',started:[],utterances:[],active:[],cancelled:0};window.__r2Speech=state;
 class Utterance{constructor(text){this.text=text;this.lang='';}}
 const emit=(u,type,error)=>u[`on${type}`]?.({type,error,utterance:u});
 state.fail=index=>emit(state.utterances[index],'error','synthesis-failed');
 const synth={
  getVoices(){if(state.mode==='missing')return [];if(state.mode==='remote')return [{name:'QA remote rejected',lang:'zh-CN',localService:false}];if(state.mode==='cantonese')return [{name:'QA Cantonese rejected',lang:'zh-HK',localService:true}];return [{name:'QA injected Mandarin',lang:'zh-CN',localService:true,default:true,voiceURI:'qa-injected'}];},
  addEventListener(){},removeEventListener(){},
  cancel(){state.cancelled++;for(const u of state.active.splice(0))emit(u,'error','canceled');},
  speak(u){state.utterances.push(u);if(state.mode==='throw')throw Error('QA playback rejected');if(state.mode==='error'){queueMicrotask(()=>emit(u,'error','synthesis-failed'));return;}state.active.push(u);queueMicrotask(()=>{if(!state.active.includes(u)||state.mode==='timeout')return;state.started.push(u.text);emit(u,'start');if(state.mode==='hold')return;setTimeout(()=>{if(!state.active.includes(u))return;state.active=state.active.filter(x=>x!==u);emit(u,'end');},30);});},
  get speaking(){return state.active.length>0;},get pending(){return state.active.length>0;},get paused(){return false;},
 };
 Object.defineProperty(window,'SpeechSynthesisUtterance',{value:Utterance,configurable:true});Object.defineProperty(window,'speechSynthesis',{value:synth,configurable:true});
}
