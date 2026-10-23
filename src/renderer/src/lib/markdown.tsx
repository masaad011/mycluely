import { Fragment, type ReactNode } from 'react'
import { CodeBlock } from '../components/CodeBlock'

/**
 * Minimal Markdown renderer for model output: headings, paragraphs, bullet/numbered lists, quotes,
 * tables, rules, fenced code (syntax-highlighted), inline code, bold, italics and web links. It
 * builds React elements (no innerHTML), so model output can never inject markup or scripts.
 */
export function Markdown({ text, className, onCopyCode }: { text: string; className?: string; onCopyCode?: (code: string) => void }): ReactNode {
  return <div className={className ? `md ${className}` : 'md'}>{renderBlocks(text, onCopyCode)}</div>
}

const LIST_ITEM = /^\s*([-*•]|\d+[.)])\s+/
const QUOTE = /^\s*>\s?/
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/
const TABLE_ROW = /^\s*\|.*\|\s*$/
// Any number of dashes per cell (as in GitHub Markdown), and at least one pipe so a plain `---`
// rule under a table-like line is not taken for a table.
const TABLE_SEPARATOR = /^(?=.*\|)\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function startsBlock(lines: string[], i: number): boolean {
  const l = lines[i]
  return (
    /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || LIST_ITEM.test(l) || QUOTE.test(l) || RULE.test(l) ||
    (TABLE_ROW.test(l) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]))
  )
}

function cells(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}

function renderBlocks(text: string, onCopyCode?: (code: string) => void): ReactNode[] {
  const lines = text.replace(/\r/g, '').split('\n')
  const out: ReactNode[] = []
  let i = 0
  let key = 0
  while (i < lines.length) {
    const line = lines[i]
    const fence = /^\s*```\s*([\w#+.-]*)/.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      const complete = i < lines.length // the closing fence has arrived (not still streaming)
      i++
      out.push(<CodeBlock key={key++} code={body.join('\n')} lang={fence[1] || undefined} complete={complete} onCopy={onCopyCode} />)
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
    if (RULE.test(line)) {
      out.push(<hr key={key++} />)
      i++
      continue
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      const head = cells(line)
      const align = cells(lines[i + 1]).map((c) => (c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : 'left') as 'left' | 'center' | 'right')
      i += 2
      const rows: string[][] = []
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(cells(lines[i++]))
      out.push(
        <div key={key++} className="md-table-wrap">
          <table>
            <thead>
              <tr>
                {head.map((h, j) => (
                  <th key={j} style={{ textAlign: align[j] ?? 'left' }}>
                    {inline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, j) => (
                    <td key={j} style={{ textAlign: align[j] ?? 'left' }}>
                      {inline(r[j] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(lines[i++].replace(QUOTE, ''))
      out.push(<blockquote key={key++}>{renderBlocks(quoted.join('\n'), onCopyCode)}</blockquote>)
      continue
    }
    if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && LIST_ITEM.test(lines[i])) {
        let item = lines[i].replace(LIST_ITEM, '')
        i++
        // Continuation lines indented under the bullet.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST_ITEM.test(lines[i])) {
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
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++])
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

const INLINE = /(`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g

function inline(text: string): ReactNode[] {
  const parts = text.split(INLINE)
  return parts.map((p, i) => {
    if (!p) return null
    if (p.startsWith('`') && p.endsWith('`') && p.length > 1) return <code key={i}>{p.slice(1, -1)}</code>
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(p)
    if (link) {
      // Web links only; opened in the browser (new windows are routed to the system browser).
      return (
        <a key={i} href={link[2]} target="_blank" rel="noreferrer noopener" title={link[2]}>
          {link[1]}
        </a>
      )
    }
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
    .replace(/```[\w#+.-]*\n?/g, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .trim()
}
