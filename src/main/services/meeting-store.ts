import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { MeetingRecord, MeetingRecordMeta, TranscriptSegment } from '@shared/types'
import { readJson, SerialQueue, writeFileAtomic } from './json-file'

type StoredMeeting = Omit<MeetingRecord, 'segments'>

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/

/** Same folder? Windows paths are case-insensitive. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p))
  return norm(a) === norm(b)
}

/**
 * One folder per meeting:
 *   meeting.json      – metadata, summary, questions, responses, screen OCR (atomic rewrite)
 *   transcript.jsonl  – append-only transcript log, durable even if the app crashes mid-meeting
 *   screens/*.jpg     – screenshots, only when the user chose to keep them
 * plus `.session-cache/` for the live meeting's temporary screenshots.
 *
 * The root can be a folder the user picked, so only meeting folders are ever deleted from it.
 */
export class MeetingStore {
  private readonly queues = new Map<string, SerialQueue>()

  constructor(private rootDir: string) {}

  get root(): string {
    return this.rootDir
  }

  /** Screenshots of the live meeting that are not kept afterwards (cleared at startup). */
  get cacheDir(): string {
    return path.join(this.rootDir, '.session-cache')
  }

  private dir(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid meeting id: ${id}`)
    return path.join(this.root, id)
  }

  private queue(id: string): SerialQueue {
    let q = this.queues.get(id)
    if (!q) {
      q = new SerialQueue()
      this.queues.set(id, q)
    }
    return q
  }

  screensDir(id: string): string {
    return path.join(this.dir(id), 'screens')
  }

  async save(record: MeetingRecord): Promise<void> {
    const { segments: _segments, ...rest } = record
    const stored: StoredMeeting = { ...rest, segmentCount: record.segments.length }
    const file = path.join(this.dir(record.id), 'meeting.json')
    const json = JSON.stringify(stored)
    await this.queue(record.id).run(() => writeFileAtomic(file, json))
  }

  async appendSegment(meetingId: string, seg: TranscriptSegment): Promise<void> {
    const file = path.join(this.dir(meetingId), 'transcript.jsonl')
    const line = JSON.stringify(seg) + '\n'
    await this.queue(meetingId).run(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.appendFile(file, line, 'utf8')
    })
  }

  async list(): Promise<MeetingRecordMeta[]> {
    let names: string[]
    try {
      names = await fs.readdir(this.root)
    } catch {
      return []
    }
    const metas: MeetingRecordMeta[] = []
    for (const name of names) {
      if (!SAFE_ID.test(name)) continue
      const m = await readJson<StoredMeeting>(path.join(this.root, name, 'meeting.json'))
      if (!m?.id) continue
      metas.push({
        id: m.id,
        title: m.title,
        mode: m.mode,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        durationMs: m.durationMs,
        segmentCount: m.segmentCount ?? 0,
        provider: m.provider,
        model: m.model,
        hasSummary: !!m.summary
      })
    }
    return metas.sort((a, b) => b.startedAt - a.startedAt)
  }

  async get(id: string): Promise<MeetingRecord | undefined> {
    const dir = this.dir(id)
    const m = await readJson<StoredMeeting>(path.join(dir, 'meeting.json'))
    if (!m) return undefined
    const segments = await this.readSegments(id)
    // Kept screenshots are stored with absolute paths; point them at this folder in case the meetings folder moved.
    const snapshots = m.snapshots?.map((s) => (s.imagePath ? { ...s, imagePath: path.join(this.screensDir(id), path.basename(s.imagePath)) } : s))
    return { ...m, snapshots, segments, segmentCount: segments.length }
  }

  private async readSegments(id: string): Promise<TranscriptSegment[]> {
    let text = ''
    try {
      text = await fs.readFile(path.join(this.dir(id), 'transcript.jsonl'), 'utf8')
    } catch {
      return []
    }
    // Later lines win (segments can be re-written, e.g. after a retry).
    const byId = new Map<string, TranscriptSegment>()
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const seg = JSON.parse(line) as TranscriptSegment
        if (seg?.id) byId.set(seg.id, seg)
      } catch {
        // A torn final line after a crash is skipped.
      }
    }
    return [...byId.values()].filter((s) => s.status !== 'removed').sort((a, b) => a.startMs - b.startMs)
  }

  async delete(id: string): Promise<void> {
    await this.queue(id).run(() => fs.rm(this.dir(id), { recursive: true, force: true }))
    this.queues.delete(id)
  }

  async deleteAll(): Promise<void> {
    for (const id of await this.meetingFolders()) await this.delete(id)
  }

  /**
   * Use `next` as the meetings folder, moving the saved meetings there. A meeting whose folder
   * already exists in `next` (or that cannot be moved) stays in the old folder.
   */
  async relocate(next: string): Promise<{ moved: number; left: number }> {
    next = path.resolve(next)
    const from = this.rootDir
    if (samePath(from, next)) return { moved: 0, left: 0 }
    const rel = path.relative(from, next)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && SAFE_ID.test(rel.split(path.sep)[0]!)) {
      throw new Error('Choose a folder outside the saved meetings.')
    }
    await fs.mkdir(next, { recursive: true })
    const ids = await this.meetingFolders()
    // Switch the root and queue every move synchronously: writes queued earlier (old paths) run
    // before their meeting's move, writes queued later (new paths) run after it.
    this.rootDir = next
    const moves = ids.map((id) =>
      this.queue(id).run(async () => {
        const src = path.join(from, id)
        const dest = path.join(next, id)
        if (await fs.stat(dest).then(() => true, () => false)) return false
        try {
          await fs.rename(src, dest)
        } catch {
          // Different drive: copy, then remove the original.
          await fs.cp(src, dest, { recursive: true, errorOnExist: true, force: false })
          await fs.rm(src, { recursive: true, force: true })
        }
        return true
      })
    )
    const moved = (await Promise.allSettled(moves)).filter((r) => r.status === 'fulfilled' && r.value).length
    await fs.rm(path.join(from, '.session-cache'), { recursive: true, force: true }).catch(() => undefined)
    await fs.rmdir(from).catch(() => undefined) // only succeeds if nothing else is left there
    return { moved, left: ids.length - moved }
  }

  private async meetingFolders(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.rootDir, { withFileTypes: true })
      return entries.filter((e) => e.isDirectory() && SAFE_ID.test(e.name)).map((e) => e.name)
    } catch {
      return []
    }
  }

  /** Delete meetings older than `days` (0 keeps everything). Returns the number deleted. */
  async applyRetention(days: number, now = Date.now()): Promise<number> {
    if (!days || days <= 0) return 0
    const cutoff = now - days * 86_400_000
    let n = 0
    for (const m of await this.list()) {
      if ((m.endedAt ?? m.startedAt) < cutoff) {
        await this.delete(m.id)
        n++
      }
    }
    return n
  }

  async removeScreens(id: string): Promise<void> {
    await fs.rm(this.screensDir(id), { recursive: true, force: true })
  }
}
