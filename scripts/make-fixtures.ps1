# Generates deterministic test fixtures with built-in Windows components:
#   tests/fixtures/question.wav  - speech synthesised with System.Speech (16 kHz mono PCM)
#   tests/fixtures/answer.wav    - a second utterance
#   tests/fixtures/slide.png     - a "presentation slide" rendered with System.Drawing
#   tests/fixtures/slide-2.png   - the next slide: same layout, different text (change detection)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$fixtures = Join-Path $root 'tests/fixtures'
New-Item -ItemType Directory -Force $fixtures | Out-Null

Add-Type -AssemblyName System.Speech
function Save-Speech([string]$text, [string]$file) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $synth.SetOutputToWaveFile($file, $fmt)
  $synth.Rate = 0
  # Leading/trailing silence so voice activity detection sees clear boundaries.
  $prompt = New-Object System.Speech.Synthesis.PromptBuilder
  $prompt.AppendBreak([TimeSpan]::FromMilliseconds(800))
  $prompt.AppendText($text)
  $prompt.AppendBreak([TimeSpan]::FromMilliseconds(1500))
  $synth.Speak($prompt)
  $synth.Dispose()
}
Save-Speech 'Can you explain how the caching layer handles invalidation when the database changes?' (Join-Path $fixtures 'question.wav')
Save-Speech 'Sure. We publish change events and the cache evicts the affected keys within a second.' (Join-Path $fixtures 'answer.wav')

Add-Type -AssemblyName System.Drawing
$w = 1600; $h = 900
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::White)
$title = New-Object System.Drawing.Font('Segoe UI', 54, [System.Drawing.FontStyle]::Bold)
$body = New-Object System.Drawing.Font('Segoe UI', 34)
$dark = [System.Drawing.Brushes]::Black
$g.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(40, 70, 160))), 0, 0, $w, 24)
$g.DrawString('Quarterly Revenue Review', $title, $dark, 80, 90)
$lines = @(
  'Q3 revenue grew 18 percent to 4.2 million dollars',
  'Customer churn decreased to 2.1 percent',
  'Cache hit rate improved from 71 to 93 percent',
  'Next step: migrate billing service to Postgres by November'
)
$y = 260
foreach ($l in $lines) { $g.DrawString([char]0x2022 + '  ' + $l, $body, $dark, 100, $y); $y += 90 }
$g.Dispose()
$bmp.Save((Join-Path $fixtures 'slide.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

function New-Slide([string]$file, [string]$title, [string[]]$lines) {
  $b = New-Object System.Drawing.Bitmap(1600, 900)
  $gr = [System.Drawing.Graphics]::FromImage($b)
  $gr.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $gr.Clear([System.Drawing.Color]::White)
  $gr.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(40, 70, 160))), 0, 0, 1600, 24)
  $gr.DrawString($title, (New-Object System.Drawing.Font('Segoe UI', 54, [System.Drawing.FontStyle]::Bold)), [System.Drawing.Brushes]::Black, 80, 90)
  $yy = 260
  foreach ($l in $lines) { $gr.DrawString([char]0x2022 + '  ' + $l, (New-Object System.Drawing.Font('Segoe UI', 34)), [System.Drawing.Brushes]::Black, 100, $yy); $yy += 90 }
  $gr.Dispose(); $b.Save($file, [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose()
}
New-Slide (Join-Path $fixtures 'slide-2.png') 'Quarterly Hiring Overview' @('Engineering hired 12 people against a plan of 15', 'Attrition in support increased to 9 percent', 'Two senior roles remain open in platform team', 'Next step: approve contractor budget by Friday')
# A screen with a visible question (screen auto-answer).
New-Slide (Join-Path $fixtures 'quiz.png') 'Interview Question 3' @('Which data structure gives O(1) average lookup by key?', 'A) Linked list      B) Hash table', 'C) Binary heap      D) Sorted array', 'Explain your choice in one sentence.')

Write-Output "Fixtures written to $fixtures"
