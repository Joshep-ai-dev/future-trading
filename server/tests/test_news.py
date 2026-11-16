import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

from server.market.patterns import find_similar
from server.news import routes
from server.news.features import news_features
from server.news.sentiment import score_text, topics_for
from server.news.service import NewsService
from server.news.sources import GdeltClient, GdeltRateLimited, article_id, make_article, parse_feed
from server.news.store import NewsStore

RSS = b'''<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Feed</title>
<item><title><![CDATA[Silver rallies to record high as dollar slips]]></title><link>https://example.com/a?utm=1</link>
<pubDate>Mon, 16 Nov 2026 11:12:10 GMT</pubDate><description><![CDATA[<p>Spot <b>silver</b> jumps.</p>]]></description></item>
<item><title>Canadian Dollar extends decline</title><link>https://example.com/b</link><pubDate>Mon, 16 Nov 2026 12:00:00 GMT</pubDate></item>
<item><title>Gold slides on hawkish Fed</title><link>https://example.com/c</link><pubDate>bad date</pubDate></item>
</channel></rss>'''


class SentimentTests(unittest.TestCase):
    def test_silver_point_of_view(self):
        self.assertGreater(score_text('Silver rallies to record high'), .5)
        self.assertLess(score_text('Gold slides to lowest level on dollar strength, Fed hike bets'), -.5)
        self.assertGreater(score_text('US Dollar falls after weak jobs data'), 0)  # weaker USD helps silver
        self.assertEqual(score_text('Canadian Dollar extends decline'), 0)  # not a silver driver
        self.assertLess(score_text('Silver fails to rally'), 0)
        self.assertGreater(score_text('Silver does not rise despite rate cut'), 0)
        self.assertEqual(topics_for('Fed hike bets lift the dollar'), ['fed', 'dollar'])


class SourceTests(unittest.TestCase):
    def test_rss_parsing_cleans_text_and_keeps_relevant_items(self):
        rows = parse_feed(RSS, 'demo', 'Demo', now=1_794_900_000)
        self.assertEqual([row['title'] for row in rows], ['Silver rallies to record high as dollar slips', 'Gold slides on hawkish Fed'])
        first, second = rows
        self.assertEqual(first['summary'], 'Spot silver jumps.')
        self.assertEqual(first['published'], 1_794_827_530)
        self.assertEqual(first['id'], article_id('https://example.com/a'))  # tracking query ignored
        self.assertEqual(second['published'], 1_794_900_000)  # unparseable date -> fetch time
        self.assertLess(second['sentiment'], 0)
        self.assertEqual(parse_feed(RSS, 'demo', 'Demo', now=1_794_900_000+30*86400)[0]['title'], 'Gold slides on hawkish Fed')  # old items dropped

    def test_gdelt_timeline_and_rate_limit(self):
        pages = [json.dumps({'timeline': [{'series': 'Article Count', 'data': [
                    {'date': '20260101T000000Z', 'value': 3}, {'date': '20260101T001500Z', 'value': 0}]}]}).encode(),
                 json.dumps({'timeline': [{'series': 'Average Tone', 'data': [{'date': '20260101T000000Z', 'value': -2.5}]}]}).encode()]
        client = GdeltClient(spacing=0, opener=lambda url, timeout: pages.pop(0))
        self.assertEqual(client.timeline(1767225600, 1767226500), [(1767225600, 3., -2.5), (1767226500, 0., None)])
        limited = GdeltClient(spacing=0, opener=lambda url, timeout: b'Please limit requests to one every 5 seconds')
        with self.assertRaises(GdeltRateLimited):
            limited.articles()


class StoreAndFeatureTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.store = NewsStore(Path(self.directory.name)/'news.sqlite')

    def tearDown(self):
        self.directory.cleanup()

    def test_store_deduplicates_and_filters(self):
        rows = [make_article(provider='p', source='S', title='Silver surges', url='https://x.com/1', published=100),
                make_article(provider='p', source='S', title='Gold slides on hawkish Fed', url='https://x.com/2', published=200)]
        self.assertEqual(self.store.add_articles(rows), 2)
        self.assertEqual(self.store.add_articles(rows), 0)
        self.assertEqual(self.store.articles(sentiment='positive')[1], 1)
        self.assertEqual(self.store.articles(topic='fed')[0][0]['title'], 'Gold slides on hawkish Fed')
        self.assertEqual(self.store.articles(query='surges', since=50, until=150)[1], 1)
        self.store.add_timeline([(0, 5., 1.)], 1)
        self.store.add_timeline([(0, None, 2.)], 2)  # None keeps the stored volume
        self.assertEqual(self.store.timeline(), [dict(bucket=0, volume=5., tone=2.)])

    def test_features_are_causal_and_volume_weighted(self):
        base = 1_767_225_600
        timeline = [dict(bucket=base, volume=1., tone=4.), dict(bucket=base+900, volume=3., tone=-4.)]
        index = pd.date_range(pd.Timestamp(base, unit='s', tz='UTC'), periods=4, freq='15min')
        frame = news_features(index, 900, timeline=timeline, articles=[(base+100, .5), (base+1000, -1.)])
        # Candle 0 closes at base+900: only bucket 0 has ended.
        self.assertEqual(frame['news_volume'].iloc[0], 1.)
        self.assertEqual(frame['news_tone'].iloc[0], 4.)
        self.assertEqual(frame['news_volume'].iloc[1], 4.)
        self.assertAlmostEqual(frame['news_tone'].iloc[1], (4-12)/4)
        self.assertEqual(frame['headline_count'].iloc[0], 1)
        self.assertAlmostEqual(frame['headline_sentiment'].iloc[1], -.25)
        early = news_features(pd.DatetimeIndex([pd.Timestamp(base-3600, unit='s', tz='UTC')]), 900, timeline=timeline, articles=[])
        self.assertTrue(np.isnan(early['news_volume'].iloc[0]))  # before coverage: unknown, not zero

    def test_service_backfills_in_chunks_and_survives_feed_errors(self):
        calls = []

        class FakeGdelt:
            def timeline(self, start, end):
                calls.append((start, end))
                return [(start, 2., 1.)]

            def articles(self):
                raise RuntimeError('offline')

        service = NewsService(store=self.store, gdelt=FakeGdelt(), feeds=(('broken', 'Broken', 'https://invalid.example/rss'),))
        with patch('server.news.service.history_start', return_value=0), \
                patch('server.news.service.fetch_rss', side_effect=OSError('down')):
            self.assertEqual(service.collect_articles(), 0)
            self.assertTrue(service.extend_timeline(now=10*86400, max_chunks=2))
        self.assertEqual(calls, [(0, 2*86400), (2*86400, 4*86400)])
        self.assertEqual(self.store.get_meta('timeline_until'), str(4*86400))
        self.assertEqual(set(service.status()['errors']), {'broken', 'gdelt'})

    def test_routes_list_timeline_and_outlook(self):
        now = int(pd.Timestamp.now(tz='UTC').timestamp())
        self.store.add_articles([make_article(provider='p', source='S', title='Silver surges on rate cut bets', url='https://x.com/9',
                                              published=now-600)])
        self.store.add_timeline([(now//900*900-86400*3, 10., -2.), (now//900*900-3600, 10., 2.)], now)
        with patch.object(routes.news_service, '_store', self.store):
            listed = routes.list_news(q='', topic='silver', sentiment='', since=None, until=None, limit=10, offset=0)
            self.assertEqual(listed['total'], 1)
            outlook = routes.news_outlook()
            self.assertEqual(outlook['label'], 'Bullish')
            self.assertEqual(outlook['toneShift'], 4.)
            buckets = routes.news_timeline(hours=24, resolution='1h')['buckets']
            self.assertEqual(sum(row['headlines'] for row in buckets), 1)


class PatternNewsTests(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(3)
        index = pd.date_range('2026-01-01', periods=1500, freq='15min', tz='UTC')
        close = 50*np.exp(np.cumsum(rng.normal(0, .002, len(index))))
        self.bars = pd.DataFrame(dict(open=close, high=close*1.001, low=close*.999, close=close), index=index)
        self.news = pd.DataFrame(dict(news_tone=np.sin(np.arange(len(index))/40)*3, news_volume_z=0.), index=index)

    def test_forecast_extends_the_query(self):
        plain = find_similar(self.bars, window=32, horizon=12, top_k=5)
        rising = find_similar(self.bars, window=32, horizon=12, top_k=5, forecast=list(self.bars.close.iloc[-1]*np.linspace(1.002, 1.02, 6)))
        self.assertEqual(rising['forecast'][0], self.bars.close.iloc[-1]*1.002)
        self.assertNotEqual([m['start'] for m in plain['matches']], [m['start'] for m in rising['matches']])
        # Matches followed the predicted rise more closely than an unconstrained search, on average.
        self.assertGreater(np.mean([m['futureClosePct'] for m in rising['matches']]), np.mean([m['futureClosePct'] for m in plain['matches']]))
        with self.assertRaises(ValueError):
            find_similar(self.bars, window=32, horizon=4, forecast=[50.]*6)

    def test_news_weight_prefers_similar_news(self):
        priced = find_similar(self.bars, window=32, horizon=12, top_k=5, news=self.news)
        newsy = find_similar(self.bars, window=32, horizon=12, top_k=5, news=self.news, news_weight=.8)
        self.assertIsNone(priced['matches'][0]['newsDistance'])
        self.assertLess(np.mean([m['newsDistance'] for m in newsy['matches']]),
                        np.mean([abs(m['news']['tone']-priced['queryNews']['tone']) for m in priced['matches']])+10)
        query_tone = newsy['queryNews']['tone']
        self.assertLess(np.mean([abs(m['news']['tone']-query_tone) for m in newsy['matches']]),
                        np.mean([abs(m['news']['tone']-query_tone) for m in priced['matches']]))
        with self.assertRaises(ValueError):
            find_similar(self.bars, window=32, horizon=12, news_weight=.5)


if __name__ == '__main__':
    unittest.main()
