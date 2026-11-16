"""News for XAG/USDT: ingestion, storage, sentiment, candle-aligned features.

Two kinds of data are kept in ``data/news/news.sqlite`` (shared by all users,
like the market files):

* ``articles`` - individual headlines from RSS feeds and the GDELT article
  list, with a headline sentiment score and topic tags. Free sources only keep
  recent items, so articles accumulate from when the service started.
* ``tone_timeline`` - GDELT's 15-minute news volume and average tone for the
  silver query. GDELT keeps this history, so it is backfilled over the whole
  market-data range and gives every historical candle its news context.

``features.news_features`` turns both into causal per-candle features (a news
bucket counts only once it has closed before the candle closes); the pattern
search uses them to find past moments with similar price *and* news.
"""
