import {useEffect,useRef} from 'react';

export const APP_NAME='Trading';

/** Browser tab title: live price and symbol first (like exchange terminals), then the app name. */
export function useMarketTitle(active:boolean,price:string|null|undefined,symbol:string){
  const previousSymbol=useRef<string|null>(null);
  useEffect(()=>{
    if(!active)return;
    return()=>{
      previousSymbol.current=null;
      document.title=APP_NAME;
    };
  },[active]);

  useEffect(()=>{
    if(!active)return;
    if(!price||price==='—'){
      previousSymbol.current=null;
      document.title=`${symbol} · ${APP_NAME}`;
      return;
    }
    const firstPrice=previousSymbol.current!==symbol;
    previousSymbol.current=symbol;
    const title=`${price} ${symbol} · ${APP_NAME}`;
    document.title=firstPrice?`● ${title}`:title;
    if(!firstPrice)return;
    const timer=window.setTimeout(()=>{document.title=title;},650);
    return()=>window.clearTimeout(timer);
  },[active,price,symbol]);
}
