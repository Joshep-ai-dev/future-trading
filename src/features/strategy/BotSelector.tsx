import SetupPicker,{type SavedSetup} from './SetupPicker';

const BOTS:readonly (readonly [BotKey,string,string])[]=[['adx_supertrend','ADX + Supertrend','Trend following · backtest & paper'],['st_scalper','SuperTrend Scalper','5m scalping · filters · research lab']];
export type BotKey='none'|'adx_supertrend'|'st_scalper'|'bb_outer_reversal'|'ml_directional';

/** Choose the bot model, then one of its saved parameter setups. Used on the Backtest and Trading pages. */
export default function BotSelector({strategy,onStrategyChange,profiles,onApplySetup,disabled=false,setupLabel='Saved parameters',actionLabel}:{
  strategy:string;onStrategyChange:(strategy:BotKey)=>void;profiles:SavedSetup[];onApplySetup:(setup:SavedSetup)=>void;
  disabled?:boolean;setupLabel?:string;actionLabel?:string;
}){
  // Saved setups only appear once the user has some for this strategy.
  const hasSetups=profiles.some(profile=>profile.settings.strategy===strategy);
  return <div className="bot-selector">
    <div className="bot-picker" role="radiogroup" aria-label="Bot model">{BOTS.map(([key,label,kind])=><button key={key} type="button" role="radio" disabled={disabled} aria-checked={strategy===key} onClick={()=>onStrategyChange(key)}>
      <span className="bot-picker-icon" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none"><path d="M2 14l4-5 3 3 4-6 5 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg></span>
      <span className="bot-picker-copy"><strong>{label}</strong><small>{kind}</small></span>
      {strategy===key&&<span className="bot-picker-check" aria-hidden="true">✓</span>}
    </button>)}</div>
    {hasSetups&&<SetupPicker key={strategy} profiles={profiles} onApply={onApplySetup} strategy={strategy} disabled={disabled} label={setupLabel} actionLabel={actionLabel}/>}
  </div>;
}
