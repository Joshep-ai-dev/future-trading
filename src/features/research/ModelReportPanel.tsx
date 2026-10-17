import {fmt,type ModelReport} from '../../shared/types/types';

const day=(t:number)=>new Date(t*1000).toISOString().slice(0,10);
const pct=(value:number|null|undefined,digits=1)=>value==null?'—':`${fmt(value*100,digits)}%`;
const label=(name:string)=>name.replaceAll('_',' ');

/** Walk-forward diagnostics for ML strategies: accuracy, outcomes, costs and feature importance. */
export default function ModelReportPanel({report}:{report:ModelReport}){
  const importance=Object.entries(report.importance).slice(0,15),top=importance[0]?.[1]||1;
  const baseline=1/3,edge=report.accuracy==null?null:report.accuracy-baseline;
  const costShare=report.medianTarget&&report.medianRoundTripCost?report.medianRoundTripCost/report.medianTarget:null;
  return <div className="model-report">
    <div className="model-kpis">
      <div><span>Out-of-sample accuracy</span><strong className={edge!=null&&edge>0?'positive':'negative'}>{pct(report.accuracy)}</strong><small>Random guessing ≈ 33.3%{edge!=null&&` · ${edge>=0?'+':''}${fmt(edge*100,1)} pts`}</small></div>
      <div><span>Test blocks</span><strong>{report.folds.length}</strong><small>{report.trainedBars.toLocaleString()} unseen candles · {report.featureCount} features</small></div>
      <div><span>Cost vs target</span><strong className={costShare!=null&&costShare>.33?'negative':''}>{costShare==null?'—':`${fmt(costShare*100,0)}%`}</strong><small>Round trip {fmt(report.medianRoundTripCost,3)} vs target {fmt(report.medianTarget,3)} USDT</small></div>
      <div><span>Signals skipped for cost</span><strong>{report.blockedByCost.toLocaleString()}</strong><small>Target below the reward ÷ cost ratio</small></div>
    </div>
    {report.regimes&&<section className="regime-report"><h3>Results by market regime</h3><p className="model-note">Learned market states in the tested period. Off = excluded by your regime filter.</p>
      <table><thead><tr><th>Regime</th><th>Time in regime</th><th>Trades</th><th>Win rate</th><th>Net P&amp;L</th><th>Traded</th></tr></thead><tbody>
        {report.regimes.map(regime=><tr key={regime.name}><td><span className={`regime-dot is-${regime.name.replace(' ','-').toLowerCase()}`}/>{regime.name}</td><td><i className="regime-share"><b style={{width:`${regime.share*100}%`}}/></i>{pct(regime.share,0)}</td><td>{regime.trades}</td><td>{regime.winRate==null?'—':`${fmt(regime.winRate,1)}%`}</td><td className={regime.netPnl>=0?'positive':'negative'}>{regime.netPnl>=0?'+':'-'}${fmt(Math.abs(regime.netPnl))}</td><td>{regime.allowed?'On':'Off'}</td></tr>)}
      </tbody></table>
      {report.exitMode==='learned'&&report.learnedExits&&<div className="learned-exits"><span>Median learned exits (× ATR)</span>{([['Long target','long_tp'],['Long stop','long_sl'],['Short target','short_tp'],['Short stop','short_sl']] as const).map(([label,key])=><div key={key}><small>{label}</small><b>{report.learnedExits?.[key]==null?'—':fmt(report.learnedExits[key],2)}</b></div>)}<div><small>Skipped by reward/risk</small><b>{(report.blockedByRewardRisk??0).toLocaleString()}</b></div><div><small>Skipped by regime</small><b>{(report.blockedByRegime??0).toLocaleString()}</b></div></div>}
    </section>}
    <div className="model-report-grid">
      <section><h3>What the market did</h3><p className="model-note">Share of candles where a long win, a short win or neither happened within the horizon.</p>
        <div className="outcome-bar" aria-label="Outcome balance">{(['long','none','short'] as const).map(key=><i key={key} className={`is-${key}`} style={{width:`${report.labelBalance[key]*100}%`}} title={`${key}: ${pct(report.labelBalance[key])}`}/>)}</div>
        <div className="outcome-legend"><span><i className="is-long"/>Long win {pct(report.labelBalance.long)}</span><span><i className="is-none"/>Neither {pct(report.labelBalance.none)}</span><span><i className="is-short"/>Short win {pct(report.labelBalance.short)}</span></div>
        <h3>Accuracy by test block</h3>
        <div className="fold-bars">{report.folds.map(fold=><div key={fold.start} title={`${day(fold.start)} → ${day(fold.end)} · ${pct(fold.accuracy)} · trained on ${fold.trainRows} candles`}><i style={{height:`${Math.max(4,(fold.accuracy??0)*100)}%`}} className={(fold.accuracy??0)>baseline?'is-good':'is-bad'}/></div>)}<span className="fold-baseline" style={{bottom:`${baseline*100}%`}}>33%</span></div>
        <div className="fold-axis"><span>{report.folds[0]?day(report.folds[0].start):''}</span><span>{report.folds.at(-1)?day(report.folds.at(-1)!.end):''}</span></div>
      </section>
      <section><h3>Most important indicators</h3><p className="model-note">Share of the tree models' decisions based on each feature, across all test blocks.</p>
        {importance.length?<ol className="importance-list">{importance.map(([name,value])=><li key={name}><span>{label(name)}</span><i><b style={{width:`${value/top*100}%`}}/></i><em>{pct(value)}</em></li>)}</ol>:<p className="model-note">The selected models do not report feature importance.</p>}
      </section>
    </div>
  </div>;
}
