import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Write a file atomically (temp file + rename) so a crash never leaves a half-written file. */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, data)
  try {
    await fs.rename(tmp, file)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
      // Windows can briefly lock the destination (antivirus/indexer); fall back to copy.
      await fs.copyFile(tmp, file)
      await fs.rm(tmp, { force: true })
      return
    }
    await fs.rm(tmp, { force: true })
    throw err
  }
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    // Corrupt file: keep a copy for diagnosis and start fresh.
    await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => undefined)
    return undefined
  }
}

/** Serialises async operations (e.g. writes to one file) without blocking callers. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.catch(() => undefined)
    return next
  }
}
