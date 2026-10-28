import {liveNumber as number,type LiveOrder,type LivePosition} from '../../shared/api/useExchangeStream';
import {Button,StatusBadge,TableFrame} from '../../shared/ui/ui';

export function PositionTable({asset,positions,disabled,closeDisabled=disabled,onClose,onEditProtection,protection}:{asset:string;positions:LivePosition[];disabled:boolean;closeDisabled?:boolean;onClose:(position:LivePosition)=>void;onEditProtection?:(position:LivePosition)=>void;protection?:Partial<Record<string,{stop:number|null;takeProfit:number|null}>>}){
  const priceDigits=asset==='STABLE'?5:3;
  return <TableFrame label={`Open ${asset} positions`} columns={['Contract','Mark price','Entry price','Margin (USDT)','Unrealized PnL','PnL (%)','Liquidation',`Size (${asset})`,'TP / SL','Action']}>
    {positions.map((position,index)=><tr key={`${position.side}-${position.marginMode}-${index}`}>
      <td><strong>{asset}USDT <small>Perpetual</small></strong><div className="exchange-position-tags"><StatusBadge tone={position.side==='long'?'positive':'negative'}>{position.side?.toUpperCase()}</StatusBadge><StatusBadge>{number(position.leverage,1)}x</StatusBadge><StatusBadge>{position.marginMode??'—'}</StatusBadge></div></td>
      <td>{number(position.markPrice,priceDigits)}</td><td>{number(position.entryPrice,priceDigits)}</td><td>{number(position.initialMargin,4)}</td>
      <td className={(position.unrealizedPnl??0)<0?'negative':'positive'}>{position.unrealizedPnl!=null&&position.unrealizedPnl>=0?'+':''}{number(position.unrealizedPnl,4)} <small>USDT</small></td>
      <td className={(position.percentage??0)<0?'negative':'positive'}>{number(position.percentage,2)}{position.percentage!=null?'%':''}</td>
      <td>{number(position.liquidationPrice,priceDigits)}</td><td>{number(position.quantity)}</td>
      <td><div className="position-tpsl"><span className="positive">{protection?.[position.side]?.takeProfit!=null?number(protection[position.side]!.takeProfit,priceDigits):'--'}</span><span className="negative">{protection?.[position.side]?.stop!=null?number(protection[position.side]!.stop,priceDigits):'--'}</span></div></td>
      <td><div className="exchange-position-actions">{onEditProtection&&<Button variant="secondary" disabled={disabled} onClick={()=>onEditProtection(position)}>TP/SL</Button>}<Button variant="danger" disabled={closeDisabled} onClick={()=>onClose(position)}>Close {position.side}</Button></div></td>
    </tr>)}
  </TableFrame>;
}

export function OrderTable({asset,orders,collateral='USDT'}:{asset:string;orders:LiveOrder[];collateral?:string}){
  const priceDigits=asset==='STABLE'?5:3;
  return <TableFrame label={`Open ${asset} orders`} columns={['Contract','Side','Margin','Type',`Size (${asset})`,'Filled','Price','Trigger','Status']}>
    {orders.map((order,index)=><tr key={order.id??index}><td><strong>{asset}{collateral}</strong></td><td><StatusBadge tone={order.side==='buy'?'positive':'negative'}>{order.side?.toUpperCase()}</StatusBadge></td><td>{order.marginMode??'--'}</td><td>{order.type??'—'}</td><td>{number(order.quantity)}</td><td>{number(order.filled)}</td><td>{number(order.price,priceDigits)}</td><td>{number(order.triggerPrice,priceDigits)}</td><td>{order.status??'—'}</td></tr>)}
  </TableFrame>;
}

export function AssetTable({balance}:{balance:Record<string,number|null>|null|undefined}){
  return <TableFrame label="USDT account balance" columns={['Asset','Account equity','Available','Used margin']}><tr><td><strong>USDT</strong></td><td>{number(balance?.total,4)}</td><td>{number(balance?.free,4)}</td><td>{number(balance?.used,4)}</td></tr></TableFrame>;
}
