import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown, markdownToPlain } from '../../../src/renderer/src/lib/markdown'

const html = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text, onCopyCode: () => undefined }))

describe('Markdown rendering of model output', () => {
  it('highlights fenced code with a language label and a copy button', () => {
    const out = html('Use this:\n\n```ts\nconst total: number = items.reduce((a, b) => a + b, 0) // sum\n```')
    expect(out).toContain('class="code-block"')
    expect(out).toContain('TypeScript')
    expect(out).toContain('aria-label="Copy code"')
    expect(out).toMatch(/<span class="hljs-keyword">const<\/span>/)
    expect(out).toMatch(/<span class="hljs-comment">\/\/ sum<\/span>/)
    expect(out).toMatch(/<span class="hljs-number">0<\/span>/)
  })

  it('detects an unlabelled language only once the block is complete', () => {
    const python = 'def fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)\n\nprint([fib(i) for i in range(10)])'
    expect(html('```\n' + python + '\n```')).toMatch(/hljs-keyword/)
    expect(html('```\n' + python + '\n```')).toContain('Python')
    // Still streaming (no closing fence): plain text, no guessing on every character.
    expect(html('```\n' + python)).not.toMatch(/hljs-/)
  })

  it('never turns model output into markup', () => {
    const out = html('Hi <img src=x onerror=alert(1)>\n\n```html\n<script>alert(1)</script>\n```\n\n[click](javascript:alert(1))')
    expect(out).not.toMatch(/<img|<script/)
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(out).toContain('&lt;')
    expect(out).not.toContain('href="javascript:')
  })

  it('renders tables, quotes, rules and web links', () => {
    const out = html('| Option | Latency |\n|:--|--:|\n| Redis | 1 ms |\n| Postgres | 8 ms |\n\n> Measured at p95.\n\n---\n\nSee [the docs](https://example.com/docs).')
    expect(out).toContain('<table>')
    expect(out).toMatch(/<th style="text-align:left">Option<\/th>/)
    expect(out).toMatch(/<td style="text-align:right">8 ms<\/td>/)
    expect(out).toMatch(/<blockquote><p>Measured at p95.<\/p><\/blockquote>/)
    expect(out).toContain('<hr/>')
    expect(out).toContain('href="https://example.com/docs"')
  })

  it('copies as plain text', () => {
    expect(markdownToPlain('**Use** `Redis` — see [docs](https://x.io)\n> quoted\n```ts\nconst a = 1\n```')).toBe('Use Redis — see docs (https://x.io)\nquoted\nconst a = 1')
  })
})
