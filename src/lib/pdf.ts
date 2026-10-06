import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PDFDocument } from 'pdf-lib'
import type { PdfMode } from '../types'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export type InspectFailure = 'not_pdf' | 'password' | 'damaged' | 'empty'

export interface InspectResult {
  ok: true
  pages: number
  mode: PdfMode
  text: string
}

export interface InspectError {
  ok: false
  reason: InspectFailure
}

export interface OpenedPdf {
  doc: pdfjs.PDFDocumentProxy
  destroy: () => void
}

/** pdf.js transfers (detaches) the buffer it is given, so always hand it a copy. */
export async function openWithPdfJs(bytes: Uint8Array, password?: string): Promise<OpenedPdf> {
  const task = pdfjs.getDocument({ data: bytes.slice(), password, stopAtErrors: false })
  try {
    const doc = await task.promise
    return { doc, destroy: () => void task.destroy() }
  } catch (e) {
    void task.destroy()
    throw e
  }
}

async function extractText(doc: pdfjs.PDFDocumentProxy, maxPages: number): Promise<string> {
  const parts: string[] = []
  for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
    try {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      for (const item of content.items) {
        if ('str' in item) parts.push(item.str + (item.hasEOL ? '\n' : ' '))
      }
      parts.push('\n')
    } catch {
      /* ignore text errors – text is only used for hints */
    }
  }
  return parts.join('').replace(/[ \t]+/g, ' ')
}

/**
 * Check that a file is a usable PDF. Returns the page count and whether the
 * pages can be copied directly (pdf-lib) or must be rasterised (pdf.js only).
 */
export async function inspectPdf(bytes: Uint8Array): Promise<InspectResult | InspectError> {
  let libPages = -1
  let libError: 'encrypted' | 'broken' | null = null
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    libPages = doc.getPageCount()
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).toLowerCase()
    libError = msg.includes('encrypt') ? 'encrypted' : 'broken'
  }

  let opened: OpenedPdf | null = null
  try {
    opened = await openWithPdfJs(bytes)
  } catch (e) {
    const name = (e as { name?: string })?.name ?? ''
    if (name === 'PasswordException') return { ok: false, reason: 'password' }
    opened = null
  }
  const jsDoc = opened?.doc ?? null

  try {
    if (!jsDoc) {
      // pdf.js could not open it. Accept only if pdf-lib read real pages.
      if (libError === null && libPages > 0) return { ok: true, pages: libPages, mode: 'direct', text: '' }
      return { ok: false, reason: 'damaged' }
    }
    const pages = jsDoc.numPages
    if (pages < 1) return { ok: false, reason: 'empty' }
    // Make sure at least the first page really loads (catches badly damaged files).
    try {
      await jsDoc.getPage(1)
    } catch {
      return { ok: false, reason: 'damaged' }
    }
    const text = await extractText(jsDoc, 3)
    if (libError === null && libPages === pages) return { ok: true, pages, mode: 'direct', text }
    // Readable by pdf.js only (owner-password protected or structure pdf-lib cannot parse).
    return { ok: true, pages, mode: 'raster', text }
  } finally {
    opened?.destroy()
  }
}

/** Render one page into a canvas, at a CSS width in pixels. */
export async function renderPageToCanvas(
  doc: pdfjs.PDFDocumentProxy,
  pageNo: number,
  canvas: HTMLCanvasElement,
  cssWidth: number,
) {
  const page = await doc.getPage(pageNo)
  const base = page.getViewport({ scale: 1 })
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const scale = (cssWidth / base.width) * dpr
  const viewport = page.getViewport({ scale })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  canvas.style.width = `${cssWidth}px`
  canvas.style.height = `${Math.floor(viewport.height / dpr)}px`
  const ctx = canvas.getContext('2d')!
  await page.render({ canvasContext: ctx, viewport, canvas }).promise
}

/** Rasterise every page of a PDF (fallback for files pdf-lib cannot copy). */
export async function rasterizePdf(bytes: Uint8Array, scale = 2): Promise<{ jpg: Uint8Array; width: number; height: number }[]> {
  const opened = await openWithPdfJs(bytes)
  const doc = opened.doc
  const out: { jpg: Uint8Array; width: number; height: number }[] = []
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const vp1 = page.getViewport({ scale: 1 })
      const vp = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(vp.width)
      canvas.height = Math.ceil(vp.height)
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise
      const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', 0.92))
      out.push({ jpg: new Uint8Array(await blob.arrayBuffer()), width: vp1.width, height: vp1.height })
    }
  } finally {
    opened.destroy()
  }
  return out
}

/** Small JPEG (base64, no data: prefix) of page 1 – used only for the optional AI help on scanned files. */
export async function firstPageJpegBase64(bytes: Uint8Array, width = 900): Promise<string> {
  const opened = await openWithPdfJs(bytes)
  try {
    const page = await opened.doc.getPage(1)
    const base = page.getViewport({ scale: 1 })
    const vp = page.getViewport({ scale: width / base.width })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(vp.width)
    canvas.height = Math.ceil(vp.height)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise
    return canvas.toDataURL('image/jpeg', 0.8).split(',')[1]
  } finally {
    opened.destroy()
  }
}
