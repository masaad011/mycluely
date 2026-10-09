import { Fragment, type ReactNode } from 'react'

/**
 * Minimal Markdown renderer for model output: headings, paragraphs, bullet/numbered lists,
 * fenced code, inline code, bold and italics. It builds React elements (no innerHTML), so model
 * output can never inject markup or scripts.
 */
export function Markdown({ text, className }: { text: string; className?: string }): ReactNode {
  return <div className={className ? `md ${className}` : 'md'}>{renderBlocks(text)}</div>
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.replace(/\r/g, '').split('\n')
  const out: ReactNode[] = []
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = /^\s*```(\w*)/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i++ // closing fence (or EOF while streaming)
      out.push(
        <pre key={key++} className="md-code" data-lang={fence[1] || undefined}>
          <code>{body.join('\n')}</code>
        </pre>
      )
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6)
      const Tag = `h${level}` as 'h3'
      out.push(<Tag key={key++}>{inline(heading[2])}</Tag>)
      i++
      continue
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, '')
        i++
        // Continuation lines indented under the bullet.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
          item += ' ' + lines[i].trim()
          i++
        }
        items.push(item)
      }
      const ListTag = ordered ? 'ol' : 'ul'
      out.push(
        <ListTag key={key++}>
          {items.map((it, j) => (
            <li key={j}>{inline(it.replace(/^\[( |x)\]\s*/i, ''))}</li>
          ))}
        </ListTag>
      )
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const para: string[] = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])
    ) {
      para.push(lines[i++])
    }
    out.push(
      <p key={key++}>
        {para.map((p, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {inline(p)}
          </Fragment>
        ))}
      </p>
    )
  }
  return out
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g

function inline(text: string): ReactNode[] {
  const parts = text.split(INLINE)
  return parts.map((p, i) => {
    if (!p) return null
    if (p.startsWith('`') && p.endsWith('`') && p.length > 1) return <code key={i}>{p.slice(1, -1)}</code>
    if ((p.startsWith('**') && p.endsWith('**')) || (p.startsWith('__') && p.endsWith('__'))) {
      return <strong key={i}>{p.slice(2, -2)}</strong>
    }
    if ((p.startsWith('*') && p.endsWith('*')) || (p.startsWith('_') && p.endsWith('_'))) {
      return <em key={i}>{p.slice(1, -1)}</em>
    }
    return <Fragment key={i}>{p}</Fragment>
  })
}

/** Plain text for clipboard copies: drop Markdown markers. */
export function markdownToPlain(text: string): string {
  return text
    .replace(/```\w*\n?/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .trim()
}
