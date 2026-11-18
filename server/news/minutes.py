"""Official FOMC minutes, matched by publication day rather than meeting day."""
from __future__ import annotations

import difflib
import json
import re
import time
from datetime import datetime, timezone
from html.parser import HTMLParser
from http.client import HTTPException as HTTPReadError
from pathlib import Path
from threading import RLock
from urllib.request import Request, urlopen

BASE = 'https://www.federalreserve.gov'
CACHE = Path(__file__).resolve().parents[2] / 'data' / 'news' / 'minutes'
LOCK = RLock()


def download(url: str) -> str:
    return download_bytes(url, 2_000_000).decode('utf-8', errors='replace')


def download_bytes(url: str, limit: int = 8_000_000) -> bytes:
    request = Request(url, headers={'User-Agent': 'Mozilla/5.0 SilverTerminal',
                                    'Accept': 'application/pdf' if url.lower().endswith('.pdf') else 'text/html'})
    for attempt in range(2):
        try:
            with urlopen(request, timeout=15) as response:
                body = response.read(limit+1)
                if len(body) > limit:
                    raise ValueError('Federal Reserve document exceeds the reader limit.')
                return body
        except (OSError, HTTPReadError):
            if attempt:
                raise
    raise OSError('The Federal Reserve document could not be downloaded.')


def parse_index(html: str) -> list[dict]:
    rows = []
    for block in re.findall(r'<div\b[^>]*class="[^"]*fomc-meeting__minutes[^"]*"[^>]*>(.*?)</div>', html, re.S):
        link = re.search(r'href="(/monetarypolicy/fomcminutes(\d{8})\.htm)"', block)
        released = re.search(r'Released\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})', block)
        if link and released:
            day = datetime.strptime(released[1], '%B %d, %Y').strftime('%Y-%m-%d')
            rows.append(dict(meeting=datetime.strptime(link[2], '%Y%m%d').strftime('%Y-%m-%d'),
                             releaseDate=day, url=BASE+link[1]))
    if not rows:
        raise ValueError('The Federal Reserve minutes index could not be read.')
    return sorted(rows, key=lambda row: row['releaseDate'])


class ArticleParser(HTMLParser):
    """Extract readable blocks only inside the official article; never serve remote HTML."""
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.block = ''
        self.parts: list[str] = []
        self.paragraphs: list[str] = []
        self.ignored = 0

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag == 'div':
            if self.depth or dict(attrs).get('id') == 'article':
                self.depth += 1
        if not self.depth:
            return
        if tag in ('script', 'style'):
            self.ignored += 1
        if tag in ('p', 'h3', 'h4', 'li') and not self.block:
            self.block = tag
            self.parts = []
        if tag == 'br':
            self.parts.append('\n')

    def handle_data(self, data: str) -> None:
        if self.depth and self.block and not self.ignored:
            self.parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == self.block:
            text = re.sub(r'\s+', ' ', ''.join(self.parts)).strip()
            if text:
                self.paragraphs.append(text)
            self.block = ''
        if tag in ('script', 'style') and self.ignored:
            self.ignored -= 1
        if tag == 'div' and self.depth:
            self.depth -= 1


def parse_document(html: str) -> list[str]:
    parser = ArticleParser()
    parser.feed(html)
    if len(parser.paragraphs) < 5 or 'Minutes of the Federal Open Market Committee' not in ' '.join(parser.paragraphs[:3]):
        raise ValueError('The official minutes text could not be verified.')
    return parser.paragraphs


def cached(name: str, url: str, parser, ttl: int, cache: Path, binary: bool = False):
    path = cache / f'{name}.json'
    try:
        saved = json.loads(path.read_text(encoding='utf-8'))
        if saved['fetched'] > time.time()-ttl:
            return saved['data']
    except (OSError, ValueError, KeyError):
        pass
    data = parser(download_bytes(url) if binary else download(url))
    cache.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(dict(fetched=time.time(), data=data), ensure_ascii=False), encoding='utf-8')
    temporary.replace(path)
    return data


def paragraph_changes(previous: list[str], current: list[str]) -> list[dict]:
    changes = []
    for tag, a, b, c, d in difflib.SequenceMatcher(None, previous, current, autojunk=False).get_opcodes():
        if tag != 'equal':
            changes.append(dict(kind=tag, before=previous[a:b], after=current[c:d]))
    return changes


def read_minutes(released: int, cache: Path = CACHE) -> dict:
    if released > time.time():
        raise LookupError('These minutes have not been released yet.')
    day = datetime.fromtimestamp(released, timezone.utc).strftime('%Y-%m-%d')
    with LOCK:
        index = cached('calendar', BASE+'/monetarypolicy/fomccalendars.htm', parse_index, 3600, cache)
        match = next((i for i, row in enumerate(index) if row['releaseDate'] == day), None)
        if match is None:
            raise LookupError('No official minutes publication matches this calendar date. The calendar date may be incorrect or outside the Fed’s recent archive.')

        def document(row: dict) -> dict:
            paragraphs = cached('minutes-'+row['meeting'], row['url'], parse_document, 86400, cache)
            return dict(**row, paragraphs=paragraphs)

        current = document(index[match])
        previous = None
        comparison_error = None
        if match:
            try:
                previous = document(index[match-1])
            except (OSError, ValueError, HTTPReadError):
                comparison_error = 'The preceding minutes could not be loaded. Try again later.'
        return dict(source='Federal Reserve', current=current, previous=previous,
                    changes=paragraph_changes(previous['paragraphs'], current['paragraphs']) if previous else [],
                    comparisonError=comparison_error)
