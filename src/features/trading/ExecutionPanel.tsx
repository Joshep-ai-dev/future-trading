import type {ReactNode} from 'react';
import {Panel,TabBar} from '../../shared/ui/ui';
import type {ExecutionMode} from './ExecutionModeContext';

const MODES=[{value:'manual',label:'Manual'},{value:'bot',label:'Bots'}] as const;

/** Result line under the execution card; `error` switches to the error color. */
export function ExecutionMessage({text,error=false}:{text:string;error?:boolean}){
  return <p className={error?'live-result error':'live-result'} role={error?'alert':'status'}>{text}</p>;
}

/**
 * Manual / Bots execution card shared by paper and live trading, so both render the same markup and styles.
 * Callers supply the account status row, the order ticket and the bot controls.
 */
export default function ExecutionPanel({prefix,mode,onModeChange,status,manual,bot,footer}:{
  /** Unique id prefix for the tabs and panels, e.g. "paper-execution". */
  prefix:string;
  mode:ExecutionMode;
  onModeChange:(mode:ExecutionMode)=>void;
  /** Row under the tabs: exchange connection (live) or virtual-funds badge (paper). */
  status:ReactNode;
  manual:ReactNode;
  bot:ReactNode;
  /** Messages shown under either tab, usually `ExecutionMessage`. */
  footer?:ReactNode;
}){
  return <Panel className="live-terminal-controls">
    <div className="live-method-section">
      <div className="execution-tabs-row">
        <TabBar className="live-execution-mode-tabs" label="Execution mode" idPrefix={`${prefix}-tab`} value={mode} onChange={onModeChange}
          items={MODES.map(item=>({...item,controls:`${prefix}-${item.value}-panel`}))}/>
      </div>
      {status}
      <div id={`${prefix}-${mode}-panel`} role="tabpanel" aria-labelledby={`${prefix}-tab-${mode}`}>{mode==='manual'?manual:bot}</div>
    </div>
    {footer}
  </Panel>;
}
