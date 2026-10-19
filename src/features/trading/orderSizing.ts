export function estimateOrderSize(input:string,unit:'XAG'|'USDT',price:number|null|undefined,leverage:number){
  const amount=Number(input);
  const validPrice=price!=null&&Number.isFinite(price)&&price>0;
  if(!input.trim()||!Number.isFinite(amount)||amount<=0||(unit==='USDT'&&!validPrice)){
    return {quantity:null,notional:null,margin:null};
  }
  // USDT is the margin committed; leverage multiplies it into the position value (10 USDT at 12x = 120 USDT).
  const lever=Number.isFinite(leverage)&&leverage>0?leverage:1;
  const quantity=unit==='XAG'?amount:amount*lever/price!;
  if(!Number.isFinite(quantity)||quantity<=0)return {quantity:null,notional:null,margin:null};
  const notional=validPrice?quantity*price!:null;
  const margin=notional!=null&&Number.isFinite(leverage)&&leverage>0?notional/leverage:null;
  return {quantity,notional,margin};
}
