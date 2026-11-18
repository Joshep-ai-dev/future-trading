import type {ComponentProps,ReactNode} from 'react';
import {Metric} from './ui';

type MarketMetric=Pick<ComponentProps<typeof Metric>,'label'|'value'|'unit'|'tone'>;
type Props={icon:string;selector:ReactNode;caption?:ReactNode;price:ReactNode;quote:string;priceCaption?:ReactNode;direction?:'up'|'down'|'flat';metrics:readonly MarketMetric[];actions?:ReactNode;info?:ReactNode;notice?:ReactNode};

/** Shared market identity, price, statistics and account controls. */
export default function MarketHeader({icon,selector,caption,price,quote,priceCaption,direction,metrics,actions,info,notice}:Props){
  return <div className="exchange-market-header live-market-bar market-header">
    <div className="live-market-selectors"><span className="live-symbol-mark" aria-hidden="true">{icon}</span><div className="market-header-identity">{selector}{caption&&<small className="market-header-caption">{caption}</small>}</div></div>
    <div className={`live-header-price ${direction?`is-${direction}`:''}`}><strong>{price}</strong><span>{priceCaption??quote}</span></div>
    <div className="live-header-stats" aria-label="24 hour market statistics">{metrics.map(metric=><Metric key={metric.label} {...metric}/>)}</div>
    {info&&<div className="market-header-info">{info}</div>}
    {actions&&<div className="live-header-actions">{actions}</div>}
    {notice}
  </div>;
}
