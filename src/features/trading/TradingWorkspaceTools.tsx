import {useState} from 'react';

export function SidebarArrow({open,onToggle,panelId}:{open:boolean;onToggle:()=>void;panelId:string}){
  const label=open?'Collapse sidebar':'Expand sidebar';
  return <button type="button" className="workspace-sidebar-arrow" aria-label={label} title={label} aria-expanded={open} aria-controls={panelId} onClick={onToggle}><svg viewBox="0 0 20 20" aria-hidden="true"><path d={open?'M7 5l5 5-5 5':'M13 5l-5 5 5 5'} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg></button>;
}

export default function TradingWorkspaceTools({open,onToggle,panelId,mode,showSidebarToggle=true}:{showSidebarToggle?:boolean;open:boolean;onToggle:()=>void;panelId:string;mode:'paper'|'live'}){
  return <div className="workspace-tools">
    <span className={`workspace-account-mode is-${mode}`}><i aria-hidden="true"/>{mode==='paper'?'Paper account':'Live account'}</span>
    {mode==='live'&&showSidebarToggle&&<SidebarArrow open={open} onToggle={onToggle} panelId={panelId}/>}
  </div>;
}

export type WorkspacePanels={book:boolean;order:boolean};
function readPanels(key:string):WorkspacePanels{
  try{const saved=JSON.parse(localStorage.getItem(key)??'{}');return {book:saved.book!==false,order:saved.order!==false};}
  catch{return {book:true,order:true};}
}
/** Remembered show/hide state for the order book and the action panel (per page). */
export function useWorkspacePanels(storageKey:string){
  const [panels,setPanels]=useState(()=>readPanels(storageKey));
  function toggle(key:keyof WorkspacePanels){
    setPanels(old=>{const next={...old,[key]:!old[key]};try{localStorage.setItem(storageKey,JSON.stringify(next));}catch{/* Session only. */}return next;});
  }
  return [panels,toggle] as const;
}

/** Chart-toolbar toggles that show or hide the order book and the action panel. */
export function PanelToggles({panels,onToggle,bookId,actionId}:{panels:WorkspacePanels;onToggle:(key:keyof WorkspacePanels)=>void;bookId:string;actionId:string}){
  return <div className="live-panel-toggles" role="group" aria-label="Show or hide panels">
    <button type="button" className="tv-icon live-panel-toggle" aria-pressed={panels.book} aria-controls={bookId} title={panels.book?'Hide order book':'Show order book'} aria-label="Order book" onClick={()=>onToggle('book')}>
      <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M7 8h14M11 12h10M9 16h12M13 20h8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
    </button>
    <button type="button" className="tv-icon live-panel-toggle" aria-pressed={panels.order} aria-controls={actionId} title={panels.order?'Hide action panel':'Show action panel'} aria-label="Action panel" onClick={()=>onToggle('order')}>
      <svg viewBox="0 0 28 28" aria-hidden="true"><rect x="5" y="6.5" width="18" height="15" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M16.5 6.5v15" stroke="currentColor" strokeWidth="1.5"/></svg>
    </button>
  </div>;
}
