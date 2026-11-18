"""Verified Fed transcript text; only chair turns enter the tone analysis."""
from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from server.news.minutes import BASE, CACHE, LOCK, cached


def parse_conferences(html: str) -> list[str]:
    dates = sorted(set(re.findall(r'href="/monetarypolicy/fomcpress?conf(\d{8})\.htm', html)))
    if not dates:
        raise ValueError('Official press conference calendar could not be verified.')
    return [datetime.strptime(day, '%Y%m%d').strftime('%Y-%m-%d') for day in dates]


def chair_turns(text: str) -> list[str]:
    lines = [line for line in text.splitlines() if not re.search(r'Page\s+\d+\s+of\s+\d+|Press Conference.*(?:FINAL|PRELIMINARY)', line, re.I)]
    text = '\n'.join(lines)
    speakers = list(re.finditer(r"(?m)^\s*([A-Z][A-Z .’'\-]{1,65})\.\s+", text))
    turns = []
    for i, speaker in enumerate(speakers):
        if not re.fullmatch(r"CHAIR(?:MAN|WOMAN)? [A-Z][A-Z ’'\-]+", speaker[1].strip()):
            continue
        end = speakers[i+1].start() if i+1 < len(speakers) else len(text)
        turn = re.sub(r'\s+', ' ', text[speaker.end():end]).strip()
        if turn:
            turns.append(turn)
    if len(turns) < 2 or sum(map(len, turns)) < 1000:
        raise ValueError('A complete transcript with chair answers is not yet available.')
    return turns


def parse_transcript(body: bytes, day: str) -> list[str]:
    from pypdf import PdfReader
    if not body.startswith(b'%PDF-'):
        raise ValueError('The official transcript response is not a PDF.')
    reader = PdfReader(BytesIO(body))
    if reader.is_encrypted or len(reader.pages) > 100:
        raise ValueError('Unsupported official transcript PDF.')
    text = '\n'.join(page.extract_text() or '' for page in reader.pages)
    expected = datetime.strptime(day, '%Y-%m-%d').strftime('%B %d, %Y').replace(' 0', ' ')
    header = re.sub(r'\s+', ' ', text[:1600])
    if 'Press Conference' not in header or expected not in header:
        raise ValueError('Transcript header does not match this conference date.')
    return chair_turns(text)


def read_conference(released: int, cache: Path = CACHE) -> dict:
    if released > time.time():
        raise LookupError('This press conference has not occurred yet.')
    day = datetime.fromtimestamp(released, timezone.utc).strftime('%Y-%m-%d')
    with LOCK:
        dates = cached('press-calendar-v2', BASE+'/monetarypolicy/fomccalendars.htm', parse_conferences, 3600, cache)
        if day not in dates:
            raise LookupError('No official press conference matches this UTC event date.')

        def document(date: str) -> dict:
            compact = date.replace('-', '')
            url = BASE+f'/mediacenter/files/FOMCpresconf{compact}.pdf'
            paragraphs = cached('press-'+date, url, lambda body: parse_transcript(body, date), 86400, cache, binary=True)
            return dict(meeting=date, releaseDate=date, paragraphs=paragraphs)

        current = document(day)
        index = dates.index(day)
        previous = None
        if index:
            try:
                previous = document(dates[index-1])
            except Exception:
                # A missing preceding transcript must not erase the selected conference's result.
                pass
        return dict(current=current, previous=previous)
