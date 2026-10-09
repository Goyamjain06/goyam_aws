"""
Hindi speech comes back in Devanagari ("आनंद विहार से नोएडा"). Place names in the data are in English.
This turns both into the same rough phonetic key so they can be fuzzy-matched without any cloud call.
"""
from __future__ import annotations

import difflib
import re

VOWELS = {"अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au",
          "ऋ": "ri", "ऑ": "o"}
MATRAS = {"ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ृ": "ri",
          "ॉ": "o"}
CONS = {"क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
        "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
        "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
        "ष": "sh", "स": "s", "ह": "h", "क़": "k", "ख़": "kh", "ग़": "g", "ज़": "z", "ड़": "r", "ढ़": "rh", "फ़": "f"}
NASAL = {"ं": "n", "ँ": "n", "ः": "h"}
VIRAMA, NUKTA = "्", "़"
SCHWA = "\u0001"
DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")


def deva_to_latin(text: str) -> str:
    text = text.translate(DIGITS)
    out, i = [], 0
    while i < len(text):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if nxt == NUKTA and ch + NUKTA in CONS:
            ch, i = ch + NUKTA, i + 1
            nxt = text[i + 1] if i + 1 < len(text) else ""
        if ch in CONS:
            out.append(CONS[ch])
            if nxt in MATRAS or nxt == VIRAMA:
                pass
            else:
                out.append(SCHWA)  # inherent vowel; dropped at word end, 'a' elsewhere
        elif ch in MATRAS:
            out.append(MATRAS[ch])
        elif ch in VOWELS:
            out.append(VOWELS[ch])
        elif ch in NASAL:
            out.append(NASAL[ch])
        elif ch in (VIRAMA, NUKTA):
            pass
        else:
            out.append(ch)
        i += 1
    s = "".join(out)
    # schwa deletion: an inherent vowel at the end of a word is silent ("विहार" -> "vihar")
    s = re.sub(SCHWA + r"(?=[^a-z" + SCHWA + r"]|$)", "", s)
    return s.replace(SCHWA, "a")


def phonetic(s: str) -> str:
    s = deva_to_latin(s).lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = re.sub(r"\b(metro|station|stesan|steshan|sector|sektar|sektor|sec|phase|fes|delhi|dilli|dili|deli|new|nyu|nai|"
               r"imd|dpcc|cpcb|uppcb|hspcb|iitm|dtu)\b", " ", s)
    s = s.replace("ow", "o").replace("au", "o").replace("oe", "oi")
    s = s.replace("w", "v").replace("z", "j").replace("ph", "f").replace("q", "k")
    s = re.sub(r"(?<=[kgcjtdpbsr])h", "", s)
    s = re.sub(r"aa+", "a", s).replace("ee", "i").replace("oo", "u")
    s = re.sub(r"(.)\1+", r"\1", s)
    return re.sub(r"\s+", " ", s).strip()


def _skeleton(s: str) -> str:
    return re.sub(r"[aeiou]", "", s)


def similarity(a: str, b: str) -> float:
    """Fuzzy match that forgives vowel spelling ('kashmiri gate' vs 'kashmere gate') and station suffixes ('okhla 2')."""
    best = 0.0
    for bb in {b, re.sub(r"\s*\d+$", "", b).strip() or b}:
        r = difflib.SequenceMatcher(None, a, bb).ratio()
        ka, kb = _skeleton(a), _skeleton(bb)
        if len(ka) >= 4 and len(kb) >= 4:
            r = max(r, difflib.SequenceMatcher(None, ka, kb).ratio() - 0.06)
        best = max(best, r)
    return best


def find_in_text(text: str, keys: list[str], threshold: float = 0.8) -> list[tuple[int, int, int, float]]:
    """Returns (token_start, token_end, key_index, score) for non-overlapping fuzzy matches, in text order."""
    toks = phonetic(text).split()
    cands = []
    for n in (3, 2, 1):
        for s in range(0, len(toks) - n + 1):
            win = " ".join(toks[s:s + n])
            if len(win) < 3:
                continue
            for ki, k in enumerate(keys):
                if len(k) < 4 or abs(len(k) - len(win)) > max(3, len(k) // 2):
                    continue
                sc = similarity(win, k)
                if sc >= threshold:
                    cands.append((s, s + n, ki, sc + 0.01 * n))
    cands.sort(key=lambda c: -c[3])
    taken, out = set(), []
    for s, e, ki, sc in cands:
        if any(t in taken for t in range(s, e)):
            continue
        taken.update(range(s, e))
        out.append((s, e, ki, sc))
    return sorted(out)
