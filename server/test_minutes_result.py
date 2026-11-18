import unittest
from unittest.mock import patch

from server.news import minutes_result
from server.news.minutes_result import score_tone, summarize

HEADING = "Participants’ Views on Current Conditions and the Economic Outlook"
HAWK = [HEADING, 'Most participants supported further policy tightening.',
        'Many participants favored raising the target range.',
        'Participants saw upside risks to inflation.']
DOVE = [HEADING, 'Most participants favored lowering the target range.',
        'Participants supported easing monetary policy.',
        'Many participants saw downside risks to employment.']


class MinutesResultTests(unittest.TestCase):
    def test_hawk_and_dove_directions(self):
        self.assertEqual(score_tone(HAWK)['label'], 'Hawkish')
        self.assertEqual(score_tone(DOVE)['label'], 'Dovish')

    def test_missing_evidence_is_unclear_not_neutral(self):
        self.assertIsNone(score_tone([HEADING, 'Participants discussed policy.'])['score'])
        self.assertEqual(score_tone(HAWK[:2])['label'], 'Unclear')

    def test_does_not_classify_market_quotes_staff_or_known_policy_action(self):
        self.assertIsNone(score_tone(['Staff Economic Outlook', *HAWK[1:]])['score'])
        self.assertIsNone(score_tone([HEADING, 'Market participants supported further policy tightening.',
                                     'Staff supported raising the target range.',
                                     'Committee Policy Action', *HAWK[1:]])['score'])

    def test_negation_and_conditionals_do_not_invert_into_false_signals(self):
        paragraphs = [HEADING, 'Participants did not support further policy tightening.',
                      "Participants didn't support raising the target range.",
                      'If inflation rose, participants would support further policy tightening.',
                      'Participants did not favor lowering the target range.']
        self.assertIsNone(score_tone(paragraphs)['score'])

    def test_repeated_keywords_in_one_sentence_do_not_supply_coverage(self):
        self.assertIsNone(score_tone([HEADING, 'Participants supported further policy tightening and additional tightening and raising the target range.'])['score'])

    def test_mixed_evidence_is_not_forced_into_direction(self):
        score = score_tone([*HAWK, *DOVE])
        self.assertEqual(score['score'], 0)
        self.assertEqual(score['label'], 'Mixed')

    def test_comparison_and_bias_do_not_require_market_prices(self):
        result = summarize(dict(current=dict(paragraphs=HAWK, meeting='2026-09-16'),
                                previous=dict(paragraphs=DOVE)))
        self.assertEqual(result['change'], 200)
        self.assertEqual(result['silverBias'], -1)
        self.assertEqual(result['shift'], 'More hawkish')
        self.assertNotIn('paragraphs', result)

    def test_no_previous_document_still_reports_current_tone(self):
        result = summarize(dict(current=dict(paragraphs=DOVE, meeting='2026-09-16'), previous=None))
        self.assertIsNone(result['change'])
        self.assertEqual(result['silverBias'], 1)

    def test_future_rows_do_not_start_background_download(self):
        with patch.object(minutes_result.time, 'time', return_value=1), patch.object(minutes_result, '_collect') as collect:
            self.assertIsNone(minutes_result.calendar_result(2))
            collect.assert_not_called()

    def test_pending_rows_are_queued_once_without_blocking_request(self):
        released = 1780000001
        with patch.object(minutes_result, '_results', {}), patch.object(minutes_result, '_active', set()), patch.object(minutes_result, '_worker') as worker, patch.object(minutes_result, '_jobs') as jobs, patch.object(minutes_result, 'result_path') as path:
            path.return_value.read_text.side_effect = OSError('not cached')
            worker.is_alive.return_value = True
            self.assertEqual(minutes_result.calendar_result(released)['status'], 'pending')
            self.assertEqual(minutes_result.calendar_result(released)['status'], 'pending')
            jobs.put.assert_called_once_with((released, 'minutes'))

    def test_calendar_attaches_text_result_without_replacing_numeric_data_or_price_moves(self):
        from server.news import routes
        now = int(minutes_result.time.time())
        reaction = dict(m15=.12, m60=-.05, m240=.2)
        minutes = dict(id='minutes', group='minutes', core=True, released=now-3600,
                       actual=None, forecast=None, surpriseZ=None, silverBias=None, reaction=reaction)
        cpi = dict(id='cpi', group='cpi', core=True, released=now-7200,
                   actual=.3, forecast=.2, surpriseZ=1., silverBias=-1, reaction=reaction)
        text_result = dict(status='ready', label='Hawkish', score=60, silverBias=-1)
        with patch.object(routes, 'calendar_rows', return_value=[minutes, cpi]), patch.object(minutes_result, 'calendar_result', return_value=text_result) as analyze:
            result = routes.economic_calendar(days_back=60, days_ahead=30, group='')
        analyze.assert_called_once_with(minutes['released'])
        self.assertEqual(result['past'][0]['minutesResult'], text_result)
        self.assertIsNone(result['past'][0]['actual'])
        self.assertIsNone(result['past'][0]['silverBias'])
        self.assertEqual(result['past'][0]['reaction'], reaction)
        self.assertNotIn('minutesResult', cpi)
        self.assertEqual(cpi['actual'], .3)


if __name__ == '__main__':
    unittest.main()
