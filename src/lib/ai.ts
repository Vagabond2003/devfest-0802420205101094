// Optional AI help (Rulebook 5.5): the user types their own Anthropic API key.
// The key is kept in memory only and is sent only to api.anthropic.com from this browser.
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import * as z from 'zod/v4'
import type { Requirement, UploadedFile } from '../types'
import { isIsoDate } from './util'

const MODEL = 'claude-opus-5-5'

const ResultSchema = z.object({
  matches: z.array(
    z.object({
      requirement_id: z.string().describe('The requirement key, e.g. "R01"'),
      file_id: z.string().describe('The file id, e.g. "F3"'),
      expiry_date: z.string().nullable().describe('Expiry / valid-until date shown in the document, as YYYY-MM-DD, or null'),
      confidence: z.enum(['high', 'medium', 'low']),
      reason: z.string().describe('Very short reason, max 12 words'),
    }),
  ),
})

export type AiErrorCode = 'auth' | 'rate' | 'network' | 'refusal' | 'other'
export class AiError extends Error {
  code: AiErrorCode
  constructor(code: AiErrorCode, message: string = code) {
    super(message)
    this.code = code
  }
}

export interface AiSuggestion {
  reqKey: string
  fileId: string
  expiry?: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

const SYSTEM = `You help office staff in Bangladesh prepare a tender submission package.
You get the list of documents the tender requires and the PDF files the user uploaded
(file name, page count, a short text extract, and for scanned files an image of the first page).
Match files to required documents.

Rules:
- Each file can be used for at most one document, and each document gets at most one file.
- Files marked as having the same content as another file are duplicates: use at most one of them.
- Only suggest a match when the file clearly is that document. Leave a document out if no file fits.
- If two files fit the same document (for example an old and a new licence), prefer the one that is still valid on the submission deadline.
- expiry_date: only the expiry / "valid until" date printed in the document, as YYYY-MM-DD. Never use an issue date. Use null if none is shown.`

/** Ask Claude to suggest file ↔ requirement matches. Only free requirements and files are sent. */
export async function aiSuggest(opts: {
  apiKey: string
  deadline: string
  requirements: Requirement[]
  files: UploadedFile[]
  duplicateOf: Map<string, string[]> // fileId → other file ids with the same content
  images: Map<string, string> // fileId → base64 JPEG of page 1 (scans only)
}): Promise<AiSuggestion[]> {
  const client = new Anthropic({ apiKey: opts.apiKey.trim(), dangerouslyAllowBrowser: true, maxRetries: 1 })

  const fileIds = new Map<string, string>() // short id → real id
  const shortOf = new Map<string, string>()
  opts.files.forEach((f, i) => {
    fileIds.set(`F${i + 1}`, f.id)
    shortOf.set(f.id, `F${i + 1}`)
  })

  const reqLines = opts.requirements.map(
    (r) => `- ${r.key}: "${r.title_en}" / "${r.title_bn}"${r.mandatory ? '' : ' (optional)'}${r.has_expiry ? ' (has expiry date)' : ''}`,
  )
  const fileLines = opts.files.map((f) => {
    const dups = (opts.duplicateOf.get(f.id) ?? []).map((d) => shortOf.get(d)).filter(Boolean)
    const excerpt = f.text.replace(/\s+/g, ' ').trim().slice(0, 700)
    return [
      `### ${shortOf.get(f.id)}: "${f.name}" (${f.pages} pages)${dups.length ? ` – same content as ${dups.join(', ')}` : ''}`,
      excerpt ? `Text: ${excerpt}` : 'Text: (none – scanned file, see image)',
    ].join('\n')
  })

  const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [
    {
      type: 'text',
      text: `Submission deadline: ${opts.deadline}\n\nRequired documents:\n${reqLines.join('\n')}\n\nUploaded files:\n${fileLines.join('\n\n')}`,
    },
  ]
  for (const [fid, b64] of opts.images) {
    const sid = shortOf.get(fid)
    if (!sid) continue
    content.push({ type: 'text', text: `First page of ${sid}:` })
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } })
  }

  let response
  try {
    response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      output_config: { effort: 'low', format: betaZodOutputFormat(ResultSchema) },
      messages: [{ role: 'user', content }],
    })
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new AiError('auth')
    if (e instanceof Anthropic.RateLimitError) throw new AiError('rate')
    if (e instanceof Anthropic.APIConnectionError) throw new AiError('network')
    if (e instanceof Anthropic.APIError) throw new AiError('other', `${e.status ?? ''} ${e.message}`.trim())
    throw new AiError('other', String((e as Error)?.message ?? e))
  }
  if (response.stop_reason === 'refusal') throw new AiError('refusal')
  const parsed = response.parsed_output
  if (!parsed) throw new AiError('other', 'no result')

  const validReq = new Set(opts.requirements.map((r) => r.key))
  return parsed.matches
    .filter((m) => validReq.has(m.requirement_id) && fileIds.has(m.file_id) && m.confidence !== 'low')
    .map((m) => ({
      reqKey: m.requirement_id,
      fileId: fileIds.get(m.file_id)!,
      expiry: isIsoDate(m.expiry_date ?? '') ? m.expiry_date! : undefined,
      confidence: m.confidence,
      reason: m.reason,
    }))
}
