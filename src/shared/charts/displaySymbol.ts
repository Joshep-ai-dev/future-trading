/** Hide the CCXT settlement suffix in chart labels, keeping full IDs for requests. */
export function displaySymbol(symbol:string){return symbol.split(':')[0];}
