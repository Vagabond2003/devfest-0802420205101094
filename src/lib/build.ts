import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, degrees, rgb, type RGB } from 'pdf-lib'
import '@fontsource/noto-sans-bengali/400.css'
import '@fontsource/noto-sans-bengali/700.css'
import type { Requirement, SealSettings, Tender, UploadedFile } from '../types'
import { rasterizePdf } from './pdf'
import { formatDate, parsePageList } from './util'

const A4W = 595.28
const A4H = 841.89
/** Height of the white strip added under every page for the footer, in points. */
export const FOOTER_H = 30
const MARGIN = 50

export interface PackageItem {
  req: Requirement
  file: UploadedFile
  expiry?: string
}

export interface BuildInput {
  tender: Tender
  items: PackageItem[] // already sorted by order
  omitted: Requirement[] // optional requirements with no file
  includeIndex: boolean
  seal: SealSettings | null
  generatedOn: string // YYYY-MM-DD
}

export interface PlanEntry {
  reqKey: string
  start: number
  pages: number
}

export interface PackagePlan {
  indexPages: number
  total: number
  entries: PlanEntry[]
}

export interface BuildOutput {
  bytes: Uint8Array
  plan: PackagePlan
}

const INDEX_ROW_H = 24
const INDEX_TOP = 150 // space used by the index page header
function indexRowsPerPage(): number {
  return Math.floor((A4H - INDEX_TOP - 60) / INDEX_ROW_H)
}

/** Page numbers of the final package (cover = 1). */
export function planPackage(items: PackageItem[], includeIndex: boolean): PackagePlan {
  const indexPages = includeIndex ? Math.max(1, Math.ceil(items.length / indexRowsPerPage())) : 0
  let next = 1 + indexPages + 1
  const entries = items.map((it) => {
    const e = { reqKey: it.req.key, start: next, pages: it.file.pages }
    next += it.file.pages
    return e
  })
  return { indexPages, total: next - 1, entries }
}

// ---------------------------------------------------------------------------
// Visual frame: coordinates (u, v) measured on the page *as displayed*,
// u from the left edge, v from the bottom edge (including the footer strip).
// This lets us place the footer correctly on rotated pages too.
// ---------------------------------------------------------------------------
interface Frame {
  W: number
  H: number
  rot: number
  at: (u: number, v: number) => { x: number; y: number }
}

function plainFrame(page: PDFPage): Frame {
  const { width, height } = page.getSize()
  return { W: width, H: height, rot: 0, at: (u, v) => ({ x: u, y: v }) }
}

/** Grow the page by FOOTER_H at its visual bottom and paint that strip white. */
function extendForFooter(page: PDFPage): Frame {
  page.node.normalize() // wraps the original content in q/Q so its graphics state cannot leak into ours
  const rot = ((Math.round(page.getRotation().angle / 90) * 90) % 360 + 360) % 360
  const { x, y, width: w, height: h } = page.getCropBox()
  const F = FOOTER_H
  let box: [number, number, number, number]
  let strip: { x: number; y: number; width: number; height: number }
  let frame: Frame
  switch (rot) {
    case 90:
      box = [x, y, w + F, h]
      strip = { x: x + w, y, width: F, height: h }
      frame = { W: h, H: w + F, rot, at: (u, v) => ({ x: x + w + F - v, y: y + u }) }
      break
    case 180:
      box = [x, y, w, h + F]
      strip = { x, y: y + h, width: w, height: F }
      frame = { W: w, H: h + F, rot, at: (u, v) => ({ x: x + w - u, y: y + h + F - v }) }
      break
    case 270:
      box = [x - F, y, w + F, h]
      strip = { x: x - F, y, width: F, height: h }
      frame = { W: h, H: w + F, rot, at: (u, v) => ({ x: x - F + v, y: y + h - u }) }
      break
    default:
      box = [x, y - F, w, h + F]
      strip = { x, y: y - F, width: w, height: F }
      frame = { W: w, H: h + F, rot: 0, at: (u, v) => ({ x: x + u, y: y - F + v }) }
  }
  page.setMediaBox(...box)
  page.setCropBox(...box)
  page.setBleedBox(...box)
  page.setTrimBox(...box)
  page.setArtBox(...box)
  page.drawRectangle({ ...strip, color: rgb(1, 1, 1) })
  return frame
}

// ---------------------------------------------------------------------------
// Text drawing. Standard PDF fonts cannot show Bangla (or other non-Latin)
// text, so such strings are drawn by the browser on a canvas (correct Bangla
// shaping) and embedded as a high-resolution image.
// ---------------------------------------------------------------------------
const BN_FAMILY = '"Noto Sans Bengali", "Nirmala UI", "Vrinda", "Kohinoor Bangla", "Bangla Sangam MN", sans-serif'

class TextKit {
  doc: PDFDocument
  font: PDFFont
  bold: PDFFont
  private cache = new Map<string, { img: PDFImage; w: number; h: number; descent: number }>()

  constructor(doc: PDFDocument, font: PDFFont, bold: PDFFont) {
    this.doc = doc
    this.font = font
    this.bold = bold
  }

  canEncode(text: string, bold = false): boolean {
    try {
      ;(bold ? this.bold : this.font).encodeText(text)
      return true
    } catch {
      return false
    }
  }

  width(text: string, size: number, bold = false): number {
    if (this.canEncode(text, bold)) return (bold ? this.bold : this.font).widthOfTextAtSize(text, size)
    const c = document.createElement('canvas').getContext('2d')!
    c.font = `${bold ? 700 : 400} ${size}px ${BN_FAMILY}`
    return c.measureText(text).width
  }

  private async image(text: string, size: number, bold: boolean, color: string) {
    const key = `${text}|${size}|${bold}|${color}`
    const hit = this.cache.get(key)
    if (hit) return hit
    const scale = 4
    const px = size * scale
    const fontCss = `${bold ? 700 : 400} ${px}px ${BN_FAMILY}`
    try {
      await document.fonts.load(`${bold ? 700 : 400} ${px}px "Noto Sans Bengali"`, text)
    } catch {
      /* fall back to system fonts */
    }
    const canvas = document.createElement('canvas')
    let ctx = canvas.getContext('2d')!
    ctx.font = fontCss
    const m = ctx.measureText(text)
    const asc = Math.ceil(Math.max(m.actualBoundingBoxAscent || 0, px * 0.95)) + 4
    const desc = Math.ceil(Math.max(m.actualBoundingBoxDescent || 0, px * 0.35)) + 4
    canvas.width = Math.max(1, Math.ceil(m.width) + 8)
    canvas.height = asc + desc
    ctx = canvas.getContext('2d')!
    ctx.font = fontCss
    ctx.fillStyle = color
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(text, 4, asc)
    const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('png'))), 'image/png'))
    const img = await this.doc.embedPng(new Uint8Array(await blob.arrayBuffer()))
    const out = { img, w: canvas.width / scale, h: canvas.height / scale, descent: desc / scale, pad: 4 / scale }
    this.cache.set(key, out)
    return out
  }

  /** Draw text with its baseline at visual (u, v). */
  async draw(page: PDFPage, frame: Frame, text: string, u: number, v: number, size: number, opts: { bold?: boolean; color?: RGB } = {}) {
    if (!text) return
    const color = opts.color ?? rgb(0.1, 0.1, 0.1)
    if (this.canEncode(text, opts.bold)) {
      const p = frame.at(u, v)
      page.drawText(text, { x: p.x, y: p.y, size, font: opts.bold ? this.bold : this.font, color, rotate: degrees(frame.rot) })
      return
    }
    const css = `rgb(${Math.round(color.red * 255)},${Math.round(color.green * 255)},${Math.round(color.blue * 255)})`
    const im = await this.image(text, size, !!opts.bold, css)
    const p = frame.at(u - 1, v - im.descent)
    page.drawImage(im.img, { x: p.x, y: p.y, width: im.w, height: im.h, rotate: degrees(frame.rot) })
  }

  /** Split text into lines no wider than maxWidth. */
  wrap(text: string, size: number, maxWidth: number, bold = false): string[] {
    const words = text.split(/\s+/).filter(Boolean)
    const lines: string[] = []
    let line = ''
    for (const w of words) {
      const tryLine = line ? `${line} ${w}` : w
      if (this.width(tryLine, size, bold) <= maxWidth || !line) line = tryLine
      else {
        lines.push(line)
        line = w
      }
    }
    if (line) lines.push(line)
    return lines.length ? lines : ['']
  }
}

const TEAL = rgb(0.05, 0.3, 0.4)
const GRAY = rgb(0.38, 0.4, 0.43)
const LIGHT = rgb(0.93, 0.95, 0.96)

async function drawFooter(kit: TextKit, page: PDFPage, frame: Frame, text: string) {
  const size = 10
  const tw = kit.width(text, size)
  const a = frame.at(MARGIN - 14, FOOTER_H - 5)
  const b = frame.at(frame.W - MARGIN + 14, FOOTER_H - 5)
  page.drawLine({ start: a, end: b, thickness: 0.6, color: rgb(0.72, 0.74, 0.76) })
  await kit.draw(page, frame, text, (frame.W - tw) / 2, 11, size, { color: rgb(0.1, 0.1, 0.1) })
}

function newPage(doc: PDFDocument): { page: PDFPage; frame: Frame } {
  const page = doc.addPage([A4W, A4H + FOOTER_H])
  return { page, frame: plainFrame(page) }
}

async function drawCover(kit: TextKit, doc: PDFDocument, input: BuildInput, plan: PackagePlan) {
  const { page, frame } = newPage(doc)
  const H = frame.H
  const { tender } = input
  // Header band
  page.drawRectangle({ x: 0, y: H - 118, width: A4W, height: 118, color: TEAL })
  await kit.draw(page, frame, 'TENDER SUBMISSION PACKAGE', MARGIN, H - 62, 22, { bold: true, color: rgb(1, 1, 1) })
  await kit.draw(page, frame, 'Cover Page', MARGIN, H - 88, 11, { color: rgb(0.82, 0.9, 0.93) })

  // Tender details
  let v = H - 160
  const labelW = 150
  const valueX = MARGIN + labelW
  const valueW = A4W - MARGIN - valueX
  const rows: [string, string][] = [
    ['Tender ID', tender.tender_id],
    ['Tender Title', tender.title],
    ['Procuring Entity', tender.procuring_entity],
    ['Bidder', tender.bidder],
    ['Submission Deadline', `${tender.submission_deadline}  (${formatDate(tender.submission_deadline, 'en')})`],
    ['Package Prepared On', `${input.generatedOn}  (${formatDate(input.generatedOn, 'en')})`],
    ['Total Pages', String(plan.total)],
  ]
  for (const [label, value] of rows) {
    const lines = kit.wrap(value || '-', 11.5, valueW)
    await kit.draw(page, frame, label, MARGIN, v, 10.5, { bold: true, color: GRAY })
    for (let i = 0; i < lines.length; i++) await kit.draw(page, frame, lines[i], valueX, v - i * 15, 11.5, { bold: label === 'Tender ID' })
    v -= 15 * (lines.length - 1) + 24
  }

  // Included documents
  v -= 12
  page.drawLine({ start: { x: MARGIN, y: v + 14 }, end: { x: A4W - MARGIN, y: v + 14 }, thickness: 0.8, color: rgb(0.8, 0.83, 0.85) })
  v -= 10
  await kit.draw(page, frame, 'Included Documents (in package order)', MARGIN, v, 13.5, { bold: true, color: TEAL })
  v -= 24

  const cols = { no: MARGIN + 6, id: MARGIN + 34, doc: MARGIN + 74, pages: A4W - MARGIN - 130, valid: A4W - MARGIN - 80 }
  const items = input.items
  const omittedNote = input.omitted.length
    ? kit.wrap(`Not included (optional, not provided): ${input.omitted.map((r) => r.title_en).join('; ')}`, 9, A4W - 2 * MARGIN)
    : []
  const bottomLimit = FOOTER_H + 30 + omittedNote.length * 12
  const available = v - 18 - bottomLimit
  const rowH = Math.max(12, Math.min(21, available / Math.max(1, items.length)))
  const fs = rowH >= 18 ? 10.5 : rowH >= 15 ? 9.5 : 8

  page.drawRectangle({ x: MARGIN, y: v - 6, width: A4W - 2 * MARGIN, height: 20, color: TEAL })
  const hdr = rgb(1, 1, 1)
  await kit.draw(page, frame, 'No.', cols.no, v, 9.5, { bold: true, color: hdr })
  await kit.draw(page, frame, 'Req.', cols.id, v, 9.5, { bold: true, color: hdr })
  await kit.draw(page, frame, 'Document', cols.doc, v, 9.5, { bold: true, color: hdr })
  await kit.draw(page, frame, 'Pages', cols.pages, v, 9.5, { bold: true, color: hdr })
  await kit.draw(page, frame, 'Valid Until', cols.valid, v, 9.5, { bold: true, color: hdr })
  v -= 20
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (i % 2 === 1) page.drawRectangle({ x: MARGIN, y: v - rowH / 2 + fs / 2 - 3, width: A4W - 2 * MARGIN, height: rowH, color: LIGHT })
    const maxDocW = cols.pages - cols.doc - 8
    let title = it.req.title_en
    while (kit.width(title, fs) > maxDocW && title.length > 4) title = title.slice(0, -2).trimEnd() + '…'
    if (title !== it.req.title_en && !kit.canEncode(title)) title = it.req.title_en
    await kit.draw(page, frame, String(i + 1), cols.no, v, fs)
    await kit.draw(page, frame, it.req.id, cols.id, v, fs, { color: GRAY })
    await kit.draw(page, frame, title, cols.doc, v, fs)
    await kit.draw(page, frame, String(it.file.pages), cols.pages + 8, v, fs)
    await kit.draw(page, frame, it.req.has_expiry && it.expiry ? it.expiry : '-', cols.valid, v, fs)
    v -= rowH
  }
  if (!items.length) await kit.draw(page, frame, 'No documents.', cols.doc, v, fs, { color: GRAY })

  v -= 8
  for (const line of omittedNote) {
    await kit.draw(page, frame, line, MARGIN, v, 9, { color: GRAY })
    v -= 12
  }
}

async function drawIndex(kit: TextKit, doc: PDFDocument, input: BuildInput, plan: PackagePlan) {
  const per = indexRowsPerPage()
  const items = input.items
  for (let p = 0; p < plan.indexPages; p++) {
    const { page, frame } = newPage(doc)
    const H = frame.H
    page.drawRectangle({ x: 0, y: H - 92, width: A4W, height: 92, color: TEAL })
    await kit.draw(page, frame, 'INDEX', MARGIN, H - 52, 22, { bold: true, color: rgb(1, 1, 1) })
    await kit.draw(page, frame, 'সূচিপত্র', MARGIN + kit.width('INDEX', 22, true) + 14, H - 52, 18, { bold: true, color: rgb(1, 1, 1) })
    await kit.draw(page, frame, `${input.tender.tender_id}  -  ${input.tender.title}`, MARGIN, H - 75, 10, { color: rgb(0.82, 0.9, 0.93) })

    const cols = { no: MARGIN + 6, en: MARGIN + 34, bn: MARGIN + 220, pages: A4W - MARGIN - 112, start: A4W - MARGIN - 58 }
    let v = H - INDEX_TOP + 28
    page.drawRectangle({ x: MARGIN, y: v - 7, width: A4W - 2 * MARGIN, height: 22, color: LIGHT })
    await kit.draw(page, frame, 'No.', cols.no, v, 9.5, { bold: true, color: TEAL })
    await kit.draw(page, frame, 'Document', cols.en, v, 9.5, { bold: true, color: TEAL })
    await kit.draw(page, frame, 'নথির নাম', cols.bn, v, 9.5, { bold: true, color: TEAL })
    await kit.draw(page, frame, 'Pages', cols.pages, v, 9.5, { bold: true, color: TEAL })
    await kit.draw(page, frame, 'Starts on', cols.start, v, 9.5, { bold: true, color: TEAL })
    v -= INDEX_ROW_H

    const slice = items.slice(p * per, (p + 1) * per)
    for (let i = 0; i < slice.length; i++) {
      const it = slice[i]
      const n = p * per + i
      const entry = plan.entries[n]
      const fit = (t: string, w: number) => {
        let s = t
        while (kit.width(s, 10) > w && s.length > 4) s = s.slice(0, -2).trimEnd() + '…'
        return s
      }
      await kit.draw(page, frame, String(n + 1), cols.no, v, 10)
      await kit.draw(page, frame, fit(it.req.title_en, cols.bn - cols.en - 10), cols.en, v, 10)
      await kit.draw(page, frame, fit(it.req.title_bn, cols.pages - cols.bn - 10), cols.bn, v, 10)
      await kit.draw(page, frame, String(entry.pages), cols.pages + 8, v, 10)
      // dotted leader + start page
      await kit.draw(page, frame, `Page ${entry.start}`, cols.start, v, 10, { bold: true })
      page.drawLine({ start: { x: MARGIN, y: v - 8 }, end: { x: A4W - MARGIN, y: v - 8 }, thickness: 0.4, color: rgb(0.85, 0.87, 0.88) })
      v -= INDEX_ROW_H
    }
  }
}

function sealBox(frame: Frame, pos: SealSettings['position'], sw: number, sh: number) {
  const m = 36
  const bottom = FOOTER_H + 22
  switch (pos) {
    case 'bottom-left':
      return { u: m, v: bottom }
    case 'bottom-center':
      return { u: (frame.W - sw) / 2, v: bottom }
    case 'top-right':
      return { u: frame.W - m - sw, v: frame.H - m - sh }
    case 'top-left':
      return { u: m, v: frame.H - m - sh }
    case 'center':
      return { u: (frame.W - sw) / 2, v: (frame.H + FOOTER_H - sh) / 2 }
    default:
      return { u: frame.W - m - sw, v: bottom }
  }
}

/** Build the final package PDF (Section 6 of the problem statement). */
export async function buildPackage(input: BuildInput, onProgress?: (msg: string) => void): Promise<BuildOutput> {
  const plan = planPackage(input.items, input.includeIndex)
  const out = await PDFDocument.create()
  const kit = new TextKit(out, await out.embedFont(StandardFonts.Helvetica), await out.embedFont(StandardFonts.HelveticaBold))
  const frames: { page: PDFPage; frame: Frame }[] = []

  onProgress?.('cover')
  await drawCover(kit, out, input, plan)
  if (input.includeIndex) await drawIndex(kit, out, input, plan)
  for (const p of out.getPages()) frames.push({ page: p, frame: plainFrame(p) })

  const lastPages = new Set<number>()
  for (const it of input.items) {
    onProgress?.(it.file.name)
    if (it.file.mode === 'direct') {
      const src = await PDFDocument.load(it.file.bytes, { updateMetadata: false })
      const copied = await out.copyPages(src, src.getPageIndices())
      for (const pg of copied) {
        out.addPage(pg)
        frames.push({ page: pg, frame: extendForFooter(pg) })
      }
    } else {
      const imgs = await rasterizePdf(it.file.bytes)
      for (const im of imgs) {
        const pg = out.addPage([im.width, im.height])
        const jpg = await out.embedJpg(im.jpg)
        pg.drawImage(jpg, { x: 0, y: 0, width: im.width, height: im.height })
        frames.push({ page: pg, frame: extendForFooter(pg) })
      }
    }
    lastPages.add(frames.length)
  }

  const total = frames.length
  if (total !== plan.total) plan.total = total // safety: footer always uses the real count

  // Seal / signature
  if (input.seal?.enabled && input.seal.bytes) {
    const img = await out.embedPng(input.seal.bytes)
    const sw = input.seal.width
    const sh = (img.height / img.width) * sw
    const firstDocPage = 1 + plan.indexPages + 1
    let targets: Set<number>
    switch (input.seal.placement) {
      case 'all':
        targets = new Set(frames.map((_, i) => i + 1))
        break
      case 'docs':
        targets = new Set(frames.map((_, i) => i + 1).filter((n) => n >= firstDocPage))
        break
      case 'last':
        targets = lastPages
        break
      default:
        targets = parsePageList(input.seal.customPages, total)
    }
    for (const n of targets) {
      const { page, frame } = frames[n - 1]
      const { u, v } = sealBox(frame, input.seal.position, sw, sh)
      const p = frame.at(u, v)
      page.drawImage(img, { x: p.x, y: p.y, width: sw, height: sh, rotate: degrees(frame.rot) })
    }
  }

  // Footer on every page, including the cover: "<tender_id> | Page X of Y"
  onProgress?.('footer')
  for (let i = 0; i < frames.length; i++) {
    await drawFooter(kit, frames[i].page, frames[i].frame, `${input.tender.tender_id} | Page ${i + 1} of ${total}`)
  }

  out.setTitle(`${input.tender.tender_id} - Tender Submission Package`)
  out.setSubject(input.tender.title)
  out.setAuthor(input.tender.bidder)
  out.setCreator('Tender Package Builder')
  out.setProducer('Tender Package Builder (pdf-lib)')
  const bytes = await out.save()
  return { bytes, plan }
}
