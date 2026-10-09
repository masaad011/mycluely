import { _electron as electron, expect, test } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Settings → Appearance → Theme switches every window between the light and dark palettes,
 * and the native window background follows (no flash on resize or reload).
 */
const root = path.resolve(__dirname, '../..')
const packaged = process.env['MYCLUELY_EXECUTABLE']

test('switches between light and dark themes', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'mycluely-theme-'))
  writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ privacy: { consentReminder: false } }))
  const app = await electron.launch({
    ...(packaged ? { executablePath: path.resolve(root, packaged) } : {}),
    args: packaged ? [] : [path.join(root, 'out/main/index.js')],
    cwd: root,
    env: { ...process.env, MYCLUELY_USER_DATA: userData, MYCLUELY_HEADLESS_UI: '1', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_API_KEY: '' }
  })
  try {
    await app.firstWindow()
    await expect.poll(() => ['index.html', 'overlay.html'].every((p) => app.windows().some((w) => w.url().endsWith(p)))).toBe(true)
    const main = app.windows().find((w) => w.url().endsWith('index.html'))!
    const overlay = app.windows().find((w) => w.url().endsWith('overlay.html'))!
    const theme = (page: typeof main) => page.locator('html').getAttribute('data-theme')
    const bodyBg = (page: typeof main) => page.evaluate<string>('getComputedStyle(document.body).backgroundColor')
    const native = () =>
      app.evaluate(({ BrowserWindow, nativeTheme }) => ({
        source: nativeTheme.themeSource,
        bg: BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'))!.getBackgroundColor().toLowerCase()
      }))

    // Default follows Windows.
    expect((await native()).source).toBe('system')

    await main.getByTestId('nav-settings').click()
    await main.getByRole('button', { name: 'Appearance' }).click()
    const picker = main.getByRole('radiogroup', { name: 'Theme' })
    await expect(picker.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true')

    await picker.getByRole('radio', { name: 'Dark' }).click()
    await expect.poll(() => theme(main)).toBe('dark')
    await expect.poll(() => theme(overlay)).toBe('dark')
    expect(await bodyBg(main)).toBe('rgb(17, 18, 21)')
    expect(await native()).toEqual({ source: 'dark', bg: '#111215' })

    await picker.getByRole('radio', { name: 'Light' }).click()
    await expect.poll(() => theme(main)).toBe('light')
    await expect.poll(() => theme(overlay)).toBe('light')
    expect(await bodyBg(main)).toBe('rgb(245, 246, 248)')
    expect(await native()).toEqual({ source: 'light', bg: '#f5f6f8' })

    // More themes: each sets its palette and the native light/dark mode it belongs to.
    await picker.getByRole('radio', { name: 'Midnight' }).click()
    await expect.poll(() => theme(overlay)).toBe('midnight')
    expect(await bodyBg(main)).toBe('rgb(11, 17, 32)')
    expect(await native()).toEqual({ source: 'dark', bg: '#0b1120' })
    await picker.getByRole('radio', { name: 'Paper' }).click()
    await expect.poll(() => theme(main)).toBe('paper')
    expect(await native()).toEqual({ source: 'light', bg: '#f4f1ea' })

    // Style choices reach both windows.
    const attrs = (page: typeof main) =>
      page.evaluate<Record<string, string | undefined>>('({ ...document.documentElement.dataset })')
    await main.getByRole('radiogroup', { name: 'Accent colour' }).getByRole('radio', { name: 'Teal' }).click()
    await main.getByRole('radiogroup', { name: 'Density' }).getByRole('radio', { name: 'Compact' }).click()
    await main.getByRole('radiogroup', { name: 'Corners' }).getByRole('radio', { name: 'Square' }).click()
    await main.getByRole('radiogroup', { name: 'Font' }).getByRole('radio', { name: 'Bahnschrift' }).click()
    const expected = { theme: 'paper', accent: 'teal', density: 'compact', corners: 'square', font: 'bahnschrift' }
    await expect.poll(() => attrs(main)).toMatchObject(expected)
    await expect.poll(() => attrs(overlay)).toMatchObject(expected)
    // Teal on a light theme, square corners, compact controls.
    const style = await main.evaluate<{ button: string; radius: string; height: string }>(
      `(() => { const b = document.querySelector('.btn.primary, .btn'); const s = getComputedStyle(b); return { button: getComputedStyle(document.querySelector('.swatch.active')).backgroundColor, radius: s.borderTopLeftRadius, height: s.height } })()`
    )
    expect(style).toEqual({ button: 'rgb(15, 118, 110)', radius: '3px', height: '28px' })

    // Restore default appearance.
    await main.getByRole('button', { name: 'Restore default appearance' }).click()
    await expect.poll(() => attrs(main)).toMatchObject({ accent: 'blue', density: 'comfortable', corners: 'rounded', font: 'segoe' })
    expect((await native()).source).toBe('system')
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
