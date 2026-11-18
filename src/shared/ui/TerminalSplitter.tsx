import {useEffect,useRef} from 'react';

const storageKey='silver.terminal.chart';
const minimumChart=280,maximumChart=1600,step=40;

function apply(main:HTMLElement,height:number){
  const value=Math.round(Math.min(maximumChart,Math.max(minimumChart,height)));
  main.style.setProperty('--terminal-chart',`${value}px`);
  return value;
}
function save(value:number){try{localStorage.setItem(storageKey,String(value));}catch{/* Height stays for this session. */}}

/** Drag handle under the terminal chart; sets the chart pane height. */
export default function TerminalSplitter(){
  const ref=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const main=ref.current?.parentElement;
    if(!main)return;
    let saved=NaN;
    try{saved=Number(localStorage.getItem(storageKey));}catch{/* Use the stylesheet default. */}
    if(Number.isFinite(saved)&&saved>0)apply(main,saved);
  },[]);
  // The chart is the price panel, not simply the first child (the market header may precede it).
  const chartOf=(main:HTMLElement)=>main.querySelector<HTMLElement>(':scope > .price-panel')??main.firstElementChild as HTMLElement|null;
  const chartHeight=(main:HTMLElement)=>chartOf(main)?.getBoundingClientRect().height??640;
  function start(event:React.PointerEvent<HTMLDivElement>){
    const main=ref.current?.parentElement;
    if(!main||!chartOf(main)||event.button!==0)return;
    event.preventDefault();
    const handle=event.currentTarget;handle.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing-terminal');
    // Resize by the drag distance from the press point, so pressing alone never changes the height.
    const startY=event.clientY,startHeight=chartHeight(main);
    let frame=0,latestY=startY;
    const move=(e:PointerEvent)=>{
      latestY=e.clientY;
      if(frame)return;
      frame=requestAnimationFrame(()=>{frame=0;apply(main,startHeight+latestY-startY);});
    };
    const end=()=>{
      handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);
      if(frame){cancelAnimationFrame(frame);frame=0;}
      if(latestY!==startY){apply(main,startHeight+latestY-startY);save(chartHeight(main));}
      document.body.classList.remove('is-resizing-terminal');
    };
    handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);
  }
  function key(event:React.KeyboardEvent<HTMLDivElement>){
    const main=ref.current?.parentElement;
    if(!main||(event.key!=='ArrowUp'&&event.key!=='ArrowDown'))return;
    event.preventDefault();
    save(apply(main,chartHeight(main)+(event.key==='ArrowDown'?step:-step)));
  }
  function reset(){
    const main=ref.current?.parentElement;
    if(!main)return;
    main.style.removeProperty('--terminal-chart');
    try{localStorage.removeItem(storageKey);}catch{/* Nothing stored. */}
  }
  return <div ref={ref} className="terminal-splitter" role="separator" aria-orientation="horizontal" aria-label="Resize chart height" title="Drag to resize the chart · double-click to reset" tabIndex={0} onPointerDown={start} onKeyDown={key} onDoubleClick={reset}><i aria-hidden="true"/></div>;
}
