import {TabBar} from '../../shared/ui/ui';
import type {ExecutionMode} from './ExecutionModeContext';

export default function ExecutionTabs({mode,onChange,prefix='execution'}:{mode:ExecutionMode;onChange:(mode:ExecutionMode)=>void;prefix?:string}){
  return <div className="execution-tabs-row"><TabBar className="live-execution-mode-tabs" items={[{value:'manual',label:'Manual',controls:`${prefix}-manual-panel`},{value:'bot',label:'Bots',controls:`${prefix}-bot-panel`}] as const} value={mode} onChange={onChange} label="Execution mode" idPrefix={`${prefix}-tab`}/></div>;
}
