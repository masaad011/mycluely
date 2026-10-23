import { memo, useMemo, type ReactNode } from 'react'
import { highlightCode } from '../lib/highlight'
import { IconCopy } from './icons'

/**
 * A fenced code block: language label, copy button and syntax highlighting. `complete` is false
 * while the closing fence has not streamed in yet (language auto-detection waits for it).
 */
export const CodeBlock = memo(function CodeBlock({
  code,
  lang,
  complete,
  onCopy
}: {
  code: string
  lang?: string
  complete: boolean
  onCopy?: (code: string) => void
}): ReactNode {
  const { nodes, language } = useMemo(() => highlightCode(code, lang, complete), [code, lang, complete])
  return (
    <div className="code-block" data-testid="code-block">
      <div className="code-head">
        <span className="code-lang" data-testid="code-lang">
          {language ?? 'Code'}
        </span>
        {onCopy && (
          <button type="button" className="btn ghost sm" onClick={() => onCopy(code)} title="Copy code" aria-label="Copy code">
            <IconCopy /> Copy
          </button>
        )}
      </div>
      <pre className="md-code">
        <code className="hljs">{nodes}</code>
      </pre>
    </div>
  )
})
