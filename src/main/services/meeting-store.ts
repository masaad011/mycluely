import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { MeetingRecord, MeetingRecordMeta, TranscriptSegment } from '@shared/types'
import { readJson, SerialQueue, writeFileAtomic } from './json-file'

type StoredMeeting = Omit<MeetingRecord, 'segments'>

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/

/**
 * One folder per meeting:
 *   meeting.json      – metadata, summary, questions, responses, screen OCR (atomic rewrite)
 *   transcript.jsonl  – append-only transcript log, durable even if the app crashes mid-meeting
 *   screens/*.jpg     – screenshots, only when the user chose to keep them
 */
export class MeetingStore {
  private readonly queues = new Map<string, SerialQueue>()

  constructor(readonly root: string) {}

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
    return { ...m, segments, segmentCount: segments.length }
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
    await fs.rm(this.root, { recursive: true, force: true })
    this.queues.clear()
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
