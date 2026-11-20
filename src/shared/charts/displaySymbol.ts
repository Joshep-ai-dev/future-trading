/** Hide the CCXT settlement suffix in chart labels, keeping full IDs for requests. */
export function displaySymbol(symbol:string){return symbol.replace(/:(USDT|USDC|USD)$/i,'');}
