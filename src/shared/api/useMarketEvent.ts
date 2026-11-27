import {useEffect,useState} from 'react';

export function okxPublicSymbol(instrument: string) {
  return instrument.includes('/') ? instrument : 'XAG/USDT:USDT';
}

export function okxPublicMarketUrl(kind: 'ticker' | 'orderBook' | 'trades', instrument: string) {
  return `/api/market/realtime?${new URLSearchParams({kind, okx_symbol: okxPublicSymbol(instrument)})}`;
}

export function useMarketEvent<T>(url: string | null) {
  const [frame, setFrame] = useState<{url: string; value: T} | null>(null);
  useEffect(() => {
    setFrame(null);
    if (!url) return;
    const source = new EventSource(url);
    source.onmessage = (event) => {
      try {
        setFrame({url, value: JSON.parse(event.data) as T});
      } catch {
        // Keep the latest valid snapshot.
      }
    };
    return () => source.close();
  }, [url]);
  return frame?.url === url ? frame.value : null;
}
