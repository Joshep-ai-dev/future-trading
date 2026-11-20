import type {ReactNode} from 'react';
import {TabBar} from '../../shared/ui/ui';
import type {ExecutionMode} from './ExecutionModeContext';

const MODES=[{value:'manual',label:'Manual'},{value:'bot',label:'Bots'}] as const;

/**
 * Manual / Bots execution section shared by paper and live trading.
 * Callers supply the order ticket and bot controls; this owns the tabs and tab panels.
 */
export default function ExecutionPanel({prefix,className='',mode,onModeChange,status,manual,bot,footer}:{
  /** Unique id prefix for the tabs and panels, e.g. "paper-execution". */
  prefix:string;
  className?:string;
  mode:ExecutionMode;
  onModeChange:(mode:ExecutionMode)=>void;
  /** Row under the tabs, e.g. exchange connection state. */
  status?:ReactNode;
  manual:ReactNode;
  bot:ReactNode;
  /** Messages shown under either tab. */
  footer?:ReactNode;
}){
  return <section className={`live-method-section ${className}`.trim()}>
    <div className="execution-tabs-row">
      <TabBar className="live-execution-mode-tabs" label="Execution mode" idPrefix={`${prefix}-tab`} value={mode} onChange={onModeChange}
        items={MODES.map(item=>({...item,controls:`${prefix}-${item.value}-panel`}))}/>
    </div>
    {status}
    <div id={`${prefix}-${mode}-panel`} role="tabpanel" aria-labelledby={`${prefix}-tab-${mode}`}>{mode==='manual'?manual:bot}</div>
    {footer}
  </section>;
}
