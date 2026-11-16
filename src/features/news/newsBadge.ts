import { useEffect, useState } from "react";
import { api } from "../../shared/api/api";

/** "Unread news" marker: the newest headline / release the user has seen, kept per browser. */
const KEY = "silver.news.seen";
const EVENT = "silver:news-seen";

export function readNewsSeen(): number {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === null) {
      // First visit: start from now so old items are not all "new".
      const now = Math.floor(Date.now() / 1000);
      localStorage.setItem(KEY, String(now));
      return now;
    }
    return Number(stored) || 0;
  } catch {
    return 0;
  }
}

export function markNewsSeen(time = Date.now() / 1000) {
  try {
    localStorage.setItem(KEY, String(Math.floor(time)));
  } catch {
    /* Without storage the dot clears for this visit only. */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** True when a headline or released figure arrived after the user last opened the News page. */
export function useNewsDot(onNewsPage: boolean): boolean {
  const [seen, setSeen] = useState(readNewsSeen);
  const [latest, setLatest] = useState(0);
  useEffect(() => {
    const update = () => setSeen(readNewsSeen());
    const storage = (event: StorageEvent) => {
      if (event.key === KEY) update();
    };
    window.addEventListener(EVENT, update);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener("storage", storage);
    };
  }, []);
  useEffect(() => {
    const load = () =>
      api<{ latest: number }>("/api/news/latest")
        .then((value) => setLatest(value.latest))
        .catch(() => {});
    void load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, []);
  return !onNewsPage && latest > seen;
}
