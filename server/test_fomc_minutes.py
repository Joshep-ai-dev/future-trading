"""The reader must match publication dates, isolate official text and compare actual documents."""
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from server.news.minutes import BASE, paragraph_changes, parse_document, parse_index, read_minutes


def article(text: str) -> str:
    return ('<p>Navigation must not leak</p><div id="article"><h3>Minutes of the Federal Open Market Committee</h3>'
            '<p>Meeting dates</p><p><strong>Policy discussion</strong><br>Details &amp; risks</p>'
            f'<div><p>{text}</p></div><p>Vote</p></div><p>Footer must not leak</p>')


INDEX = '''<div class="col fomc-meeting__minutes"><a href="/monetarypolicy/fomcminutes20260729.htm">HTML</a>
 (Released August 19, 2026)</div>
 <div class="fomc-meeting__minutes"><a href="/monetarypolicy/fomcminutes20260916.htm">HTML</a>
 (Released October 07, 2026)</div>'''


class MinutesTests(unittest.TestCase):
    def test_index_distinguishes_meeting_from_publication(self):
        rows = parse_index(INDEX)
        self.assertEqual(rows[1]['meeting'], '2026-09-16')
        self.assertEqual(rows[1]['releaseDate'], '2026-10-07')
        self.assertTrue(rows[1]['url'].startswith(BASE+'/monetarypolicy/'))

    def test_article_excludes_navigation_and_footer(self):
        paragraphs = parse_document(article('Inflation remained elevated.'))
        self.assertEqual(len(paragraphs), 5)
        self.assertEqual(paragraphs[2], 'Policy discussion Details & risks')
        self.assertNotIn('must not leak', ' '.join(paragraphs))

    def test_rejects_unverified_remote_content(self):
        with self.assertRaises(ValueError):
            parse_document('<html><p>Access denied</p></html>')
        with self.assertRaises(ValueError):
            parse_index('<a href="https://another-host/minutes.htm">Minutes</a>')

    def test_diff_preserves_exact_before_and_after(self):
        self.assertEqual(paragraph_changes(['Same', 'Old'], ['Same', 'New']),
                         [dict(kind='replace', before=['Old'], after=['New'])])

    def test_loads_matched_and_previous_documents_and_reuses_cache(self):
        published = int(datetime(2026, 10, 7, 18, tzinfo=timezone.utc).timestamp())
        def fetch(url):
            if url.endswith('fomccalendars.htm'):
                return INDEX
            return article('New policy text' if '20260916' in url else 'Previous policy text')
        with tempfile.TemporaryDirectory() as directory, patch('server.news.minutes.download', side_effect=fetch) as download, patch('server.news.minutes.time.time', return_value=published+1):
            result = read_minutes(published, Path(directory))
            self.assertEqual(result['current']['meeting'], '2026-09-16')
            self.assertEqual(result['previous']['meeting'], '2026-07-29')
            self.assertEqual(result['changes'][0]['after'], ['New policy text'])
            self.assertEqual(read_minutes(published, Path(directory)), result)
            self.assertEqual(download.call_count, 3)

    def test_incorrect_calendar_date_is_not_silently_matched(self):
        timestamp = int(datetime(2026, 10, 8, tzinfo=timezone.utc).timestamp())
        with tempfile.TemporaryDirectory() as directory, patch('server.news.minutes.download', return_value=INDEX), patch('server.news.minutes.time.time', return_value=timestamp+1):
            with self.assertRaises(LookupError):
                read_minutes(timestamp, Path(directory))

    def test_future_release_does_not_download(self):
        with patch('server.news.minutes.download') as download, patch('server.news.minutes.time.time', return_value=0):
            with self.assertRaises(LookupError):
                read_minutes(1)
            download.assert_not_called()

    def test_comparison_failure_keeps_current_document(self):
        published = int(datetime(2026, 10, 7, 18, tzinfo=timezone.utc).timestamp())
        with tempfile.TemporaryDirectory() as directory, patch('server.news.minutes.download', side_effect=[INDEX, article('Current text'), OSError('offline')]), patch('server.news.minutes.time.time', return_value=published+1):
            result = read_minutes(published, Path(directory))
            self.assertIsNotNone(result['current'])
            self.assertIsNone(result['previous'])
            self.assertTrue(result['comparisonError'])


if __name__ == '__main__':
    unittest.main()
