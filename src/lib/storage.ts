import { del, get, set } from 'idb-keyval'
import type { SealSettings, TenderProject, UploadedFile } from '../types'
import { base64ToBytes, bytesToBase64 } from './util'

/** Everything needed to reopen the work later. Stored only in this browser (IndexedDB). */
export interface SavedState {
  version: 1
  project: TenderProject | null
  files: UploadedFile[]
  matches: Record<string, string>
  expiry: Record<string, string>
  suggested: string[]
  includeIndex: boolean
  seal: SealSettings
  savedAt: string
}

const KEY = 'tender-package-builder/state/v1'

export async function saveLocal(state: SavedState): Promise<void> {
  await set(KEY, state)
}

export async function loadLocal(): Promise<SavedState | null> {
  try {
    const s = (await get(KEY)) as SavedState | undefined
    return s && s.version === 1 ? s : null
  } catch {
    return null
  }
}

export async function clearLocal(): Promise<void> {
  await del(KEY)
}

// ----- Project file (portable JSON, files embedded as base64) -----

interface ProjectFileJson extends Omit<SavedState, 'files' | 'seal'> {
  app: 'tender-package-builder'
  files: (Omit<UploadedFile, 'bytes'> & { bytes: string })[]
  seal: Omit<SealSettings, 'bytes'> & { bytes: string | null }
}

export function exportProjectFile(state: SavedState): Blob {
  const json: ProjectFileJson = {
    ...state,
    app: 'tender-package-builder',
    files: state.files.map((f) => ({ ...f, bytes: bytesToBase64(f.bytes) })),
    seal: { ...state.seal, bytes: state.seal.bytes ? bytesToBase64(state.seal.bytes) : null },
  }
  return new Blob([JSON.stringify(json)], { type: 'application/json' })
}

export function isProjectFileJson(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as { app?: string }).app === 'tender-package-builder'
}

export function importProjectFile(data: unknown): SavedState {
  const j = data as ProjectFileJson
  if (!isProjectFileJson(j) || !Array.isArray(j.files)) throw new Error('bad_project')
  return {
    version: 1,
    project: j.project ?? null,
    files: j.files.map((f) => ({ ...f, bytes: base64ToBytes(f.bytes) })),
    matches: j.matches ?? {},
    expiry: j.expiry ?? {},
    suggested: j.suggested ?? [],
    includeIndex: j.includeIndex ?? true,
    seal: { ...j.seal, bytes: j.seal?.bytes ? base64ToBytes(j.seal.bytes) : null },
    savedAt: j.savedAt ?? new Date().toISOString(),
  }
}
