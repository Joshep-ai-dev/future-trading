import {useEffect,useRef,useState,type MouseEvent} from 'react';
import {createPortal} from 'react-dom';
import {defaultIndicators,type IndicatorConfig,type SettingsKind} from './indicatorConfig';
import {hasKey,INDICATOR_SCHEMAS,isValidConfig,schemaKeys,validateSettings,type SettingsField} from './indicatorSchema';
import SettingsFieldControl,{type FieldChange} from './SettingsFieldControl';

type Tab='inputs'|'style';
const TABS:readonly {id:Tab;label:string}[]=[{id:'inputs',label:'Inputs'},{id:'style',label:'Style'}];
const fieldId=(field:SettingsField,index:number)=>hasKey(field)?field.key:`${field.type}-${index}`;

/**
 * TradingView-style settings dialog shared by every indicator. Fields come from
 * `INDICATOR_SCHEMAS[kind]`; valid edits preview live through `onApply`, Cancel reverts.
 */
export default function IndicatorSettings({kind,value,onApply,onClose}:{kind:SettingsKind;value:IndicatorConfig;onApply:(config:IndicatorConfig)=>void;onClose:()=>void}){
  const schema=INDICATOR_SCHEMAS[kind];
  const original=useRef(value);
  const dialog=useRef<HTMLDialogElement>(null);
  const defaultsMenu=useRef<HTMLDetailsElement>(null);
  const [draft,setDraft]=useState(value);
  const [tab,setTab]=useState<Tab>('inputs');
  useEffect(()=>{
    const element=dialog.current,previous=document.activeElement as HTMLElement|null;
    element?.showModal();
    return ()=>{element?.close();previous?.focus();};
  },[]);

  const issues=validateSettings(kind,draft);
  const invalidKeys=new Set(issues.flatMap(issue=>issue.keys));
  const valid=issues.length===0;

  function change(next:IndicatorConfig){setDraft(next);if(isValidConfig(next))onApply(next);}
  const set:FieldChange=(key,fieldValue)=>change({...draft,[key]:fieldValue});
  function cancel(){onApply(original.current);onClose();}
  function resetDefaults(){
    const reset={...draft};
    for(const key of schemaKeys(kind))(reset as Record<string,unknown>)[key]=defaultIndicators[key];
    change(reset);
    if(defaultsMenu.current)defaultsMenu.current.open=false;
  }
  function backdropClick(event:MouseEvent<HTMLDialogElement>){
    if(event.target!==event.currentTarget)return;
    const rect=event.currentTarget.getBoundingClientRect();
    if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)cancel();
  }

  const fields=tab==='inputs'?schema.inputs:schema.style;
  return createPortal(<dialog ref={dialog} className="indicator-modal tv-dialog" aria-labelledby="indicator-dialog-title" onCancel={event=>{event.preventDefault();cancel();}} onClick={backdropClick}>
    <form onSubmit={event=>{event.preventDefault();if(valid)onClose();}}>
      <header className="tv-dialog-header">
        <h3 id="indicator-dialog-title">{schema.title}</h3>
        <button type="button" className="tv-dialog-close" aria-label="Close" onClick={cancel}><svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4.5 4.5l9 9M13.5 4.5l-9 9"/></svg></button>
      </header>
      <div className="tv-dialog-tabs" role="tablist">
        {TABS.map(item=><button type="button" key={item.id} role="tab" aria-selected={tab===item.id} onClick={()=>setTab(item.id)}>{item.label}</button>)}
      </div>
      <div className="tv-dialog-body" role="tabpanel">
        {fields.map((field,index)=><SettingsFieldControl key={fieldId(field,index)} field={field} config={draft} invalid={hasKey(field)&&invalidKeys.has(field.key)} onChange={set}/>)}
      </div>
      {!valid&&<p className="tv-dialog-error" role="alert">{issues[0].message}</p>}
      <footer className="tv-dialog-footer">
        <details className="tv-defaults" ref={defaultsMenu}><summary>Defaults<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M5 7l4 4 4-4"/></svg></summary><div><button type="button" onClick={resetDefaults}>Reset settings</button></div></details>
        <button type="button" className="tv-dialog-cancel" onClick={cancel}>Cancel</button>
        <button type="submit" className="tv-dialog-ok" disabled={!valid}>Ok</button>
      </footer>
    </form>
  </dialog>,document.body);
}
