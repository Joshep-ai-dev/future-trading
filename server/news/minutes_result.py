"""Conservative, uncalibrated text-tone results for the calendar, never price-derived."""
from __future__ import annotations

import json
import logging
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from queue import Queue
from threading import Lock, Thread

from server.news.minutes import CACHE, read_minutes

VERSION = 1
logger = logging.getLogger(__name__)
_lock = Lock()
_results: dict[int | tuple, dict] = {}
_active: set[int | tuple] = set()
_jobs: Queue[tuple[int, str]] = Queue()
_worker: Thread | None = None

# Narrow phrases, not standalone positive/negative words. Policy intentions outweigh outlook.
RULES = (
    (1, 2., r'\b(?:raise|raising|increase|increasing)\b.{0,65}\b(?:target range|policy rate|federal funds rate)\b'),
    (1, 2., r'\b(?:further|additional) (?:policy )?tightening\b'),
    (1, 2., r'\bhigher\b.{0,35}\b(?:policy rate|federal funds rate|target range)\b'),
    (1, 2., r'\b(?:maintain|maintaining|remain|remaining|keep|keeping)\b.{0,45}\brestrictive\b'),
    (1, 1., r'\binflation\b.{0,65}\b(?:remained elevated|persistently high|persistent|upside risks)\b'),
    (1, 1., r'\bupside risks\b.{0,40}\binflation\b'),
    (-1, 2., r'\b(?:lower|lowering|reduce|reducing|cut|cutting)\b.{0,65}\b(?:target range|policy rate|federal funds rate)\b'),
    (-1, 2., r'\b(?:ease|easing) (?:the stance of )?monetary policy\b'),
    (-1, 1., r'\b(?:progress|further progress)\b.{0,45}\b(?:disinflation|reducing inflation|inflation.*2 percent)\b'),
    (-1, 1., r'\binflation\b.{0,35}\b(?:was declining|had declined|was easing|had eased)\b'),
    (-1, 1., r'\b(?:downside risks|weakening|deterioration)\b.{0,45}\b(?:employment|labor market)\b'),
)
COMPILED = [(sign, weight, re.compile(pattern, re.I)) for sign, weight, pattern in RULES]
PRESS_COMPILED = COMPILED + [
    (1, 1., re.compile(r'\binflation\b.{0,35}\b(?:remains elevated|is too high|remains too high|is still elevated)\b', re.I)),
    (-1, 1., re.compile(r'\binflation\b.{0,35}\b(?:has declined|has eased|is declining|is easing)\b', re.I)),
    (-1, 1., re.compile(r'\blabor market\b.{0,30}\b(?:has cooled|has weakened|is weakening)\b', re.I)),
    (1, 1., re.compile(r'\binflation\b.{0,40}\brunning above\b.{0,30}\b(?:objective|target)\b', re.I)),
    (1, 2., re.compile(r'\bwe (?:are|will be) tightening (?:financial conditions|monetary policy)\b', re.I)),
]


def score_tone(paragraphs: list[str], conference: bool = False) -> dict:
    """Use participants' discussion only; exclude staff, market quotes, and the known decision.

    Negated and conditional clauses are omitted rather than mechanically reversing their meaning.
    [-100, 100] is a dictionary balance index, not a probability or statistical surprise.
    """
    active = conference
    hawk = dove = 0.
    matched = 0
    for paragraph in paragraphs:
        lower = paragraph.lower().replace('\u2019', "'")
        if re.match(r"participants.{0,5} views", lower):
            active = True
        if re.match(r'committee policy action|voting for|implementation note|attendance', lower):
            active = False
        if not active:
            continue
        for sentence in re.split(r'(?<=[.!?])\s+(?=[A-Z])', paragraph):
            text = sentence.lower().replace('\u2019', "'") if conference else sentence.lower()
            if re.search(r'\b(?:market participants|staff|investors|traders)\b', text):
                continue
            if re.search(r'\b(?:if|unless|conditional on|in the event|had previously|previous meeting)\b', text):
                continue
            # Count at most one cue in each direction per sentence to avoid keyword repetition.
            weights = {1: 0., -1: 0.}
            for sign, weight, pattern in PRESS_COMPILED if conference else COMPILED:
                for match in pattern.finditer(text):
                    prefix = text[max(0, match.start()-55):match.start()]
                    cue = match.group()
                    if re.search(r"\b(?:not|no|never|unlikely|neither)\b|n't\b", ' '.join((prefix+' '+cue).split()[-20:])):
                        continue
                    weights[sign] = max(weights[sign], weight)
            if not any(weights.values()):
                continue
            attribution = .35 if re.search(r'\b(?:a couple|a few|one participant)\b', text) else .65 if re.search(r'\b(?:some|several) participants\b', text) else 1.
            hawk += weights[1]*attribution
            dove += weights[-1]*attribution
            matched += 1
    if matched < 3:
        return dict(score=None, label='Unclear', matchedSentences=matched)
    score = round(100*(hawk-dove)/(hawk+dove))
    return dict(score=score, label='Hawkish' if score >= 25 else 'Dovish' if score <= -25 else 'Mixed', matchedSentences=matched)


def summarize(document: dict, conference: bool = False) -> dict:
    current = score_tone(document['current']['paragraphs'], conference)
    previous = score_tone(document['previous']['paragraphs'], conference) if document['previous'] else dict(score=None, label='Unavailable')
    change = None if current['score'] is None or previous['score'] is None else current['score']-previous['score']
    # Textbook tone bias; the preceding release is not a stand-in for market consensus.
    score = current['score']
    bias = None if score is None or abs(score) < 25 else (-1 if score > 0 else 1)
    return dict(status='ready', method='Rules v1', **current, previousScore=previous['score'],
                previousLabel=previous['label'], change=change, silverBias=bias,
                shift='Unclear' if change is None else 'More hawkish' if change >= 15 else 'More dovish' if change <= -15 else 'Little change',
                meeting=document['current']['meeting'], source='Federal Reserve',
                note=f'Uncalibrated text-tone estimate; change is versus the preceding {"press conference" if conference else "minutes"}, not market consensus. Silver bias is a heuristic, not a trade probability.')


def result_path(released: int, cache: Path = CACHE, kind: str = 'minutes') -> Path:
    day = datetime.fromtimestamp(released, timezone.utc).strftime('%Y-%m-%d')
    prefix = 'press-' if kind == 'press' else ''
    version = 2 if kind == 'press' else VERSION
    return cache / f'{prefix}result-v{version}-{day}.json'


def analyze_minutes(released: int) -> dict:
    return summarize(read_minutes(released))


def _collect(released: int, kind: str = 'minutes') -> None:
    try:
        if kind == 'press':
            from server.news.press_conference import read_conference
            result = summarize(read_conference(released), conference=True)
        else:
            result = analyze_minutes(released)
        result['checked'] = time.time()
        path = result_path(released, kind=kind)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix('.tmp')
        temporary.write_text(json.dumps(result), encoding='utf-8')
        temporary.replace(path)
    except Exception:
        logger.warning('FOMC tone unavailable for release %s', released, exc_info=True)
        result = dict(status='unavailable', label='Unavailable', checked=time.time(),
                      note=f'Official {"press conference transcript" if kind == "press" else "minutes"} could not be verified or loaded for this date. Retrying later.')
    with _lock:
        key = (released, kind) if kind == 'press' else released
        _results[key] = result
        _active.discard(key)


def calendar_result(released: int, kind: str = 'minutes') -> dict | None:
    """Nonblocking: backfill results on demand in one worker; calendar polls see completed rows."""
    global _worker
    if released > time.time():
        return None
    key = (released, kind) if kind == 'press' else released
    with _lock:
        result = _results.get(key)
        if result is None:
            try:
                result = json.loads(result_path(released, kind=kind).read_text(encoding='utf-8'))
                _results[key] = result
            except (OSError, ValueError):
                pass
        if result and result.get('checked', 0) > time.time()-(86400 if result.get('status') == 'ready' else 600):
            return result
        if key not in _active:
            _active.add(key)
            _jobs.put((released, kind))
            if _worker is None or not _worker.is_alive():
                _worker = Thread(target=_work, name='minutes-tone', daemon=True)
                _worker.start()
        return result or dict(status='pending', label='Analyzing', note='Reading official Fed documents in the background.')


def _work() -> None:
    while True:
        released, kind = _jobs.get()
        try:
            _collect(released, kind)
        finally:
            _jobs.task_done()
