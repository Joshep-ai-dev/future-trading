import {displaySymbol} from './displaySymbol';
import {useEffect,useId,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {TIMEFRAMES} from './chartTimeframe';

export default function TradingChartHeader({timeframe,onTimeframeChange,mode,caption,actions,symbol='XAGUSDT'}:{timeframe:string;onTimeframeChange?:(timeframe:string)=>void;mode:string;caption:string;actions?:ReactNode;symbol?:string}){
  const menu=useRef<HTMLDivElement>(null),popover=useRef<HTMLDivElement>(null);
  const menuId=useId();
  const [position,setPosition]=useState({left:0,top:0});
  const [menuOpen,setMenuOpen]=useState(false);
  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(menu.current&&!menu.current.contains(event.target as Node)&&!popover.current?.contains(event.target as Node))setMenuOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&menuOpen){setMenuOpen(false);menu.current?.querySelector('button')?.focus();}};
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};
  },[menuOpen]);
  const timeframes=Object.keys(TIMEFRAMES),primary=timeframes.slice(0,3),remaining=timeframes.slice(3);
  useLayoutEffect(()=>{
    if(!menuOpen)return;
    const place=()=>{
      const rect=menu.current?.getBoundingClientRect();if(!rect)return;
      const height=remaining.length*32+12;
      setPosition({left:Math.max(8,Math.min(rect.left,window.innerWidth-132)),top:rect.bottom+8+height>window.innerHeight?Math.max(8,rect.top-height-8):rect.bottom+8});
    };
    place();
    popover.current?.querySelector<HTMLButtonElement>('[aria-checked="true"],button')?.focus();
    window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
    return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
  },[menuOpen]);
  return <div className={`trading-chart-heading tv-header compact-chart-header ${actions?'has-chart-actions':''}`}>
    <div className="chart-title"><strong>{displaySymbol(symbol)}</strong>
      <div className="tv-timeframes" role="group" aria-label="Chart timeframe">{onTimeframeChange?<><div className="tv-timeframe-primary" role="radiogroup" aria-label="Quick timeframes">{primary.map(value=><button key={value} type="button" role="radio" aria-checked={value===timeframe} onClick={()=>onTimeframeChange(value)}>{value}</button>)}</div><div className="tv-timeframe-menu" ref={menu}><button type="button" className="tv-timeframe-trigger" aria-expanded={menuOpen} onClick={()=>setMenuOpen(value=>!value)} aria-label="More timeframes" aria-haspopup="menu" aria-controls={menuOpen?menuId:undefined} onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setMenuOpen(true);}}} data-active={remaining.includes(timeframe)}>{remaining.includes(timeframe)?timeframe:'More'}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg></button></div></>:<button type="button" role="radio" aria-checked disabled>{timeframe}</button>}</div>
      <span className="sr-only">{mode}</span>
    </div>
    <div className="trading-chart-heading-meta">{actions}{caption&&<span className="chart-caption">{caption}</span>}</div>
    {menuOpen&&createPortal(<div ref={popover} id={menuId} className="chart-timeframe-popover" role="menu" aria-label="Additional timeframes" style={{left:position.left,top:position.top}} onKeyDown={event=>{
      const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
      const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();buttons[(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
      if(event.key==='Home'||event.key==='End'){event.preventDefault();buttons[event.key==='Home'?0:buttons.length-1]?.focus();}
      if(event.key==='Tab')setMenuOpen(false);
    }}>{remaining.map(value=><button key={value} type="button" role="menuitemradio" aria-checked={value===timeframe} onClick={()=>{onTimeframeChange?.(value);setMenuOpen(false);menu.current?.querySelector('button')?.focus();}}><span>{value}</span>{value===timeframe&&<span aria-hidden="true">&#10003;</span>}</button>)}</div>,document.body)}
  </div>;
}
