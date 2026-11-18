import {useEffect,useRef,useState,type ReactNode} from 'react';
import {TIMEFRAMES} from './chartTimeframe';

export default function TradingChartHeader({timeframe,onTimeframeChange,mode,caption,actions,symbol='XAGUSDT'}:{timeframe:string;onTimeframeChange?:(timeframe:string)=>void;mode:string;caption:string;actions?:ReactNode;symbol?:string}){
  const menu=useRef<HTMLDivElement>(null);
  const [menuOpen,setMenuOpen]=useState(false);
  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(menu.current&&!menu.current.contains(event.target as Node))setMenuOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&menuOpen){setMenuOpen(false);menu.current?.querySelector('button')?.focus();}};
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};
  },[menuOpen]);
  const timeframes=Object.keys(TIMEFRAMES),primary=timeframes.slice(0,3),remaining=timeframes.slice(3);
  return <div className="panel-heading trading-chart-heading tv-header">
    <div className="chart-title"><strong>{symbol}</strong>
      <div className="tv-timeframes" role="group" aria-label="Chart timeframe">{onTimeframeChange?<><div className="tv-timeframe-primary" role="radiogroup" aria-label="Quick timeframes">{primary.map(value=><button key={value} type="button" role="radio" aria-checked={value===timeframe} onClick={()=>onTimeframeChange(value)}>{value}</button>)}</div><div className="tv-timeframe-menu" ref={menu}><button type="button" className="tv-timeframe-trigger" aria-expanded={menuOpen} onClick={()=>setMenuOpen(value=>!value)} aria-label="More timeframes" data-active={remaining.includes(timeframe)}>{remaining.includes(timeframe)?timeframe:'More'}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg></button>{menuOpen&&<div className="tv-timeframe-options" role="group" aria-label="Additional timeframes">{remaining.map(value=><button key={value} type="button" aria-pressed={value===timeframe} onClick={()=>{onTimeframeChange(value);setMenuOpen(false);menu.current?.querySelector('button')?.focus();}}><span>{value}</span>{value===timeframe&&<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.5"/></svg>}</button>)}</div>}</div></>:<button type="button" role="radio" aria-checked disabled>{timeframe}</button>}</div>
      <span className="chart-mode">{mode}</span>
    </div>
    <div className="trading-chart-heading-meta">{actions}{caption&&<span className="chart-caption">{caption}</span>}</div>
  </div>;
}
