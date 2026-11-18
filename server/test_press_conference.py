import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from server.news.press_conference import chair_turns, parse_conferences, parse_transcript, read_conference
from server.news.minutes_result import score_tone, summarize, result_path

FILLER = 'We discussed economic developments and the policy outlook in detail. '*12
TRANSCRIPT = ('October 28, 2026 Chairman Warsh’s Press Conference FINAL\nPage 1 of 2\n'
              'Transcript of Chairman Warsh’s Press Conference\nOctober 28, 2026\n'
              'CHAIRMAN WARSH. Inflation remains elevated. Inflation is too high. '+FILLER+
              '\nJANE REPORTER. We favor lowering the target range. We support easing monetary policy.\n'
              'CHAIRMAN WARSH. We are tightening financial conditions. '+FILLER)


class PressConferenceTests(unittest.TestCase):
    def test_press_and_minutes_caches_cannot_overwrite_each_other(self):
        self.assertNotEqual(result_path(1780000000), result_path(1780000000, kind='press'))

    def test_calendar_links_are_verified_sorted_and_deduplicated(self):
        self.assertEqual(parse_conferences('<a href="/monetarypolicy/fomcpresconf20261028.htm">x</a>'
                                          '<a href="/monetarypolicy/fomcpresconf20260916.htm">x</a>'
                                          '<a href="/monetarypolicy/fomcpressconf20260128.htm">x</a>'),
                         ['2026-01-28', '2026-09-16', '2026-10-28'])
        with self.assertRaises(ValueError):
            parse_conferences('<a href="https://another-host/transcript.pdf">x</a>')

    def test_chair_answers_only_reporters_and_page_headers_excluded(self):
        turns = chair_turns(TRANSCRIPT)
        self.assertEqual(len(turns), 2)
        self.assertNotIn('lowering the target range', ' '.join(turns))
        self.assertNotIn('FINAL', ' '.join(turns))
        self.assertEqual(score_tone(turns, conference=True)['label'], 'Hawkish')
        self.assertIsNone(score_tone(turns)['score'])

    def test_powell_speaker_format_and_page_breaks(self):
        text = TRANSCRIPT.replace('CHAIRMAN WARSH.', 'CHAIR POWELL.').replace(FILLER, FILLER+'\nPage 2 of 2\n')
        self.assertEqual(len(chair_turns(text)), 2)
        self.assertNotIn('Page 2', ' '.join(chair_turns(text)))

    def test_opening_statement_alone_is_not_full_transcript(self):
        with self.assertRaises(ValueError):
            chair_turns('CHAIR POWELL. '+FILLER*2)

    def test_pdf_header_date_must_match_event(self):
        fake = SimpleNamespace(is_encrypted=False, pages=[SimpleNamespace(extract_text=lambda: TRANSCRIPT)])
        with patch('pypdf.PdfReader', return_value=fake):
            self.assertEqual(len(parse_transcript(b'%PDF-fake', '2026-10-28')), 2)
            with self.assertRaises(ValueError):
                parse_transcript(b'%PDF-fake', '2026-09-16')
        with self.assertRaises(ValueError):
            parse_transcript(b'<html>Not a PDF</html>', '2026-10-28')

    def test_curly_apostrophe_negation_is_not_positive_policy_intent(self):
        result = score_tone(['We didn’t favor raising the target range. '*5], conference=True)
        self.assertIsNone(result['score'])

    def test_compact_summary_compares_same_type_without_reporter_tone(self):
        result = summarize(dict(current=dict(meeting='2026-10-28', paragraphs=chair_turns(TRANSCRIPT)),
                                previous=dict(paragraphs=['We support lowering the target range. We favor easing monetary policy. We see downside risks to employment.'])), conference=True)
        self.assertEqual(result['change'], 200)
        self.assertEqual(result['silverBias'], -1)
        self.assertNotIn('paragraphs', result)

    def test_event_utc_date_maps_to_conference_not_next_jst_day(self):
        released = int(datetime(2026, 10, 28, 18, 30, tzinfo=timezone.utc).timestamp())
        def cached(name, url, parser, ttl, cache, binary=False):
            if name == 'press-calendar-v2':
                return ['2026-09-16', '2026-10-28']
            self.assertTrue(binary)
            self.assertTrue(url.endswith('20261028.pdf') or url.endswith('20260916.pdf'))
            return chair_turns(TRANSCRIPT)
        with tempfile.TemporaryDirectory() as directory, patch('server.news.press_conference.cached', side_effect=cached), patch('server.news.press_conference.time.time', return_value=released+1):
            result = read_conference(released, Path(directory))
            self.assertEqual(result['current']['meeting'], '2026-10-28')
            self.assertEqual(result['previous']['meeting'], '2026-09-16')

    def test_api_attaches_press_result_separately_from_numeric_releases(self):
        from server.news import routes
        from server.news import minutes_result
        released = int(minutes_result.time.time())-3600
        row = dict(group='press', core=True, released=released, reaction=None)
        text_result = dict(status='ready', score=50, label='Hawkish')
        with patch.object(routes, 'calendar_rows', return_value=[row]), patch.object(minutes_result, 'calendar_result', return_value=text_result) as analyze:
            result = routes.economic_calendar(days_back=60, days_ahead=30, group='press')
        analyze.assert_called_once_with(released, kind='press')
        self.assertEqual(result['past'][0]['minutesResult'], text_result)


if __name__ == '__main__':
    unittest.main()
