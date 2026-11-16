"""Transparent headline sentiment and topic tags for silver news.

Sentiment is from the silver *price* point of view, in [-1, 1]:

* Driver phrases have a fixed meaning for silver: "rate cut", "dovish",
  "weaker dollar" are positive; "rate hike", "hawkish", "stronger dollar" negative.
* Movement words ("rises", "slides", "13-month low") describe whatever the
  headline is about. They count as-is when the subject is silver or gold,
  inverted when it is the US dollar or bond yields, and not at all otherwise
  (a Canadian-dollar or copper move says nothing about silver).

A cue up to two words after "not"/"no"/"fails" flips sign. The scorer is
deliberately simple and explainable; a learned model can replace
``score_text`` later without changing the store or the features.
"""
from __future__ import annotations

import re

DRIVERS = {
    'rate cut': 1, 'rate cuts': 1, 'cut bets': 1, 'dovish': 1, 'weaker dollar': 1, 'weak dollar': 1, 'dollar weakness': 1,
    'safe haven': .5, 'safe-haven': .5, 'supply deficit': 1, 'short squeeze': 1, 'strong demand': 1, 'inflows': .5,
    'headwinds ease': 1, 'stimulus': .5, 'easing': .5,
    'rate hike': -1, 'rate hikes': -1, 'hike bets': -1, 'hawkish': -1, 'stronger dollar': -1, 'strong dollar': -1,
    'dollar strength': -1, 'weak demand': -1, 'outflows': -.5, 'surplus': -.5, 'tightening': -.5, 'profit-taking': -.5,
}
MOVES = {
    'record high': 1, 'all-time high': 1, 'year high': 1, 'month high': .5, 'highest level': 1, 'surge': 1, 'surges': 1,
    'soar': 1, 'soars': 1, 'rally': 1, 'rallies': 1, 'jump': 1, 'jumps': 1, 'spike': 1, 'spikes': 1, 'climb': .5,
    'climbs': .5, 'rise': .5, 'rises': .5, 'gain': .5, 'gains': .5, 'advance': .5, 'advances': .5, 'higher': .5,
    'bullish': 1, 'rebound': .5, 'rebounds': .5, 'recover': .5, 'recovers': .5, 'breakout': .5, 'upside': .5,
    'firm': .5, 'firms': .5, 'upward': .5, 'uptrend': 1, 'bullish bias': 1, 'higher highs': 1,
    'downward': -.5, 'downtrend': -1, 'bearish bias': -1, 'lower lows': -1,
    'year low': -1, 'month low': -.5, 'lowest level': -1, 'plunge': -1, 'plunges': -1, 'slump': -1, 'slumps': -1,
    'tumble': -1, 'tumbles': -1, 'crash': -1, 'sink': -1, 'sinks': -1, 'sell-off': -1, 'selloff': -1, 'drop': -.5,
    'drops': -.5, 'fall': -.5, 'falls': -.5, 'slide': -.5, 'slides': -.5, 'slip': -.5, 'slips': -.5, 'decline': -.5,
    'declines': -.5, 'lower': -.5, 'bearish': -1, 'downside': -.5, 'losses': -.5, 'retreat': -.5, 'retreats': -.5,
    'weaken': -.5, 'weakens': -.5, 'ease': -.5, 'eases': -.5,
}
NEGATIONS = {'not', 'no', 'never', "isn't", "aren't", "won't", 'without', 'fails', 'failed'}

# Whole-word cues; a trailing "*" also matches longer words (tariff* -> tariffs).
TOPICS = {
    'silver': ('silver', 'xag*'),
    'gold': ('gold', 'xau*', 'bullion', 'precious metal*'),
    'fed': ('fed', 'federal reserve', 'fomc', 'powell', 'rate cut*', 'rate hike*', 'interest rate*', 'central bank*'),
    'dollar': ('us dollar', 'u.s. dollar', 'usd', 'dxy', 'greenback', 'dollar index', 'the dollar', 'dollar strength',
               'dollar weakness', 'strong dollar', 'weak dollar', 'stronger dollar', 'weaker dollar'),
    'yields': ('treasury yield*', 'bond yield*', 'yields'),
    'inflation': ('inflation', 'cpi', 'pce'),
    'demand': ('solar', 'industrial', 'photovoltaic*', 'electronics', 'china', 'chinese', 'manufacturing', 'pmi'),
    'mining': ('mine', 'mines', 'mining', 'miner*', 'production', 'output'),
    'geopolitics': ('war', 'wars', 'sanction*', 'tariff*', 'conflict*', 'election*', 'geopolitic*', 'tension*'),
}
_TOPIC_PATTERNS = {name: re.compile('|'.join(r'\b' + re.escape(cue.rstrip('*')) + ('' if cue.endswith('*') else r'\b')
                                            for cue in cues)) for name, cues in TOPICS.items()}
TOPIC_NAMES = tuple(TOPICS)
_TOKEN = re.compile(r"[a-z][a-z'\-]*")


def _hits(tokens: list[str], lexicon: dict[str, float], used: list[bool]) -> list[tuple[int, float]]:
    """(position, weight) for lexicon entries, longest phrases first, never reusing a token."""
    found = []
    for phrase, weight in sorted(lexicon.items(), key=lambda item: -len(item[0].split())):
        words = phrase.split()
        for start in range(len(tokens)-len(words)+1):
            if tokens[start:start+len(words)] == words and not any(used[start:start+len(words)]):
                used[start:start+len(words)] = [True]*len(words)
                found.append((start, weight))
    return found


def topics_for(text: str) -> list[str]:
    lower = text.lower()
    return [name for name, pattern in _TOPIC_PATTERNS.items() if pattern.search(lower)]


def move_sign(topics: list[str]) -> int:
    """How a price-movement word maps to silver: metals as-is, USD / yields inverted, anything else ignored."""
    if 'silver' in topics or 'gold' in topics:
        return 1
    if 'dollar' in topics or 'yields' in topics:
        return -1
    return 0


def score_text(text: str) -> float:
    """Silver-price sentiment in [-1, 1]; 0 when no cue applies."""
    lower = text.lower()
    tokens = _TOKEN.findall(lower)
    used = [False]*len(tokens)
    sign = move_sign(topics_for(lower))
    total = 0.
    for lexicon, factor in ((DRIVERS, 1), (MOVES, sign)):
        for position, weight in _hits(tokens, lexicon, used):
            negated = any(token in NEGATIONS for token in tokens[max(0, position-2):position])
            total += factor*(-weight if negated else weight)
    return max(-1., min(1., total/2))


# Headlines about other currencies ("Singapore Dollar: ... against US Dollar") are FX noise for silver.
OTHER_FX = re.compile(r'\b(canadian|australian|aussie|new zealand|kiwi|singapore|hong kong|taiwan|mexican) dollar\b|'
                      r'\b(yuan|renminbi|yen|won|euro|pound|sterling|franc|rupee|peso|lira|rand|krona|krone|ringgit|baht|'
                      r'rupiah|forint|zloty|real)\b|\b(eur|gbp|aud|nzd|cad|chf|jpy|cny|krw)/|/(jpy|cad|chf|cny|krw|inr|mxn)\b')


def relevance(text: str) -> float:
    """1 for silver itself, 0.6 for gold / precious metals, 0.4 for macro drivers, else 0.1 (incl. other currencies)."""
    found = topics_for(text)
    if 'silver' in found:
        return 1.
    if 'gold' in found:
        return .6
    if OTHER_FX.search(text.lower()):
        return .1
    if {'fed', 'dollar', 'yields', 'inflation', 'demand'} & set(found):
        return .4
    return .1
