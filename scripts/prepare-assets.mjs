// Ensures generated build resources exist (app icons). Run automatically before dev/build.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
if (!existsSync(join(root, 'resources', 'icon.png')) || !existsSync(join(root, 'resources', 'icon.ico'))) {
  await import('./generate-icons.mjs')
}
