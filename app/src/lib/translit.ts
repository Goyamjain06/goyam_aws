// Port of backend/src/saans/translit.py: Devanagari speech -> phonetic key, fuzzy-matched to English place names.
const VOWELS: Record<string, string> = { 'अ': 'a', 'आ': 'a', 'इ': 'i', 'ई': 'i', 'उ': 'u', 'ऊ': 'u', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऋ': 'ri', 'ऑ': 'o' }
const MATRAS: Record<string, string> = { 'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ृ': 'ri', 'ॉ': 'o' }
const CONS: Record<string, string> = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n', 'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n', 'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh',
  'ष': 'sh', 'स': 's', 'ह': 'h', 'क़': 'k', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f',
}
const NASAL: Record<string, string> = { 'ं': 'n', 'ँ': 'n', 'ः': 'h' }
const VIRAMA = '्', NUKTA = '़', SCHWA = '\u0001'

export function devaToLatin(text: string) {
  text = text.replace(/[०-९]/g, c => String(c.charCodeAt(0) - 0x0966))
  const out: string[] = []
  for (let i = 0; i < text.length; i++) {
    let ch = text[i]
    let nxt = text[i + 1] ?? ''
    if (nxt === NUKTA && CONS[ch + NUKTA]) { ch = ch + NUKTA; i++; nxt = text[i + 1] ?? '' }
    if (CONS[ch]) { out.push(CONS[ch]); if (!(nxt in MATRAS) && nxt !== VIRAMA) out.push(SCHWA) }
    else if (MATRAS[ch]) out.push(MATRAS[ch])
    else if (VOWELS[ch]) out.push(VOWELS[ch])
    else if (NASAL[ch]) out.push(NASAL[ch])
    else if (ch !== VIRAMA && ch !== NUKTA) out.push(ch)
  }
  return out.join('').replace(/\u0001(?=[^a-z\u0001]|$)/g, '').replace(/\u0001/g, 'a')
}

export function phonetic(s: string) {
  return devaToLatin(s).toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(metro|station|stesan|steshan|sector|sektar|sektor|sec|phase|fes|delhi|dilli|dili|deli|new|nyu|nai|imd|dpcc|cpcb|uppcb|hspcb|iitm|dtu)\b/g, ' ')
    .replace(/ow/g, 'o').replace(/au/g, 'o').replace(/oe/g, 'oi')
    .replace(/w/g, 'v').replace(/z/g, 'j').replace(/ph/g, 'f').replace(/q/g, 'k')
    .replace(/([kgcjtdpbsr])h/g, '$1')
    .replace(/aa+/g, 'a').replace(/ee/g, 'i').replace(/oo/g, 'u')
    .replace(/(.)\1+/g, '$1')
    .replace(/\s+/g, ' ').trim()
}

function lcsRatio(a: string, b: string) {
  if (!a.length && !b.length) return 1
  const dp = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let prev = 0
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1])
      prev = tmp
    }
  }
  return (2 * dp[b.length]) / (a.length + b.length)
}
const skeleton = (s: string) => s.replace(/[aeiou]/g, '')

export function similarity(a: string, b: string) {
  let best = 0
  for (const bb of new Set([b, b.replace(/\s*\d+$/, '').trim() || b])) {
    let r = lcsRatio(a, bb)
    const ka = skeleton(a), kb = skeleton(bb)
    if (ka.length >= 4 && kb.length >= 4) r = Math.max(r, lcsRatio(ka, kb) - 0.06)
    best = Math.max(best, r)
  }
  return best
}

export function findInText(text: string, keys: string[], threshold = 0.8) {
  const toks = phonetic(text).split(' ').filter(Boolean)
  const cands: [number, number, number, number][] = []
  for (const n of [3, 2, 1]) {
    for (let s = 0; s + n <= toks.length; s++) {
      const win = toks.slice(s, s + n).join(' ')
      if (win.length < 3) continue
      keys.forEach((k, ki) => {
        if (k.length < 4 || Math.abs(k.length - win.length) > Math.max(3, Math.floor(k.length / 2))) return
        const sc = similarity(win, k)
        if (sc >= threshold) cands.push([s, s + n, ki, sc + 0.01 * n])
      })
    }
  }
  cands.sort((a, b) => b[3] - a[3])
  const taken = new Set<number>()
  const out: typeof cands = []
  for (const c of cands) {
    let clash = false
    for (let t = c[0]; t < c[1]; t++) if (taken.has(t)) clash = true
    if (clash) continue
    for (let t = c[0]; t < c[1]; t++) taken.add(t)
    out.push(c)
  }
  return out.sort((a, b) => a[0] - b[0])
}
