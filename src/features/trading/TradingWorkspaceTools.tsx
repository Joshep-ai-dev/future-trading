export function SidebarArrow({open,onToggle,panelId}:{open:boolean;onToggle:()=>void;panelId:string}){
  const label=open?'Collapse sidebar':'Expand sidebar';
  return <button type="button" className="workspace-sidebar-arrow" aria-label={label} title={label} aria-expanded={open} aria-controls={panelId} onClick={onToggle}><svg viewBox="0 0 20 20" aria-hidden="true"><path d={open?'M7 5l5 5-5 5':'M13 5l-5 5 5 5'} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg></button>;
}

export default function TradingWorkspaceTools({open,onToggle,panelId,mode}:{open:boolean;onToggle:()=>void;panelId:string;mode:'paper'|'live'}){
  return <div className="workspace-tools">
    <span className={`workspace-account-mode is-${mode}`}><i aria-hidden="true"/>{mode==='paper'?'Paper account':'Live account'}</span>
    {mode==='live'&&<SidebarArrow open={open} onToggle={onToggle} panelId={panelId}/>}
  </div>;
}
