import {liveNumber as number,type LiveOrder,type LivePosition} from '../../shared/api/useExchangeStream';
import {Button,StatusBadge,TableFrame} from '../../shared/ui/ui';

export function PositionTable({positions,disabled,onClose,onEditProtection,editing}:{positions:LivePosition[];disabled:boolean;onClose:()=>void;onEditProtection?:()=>void;editing?:boolean}){
  return <TableFrame label="Open XAG positions" columns={['Contract','Mark price','Entry price','Margin (USDT)','Unrealized PnL','PnL (%)','Liquidation','Size (XAG)','Action']}>
    {positions.map((position,index)=><tr key={`${position.side}-${position.marginMode}-${index}`}>
      <td><strong>XAGUSDT <small>Perpetual</small></strong><div className="exchange-position-tags"><StatusBadge tone={position.side==='long'?'positive':'negative'}>{position.side?.toUpperCase()}</StatusBadge><StatusBadge>{number(position.leverage,1)}x</StatusBadge><StatusBadge>{position.marginMode??'—'}</StatusBadge></div></td>
      <td>{number(position.markPrice,3)}</td><td>{number(position.entryPrice,3)}</td><td>{number(position.initialMargin,4)}</td>
      <td className={(position.unrealizedPnl??0)<0?'negative':'positive'}>{position.unrealizedPnl!=null&&position.unrealizedPnl>=0?'+':''}{number(position.unrealizedPnl,4)} <small>USDT</small></td>
      <td className={(position.percentage??0)<0?'negative':'positive'}>{number(position.percentage,2)}{position.percentage!=null?'%':''}</td>
      <td>{number(position.liquidationPrice,3)}</td><td>{number(position.quantity)}</td>
      <td><div className="exchange-position-actions">{onEditProtection&&<Button variant="secondary" aria-expanded={editing} disabled={disabled||positions.length!==1} onClick={onEditProtection}>TP/SL</Button>}<Button variant="danger" disabled={disabled||positions.length!==1} onClick={onClose}>Close {position.side}</Button></div></td>
    </tr>)}
  </TableFrame>;
}

export function OrderTable({orders}:{orders:LiveOrder[]}){
  return <TableFrame label="Open XAG orders" columns={['Contract','Side','Type','Size (XAG)','Filled','Price','Trigger','Status']}>
    {orders.map((order,index)=><tr key={order.id??index}><td><strong>XAGUSDT</strong></td><td><StatusBadge tone={order.side==='buy'?'positive':'negative'}>{order.side?.toUpperCase()}</StatusBadge></td><td>{order.type??'—'}</td><td>{number(order.quantity)}</td><td>{number(order.filled)}</td><td>{number(order.price,3)}</td><td>{number(order.triggerPrice,3)}</td><td>{order.status??'—'}</td></tr>)}
  </TableFrame>;
}

export function AssetTable({balance}:{balance:Record<string,number|null>|null|undefined}){
  return <TableFrame label="USDT account balance" columns={['Asset','Account equity','Available','Used margin']}><tr><td><strong>USDT</strong></td><td>{number(balance?.total,4)}</td><td>{number(balance?.free,4)}</td><td>{number(balance?.used,4)}</td></tr></TableFrame>;
}
