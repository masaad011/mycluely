import { createElement, type ReactNode } from 'react'
import { createLowlight } from 'lowlight'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import php from 'highlight.js/lib/languages/php'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

/**
 * Syntax highlighting for code in answers: highlight.js grammars (a curated set, to keep the bundle
 * small) through lowlight, which returns a syntax tree. The tree is turned into React elements, so
 * model output is never inserted as HTML.
 */
const lowlight = createLowlight({
  bash, c, cpp, csharp, css, diff, go, java, javascript, json, kotlin, php,
  powershell, python, ruby, rust, sql, swift, typescript, xml, yaml
})

/** Display names, including the aliases models use in code fences. */
const LABELS: Record<string, string> = {
  bash: 'Bash', sh: 'Shell', shell: 'Shell', zsh: 'Shell', c: 'C', h: 'C', cpp: 'C++', 'c++': 'C++', hpp: 'C++', cc: 'C++',
  csharp: 'C#', cs: 'C#', 'c#': 'C#', css: 'CSS', diff: 'Diff', patch: 'Diff', go: 'Go', golang: 'Go', java: 'Java',
  javascript: 'JavaScript', js: 'JavaScript', jsx: 'JSX', mjs: 'JavaScript', json: 'JSON', kotlin: 'Kotlin', kt: 'Kotlin',
  php: 'PHP', powershell: 'PowerShell', ps: 'PowerShell', ps1: 'PowerShell', pwsh: 'PowerShell', python: 'Python', py: 'Python',
  ruby: 'Ruby', rb: 'Ruby', rust: 'Rust', rs: 'Rust', sql: 'SQL', swift: 'Swift', typescript: 'TypeScript', ts: 'TypeScript',
  tsx: 'TSX', xml: 'XML', html: 'HTML', svg: 'SVG', yaml: 'YAML', yml: 'YAML'
}

/** Code longer than this is shown without highlighting (keeps streaming smooth). */
const MAX_HIGHLIGHT_CHARS = 30_000
/** Auto-detected languages below this highlight.js relevance are shown as plain text. */
const MIN_AUTO_RELEVANCE = 6

type HastNode = { type: string; value?: string; tagName?: string; properties?: { className?: unknown }; children?: HastNode[] }

function toReact(nodes: HastNode[] | undefined, prefix = ''): ReactNode[] {
  return (nodes ?? []).map((n, i) => {
    if (n.type === 'text') return n.value ?? ''
    if (n.type !== 'element') return null
    const cls = n.properties?.className
    const className = Array.isArray(cls) ? cls.join(' ') : typeof cls === 'string' ? cls : undefined
    return createElement('span', { key: `${prefix}${i}`, className }, ...toReact(n.children, `${prefix}${i}.`))
  })
}

export function languageLabel(lang: string | undefined): string | undefined {
  if (!lang) return undefined
  return LABELS[lang.toLowerCase()] ?? lang
}

/**
 * Highlight `code`. With a fence language that we know, use it; without one, detect the language
 * only once the block is complete (not on every streamed character) and only when confident.
 * Returns plain text otherwise.
 */
export function highlightCode(code: string, lang: string | undefined, complete: boolean): { nodes: ReactNode[]; language?: string } {
  const name = lang?.toLowerCase()
  if (code.length > MAX_HIGHLIGHT_CHARS) return { nodes: [code], language: languageLabel(name) }
  try {
    if (name && lowlight.registered(name)) {
      return { nodes: toReact(lowlight.highlight(name, code).children as HastNode[]), language: languageLabel(name) }
    }
    if (!name && complete && code.trim()) {
      const tree = lowlight.highlightAuto(code)
      const detected = tree.data?.language
      if (detected && (tree.data?.relevance ?? 0) >= MIN_AUTO_RELEVANCE) {
        return { nodes: toReact(tree.children as HastNode[]), language: languageLabel(detected) }
      }
    }
  } catch {
    // Fall through to plain text.
  }
  return { nodes: [code], language: languageLabel(name) }
}
