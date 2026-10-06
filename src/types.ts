export type Lang = 'en' | 'bn'

export interface Tender {
  tender_id: string
  title: string
  procuring_entity: string
  bidder: string
  submission_deadline: string // YYYY-MM-DD
}

export interface Requirement {
  /** Internal unique key (normally the same as `id`). */
  key: string
  id: string
  order: number
  title_en: string
  title_bn: string
  mandatory: boolean
  has_expiry: boolean
}

export interface TenderProject {
  tender: Tender
  /** Always sorted by `order`. */
  requirements: Requirement[]
}

/**
 * 'direct'  – pages are copied as-is with pdf-lib.
 * 'raster'  – pdf-lib cannot read the file (e.g. owner-password protected),
 *             but pdf.js can, so pages are added as images.
 */
export type PdfMode = 'direct' | 'raster'

export interface UploadedFile {
  id: string
  name: string
  size: number
  pages: number
  hash: string
  mode: PdfMode
  /** Text of the first pages (used for auto-match and expiry hints). */
  text: string
  /** Expiry date found in the document text, YYYY-MM-DD. */
  detectedExpiry?: string
  bytes: Uint8Array
}

export type StatusCode = 'missing' | 'expiry_needed' | 'expired' | 'not_provided' | 'ok'

export type SealPlacement = 'all' | 'docs' | 'last' | 'custom'
export type SealPosition = 'bottom-right' | 'bottom-left' | 'bottom-center' | 'top-right' | 'top-left' | 'center'

export interface SealSettings {
  enabled: boolean
  name: string
  bytes: Uint8Array | null
  placement: SealPlacement
  customPages: string
  position: SealPosition
  width: number // points
}

export interface Notice {
  id: string
  kind: 'error' | 'warn' | 'info' | 'success'
  text: string
}
