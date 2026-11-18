import {useEffect} from 'react';

export const APP_NAME='Trading';

/** Browser tab title: live price and symbol first (like exchange terminals), then the app name. */
export function useMarketTitle(active:boolean,price:string|null|undefined,symbol:string){
  useEffect(()=>{
    if(!active)return;
    document.title=price&&price!=='—'?`${price} ${symbol} · ${APP_NAME}`:`${symbol} · ${APP_NAME}`;
  },[active,price,symbol]);
  useEffect(()=>{
    if(!active)return;
    return()=>{document.title=APP_NAME;};
  },[active]);
}
