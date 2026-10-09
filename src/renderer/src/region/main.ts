// Full-screen transparent overlay for dragging out a capture region. Reports the rectangle in
// window (DIP) coordinates; the main process converts it to display coordinates.
const sel = document.getElementById('selection') as HTMLDivElement
const size = document.getElementById('size') as HTMLSpanElement
let start: { x: number; y: number } | null = null
let rect = { x: 0, y: 0, width: 0, height: 0 }

function done(r: typeof rect | null): void {
  void window.mycluely.invoke('region:done', r)
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  start = { x: e.clientX, y: e.clientY }
  rect = { x: e.clientX, y: e.clientY, width: 0, height: 0 }
  sel.hidden = false
})

window.addEventListener('mousemove', (e) => {
  if (!start) return
  rect = {
    x: Math.min(start.x, e.clientX),
    y: Math.min(start.y, e.clientY),
    width: Math.abs(e.clientX - start.x),
    height: Math.abs(e.clientY - start.y)
  }
  Object.assign(sel.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
  const scale = window.devicePixelRatio || 1
  size.textContent = `${Math.round(rect.width * scale)} × ${Math.round(rect.height * scale)}`
})

window.addEventListener('mouseup', () => {
  if (!start) return
  start = null
  if (rect.width < 8 || rect.height < 8) {
    sel.hidden = true
    return
  }
  done(rect)
})

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') done(null)
})
window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  done(null)
})
