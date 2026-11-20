export function estimateOrderSize(input:string,unit:'asset'|'USDT',price:number|null|undefined,leverage:number){
  const amount=Number(input);
  const validPrice=price!=null&&Number.isFinite(price)&&price>0;
  if(!input.trim()||!Number.isFinite(amount)||amount<=0||(unit==='USDT'&&!validPrice)){
    return {quantity:null,notional:null,margin:null};
  }
  // USDT is the margin committed; leverage multiplies it into the position value (10 USDT at 12x = 120 USDT).
  const lever=Number.isFinite(leverage)&&leverage>0?leverage:1;
  const quantity=unit==='asset'?amount:amount*lever/price!;
  if(!Number.isFinite(quantity)||quantity<=0)return {quantity:null,notional:null,margin:null};
  const notional=validPrice?quantity*price!:null;
  const margin=notional!=null&&Number.isFinite(leverage)&&leverage>0?notional/leverage:null;
  return {quantity,notional,margin};
}

/** Size input for a share (0-100 %) of available margin, in the ticket's unit; '' when it cannot be computed. */
export function sizeForMarginShare(share:number,available:number|null|undefined,unit:'asset'|'USDT',price:number|null|undefined,leverage:number){
  if(available==null||!Number.isFinite(available)||available<=0||share<=0)return '';
  const margin=available*Math.min(100,share)/100;
  if(unit==='USDT')return String(Math.floor(margin*1e4)/1e4);
  if(price==null||!Number.isFinite(price)||price<=0||!Number.isFinite(leverage)||leverage<=0)return '';
  return String(Math.floor(margin*leverage/price*1e6)/1e6);
}
