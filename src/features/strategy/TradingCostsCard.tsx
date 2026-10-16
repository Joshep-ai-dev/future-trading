import {useState} from 'react';
import {api} from '../../shared/api/api';
import {fmt,type BacktestSettings} from '../../shared/types/types';
import {htxCostDefaults} from './executionCostDefaults';
import {Field,SettingsCard} from './BBReversalSettings';

/** Fee, slippage, spread and funding assumptions shared by every strategy. */
export default function TradingCostsCard({settings,onChange,step}:{settings:BacktestSettings;onChange:(s:BacktestSettings)=>void;step:number}){
  const [costBusy,setCostBusy]=useState(false),[costMessage,setCostMessage]=useState('');
  async function applyHtx(){
    setCostBusy(true);setCostMessage('');
    try{
      const data=await api<{fee_bps:number;funding_bps:number;spread:number;actualFundingPct:number;intervalHours:number;feeNote:string}>('/api/costs/htx');
      onChange({...settings,fee_bps:data.fee_bps,funding_bps:data.funding_bps,spread:data.spread});
      setCostMessage(`HTX snapshot applied: funding ${data.actualFundingPct.toFixed(6)}% / ${data.intervalHours}h, converted to an 8h equivalent. ${data.feeNote} Slippage kept. Current funding is not historical funding.`);
    }catch(error){setCostMessage(String(error));}finally{setCostBusy(false);}
  }  return <>
    <SettingsCard step={step} id="settings-costs" title="Trading costs" description={`Fee ${settings.fee_bps} bps · slippage ${fmt(settings.slippage,3)} · spread ${fmt(settings.spread,3)} · funding ${settings.funding_bps} bps / 8h`}>
      <details className="setup-more"><summary>Edit cost assumptions</summary>
        <div className="setup-inline-actions"><button type="button" className="secondary" onClick={()=>{onChange({...settings,...htxCostDefaults});setCostMessage('HTX defaults applied: fee 0.06% per side, slippage 0.01, spread 0.02, funding +0.01% per 8h.');}}>Use HTX defaults</button><button type="button" className="secondary" disabled={costBusy} onClick={()=>void applyHtx()}>{costBusy?'Fetching HTX…':'Fetch live HTX funding & spread'}</button></div>
        {costMessage&&<p className="setup-note" role="status">{costMessage}</p>}
        <div className="setup-grid">{([['fee_bps','Fee per side','bps',0,100],['slippage','Slippage per fill','USDT',0,10],['spread','Bid/ask spread','USDT',0,10],['funding_bps','Funding per 8h','bps',-100,100]] as const).map(([key,label,unit,min,max])=><Field key={key} label={label} unit={unit}><input type="number" required min={min} max={max} step="any" value={settings[key]} onChange={event=>onChange({...settings,[key]:Number(event.target.value)})}/></Field>)}</div>
        <p className="setup-note">1 bp = 0.01%. Slippage plus half the spread worsens each fill. Positive funding: longs pay, shorts receive. Funding is prorated at entry notional.</p>
      </details>
    </SettingsCard>
  </>;
}
