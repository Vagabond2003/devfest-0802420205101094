import type { Requirement, UploadedFile } from '../types'
import { bnToAsciiDigits, isIsoDate } from './util'

// ---------- Tokenising ----------

const STOP = new Set(['of', 'the', 'and', 'for', 'a', 'an', 'to', 'in', 'on', 'copy', 'final', 'scan', 'doc', 'pdf', 'file', 'new', 'old', 'updated', 'signed_copy'])

/** Common abbreviations / spellings → canonical word. */
const SYNONYMS: Record<string, string[]> = {
  licence: ['license'],
  lic: ['license'],
  cert: ['certificate'],
  certi: ['certificate'],
  certificates: ['certificate'],
  exp: ['experience'],
  tech: ['technical'],
  techn: ['technical'],
  fin: ['financial'],
  finance: ['financial'],
  price: ['financial', 'proposal'],
  boq: ['financial', 'proposal'],
  decl: ['declaration'],
  declare: ['declaration'],
  authorisation: ['authorization'],
  auth: ['authorization'],
  authorization: ['authorization'],
  maf: ['manufacturer', 'authorization'],
  mfr: ['manufacturer'],
  manufacturers: ['manufacturer'],
  audit: ['audited'],
  audited: ['audited'],
  statements: ['statement'],
  bin: ['vat'],
  solvent: ['solvency'],
  reg: ['registration'],
  registration: ['registration'],
  tradelicense: ['trade', 'license'],
  taxpayer: ['tin'],
}

function stem(w: string): string {
  if (w.endsWith("'s")) w = w.slice(0, -2)
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
  return w
}

export function tokens(s: string): string[] {
  const clean = bnToAsciiDigits(s)
    .replace(/\.pdf$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → words
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9ঀ-৿']+/g, ' ')
  const out: string[] = []
  for (let w of clean.split(' ')) {
    w = w.replace(/^'+|'+$/g, '')
    if (!w || STOP.has(w) || /^\d+$/.test(w)) continue
    w = stem(w)
    const syn = SYNONYMS[w]
    if (syn) out.push(...syn)
    else out.push(w)
  }
  return out
}

function phrase(s: string): string {
  return ' ' + s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9ঀ-৿']+/g, ' ').trim() + ' '
}

function latestYear(name: string): number {
  const ys = (bnToAsciiDigits(name).match(/(?:19|20)\d{2}/g) ?? []).map(Number)
  return ys.length ? Math.max(...ys) : 0
}

// ---------- Auto-match ----------

export interface MatchSuggestion {
  reqKey: string
  fileId: string
  score: number
}

/**
 * Suggest a file for each requirement, based mainly on the file name and,
 * as a weaker signal, on the requirement title appearing in the document text.
 * Respects existing matches, "one file per document" and duplicate groups.
 */
export function suggestMatches(
  requirements: Requirement[],
  files: UploadedFile[],
  current: Record<string, string>,
  deadline: string,
): MatchSuggestion[] {
  // Word weight = 1 / (how many requirement titles use the word), so generic words count less.
  const reqTokens = new Map<string, Set<string>>()
  const df = new Map<string, number>()
  for (const r of requirements) {
    const set = new Set([...tokens(r.title_en), ...tokens(r.title_bn)])
    reqTokens.set(r.key, set)
    for (const t of set) df.set(t, (df.get(t) ?? 0) + 1)
  }

  const usedFiles = new Set(Object.values(current))
  const usedHashes = new Set(files.filter((f) => usedFiles.has(f.id)).map((f) => f.hash))
  const freeReqs = requirements.filter((r) => !current[r.key])
  const freeFiles = files.filter((f) => !usedFiles.has(f.id) && !usedHashes.has(f.hash))

  const cands: MatchSuggestion[] = []
  for (const f of freeFiles) {
    const ft = new Set(tokens(f.name))
    const text = phrase(f.text.slice(0, 2500))
    for (const r of freeReqs) {
      const rt = reqTokens.get(r.key)!
      let nameScore = 0
      let strong = false
      for (const t of rt) {
        if (ft.has(t)) {
          const w = 1 / (df.get(t) ?? 1)
          nameScore += w
          if (w >= 0.5) strong = true
        }
      }
      // Fraction of the title covered by the file name helps break ties ("financial proposal" vs "audited financial statement").
      const cover = rt.size ? [...rt].filter((t) => ft.has(t)).length / rt.size : 0
      let score = nameScore + cover * 0.5
      const inText = text.includes(phrase(r.title_en)) || (r.title_bn && text.includes(phrase(r.title_bn)))
      if (inText) score += 0.9
      if (!strong && !inText) continue
      if (score < 0.75) continue
      // Prefer the newer document when several look alike (e.g. license_2025 vs license_2026).
      score += latestYear(f.name) / 1e6
      // Between copies, prefer "report.pdf" over "report (1).pdf" / "copy of report.pdf".
      if (/\(\d+\)|\bcopy\b/i.test(f.name)) score -= 0.001
      if (r.has_expiry && f.detectedExpiry && isIsoDate(f.detectedExpiry)) {
        score += f.detectedExpiry >= deadline ? 0.3 : -0.3
      }
      cands.push({ reqKey: r.key, fileId: f.id, score })
    }
  }

  cands.sort((a, b) => b.score - a.score)
  const takenReq = new Set<string>()
  const takenFile = new Set<string>()
  const takenHash = new Set<string>()
  const byId = new Map(files.map((f) => [f.id, f]))
  const out: MatchSuggestion[] = []
  for (const c of cands) {
    const f = byId.get(c.fileId)!
    if (takenReq.has(c.reqKey) || takenFile.has(c.fileId) || takenHash.has(f.hash)) continue
    takenReq.add(c.reqKey)
    takenFile.add(c.fileId)
    takenHash.add(f.hash)
    out.push(c)
  }
  return out
}

// ---------- Expiry date detection ----------

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
  জানুয়ারি: 1, জানুয়ারী: 1, ফেব্রুয়ারি: 2, ফেব্রুয়ারী: 2, মার্চ: 3, এপ্রিল: 4, মে: 5, জুন: 6, জুলাই: 7,
  আগস্ট: 8, সেপ্টেম্বর: 9, অক্টোবর: 10, নভেম্বর: 11, ডিসেম্বর: 12,
}

const p2 = (n: number) => String(n).padStart(2, '0')

function iso(y: number, m: number, d: number): string | null {
  const s = `${y}-${p2(m)}-${p2(d)}`
  return isIsoDate(s) ? s : null
}

const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')
const DATE_PATTERNS: { re: RegExp; get: (m: RegExpMatchArray) => string | null }[] = [
  { re: /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/, get: (m) => iso(+m[1], +m[2], +m[3]) },
  { re: new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?[\\s,-]+(${MONTH_RE})[\\s,.-]+(\\d{4})`, 'i'), get: (m) => iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]) },
  { re: new RegExp(`(${MONTH_RE})[\\s.-]+(\\d{1,2})(?:st|nd|rd|th)?,?[\\s-]+(\\d{4})`, 'i'), get: (m) => iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]) },
  // Day-first numeric dates, as used in Bangladesh (DD/MM/YYYY).
  { re: /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/, get: (m) => iso(+m[3], +m[2], +m[1]) },
]

const KEYWORDS = /(expir\w*|valid\s+(?:until|till|up\s*to|through|thru)|validity|মেয়াদ|মেয়াদ|বৈধ)/gi

/** Find an expiry date written near words like "expiry" / "valid until" / "মেয়াদ". */
export function detectExpiry(text: string): string | undefined {
  if (!text) return undefined
  const t = bnToAsciiDigits(text).replace(/\s+/g, ' ')
  KEYWORDS.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = KEYWORDS.exec(t))) {
    const windowText = t.slice(m.index, m.index + 90)
    let best: { idx: number; date: string } | null = null
    for (const p of DATE_PATTERNS) {
      const dm = windowText.match(p.re)
      if (dm && dm.index !== undefined) {
        const d = p.get(dm)
        if (d && (!best || dm.index < best.idx)) best = { idx: dm.index, date: d }
      }
    }
    if (best) return best.date
  }
  return undefined
}
