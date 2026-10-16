import {useEffect,useId,useRef,type ButtonHTMLAttributes,type HTMLAttributes,type ReactNode} from 'react';

type Tone='neutral'|'positive'|'negative'|'warning'|'accent';
export function Button({variant='primary',className='',type='button',...props}:ButtonHTMLAttributes<HTMLButtonElement>&{variant?:'primary'|'secondary'|'ghost'|'danger'}){
  return <button type={type} className={`ui-button ui-button--${variant} ${className}`} {...props}/>;
}

export function PageHeader({eyebrow,title,description,actions,id}:{eyebrow?:string;title:string;description?:string;actions?:ReactNode;id?:string}){
  return <header className="ui-page-header"><div>{eyebrow&&<span className="ui-eyebrow">{eyebrow}</span>}<h1 id={id}>{title}</h1>{description&&<p>{description}</p>}</div>{actions&&<div className="ui-page-actions">{actions}</div>}</header>;
}

export function Panel({title,description,actions,children,className='',...props}:HTMLAttributes<HTMLElement>&{title?:string;description?:string;actions?:ReactNode}){
  const headingId=useId();
  return <section className={`ui-panel ${className}`} aria-labelledby={title?headingId:undefined} {...props}>
    {title&&<div className="ui-panel-heading"><div><h2 id={headingId}>{title}</h2>{description&&<p>{description}</p>}</div>{actions}</div>}{children}
  </section>;
}

export function Metric({label,value,detail,unit,tone='neutral'}:{label:string;value:ReactNode;detail?:ReactNode;unit?:string;tone?:Tone}){
  return <div className={`ui-metric ui-tone--${tone}`}><span>{label}</span><strong>{value}{unit&&<small>{unit}</small>}</strong>{detail&&<p>{detail}</p>}</div>;
}

export function StatusBadge({children,tone='neutral',dot=false}:{children:ReactNode;tone?:Tone;dot?:boolean}){
  return <span className={`ui-status ui-tone--${tone}`}>{dot&&<i aria-hidden="true"/>}{children}</span>;
}

export type SelectOption<Key extends string>={value:Key;label:string;disabled?:boolean};
export function SelectMenu<Key extends string>({value,options,onChange,label,caption,disabled=false}:{value:Key;options:readonly SelectOption<Key>[];onChange:(value:Key)=>void;label:string;caption?:string;disabled?:boolean}){
  const ref=useRef<HTMLDetailsElement>(null),selected=options.find(option=>option.value===value);
  useEffect(()=>{
    const close=(event:PointerEvent)=>{if(ref.current&&!ref.current.contains(event.target as Node))ref.current.open=false;};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&ref.current){ref.current.open=false;ref.current.querySelector('summary')?.focus();}};
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};
  },[]);
  return <details className="ui-select-menu" ref={ref} onToggle={()=>{if(disabled&&ref.current)ref.current.open=false;}}>
    <summary aria-label={label} aria-disabled={disabled}><span className="ui-select-copy">{caption&&<small>{caption}</small>}<b>{selected?.label??value}</b></span><i aria-hidden="true"/></summary>
    <div role="listbox" aria-label={label}>{options.map(option=><button key={option.value} type="button" role="option" aria-selected={option.value===value} disabled={option.disabled} onClick={()=>{onChange(option.value);if(ref.current)ref.current.open=false;}}>{option.label}{option.value===value&&<span aria-hidden="true">✓</span>}</button>)}</div>
  </details>;
}

export type TabItem<Key extends string>={value:Key;label:string;count?:number|null;controls?:string};
export function TabBar<Key extends string>({items,value,onChange,label,idPrefix,className='',trailing}:{items:readonly TabItem<Key>[];value:Key;onChange:(value:Key)=>void;label:string;idPrefix:string;className?:string;trailing?:ReactNode}){
  return <div className={`ui-tabs ${className}`} role="tablist" aria-label={label}>
    {items.map((item,index)=><button key={item.value} type="button" id={`${idPrefix}-${item.value}`} role="tab" aria-selected={item.value===value} aria-controls={item.controls} tabIndex={item.value===value?0:-1} onClick={()=>onChange(item.value)} onKeyDown={event=>{
      let next=index;
      if(event.key==='ArrowRight')next=(index+1)%items.length;
      else if(event.key==='ArrowLeft')next=(index+items.length-1)%items.length;
      else if(event.key==='Home')next=0;
      else if(event.key==='End')next=items.length-1;
      else return;
      event.preventDefault();onChange(items[next].value);document.getElementById(`${idPrefix}-${items[next].value}`)?.focus();
    }}>{item.label}{item.count!=null&&<span>{item.count}</span>}</button>)}{trailing&&<div className="ui-tabs-trailing">{trailing}</div>}
  </div>;
}

export function EmptyState({title,description,action,compact=false}:{title:string;description?:string;action?:ReactNode;compact?:boolean}){
  return <div className={`ui-empty ${compact?'ui-empty--compact':''}`}><svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M7 30V19m9 11V9m9 21V15m9 15V5M4 35h32" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg><h3>{title}</h3>{description&&<p>{description}</p>}{action}</div>;
}

export function TableFrame({columns,children,label}:{columns:readonly string[];children:ReactNode;label:string}){
  return <div className="ui-table-scroll" tabIndex={0} role="region" aria-label={label}><table className="ui-table"><thead><tr>{columns.map((column,index)=><th key={`${column}-${index}`} scope="col">{column}</th>)}</tr></thead><tbody>{children}</tbody></table></div>;
}

export function NumberField({label,value,onValueChange,min,max,step='any'}:{label:string;value:number;onValueChange:(value:number)=>void;min?:number;max?:number;step?:number|'any'}){
  return <label className="ui-field"><span>{label}</span><input type="number" required min={min} max={max} step={step} value={value} onChange={event=>onValueChange(Number(event.target.value))}/></label>;
}
