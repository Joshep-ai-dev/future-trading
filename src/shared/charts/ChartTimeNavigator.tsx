import {lazy,Suspense,useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import type {ChartTimeZone} from './chartTimeZone';

const MaterialDatePicker=lazy(()=>import('./MaterialDatePicker'));
const MaterialWeekdayPicker=lazy(()=>import('./MaterialDatePicker').then(module=>({default:module.MaterialWeekdayPicker})));
const MaterialTimePicker=lazy(()=>import('./MaterialDatePicker').then(module=>({default:module.MaterialTimePicker})));

type NavigationIconName='previous'|'next'|'close'|'clear'|'locate'|'week';
function NavigationIcon({name}:{name:NavigationIconName}){
  const paths:Record<NavigationIconName,string>={previous:'M14 6l-6 6 6 6',next:'M10 6l6 6-6 6',close:'M6 6l12 12M18 6L6 18',clear:'M3 7h18M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5',locate:'M12 2v4m0 12v4M2 12h4m12 0h4',week:'M5 5h14v15H5zM8 3v4m8-4v4M5 10h14M8 13h2m4 0h2m-8 4h2'};
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/>{name==='locate'&&<circle cx="12" cy="12" r="6"/>}</svg>;
}

function parts(epoch:number,timeZone:ChartTimeZone){
  const values=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(epoch*1000));
  const get=(key:Intl.DateTimeFormatPartTypes)=>values.find(value=>value.type===key)?.value??'';
  return {date:`${get('year')}-${get('month')}-${get('day')}`,time:`${get('hour')}:${get('minute')}`};
}
export default function ChartTimeNavigator({timeZone,getLatest,onSelect,onCancel,busy}:{timeZone:ChartTimeZone;getLatest:()=>number;onSelect:(selection:{time:number;label:string;key:number})=>void;onCancel:()=>void;busy:boolean}){
  const [open,setOpen]=useState(false);
  const fieldsId=useId();
  const trigger=useRef<HTMLButtonElement>(null),popover=useRef<HTMLDivElement>(null);
  const close=()=>{setOpen(false);requestAnimationFrame(()=>trigger.current?.focus());};
  useEffect(()=>{
    if(!open)return;
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();close();}};
    document.addEventListener('keydown',escape);
    return()=>document.removeEventListener('keydown',escape);
  },[open]);
  useLayoutEffect(()=>{if(open)popover.current?.querySelector<HTMLButtonElement>('[aria-label="Choose chart date"]')?.focus();},[open]);
  const [date,setDate]=useState(()=>parts(getLatest(),timeZone).date);
  const [time,setTime]=useState('09:00');
  const [weekday,setWeekday]=useState('all');
  const [active,setActive]=useState(false);
  const [message,setMessage]=useState('');
  const latest=getLatest(),end=parts(latest,timeZone).date;
  const first=new Date(`${end}T12:00:00Z`);
  first.setUTCFullYear(first.getUTCFullYear()-1);
  const start=first.toISOString().slice(0,10);
  const dates:string[]=[];
  for(let day=first.getTime();day<=Date.parse(`${end}T12:00:00Z`);day+=86400000){
    const value=new Date(day);
    if(weekday==='all'||String(value.getUTCDay())===weekday)dates.push(value.toISOString().slice(0,10));
  }
  const previous=dates.filter(value=>value<date).at(-1),next=dates.find(value=>value>date);
  function show(value:string,selectedTime=time){
    setDate(value);setTime(selectedTime);setMessage('');
    if(value<start||value>end){setMessage('Choose a date within the past year.');return;}
    const wall=Date.parse(`${value}T${selectedTime}:00Z`)/1000;
    let target=wall;
    for(let attempt=0;attempt<4;attempt++){
      const local=parts(target,timeZone);
      target+=wall-Date.parse(`${local.date}T${local.time}:00Z`)/1000;
    }
    const local=parts(target,timeZone);
    if(local.date!==value||local.time!==selectedTime){setMessage('This local time is unavailable.');return;}
    if(target>latest){setMessage('No market data yet for this time.');return;}
    const label=new Intl.DateTimeFormat('en-US',{timeZone,weekday:'short',month:'short',day:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(target*1000));
    onSelect({time:target,label,key:Date.now()});setActive(true);
  }
  function cancel(){onCancel();setActive(false);setMessage('');}
  return <>
    {!open&&<button ref={trigger} type="button" className="tv-icon chart-date-trigger" title="Browse dates" aria-label="Browse dates" aria-expanded={false} onClick={()=>setOpen(true)}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="16" rx="2" fill="none" stroke="currentColor"/><path d="M8 3v4m8-4v4M4 10h16m-11 4h2m2 0h2m-6 3h2" fill="none" stroke="currentColor"/></svg></button>}
    {open&&<div ref={popover} id={fieldsId} className="chart-date-inline chart-date-header-fields" role="group" aria-label="Browse dates">
      <form onSubmit={event=>{event.preventDefault();show(date);}}>
        <div className="chart-date-row"><button type="button" aria-label="Previous date" title="Previous date" disabled={busy||!previous} onClick={()=>previous&&show(previous)}><NavigationIcon name="previous"/></button><Suspense fallback={<button type="button" className="material-date-trigger" aria-label="Choose chart date" disabled>{date}</button>}><MaterialDatePicker value={date} minimum={start} maximum={end} disabled={busy} onChange={value=>show(value)}/></Suspense><button type="button" aria-label="Next date" title="Next date" disabled={busy||!next} onClick={()=>next&&show(next)}><NavigationIcon name="next"/></button></div>
        <div className="chart-date-row"><Suspense fallback={<button type="button" className="material-date-trigger is-time" aria-label="Choose chart time" disabled>{time}</button>}><MaterialTimePicker value={time} disabled={busy} onChange={value=>show(date,value)}/></Suspense><Suspense fallback={<button type="button" className="material-date-trigger is-weekday" aria-label="Choose weekday" disabled>Every day</button>}><MaterialWeekdayPicker value={weekday} disabled={busy} onChange={selected=>{setMessage('');setWeekday(selected);if(selected!=='all'){const day=new Date(`${date}T12:00:00Z`);day.setUTCDate(day.getUTCDate()-(day.getUTCDay()-Number(selected)+7)%7);const value=day.toISOString().slice(0,10);if(value>=start)setDate(value);}}}/></Suspense></div>

        <footer><button type="submit" className="chart-date-go" title="Center selected time" aria-label="Center selected time" disabled={busy}><NavigationIcon name="locate"/></button>{active&&<button type="button" aria-label="Cancel compare" title="Cancel compare" onClick={cancel}><NavigationIcon name="clear"/></button>}<button type="button" aria-label="Close date fields" title="Close date fields" onClick={close}><NavigationIcon name="close"/></button></footer>
      </form>
      {message&&<p className="chart-date-error" role="alert">{message}</p>}
    </div>}
  </>;
}
