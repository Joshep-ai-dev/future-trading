import {useEffect,useRef,useState} from 'react';
import type {Analysis} from '../../shared/types/types';
export type Candle=Analysis['candles'][number];

export function minuteAt(row:Candle,seconds:number):Candle {
  const path=Math.abs(row.high-row.open)<Math.abs(row.open-row.low)?[row.open,row.high,row.low,row.close]:[row.open,row.low,row.high,row.close];
  const elapsed=Math.min(60,Math.max(0,seconds)),segment=Math.min(2,Math.floor(elapsed/20));
  const close=path[segment]+(path[segment+1]-path[segment])*(elapsed-segment*20)/20;
  const visited=[...path.slice(0,segment+1),close];
  return {time:row.time,open:row.open,high:Math.max(...visited),low:Math.min(...visited),close,volume:row.volume===undefined?undefined:row.volume*elapsed/60};
}

export function candleAt(minutes:Candle[],clock:number,duration:number):Candle|null {
  const bucket=Math.floor(clock/duration)*duration;
  const rows=minutes.filter(row=>row.time>=bucket&&row.time<=clock&&row.time<bucket+duration);
  if(!rows.length||rows.some((row,i)=>row.time!==bucket+i*60)||rows.at(-1)!.time+60<clock)return null;
  const visited=rows.map(row=>row.time+60>clock?minuteAt(row,clock-row.time):row);
  return {time:bucket,open:visited[0].open,high:Math.max(...visited.map(r=>r.high)),low:Math.min(...visited.map(r=>r.low)),close:visited.at(-1)!.close,volume:visited.some(row=>row.volume!==undefined)?visited.reduce((sum,row)=>sum+(row.volume??0),0):undefined};
}

export function useReplayAnimation(enabled:boolean,sessionId:number,target:number){
  const current=useRef(target),lastSession=useRef(sessionId);
  const [clock,setClock]=useState(target);
  useEffect(()=>{
    if(lastSession.current!==sessionId||!enabled||target<current.current){lastSession.current=sessionId;current.current=target;setClock(target);return;}
    const from=current.current;
    if(from===target)return;
    const started=performance.now();let frame=0;
    const tick=(now:number)=>{
      const fraction=Math.min(1,(now-started)/900);
      current.current=from+(target-from)*fraction;setClock(current.current);
      if(fraction<1)frame=requestAnimationFrame(tick);
    };
    frame=requestAnimationFrame(tick);
    return ()=>cancelAnimationFrame(frame);
  },[enabled,sessionId,target]);
  return enabled?clock:target;
}
