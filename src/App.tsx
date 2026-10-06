import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { STRINGS, type Strings } from './i18n'
import type { Lang, Requirement, SealSettings, StatusCode, TenderProject, UploadedFile } from './types'
import { BLOCKING, RequirementsError, parseRequirements, statusOf } from './lib/tender'
import { firstPageJpegBase64, inspectPdf, openWithPdfJs, renderPageToCanvas } from './lib/pdf'
import { detectExpiry, suggestMatches } from './lib/match'
import { buildPackage, planPackage } from './lib/build'
import { clearLocal, exportProjectFile, importProjectFile, isProjectFileJson, loadLocal, saveLocal, type SavedState } from './lib/storage'
import {
  csvCell, downloadBlob, formatBytes, formatDate, isIsoDate, looksLikePdf, looksLikePng, num, readFileBytes,
  safeFileName, sha256Hex, todayIso, uid,
} from './lib/util'

gsap.registerPlugin(useGSAP)

const MOTION_OK = '(prefers-reduced-motion: no-preference)'

const MAX_FILES = 30
const MAX_MB = 50
const MAX_BYTES = MAX_MB * 1024 * 1024

type Area = 'json' | 'files' | 'match' | 'build' | 'top'
interface Msg {
  id: string
  area: Area
  kind: 'error' | 'warn' | 'info' | 'success'
  key: keyof Strings
  args: (string | number)[]
}

const DEFAULT_SEAL: SealSettings = {
  enabled: false,
  name: '',
  bytes: null,
  placement: 'last',
  customPages: '',
  position: 'bottom-right',
  width: 90,
}

const STATUS_ICON: Record<StatusCode, string> = {
  missing: '✕',
  expiry_needed: '!',
  expired: '✕',
  not_provided: '–',
  ok: '✓',
}

function msgText(T: Strings, m: Msg): string {
  const v = T[m.key] as unknown
  if (typeof v === 'function') return (v as (...a: (string | number)[]) => string)(...m.args)
  if (v && typeof v === 'object') {
    const map = v as Record<string, string>
    const base = map[String(m.args[0])] ?? map.other ?? ''
    return m.args[1] ? `${base} (${m.args[1]})` : base
  }
  return String(v)
}

function title(req: Requirement, lang: Lang) {
  return lang === 'bn' ? req.title_bn : req.title_en
}

// ---------------------------------------------------------------------------

function DropZone(props: {
  label: string
  sub: string
  multiple?: boolean
  accept?: string
  onFiles: (files: File[]) => void
  compact?: boolean
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <div
      className={`drop${over ? ' over' : ''}${props.compact ? ' compact' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => ref.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          ref.current?.click()
        }
      }}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        props.onFiles(Array.from(e.dataTransfer.files))
      }}
    >
      <input
        ref={ref}
        type="file"
        hidden
        multiple={props.multiple}
        accept={props.accept}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          props.onFiles(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
      <span className="btn primary">{props.label}</span>
      {props.sub && <span className="drop-sub">{props.sub}</span>}
    </div>
  )
}

function StatusBadge({ status, T }: { status: StatusCode; T: Strings }) {
  return (
    <span className={`status st-${status}`}>
      <span className="st-icon" aria-hidden>
        {STATUS_ICON[status]}
      </span>
      {T.statuses[status]}
    </span>
  )
}

function PreviewModal({ file, onClose, T, lang }: { file: UploadedFile; onClose: () => void; T: Strings; lang: Lang }) {
  const holder = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    let docRef: { destroy: () => void } | null = null
    const el = holder.current
    ;(async () => {
      try {
        const opened = await openWithPdfJs(file.bytes)
        docRef = opened
        const doc = opened.doc
        const width = Math.min(760, window.innerWidth - 64)
        for (let p = 1; p <= Math.min(doc.numPages, 40); p++) {
          if (cancelled) return
          const wrap = document.createElement('figure')
          const canvas = document.createElement('canvas')
          const cap = document.createElement('figcaption')
          cap.textContent = `${T.page} ${num(p, lang)} / ${num(doc.numPages, lang)}`
          wrap.append(canvas, cap)
          el?.append(wrap)
          await renderPageToCanvas(doc, p, canvas, width)
          if (p === 1) setLoading(false)
        }
        setLoading(false)
      } catch {
        if (!cancelled) {
          setError(true)
          setLoading(false)
        }
      }
    })()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      cancelled = true
      window.removeEventListener('keydown', onKey)
      el?.querySelectorAll('figure').forEach((f) => f.remove())
      docRef?.destroy()
    }
  }, [file, onClose, T, lang])

  return (
    <div className="modal-back" onClick={onClose} role="dialog" aria-modal="true" aria-label={file.name}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <strong>{file.name}</strong>
          <span className="muted">{T.pages(file.pages)}</span>
          <button className="btn" onClick={onClose} autoFocus>
            {T.close}
          </button>
        </header>
        <div className="modal-body" ref={holder}>
          {loading && <p className="muted">{T.loadingPreview}</p>}
          {error && <p className="msg error">{T.rejectDamaged(file.name)}</p>}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------

export default function App() {
  const [lang, setLang] = useState<Lang>(() => {
    try {
      return localStorage.getItem('tpb-lang') === 'bn' ? 'bn' : 'en'
    } catch {
      return 'en'
    }
  })
  const T = STRINGS[lang]

  const [project, setProject] = useState<TenderProject | null>(null)
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [matches, setMatches] = useState<Record<string, string>>({})
  const [expiry, setExpiry] = useState<Record<string, string>>({})
  const [suggested, setSuggested] = useState<string[]>([])
  const [includeIndex, setIncludeIndex] = useState(true)
  const [seal, setSeal] = useState<SealSettings>(DEFAULT_SEAL)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [busy, setBusy] = useState<'files' | 'build' | null>(null)
  const [progress, setProgress] = useState('')
  const [buildError, setBuildError] = useState<string | null>(null)
  const [preview, setPreview] = useState<UploadedFile | null>(null)
  const [restoredAt, setRestoredAt] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [savedTick, setSavedTick] = useState(false)
  const [result, setResult] = useState<{ url: string; name: string; total: number; sig: object } | null>(null)

  const closePreview = useCallback(() => setPreview(null), [])
  const appRef = useRef<HTMLDivElement>(null)
  // Optional AI help – the key lives only in memory, never saved or sent anywhere except Anthropic.
  const [aiKey, setAiKey] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiReasons, setAiReasons] = useState<Record<string, string>>({})
  const filesRef = useRef(files)
  useEffect(() => {
    filesRef.current = files
  }, [files])

  useEffect(() => {
    document.documentElement.lang = lang === 'bn' ? 'bn' : 'en'
    document.title = STRINGS[lang].appTitle
    try {
      localStorage.setItem('tpb-lang', lang)
    } catch {
      /* ignore */
    }
  }, [lang])

  // Stop the browser from opening files dropped outside the drop areas.
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
    }
  }, [])

  const say = useCallback((area: Area, kind: Msg['kind'], key: keyof Strings, ...args: (string | number)[]) => {
    setMsgs((m) => [...m, { id: uid(), area, kind, key, args }])
  }, [])
  const clearArea = (area: Area) => setMsgs((m) => m.filter((x) => x.area !== area))
  const dismiss = (id: string) => setMsgs((m) => m.filter((x) => x.id !== id))

  // ----- Restore previous work from this browser -----
  const applyState = useCallback((s: SavedState) => {
    setProject(s.project)
    setFiles(s.files ?? [])
    setMatches(s.matches ?? {})
    setExpiry(s.expiry ?? {})
    setSuggested(s.suggested ?? [])
    setIncludeIndex(s.includeIndex ?? true)
    setSeal({ ...DEFAULT_SEAL, ...(s.seal ?? {}) })
  }, [])

  useEffect(() => {
    loadLocal().then((s) => {
      if (s && (s.project || s.files.length)) {
        applyState(s)
        setRestoredAt(s.savedAt)
      }
      setReady(true)
    })
  }, [applyState])

  const snapshot = useCallback(
    (): SavedState => ({
      version: 1,
      project,
      files,
      matches,
      expiry,
      suggested,
      includeIndex,
      seal,
      savedAt: new Date().toISOString(),
    }),
    [project, files, matches, expiry, suggested, includeIndex, seal],
  )

  // Autosave to this browser (debounced).
  useEffect(() => {
    if (!ready) return
    const t = setTimeout(() => {
      saveLocal(snapshot())
        .then(() => {
          setSavedTick(true)
          setTimeout(() => setSavedTick(false), 1500)
        })
        .catch(() => {})
    }, 600)
    return () => clearTimeout(t)
  }, [ready, snapshot])

  // A new object whenever an input of the package changes – used to detect a stale result.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sig = useMemo(() => ({}), [project, files, matches, expiry, includeIndex, seal])

  // ----- Derived data -----
  const deadline = project?.tender.submission_deadline ?? ''
  const fileById = useMemo(() => new Map(files.map((f) => [f.id, f])), [files])
  const reqByKey = useMemo(() => new Map((project?.requirements ?? []).map((r) => [r.key, r])), [project])
  const usedBy = useMemo(() => {
    const m = new Map<string, string>()
    for (const [rk, fid] of Object.entries(matches)) if (fileById.has(fid) && reqByKey.has(rk)) m.set(fid, rk)
    return m
  }, [matches, fileById, reqByKey])
  const dupOf = useMemo(() => {
    const byHash = new Map<string, UploadedFile[]>()
    for (const f of files) byHash.set(f.hash, [...(byHash.get(f.hash) ?? []), f])
    const m = new Map<string, UploadedFile[]>()
    for (const f of files) {
      const others = (byHash.get(f.hash) ?? []).filter((g) => g.id !== f.id)
      if (others.length) m.set(f.id, others)
    }
    return m
  }, [files])

  const rows = useMemo(
    () =>
      (project?.requirements ?? []).map((req) => {
        const file = fileById.get(matches[req.key])
        const status = statusOf(req, file, expiry[req.key], deadline)
        return { req, file, status }
      }),
    [project, fileById, matches, expiry, deadline],
  )
  const blocking = rows.filter((r) => BLOCKING[r.status])
  const included = useMemo(() => rows.filter((r) => r.file), [rows])
  const plan = useMemo(
    () => planPackage(included.map((r) => ({ req: r.req, file: r.file!, expiry: expiry[r.req.key] })), includeIndex),
    [included, includeIndex, expiry],
  )
  const unused = files.filter((f) => !usedBy.has(f.id))
  const totalSize = files.reduce((s, f) => s + f.size, 0)
  const counts = rows.reduce<Record<StatusCode, number>>(
    (acc, r) => {
      acc[r.status] += 1
      return acc
    },
    { ok: 0, missing: 0, expiry_needed: 0, expired: 0, not_provided: 0 },
  )

  /** Why a file cannot be chosen for a requirement (or null when it can). */
  const blockedReason = (fileId: string, reqKey: string): string | null => {
    const owner = usedBy.get(fileId)
    if (owner && owner !== reqKey) return `${T.inUseBy} ${title(reqByKey.get(owner)!, lang)}`
    for (const g of dupOf.get(fileId) ?? []) {
      const gOwner = usedBy.get(g.id)
      if (gOwner && gOwner !== reqKey) return T.dupInUse
    }
    return null
  }

  // ----- Actions -----
  const loadRequirementsData = (data: unknown) => {
    setJsonError(null)
    clearArea('json')
    try {
      const p = parseRequirements(data)
      setProject(p)
      setMatches({})
      setExpiry({})
      setSuggested([])
      say('json', 'success', 'jsonLoaded', p.requirements.length)
    } catch (e) {
      setJsonError(e instanceof RequirementsError ? e.code : 'not_object')
    }
  }

  const openJsonFile = async (file: File) => {
    let data: unknown
    try {
      data = JSON.parse(await file.text())
    } catch {
      setJsonError('parse')
      return
    }
    if (isProjectFileJson(data)) {
      try {
        applyState(importProjectFile(data))
        setJsonError(null)
        say('top', 'success', 'projectLoaded')
      } catch {
        say('top', 'error', 'projectBad')
      }
      return
    }
    loadRequirementsData(data)
  }

  const addFiles = async (list: File[]) => {
    if (!list.length) return
    clearArea('files')
    const isJson = (f: File) => /\.json$/i.test(f.name)
    for (const j of list.filter(isJson)) await openJsonFile(j)
    const others = list.filter((f) => !isJson(f))
    if (!others.length) return

    setBusy('files')
    const existing = filesRef.current
    let count = existing.length
    let total = existing.reduce((s, f) => s + f.size, 0)
    const added: UploadedFile[] = []
    const known: UploadedFile[] = [...existing]
    for (const file of others) {
      setProgress(file.name)
      if (count >= MAX_FILES) {
        say('files', 'error', 'rejectTooMany', file.name, MAX_FILES)
        continue
      }
      if (total + file.size > MAX_BYTES) {
        say('files', 'error', 'rejectTooBig', file.name, MAX_MB)
        continue
      }
      let bytes: Uint8Array
      try {
        bytes = await readFileBytes(file)
      } catch {
        say('files', 'error', 'rejectDamaged', file.name)
        continue
      }
      if (!looksLikePdf(bytes)) {
        say('files', 'error', 'rejectNotPdf', file.name)
        continue
      }
      let res: Awaited<ReturnType<typeof inspectPdf>>
      try {
        res = await inspectPdf(bytes)
      } catch {
        res = { ok: false, reason: 'damaged' }
      }
      if (!res.ok) {
        const key = res.reason === 'password' ? 'rejectPassword' : res.reason === 'empty' ? 'rejectEmpty' : 'rejectDamaged'
        say('files', 'error', key, file.name)
        continue
      }
      const hash = await sha256Hex(bytes)
      const uf: UploadedFile = {
        id: uid(),
        name: file.name,
        size: file.size,
        pages: res.pages,
        hash,
        mode: res.mode,
        text: res.text.slice(0, 8000),
        detectedExpiry: detectExpiry(res.text),
        bytes,
      }
      const twin = known.find((k) => k.hash === hash)
      if (twin) say('files', 'warn', 'dupFound', uf.name, twin.name)
      known.push(uf)
      added.push(uf)
      count++
      total += file.size
    }
    if (added.length) {
      setFiles((prev) => [...prev, ...added])
      say('files', 'success', 'addedFiles', added.length)
    }
    setBusy(null)
    setProgress('')
  }

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id))
    const keys = Object.entries(matches)
      .filter(([, fid]) => fid === id)
      .map(([k]) => k)
    if (keys.length) {
      setMatches((m) => {
        const n = { ...m }
        keys.forEach((k) => delete n[k])
        return n
      })
      setExpiry((e) => {
        const n = { ...e }
        keys.forEach((k) => delete n[k])
        return n
      })
      setSuggested((s) => s.filter((k) => !keys.includes(k)))
    }
  }

  const assign = (reqKey: string, fileId: string) => {
    if (fileId && blockedReason(fileId, reqKey)) return // enforce the matching rules
    if ((matches[reqKey] ?? '') === fileId) return
    setMatches((m) => {
      const n = { ...m }
      if (fileId) n[reqKey] = fileId
      else delete n[reqKey]
      return n
    })
    // A different file means the old expiry date no longer applies.
    setExpiry((e) => {
      const n = { ...e }
      delete n[reqKey]
      return n
    })
    setSuggested((s) => s.filter((k) => k !== reqKey))
  }

  const autoMatch = () => {
    if (!project) return
    clearArea('match')
    const sug = suggestMatches(project.requirements, files, matches, deadline)
    if (sug.length) {
      setMatches((m) => ({ ...m, ...Object.fromEntries(sug.map((s) => [s.reqKey, s.fileId])) }))
      setSuggested((s) => [...new Set([...s, ...sug.map((x) => x.reqKey)])])
    }
    say('match', sug.length ? 'success' : 'info', 'autoMatched', sug.length)
  }

  const runAi = async () => {
    if (!project || !aiKey.trim()) return
    clearArea('match')
    const usedFiles = new Set(usedBy.keys())
    const usedHashes = new Set(files.filter((f) => usedFiles.has(f.id)).map((f) => f.hash))
    const freeReqs = project.requirements.filter((r) => !fileById.has(matches[r.key]))
    const freeFiles = files.filter((f) => !usedFiles.has(f.id) && !usedHashes.has(f.hash))
    if (!freeReqs.length || !freeFiles.length) {
      say('match', 'info', 'aiNothingToDo')
      return
    }
    setAiBusy(true)
    try {
      const { aiSuggest } = await import('./lib/ai')
      const images = new Map<string, string>()
      for (const f of freeFiles.filter((x) => x.text.trim().length < 40).slice(0, 8)) {
        try {
          images.set(f.id, await firstPageJpegBase64(f.bytes))
        } catch {
          /* skip files that cannot be rendered */
        }
      }
      const duplicateOf = new Map(freeFiles.map((f) => [f.id, (dupOf.get(f.id) ?? []).map((g) => g.id)]))
      const sug = await aiSuggest({ apiKey: aiKey, deadline, requirements: freeReqs, files: freeFiles, duplicateOf, images })
      // Apply only what respects the matching rules (one file per document, one copy per duplicate group).
      const takenReq = new Set<string>()
      const takenFile = new Set<string>()
      const takenHash = new Set(usedHashes)
      const applied = sug.filter((x) => {
        const f = fileById.get(x.fileId)
        if (!f || takenReq.has(x.reqKey) || takenFile.has(f.id) || takenHash.has(f.hash)) return false
        takenReq.add(x.reqKey)
        takenFile.add(f.id)
        takenHash.add(f.hash)
        return true
      })
      if (applied.length) {
        setMatches((m) => ({ ...m, ...Object.fromEntries(applied.map((x) => [x.reqKey, x.fileId])) }))
        setSuggested((s) => [...new Set([...s, ...applied.map((x) => x.reqKey)])])
        setAiReasons((r) => ({ ...r, ...Object.fromEntries(applied.map((x) => [x.reqKey, x.reason])) }))
        const dated = new Map(applied.filter((x) => x.expiry).map((x) => [x.fileId, x.expiry!]))
        if (dated.size) setFiles((prev) => prev.map((f) => (dated.has(f.id) && !f.detectedExpiry ? { ...f, detectedExpiry: dated.get(f.id) } : f)))
      }
      say('match', applied.length ? 'success' : 'info', 'aiDone', applied.length)
    } catch (e) {
      const err = e as { code?: string; message?: string }
      say('match', 'error', 'aiErr', err.code ?? 'other', err.code === 'other' ? (err.message ?? '') : '')
    } finally {
      setAiBusy(false)
    }
  }

  const startOver = async () => {
    if (!window.confirm(T.startOverConfirm)) return
    setProject(null)
    setFiles([])
    setMatches({})
    setExpiry({})
    setSuggested([])
    setIncludeIndex(true)
    setSeal(DEFAULT_SEAL)
    setMsgs([])
    setJsonError(null)
    setRestoredAt(null)
    setResult(null)
    await clearLocal()
  }

  const generate = async () => {
    if (!project || blocking.length) return
    setBusy('build')
    setBuildError(null)
    const mySig = sig
    try {
      const items = included.map((r) => ({ req: r.req, file: r.file!, expiry: expiry[r.req.key] }))
      const omitted = rows.filter((r) => !r.file).map((r) => r.req)
      const out = await buildPackage(
        {
          tender: project.tender,
          items,
          omitted,
          includeIndex,
          seal: seal.enabled && seal.bytes ? seal : null,
          generatedOn: todayIso(),
        },
        (m) => setProgress(m),
      )
      const blob = new Blob([out.bytes as BlobPart], { type: 'application/pdf' })
      setResult((old) => {
        if (old) URL.revokeObjectURL(old.url)
        return {
          url: URL.createObjectURL(blob),
          name: `${safeFileName(project.tender.tender_id)}_Package.pdf`,
          total: out.plan.total,
          sig: mySig,
        }
      })
    } catch (e) {
      setBuildError(String((e as Error)?.message ?? e))
    } finally {
      setBusy(null)
      setProgress('')
    }
  }

  const exportCsv = () => {
    if (!project) return
    const lines: string[][] = [T.csvHeaders]
    for (const r of rows) {
      lines.push([
        String(r.req.order),
        r.req.id,
        title(r.req, lang),
        r.req.mandatory ? T.yes : T.no,
        r.file?.name ?? '',
        r.file ? String(r.file.pages) : '',
        r.req.has_expiry ? (expiry[r.req.key] ?? '') : '',
        T.statuses[r.status],
      ])
    }
    const csv = '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n')
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${safeFileName(project.tender.tender_id)}_Checklist.csv`)
  }

  const saveProjectFile = () => {
    const name = project ? `${safeFileName(project.tender.tender_id)}_project.json` : 'tender_project.json'
    downloadBlob(exportProjectFile(snapshot()), name)
  }

  const chooseSeal = async (list: File[]) => {
    const f = list[0]
    if (!f) return
    const bytes = await readFileBytes(f)
    if (!looksLikePng(bytes)) {
      say('build', 'error', 'sealNotPng')
      return
    }
    clearArea('build')
    setSeal((s) => ({ ...s, bytes, name: f.name, enabled: true }))
  }

  const sealPreviewUrl = useMemo(
    () => (seal.bytes ? URL.createObjectURL(new Blob([seal.bytes as BlobPart], { type: 'image/png' })) : null),
    [seal.bytes],
  )

  const blockText = (r: (typeof rows)[number]) => {
    const name = title(r.req, lang)
    if (r.status === 'missing') return T.blockMissing(name)
    if (r.status === 'expiry_needed') return T.blockExpiryNeeded(name)
    return T.blockExpired(name, formatDate(expiry[r.req.key], lang), formatDate(deadline, lang))
  }

  const area = (a: Area) =>
    msgs
      .filter((m) => m.area === a)
      .map((m) => (
        <div key={m.id} className={`msg ${m.kind}`} role={m.kind === 'error' ? 'alert' : 'status'}>
          <span>{msgText(T, m)}</span>
          <button className="x" onClick={() => dismiss(m.id)} aria-label={T.close}>
            ×
          </button>
        </div>
      ))

  const showResult = result && result.sig === sig

  // GSAP: one staggered entrance when the app opens (skipped for reduced-motion users).
  useGSAP(
    () => {
      const mm = gsap.matchMedia()
      mm.add(MOTION_OK, () => {
        gsap.from('.topbar, .stepper li, main > .card', {
          autoAlpha: 0,
          y: 14,
          duration: 0.45,
          ease: 'power2.out',
          stagger: 0.06,
          clearProps: 'opacity,visibility,transform',
        })
      })
      return () => mm.revert()
    },
    { scope: appRef },
  )

  // GSAP: reveal the finished package and draw the eye to the Download button.
  useGSAP(
    () => {
      const panel = appRef.current?.querySelector('.result')
      if (!result || !panel) return
      const mm = gsap.matchMedia()
      mm.add(MOTION_OK, () => {
        gsap
          .timeline()
          .from(panel, { autoAlpha: 0, y: 16, duration: 0.4, ease: 'power3.out' })
          .from(panel.querySelector('.btn.primary'), { scale: 0.96, duration: 0.45, ease: 'back.out(3)' }, '-=0.15')
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      })
      return () => mm.revert()
    },
    { scope: appRef, dependencies: [result?.url] },
  )
  const stepDone = [!!project, files.length > 0, !!project && files.length > 0 && blocking.length === 0, !!showResult]

  // -------------------------------------------------------------------------
  return (
    <div className="app" ref={appRef}>
      <header className="topbar">
        <div className="brand">
          <div className="logo" aria-hidden>
            TP
          </div>
          <div>
            <h1>{T.appTitle}</h1>
            <p className="tagline">{T.appTagline}</p>
          </div>
        </div>
        <div className="top-actions">
          <div className="lang" role="group" aria-label={T.language}>
            <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')} lang="en" aria-pressed={lang === 'en'}>
              English
            </button>
            <button className={lang === 'bn' ? 'on' : ''} onClick={() => setLang('bn')} lang="bn" aria-pressed={lang === 'bn'}>
              বাংলা
            </button>
          </div>
          <div className="file-actions">
            <button className="btn small" onClick={saveProjectFile} disabled={!project && !files.length}>
              {T.saveProject}
            </button>
            <label className="btn small">
              {T.openProject}
              <input
                type="file"
                hidden
                accept=".json,application/json"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) openJsonFile(f)
                  e.target.value = ''
                }}
              />
            </label>
            <button className="btn small danger-ghost" onClick={startOver} disabled={!project && !files.length}>
              {T.startOver}
            </button>
          </div>
        </div>
      </header>

      <main>
        <div className="privacy">
          {T.privacy} {savedTick && <span className="saved">✓ {T.autosaved}</span>}
        </div>
        {restoredAt && (
          <div className="msg info">
            <span>{T.restored}</span>
            <button className="x" onClick={() => setRestoredAt(null)} aria-label={T.close}>
              ×
            </button>
          </div>
        )}
        {area('top')}

        <ol className="stepper" aria-label={T.howItWorks}>
          {T.steps.map((s, i) => (
            <li key={i} className={stepDone[i] ? 'done' : ''}>
              <span className="dot">{stepDone[i] ? '✓' : num(i + 1, lang)}</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>

        {/* ---------------- Step 1 ---------------- */}
        <section className="card" id="step1">
          <h2>
            <span className="num">{num(1, lang)}</span>
            {T.step1Title}
          </h2>
          {!project && <p className="help">{T.step1Help}</p>}
          {jsonError && (
            <div className="msg error" role="alert">
              <span>{T.jsonErrors[jsonError] ?? T.jsonErrors.not_object}</span>
            </div>
          )}
          {area('json')}
          {!project ? (
            <DropZone label={T.chooseJson} sub={T.dropJson} accept=".json,application/json" onFiles={(fs) => fs[0] && openJsonFile(fs[0])} />
          ) : (
            <>
              <dl className="tender">
                <div>
                  <dt>{T.tenderId}</dt>
                  <dd className="strong">{project.tender.tender_id}</dd>
                </div>
                <div className="wide">
                  <dt>{T.tenderTitle}</dt>
                  <dd>{project.tender.title}</dd>
                </div>
                <div>
                  <dt>{T.procuringEntity}</dt>
                  <dd>{project.tender.procuring_entity}</dd>
                </div>
                <div>
                  <dt>{T.bidder}</dt>
                  <dd>{project.tender.bidder}</dd>
                </div>
                <div>
                  <dt>{T.deadline}</dt>
                  <dd className="strong">
                    {formatDate(deadline, lang)} <span className="muted">({num(deadline, lang)})</span>
                  </dd>
                </div>
              </dl>
              <h3>
                {T.requiredDocs} <span className="muted">({num(project.requirements.length, lang)})</span>
              </h3>
              <ol className="reqlist">
                {project.requirements.map((r) => (
                  <li key={r.key}>
                    <span className="ord">{num(r.order, lang)}</span>
                    <span className="rtitle">
                      {title(r, lang)} <span className="muted small">· {lang === 'bn' ? r.title_en : r.title_bn}</span>
                    </span>
                    <span className={`tag ${r.mandatory ? 'tag-m' : 'tag-o'}`}>{r.mandatory ? T.mandatory : T.optional}</span>
                    {r.has_expiry && <span className="tag tag-e">{T.hasExpiry}</span>}
                  </li>
                ))}
              </ol>
              <div className="row-actions">
                <label className="btn small">
                  {T.changeJson}
                  <input
                    type="file"
                    hidden
                    accept=".json,application/json"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) openJsonFile(f)
                      e.target.value = ''
                    }}
                  />
                </label>
              </div>
            </>
          )}
        </section>

        {/* ---------------- Step 2 ---------------- */}
        <section className="card" id="step2">
          <h2>
            <span className="num">{num(2, lang)}</span>
            {T.step2Title}
          </h2>
          <p className="help">
            {T.step2Help} <span className="muted">{T.limits(MAX_FILES, MAX_MB)}</span>
          </p>
          <DropZone label={T.chooseFiles} sub={T.dropFiles} multiple onFiles={addFiles} compact={files.length > 0} />
          {busy === 'files' && (
            <p className="busy">
              <span className="spinner" /> {T.processing} <span className="muted">{progress}</span>
            </p>
          )}
          {area('files')}
          {files.length === 0 ? (
            <p className="muted empty">{T.noFiles}</p>
          ) : (
            <>
              <ul className="files">
                {files.map((f) => {
                  const dups = dupOf.get(f.id)
                  const owner = usedBy.get(f.id)
                  const expired = !!(f.detectedExpiry && deadline && f.detectedExpiry < deadline)
                  return (
                    <li key={f.id} className={dups ? 'dup' : ''}>
                      <div className="ficon" aria-hidden>
                        PDF
                      </div>
                      <div className="fmain">
                        <div className="fname" title={f.name}>
                          {f.name}
                        </div>
                        <div className="fmeta">
                          <span className="pill">{T.pages(f.pages)}</span>
                          <span className="muted small">{formatBytes(f.size, lang)}</span>
                          {dups && (
                            <span className="badge warn">
                              {T.duplicateOf} {dups.map((d) => `“${d.name}”`).join(', ')}
                            </span>
                          )}
                          {f.mode === 'raster' && <span className="badge info">{T.rasterNote}</span>}
                          {owner ? (
                            <span className="badge ok">
                              ✓ {T.usedFor}: {title(reqByKey.get(owner)!, lang)}
                            </span>
                          ) : (
                            <span className="badge muted-b">{T.notUsed}</span>
                          )}
                          {f.detectedExpiry && (
                            <span className={`badge ${expired ? 'bad' : 'soft'}`}>
                              {T.expiryInDoc} {formatDate(f.detectedExpiry, lang)}
                              {expired ? ` (${T.beforeDeadline})` : ''}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="factions">
                        <button className="btn small" onClick={() => setPreview(f)}>
                          {T.preview}
                        </button>
                        <button className="btn small danger-ghost" onClick={() => removeFile(f.id)} aria-label={`${T.remove} ${f.name}`}>
                          {T.remove}
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
              <p className="muted small">
                {T.totalSize}: {num(files.length, lang)} / {num(MAX_FILES, lang)} · {formatBytes(totalSize, lang)} / {num(MAX_MB, lang)} MB
              </p>
            </>
          )}
        </section>

        {/* ---------------- Step 3 ---------------- */}
        <section className="card" id="step3">
          <h2>
            <span className="num">{num(3, lang)}</span>
            {T.step3Title}
          </h2>
          {!project ? (
            <p className="muted">{T.needJson}</p>
          ) : (
            <>
              <p className="help">{T.step3Help}</p>
              <div className="toolbar">
                <button className="btn accent" onClick={autoMatch} disabled={!files.length} title={T.autoMatchHelp}>
                  {T.autoMatch}
                </button>
                <button className="btn" onClick={exportCsv}>
                  {T.exportCsv}
                </button>
              </div>
              <div className="counts" aria-live="polite">
                {(['ok', 'missing', 'expiry_needed', 'expired', 'not_provided'] as StatusCode[]).map((s) => (
                  <span key={s} className={`count st-${s}`}>
                    {T.statuses[s]}: <b>{num(counts[s], lang)}</b>
                  </span>
                ))}
              </div>
              <details className="ai">
                <summary>{T.aiTitle}</summary>
                <p className="help small">{T.aiHelp}</p>
                <div className="ai-row">
                  <label>
                    {T.aiKey}{' '}
                    <input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={aiKey}
                      placeholder={T.aiKeyPh}
                      onChange={(e) => setAiKey(e.target.value)}
                    />
                  </label>
                  <button className="btn accent" onClick={runAi} disabled={!aiKey.trim() || aiBusy || !files.length}>
                    {aiBusy ? (
                      <>
                        <span className="spinner" /> {T.aiRunning}
                      </>
                    ) : (
                      <>{T.aiRun}</>
                    )}
                  </button>
                </div>
              </details>
              {!files.length && <p className="muted small">{T.addFilesFirst}</p>}
              {area('match')}
              <div className="table-wrap">
                <table className="match">
                  <thead>
                    <tr>
                      <th>{T.colOrder}</th>
                      <th>{T.colDocument}</th>
                      <th>{T.colFile}</th>
                      <th>{T.colExpiry}</th>
                      <th>{T.colStatus}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ req, file, status }) => {
                      const exp = expiry[req.key] ?? ''
                      return (
                        <tr key={req.key} className={`row-${status}`}>
                          <td className="ord" data-label={T.colOrder}>
                            {num(req.order, lang)}
                          </td>
                          <td data-label={T.colDocument}>
                            <div className="dtitle">{title(req, lang)}</div>
                            <div className="dmeta">
                              <span className="muted small">{req.id}</span>
                              <span className={`tag ${req.mandatory ? 'tag-m' : 'tag-o'}`}>{req.mandatory ? T.mandatory : T.optional}</span>
                              {req.has_expiry && <span className="tag tag-e">{T.hasExpiry}</span>}
                            </div>
                          </td>
                          <td data-label={T.colFile}>
                            <div className="pick">
                              <select
                                value={file?.id ?? ''}
                                onChange={(e) => assign(req.key, e.target.value)}
                                aria-label={`${T.colFile}: ${title(req, lang)}`}
                                disabled={!files.length}
                                className={file ? 'has' : ''}
                              >
                                <option value="">{file ? T.noFileOption : T.chooseFile}</option>
                                {files.map((f) => {
                                  const why = blockedReason(f.id, req.key)
                                  return (
                                    <option key={f.id} value={f.id} disabled={!!why}>
                                      {f.name} ({T.pages(f.pages)}){dupOf.has(f.id) ? ` · ${T.duplicate}` : ''}
                                      {why ? ` — ${why}` : ''}
                                    </option>
                                  )
                                })}
                              </select>
                              {file && (
                                <span className="pick-actions">
                                  <button className="btn small" onClick={() => setPreview(file)}>
                                    {T.preview}
                                  </button>
                                  <button className="btn small ghost" onClick={() => assign(req.key, '')}>
                                    ✕ {T.unmatch}
                                  </button>
                                </span>
                              )}
                            </div>
                            {file && suggested.includes(req.key) && (
                              <span className="badge soft" title={aiReasons[req.key]}>
                                {T.suggested}
                                {aiReasons[req.key] ? ` · ${aiReasons[req.key]}` : ''}
                              </span>
                            )}
                          </td>
                          <td data-label={T.colExpiry}>
                            {!req.has_expiry ? (
                              <span className="muted small">{T.expiryNotNeeded}</span>
                            ) : !file ? (
                              <span className="muted small">{T.expiryAfterMatch}</span>
                            ) : (
                              <div className="exp">
                                <input
                                  type="date"
                                  value={exp}
                                  onChange={(e) => setExpiry((x) => ({ ...x, [req.key]: e.target.value }))}
                                  aria-label={`${T.colExpiry}: ${title(req, lang)}`}
                                  className={status === 'expired' ? 'bad' : status === 'expiry_needed' ? 'need' : 'good'}
                                />
                                {isIsoDate(exp) && <span className="small muted">{formatDate(exp, lang)}</span>}
                                {file.detectedExpiry && file.detectedExpiry !== exp && (
                                  <span className="hint">
                                    {T.foundInDoc} <b>{formatDate(file.detectedExpiry, lang)}</b>{' '}
                                    <button className="link" onClick={() => setExpiry((x) => ({ ...x, [req.key]: file.detectedExpiry! }))}>
                                      {T.useThisDate}
                                    </button>
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          <td data-label={T.colStatus}>
                            <StatusBadge status={status} T={T} />
                            <div className="small muted st-help">
                              {status === 'expired'
                                ? `${T.statusHelp.expired} ${T.deadlineIs}: ${formatDate(deadline, lang)}`
                                : T.statusHelp[status]}
                            </div>
                            {!req.mandatory && (status === 'expired' || status === 'expiry_needed') && (
                              <div className="small hint">{T.clearOptionalHint}</div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        {/* ---------------- Step 4 ---------------- */}
        <section className="card" id="step4">
          <h2>
            <span className="num">{num(4, lang)}</span>
            {T.step4Title}
          </h2>
          <p className="help">{T.step4Help}</p>

          <label className="check">
            <input type="checkbox" checked={includeIndex} onChange={(e) => setIncludeIndex(e.target.checked)} />
            <span>{T.includeIndex}</span>
          </label>

          <details className="seal" open={seal.enabled || undefined}>
            <summary>{T.sealTitle}</summary>
            <p className="help">{T.sealHelp}</p>
            {area('build')}
            <div className="seal-grid">
              <div className="seal-img">
                {sealPreviewUrl ? <img src={sealPreviewUrl} alt={seal.name} /> : <div className="ph">PNG</div>}
                <DropZone label={T.sealChoose} sub="" accept="image/png" onFiles={chooseSeal} compact />
                {seal.bytes && (
                  <button className="btn small ghost" onClick={() => setSeal((s) => ({ ...s, bytes: null, name: '', enabled: false }))}>
                    {T.sealRemove}
                  </button>
                )}
              </div>
              <div className="seal-opts">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={seal.enabled}
                    disabled={!seal.bytes}
                    onChange={(e) => setSeal((s) => ({ ...s, enabled: e.target.checked }))}
                  />
                  <span>{T.sealEnable}</span>
                </label>
                <fieldset disabled={!seal.bytes || !seal.enabled}>
                  <legend>{T.sealPages}</legend>
                  {(['all', 'docs', 'last', 'custom'] as const).map((p) => (
                    <label key={p} className="radio">
                      <input type="radio" name="sealp" checked={seal.placement === p} onChange={() => setSeal((s) => ({ ...s, placement: p }))} />
                      <span>{p === 'all' ? T.sealAll : p === 'docs' ? T.sealDocs : p === 'last' ? T.sealLast : T.sealCustom}</span>
                      {p === 'custom' && (
                        <input
                          type="text"
                          className="pages-input"
                          placeholder={T.sealCustomPh}
                          value={seal.customPages}
                          onChange={(e) => setSeal((s) => ({ ...s, customPages: e.target.value, placement: 'custom' }))}
                        />
                      )}
                    </label>
                  ))}
                  <div className="inline">
                    <label>
                      {T.sealPosition}{' '}
                      <select value={seal.position} onChange={(e) => setSeal((s) => ({ ...s, position: e.target.value as SealSettings['position'] }))}>
                        {Object.entries(T.positions).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {T.sealSize}{' '}
                      <input type="range" min={40} max={200} value={seal.width} onChange={(e) => setSeal((s) => ({ ...s, width: Number(e.target.value) }))} />
                    </label>
                  </div>
                </fieldset>
              </div>
            </div>
          </details>

          {!project ? (
            <div className="msg warn">
              <span>{T.needJson}</span>
            </div>
          ) : blocking.length ? (
            <div className="blockers" role="status" aria-live="polite">
              <strong>{T.cannotGenerate}</strong>
              <ul>
                {blocking.map((r) => (
                  <li key={r.req.key}>
                    <StatusBadge status={r.status} T={T} /> <span>{blockText(r)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="msg success">
              <span>
                {T.ready} {T.willContain(plan.total, included.length, includeIndex)}
              </span>
            </div>
          )}
          {project && unused.length > 0 && (
            <div className="msg warn">
              <span>{T.unusedWarn(unused.map((f) => `“${f.name}”`).join(', '))}</span>
            </div>
          )}

          <div className="gen">
            <button className="btn primary big" onClick={generate} disabled={!project || blocking.length > 0 || busy !== null}>
              {busy === 'build' ? (
                <>
                  <span className="spinner light" /> {T.generating}
                </>
              ) : (
                <>{T.generate}</>
              )}
            </button>
            {busy === 'build' && <span className="muted small">{progress}</span>}
          </div>
          {buildError && (
            <div className="msg error" role="alert">
              <span>
                {T.buildFailed} {buildError}
              </span>
            </div>
          )}
          {result && !showResult && (
            <div className="msg warn">
              <span>{T.changedSince}</span>
            </div>
          )}
          {showResult && result && (
            <div className="result">
              <div className="result-head">
                <div>
                  <h3>{T.done}</h3>
                  <p className="muted">
                    {result.name} · {T.totalPages}: {num(result.total, lang)}
                  </p>
                </div>
                <div className="row-actions">
                  <a className="btn primary big" href={result.url} download={result.name}>
                    {T.download} {result.name}
                  </a>
                  <a className="btn" href={result.url} target="_blank" rel="noreferrer">
                    {T.openPreview}
                  </a>
                </div>
              </div>
              <iframe className="pdf-frame" src={result.url} title={result.name} />
            </div>
          )}
        </section>
      </main>

      <footer className="foot muted small">{T.appTitle} · MIT License · pdf-lib · pdf.js</footer>

      {preview && <PreviewModal file={preview} onClose={closePreview} T={T} lang={lang} />}
    </div>
  )
}
