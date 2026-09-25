'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Play, RotateCcw, Check, Eye, EyeOff } from 'lucide-react';
import type { Character } from '@/lib/learning';
import type HanziWriter from 'hanzi-writer';

interface Props { item:Character; independent:boolean; stroke:number; mistakes:number; done:boolean; onProgress:(stroke:number,mistakes:number)=>void; onHelp:()=>void; onComplete:(mistakes:number)=>void; onMode:(independent:boolean)=>void; }
export default function WritingPad(props:Props) {
  const host=useRef<HTMLElement>(null), writer=useRef<HanziWriter|null>(null), latest=useRef(props);
  useLayoutEffect(()=>{latest.current=props;});
  const [ready,setReady]=useState(false),[error,setError]=useState(''),[feedback,setFeedback]=useState(''),[reset,setReset]=useState(0),[animating,setAnimating]=useState(false);
  useEffect(()=>{
    let disposed=false, observer:ResizeObserver|undefined, cleanup=()=>{};
    const hostNode=host.current;
    queueMicrotask(()=>{if(!disposed){setReady(false);setError('');setFeedback('');}});
    const start=latest.current.stroke, priorMistakes=latest.current.mistakes;
    import('hanzi-writer').then(({default:HW})=>{
      if(disposed||!host.current)return;
      host.current.innerHTML='';
      const width=Math.max(200,Math.floor(host.current.clientWidth));
      const w=HW.create(host.current,props.item.hanzi,{width,height:width,padding:24,showCharacter:false,showOutline:!props.independent,strokeColor:'#28624e',outlineColor:'#e3e8dc',highlightColor:'#dcad50',drawingColor:'#225f4d',drawingWidth:16,strokeAnimationSpeed:0.7,delayBetweenStrokes:260,charDataLoader:(char,onLoad,onError)=>{
        void fetch(`/characters/${encodeURIComponent(char)}.json`).then(async r=>{if(!r.ok)throw new Error('Stroke data unavailable');const data=await r.json() as Parameters<typeof onLoad>[0];if(disposed)return;onLoad(data);setReady(true);}).catch(e=>{if(!disposed){setError('笔画还没加载好，请点重试。');onError(e);}});
      }});
      writer.current=w;
      let activeTouch:number|null=null;
      function interrupt(){activeTouch=null;if(disposed||latest.current.done)return;w.cancelQuiz();setFeedback('继续刚才那一笔。');setReset(n=>n+1);}
      function touchStart(e:TouchEvent){if(e.touches.length!==1||activeTouch!==null){e.preventDefault();e.stopImmediatePropagation();return;}activeTouch=e.changedTouches[0].identifier;}
      function touchMove(e:TouchEvent){if(e.touches.length>1){e.preventDefault();e.stopImmediatePropagation();}}
      function touchEnd(e:TouchEvent){if(activeTouch===null)return;const ended=Array.from(e.changedTouches).some(t=>t.identifier===activeTouch);if(!ended){e.stopImmediatePropagation();return;}activeTouch=null;}
      function visibility(){if(document.visibilityState==='hidden'&&activeTouch!==null)interrupt();}
      const node=host.current;
      node.addEventListener('touchstart',touchStart,{capture:true,passive:false});
      node.addEventListener('touchmove',touchMove,{capture:true,passive:false});
      node.addEventListener('touchcancel',interrupt,{capture:true});
      document.addEventListener('touchend',touchEnd,true);
      document.addEventListener('visibilitychange',visibility);
      cleanup=()=>{node.removeEventListener('touchstart',touchStart,true);node.removeEventListener('touchmove',touchMove,true);node.removeEventListener('touchcancel',interrupt,true);document.removeEventListener('touchend',touchEnd,true);document.removeEventListener('visibilitychange',visibility);};
      if(latest.current.done)void w.showCharacter();
      else void w.quiz({quizStartStrokeNum:start,leniency:1.8,showHintAfterMisses:props.independent?false:2,markStrokeCorrectAfterMisses:false,highlightOnComplete:true,
        onMistake:d=>{if(disposed)return;latest.current.onProgress(d.strokeNum,priorMistakes+d.totalMistakes);setFeedback('慢一点，试试这一笔。');},
        onCorrectStroke:d=>{if(disposed)return;latest.current.onProgress(d.strokeNum+1,priorMistakes+d.totalMistakes);setFeedback(d.strokesRemaining?'这一笔写好了！':'这个字写好了！');},
        onComplete:d=>{if(disposed)return;latest.current.onComplete(priorMistakes+d.totalMistakes);setFeedback('这个字写好了！');},
      });
      observer=new ResizeObserver(()=>{if(host.current&&!disposed){if(activeTouch!==null){interrupt();return;}const s=Math.max(200,Math.floor(host.current.clientWidth));w.updateDimensions({width:s,height:s,padding:24});}});
      observer.observe(host.current);
    }).catch(()=>setError('写字板暂时没打开，请重试。'));
    return()=>{disposed=true;cleanup();observer?.disconnect();writer.current?.cancelQuiz();writer.current=null;if(hostNode)hostNode.innerHTML='';};
  },[props.item.id,props.item.hanzi,props.independent,reset]);
  async function demonstrate(){if(!writer.current||animating)return;latest.current.onHelp();setAnimating(true);writer.current.cancelQuiz();try{await writer.current.animateCharacter();}finally{setAnimating(false);setReset(n=>n+1);}}
  return <div className="writing-section">
    <div className="mode-switch" aria-label="写字方式"><Button variant={!props.independent?'secondary':'ghost'} onClick={()=>props.onMode(false)} disabled={props.done||animating}><Eye/> 跟着写</Button><Button variant={props.independent?'secondary':'ghost'} onClick={()=>props.onMode(true)} disabled={props.done||animating}><EyeOff/> 盖住再写</Button></div>
    <div className={`writing-frame ${props.done?'writing-finished':''}`}><div className="pad-grid" aria-hidden="true"/><figure className="writing-host" ref={host} aria-label={`${props.item.hanzi}字的手指写字板`}/>{!ready&&!error&&<span className="pad-loading">正在准备写字板…</span>}</div>
    <p className={`writing-feedback ${props.done?'success-text':''}`} aria-live="polite">{error||(props.done?<><Check/> 这个字写好了！</>:feedback||'用手指写第一笔。')}</p>
    <div className="pad-actions"><Button variant="outline" disabled={!ready||animating||props.done} onClick={demonstrate}><Play/> {animating?'看一看…':'看笔顺'}</Button><Button variant="outline" disabled={animating||props.done} onClick={()=>{props.onHelp();props.onProgress(0,props.mistakes);setReset(n=>n+1);}}><RotateCcw/> {error?'重试':'重写'}</Button></div>
  </div>;
}
