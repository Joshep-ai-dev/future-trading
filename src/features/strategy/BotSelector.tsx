import SetupPicker,{type SavedSetup} from './SetupPicker';

const BOTS=[['bb_outer_reversal','BB Reversal','Rules'],['ml_ensemble','ML Ensemble','Learned']] as const;
export type BotKey=typeof BOTS[number][0];

/** Choose the bot model, then one of its saved parameter setups. Used on the Backtest and Trading pages. */
export default function BotSelector({strategy,onStrategyChange,profiles,onApplySetup,disabled=false,setupLabel='Saved parameters',actionLabel}:{
  strategy:string;onStrategyChange:(strategy:BotKey)=>void;profiles:SavedSetup[];onApplySetup:(setup:SavedSetup)=>void;
  disabled?:boolean;setupLabel?:string;actionLabel?:string;
}){
  return <div className="bot-selector">
    <div className="bot-picker" role="radiogroup" aria-label="Bot model">{BOTS.map(([key,label,kind])=><button key={key} type="button" role="radio" disabled={disabled} aria-checked={strategy===key} onClick={()=>onStrategyChange(key)}><strong>{label}</strong><small>{kind}</small></button>)}</div>
    <SetupPicker key={strategy} profiles={profiles} onApply={onApplySetup} strategy={strategy} disabled={disabled} label={setupLabel} actionLabel={actionLabel}/>
  </div>;
}
