export function estimateOrderSize(input:string,unit:'XAG'|'USDT',price:number|null|undefined,leverage:number){
  const amount=Number(input);
  const validPrice=price!=null&&Number.isFinite(price)&&price>0;
  if(!input.trim()||!Number.isFinite(amount)||amount<=0||(unit==='USDT'&&!validPrice)){
    return {quantity:null,notional:null,margin:null};
  }
  const quantity=unit==='XAG'?amount:amount/price!;
  if(!Number.isFinite(quantity)||quantity<=0)return {quantity:null,notional:null,margin:null};
  const notional=validPrice?quantity*price!:null;
  const margin=notional!=null&&Number.isFinite(leverage)&&leverage>0?notional/leverage:null;
  return {quantity,notional,margin};
}
