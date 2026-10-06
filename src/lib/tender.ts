import type { Requirement, StatusCode, TenderProject, UploadedFile } from '../types'
import { isIsoDate } from './util'

export class RequirementsError extends Error {
  code: string
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.code = code
  }
}

function toBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (['true', 'yes', '1', 'y'].includes(s)) return true
    if (['false', 'no', '0', 'n'].includes(s)) return false
  }
  return fallback
}

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim())

/** Validate and normalise a parsed requirements.json. Throws RequirementsError with a code for the UI. */
export function parseRequirements(data: unknown): TenderProject {
  if (!data || typeof data !== 'object') throw new RequirementsError('not_object')
  const root = data as Record<string, unknown>
  const t = root.tender as Record<string, unknown> | undefined
  if (!t || typeof t !== 'object') throw new RequirementsError('no_tender')
  const reqs = root.requirements
  if (!Array.isArray(reqs)) throw new RequirementsError('no_requirements')

  const tender = {
    tender_id: str(t.tender_id),
    title: str(t.title),
    procuring_entity: str(t.procuring_entity),
    bidder: str(t.bidder),
    submission_deadline: str(t.submission_deadline),
  }
  if (!tender.tender_id) throw new RequirementsError('no_tender_id')
  if (!isIsoDate(tender.submission_deadline)) throw new RequirementsError('bad_deadline', tender.submission_deadline)

  const seen = new Map<string, number>()
  const requirements: Requirement[] = reqs.map((r: Record<string, unknown>, i: number) => {
    const id = str(r?.id) || `R${String(i + 1).padStart(2, '0')}`
    const count = (seen.get(id) ?? 0) + 1
    seen.set(id, count)
    const orderNum = Number(r?.order)
    const title_en = str(r?.title_en) || str(r?.title_bn) || id
    return {
      key: count > 1 ? `${id}#${count}` : id,
      id,
      order: Number.isFinite(orderNum) ? orderNum : i + 1,
      title_en,
      title_bn: str(r?.title_bn) || title_en,
      mandatory: toBool(r?.mandatory, true),
      has_expiry: toBool(r?.has_expiry, false),
    }
  })
  // Stable sort by order (ties keep file order).
  requirements.sort((a, b) => a.order - b.order)
  return { tender, requirements }
}

/** Section 5 status rules – exactly one status per requirement. */
export function statusOf(req: Requirement, file: UploadedFile | undefined, expiry: string | undefined, deadline: string): StatusCode {
  if (!file) return req.mandatory ? 'missing' : 'not_provided'
  if (req.has_expiry) {
    if (!isIsoDate(expiry)) return 'expiry_needed'
    // ISO dates compare correctly as strings. Same day as the deadline is still OK.
    if (expiry < deadline) return 'expired'
  }
  return 'ok'
}

export const BLOCKING: Record<StatusCode, boolean> = {
  missing: true,
  expiry_needed: true,
  expired: true,
  not_provided: false,
  ok: false,
}
