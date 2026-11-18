export default function MarketSymbolLabel({base,quote}:{base:string;quote:string}){
  return <span className="live-symbol-copy"><strong>{base}<span> / {quote}</span></strong><small>Perpetual</small></span>;
}
