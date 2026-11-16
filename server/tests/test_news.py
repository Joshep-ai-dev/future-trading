import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

from server.market.patterns import find_similar
from server.news import routes
from server.news.calendar import enrich, group_stats, parse_events, reactions, surprise_scales
from server.news.features import news_features, release_surprises
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
        frame = news_features(index, 900, timeline=timeline, articles=[(base+100, .5), (base+1000, -1.)], releases=[(base+900, -2.)])
        # Candle 0 closes at base+900: only bucket 0 has ended.
        self.assertEqual(frame['news_volume'].iloc[0], 1.)
        self.assertEqual(frame['news_tone'].iloc[0], 4.)
        self.assertEqual(frame['news_volume'].iloc[1], 4.)
        self.assertAlmostEqual(frame['news_tone'].iloc[1], (4-12)/4)
        self.assertEqual(frame['headline_count'].iloc[0], 1)
        self.assertAlmostEqual(frame['headline_sentiment'].iloc[1], -.25)
        self.assertEqual(list(frame['macro_surprise'].iloc[:2]), [-2., -2.])  # known from the release time
        early = news_features(pd.DatetimeIndex([pd.Timestamp(base-3600, unit='s', tz='UTC')]), 900, timeline=timeline, articles=[], releases=[])
        self.assertTrue(np.isnan(early['news_volume'].iloc[0]))  # before coverage: unknown, not zero

    def test_service_backfills_in_chunks_and_survives_feed_errors(self):
        calls = []

        class FakeGdelt:
            def timeline(self, start, end):
                calls.append((start, end))
                return [(start, 2., 1.)]

            def articles(self):
                raise RuntimeError('offline')

        service = NewsService(store=self.store, gdelt=FakeGdelt(), feeds=(('broken', 'Broken', 'https://invalid.example/rss'),),
                              calendar=lambda start, end: [])
        with patch('server.news.service.history_start', return_value=0), \
                patch('server.news.service.fetch_rss', side_effect=OSError('down')):
            self.assertEqual(service.collect_articles(), 0)
            self.assertTrue(service.extend_timeline(now=400*86400, max_chunks=2))
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



def fx_row(name, when, actual, consensus, country='US', **extra):
    return dict(id=f'{name}-{when}', name=name, countryCode=country, dateUtc=when, periodDateUtc='2026-01-01T00:00:00Z',
                periodType='MONTH', actual=actual, consensus=consensus, previous=1.0, revised=None, potency='ZERO',
                volatility='HIGH', isBetterThanExpected=None, **extra)


class CalendarTests(unittest.TestCase):
    def test_parse_keeps_listed_us_events(self):
        rows = parse_events([fx_row('Nonfarm Payrolls', '2026-02-06T13:30:00Z', 150, 100),
                             fx_row('Nonfarm Payrolls', '2026-02-06T13:30:00Z', 1, 1, country='CA'),
                             fx_row('Building Permits', '2026-02-06T13:30:00Z', 1, 1),
                             fx_row('Unemployment Rate', '2026-02-06T13:30:00Z', 4.2, 4.1)], now=1)
        self.assertEqual([(row['name'], row['grp'], row['silver_sign'], row['primary_event']) for row in rows],
                         [('Nonfarm Payrolls', 'nfp', -1, 1), ('Unemployment Rate', 'nfp', 1, 0)])
        self.assertEqual(rows[0]['released'], 1770384600)

    def test_surprise_z_bias_and_reaction(self):
        core = 'Consumer Price Index ex Food & Energy (MoM)'
        events = parse_events([fx_row(core, f'2026-0{month}-11T13:30:00Z', .2+(month % 2)*.2, .2)
                               for month in range(1, 8)], now=1)
        scales = surprise_scales(events)
        self.assertAlmostEqual(scales[core], np.std([.2, 0, .2, 0, .2, 0, .2]))
        released = events[0]['released']  # 13:30 UTC
        times = np.arange(released-600, released+5*3600, 60)
        closes = np.where(times < released, 100., 99.)  # silver drops 1% from the release candle on
        rows = enrich(events[:1], scales, pd.DataFrame(dict(close=closes), index=pd.to_datetime(times, unit='s', utc=True)))
        self.assertTrue(rows[0]['core'])
        self.assertFalse(enrich(parse_events([fx_row('Consumer Price Index (YoY)', '2026-01-11T13:30:00Z', 3, 3)], now=1), {}, None)[0]['core'])
        self.assertGreater(rows[0]['surpriseZ'], 0)
        self.assertLess(rows[0]['silverBias'], 0)  # hotter CPI -> silver down (textbook)
        self.assertAlmostEqual(rows[0]['reaction']['m60'], -1.0)
        stats = group_stats(rows)[0]
        self.assertEqual((stats['group'], stats['measured'], stats['biasHitRate']), ('cpi', 1, 1.0))
        # A candle that opened exactly at the release is not the "before" price.
        moved = reactions(times, closes, [released])[0]
        self.assertAlmostEqual(moved['m15'], -1.0)
        self.assertEqual(reactions(times, closes, [released+86400]), [None])  # no data -> no reaction

    def test_release_surprises_average_simultaneous_releases(self):
        events = parse_events([fx_row(name, f'2026-0{month}-11T13:30:00Z', 3.0+(month % 2)*.2, 3.0)
                               for month in range(1, 8) for name in ('Consumer Price Index (YoY)', 'Consumer Price Index (MoM)')], now=1)
        surprises = release_surprises(events)
        self.assertEqual(len(surprises), 7)
        self.assertTrue(all(value < 0 for time, value in surprises[::2]))

    def test_service_backfills_calendar_in_chunks(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        store = NewsStore(Path(directory.name)/'news.sqlite')
        calls = []

        def fake(start, end):
            calls.append((start, end))
            return parse_events([fx_row('Retail Sales (MoM)', '2026-02-17T13:30:00Z', .5, .2)], now=1)

        service = NewsService(store=store, gdelt=None, feeds=(), calendar=fake)
        with patch('server.news.service.CALENDAR_START', 0):
            service.collect_calendar(now=400*86400)
        self.assertEqual(calls, [(0, 180*86400), (180*86400, 360*86400), (360*86400, 390*86400), (390*86400, 430*86400)])
        self.assertEqual(len(store.events()), 1)  # same id upserted, not duplicated


class HistoryBackfillTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = NewsStore(Path(directory.name)/'news.sqlite')

    def test_headlines_go_back_day_by_day_to_one_year(self):
        calls = []

        class FakeGdelt:
            def articles(self, limit=75, start=None, end=None):
                calls.append((start, end))
                return [make_article(provider='gdelt', source='x.com', title=f'Silver rises {start}', url=f'https://x.com/{start}',
                                     published=start+3600)]

        service = NewsService(store=self.store, gdelt=FakeGdelt(), feeds=(), calendar=lambda a, b: [])
        now = 1000*86400+500
        self.assertTrue(service.backfill_headlines(now=now, max_days=3))
        self.assertEqual(calls, [(999*86400, 1000*86400), (998*86400, 999*86400), (997*86400, 998*86400)])
        self.assertEqual(service.status()['headlinesFrom'], 997*86400)
        self.assertFalse(service.backfill_headlines(now=now, max_days=400))  # stops one year back
        self.assertEqual(calls[-1][0], (1000-365)*86400)
        self.assertEqual(self.store.articles(limit=1)[1], 365)

    def test_rate_limit_backs_off_without_moving_the_cursor(self):
        class Limited:
            def articles(self, **kwargs):
                raise GdeltRateLimited('limit')

        service = NewsService(store=self.store, gdelt=Limited(), feeds=(), calendar=lambda a, b: [])
        self.assertTrue(service.backfill_headlines(now=1000*86400))
        self.assertIsNone(self.store.get_meta('headlines_back_until'))
        self.assertEqual(service.backoff, 60.)
        status = service.status()
        self.assertNotIn('headlines', status['errors'])  # a pause, not a failure
        self.assertIn('GDELT pause', status['waiting']['gdelt'])

    def test_calendar_refresh_has_no_tiny_ranges_and_404_means_empty(self):
        import urllib.error
        from server.news.calendar import fetch_calendar
        calls = []
        service = NewsService(store=self.store, gdelt=None, feeds=(), calendar=lambda a, b: calls.append((a, b)) or [])
        self.store.set_meta('calendar_until', str(1000*86400-10*86400-600))  # 10 minutes behind the refresh window
        service.collect_calendar(now=1000*86400)
        self.assertEqual(calls, [(1000*86400-10*86400-600, 1000*86400+30*86400)])  # one refresh, reaching back to the cursor

        def missing(url):
            raise urllib.error.HTTPError(url, 404, 'Not Found', {}, None)

        self.assertEqual(fetch_calendar(0, 600, opener=missing), [])

    def test_timeline_starts_one_year_back(self):
        starts = []

        class FakeGdelt:
            def timeline(self, start, end):
                starts.append(start)
                return []

        service = NewsService(store=self.store, gdelt=FakeGdelt(), feeds=(), calendar=lambda a, b: [])
        with patch('server.news.service.history_start', return_value=900*86400):
            service.extend_timeline(now=1000*86400, max_chunks=1)
        self.assertEqual(starts, [635*86400])



class ReleaseWatcherTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = NewsStore(Path(directory.name)/'news.sqlite')
        self.now = 1_794_922_200  # 2026-11-17 13:30 UTC
        self.store.upsert_events(parse_events([
            fx_row('Retail Sales ex Autos (MoM)', '2026-11-17T13:30:00Z', None, .4),
            fx_row('FOMC Minutes', '2026-11-17T13:30:00Z', None, None)], now=1))
        self.fetches = []

    def service(self, actual):
        def calendar(start, end):
            self.fetches.append((start, end))
            return parse_events([fx_row('Retail Sales ex Autos (MoM)', '2026-11-17T13:30:00Z', actual, .4)], now=1)
        service = NewsService(store=self.store, gdelt=None, feeds=(), calendar=calendar)
        service.collect_articles = lambda: 0
        return service

    def test_due_release_is_polled_until_its_actual_arrives(self):
        waiting = self.service(actual=None)
        self.assertEqual(waiting.watch_once(now=self.now+20), dict(due=1, refreshed=True))
        self.assertEqual(waiting.status()['watching'], ['Retail Sales ex Autos (MoM)'])  # minutes have no number to wait for
        arrived = self.service(actual=.7)
        arrived.watch_once(now=self.now+35)
        self.assertEqual({row['name']: row['actual'] for row in self.store.events()}['Retail Sales ex Autos (MoM)'], .7)
        self.assertEqual(arrived.watch_once(now=self.now+50), dict(due=0, refreshed=False))
        self.assertEqual(len(self.fetches), 2)
        self.assertEqual(waiting.watch_once(now=self.now+16*60)['due'], 0)  # gives up after the watch window

    def test_one_headline_pass_after_a_release(self):
        service = self.service(actual=.7)
        passes = []
        service.collect_articles = lambda: passes.append(1) or 0
        for offset in (60, 4*60, 4*60+15, 4*60+30, 6*60):
            service.watch_once(now=self.now+offset)
        self.assertEqual(len(passes), 1)


if __name__ == '__main__':
    unittest.main()
