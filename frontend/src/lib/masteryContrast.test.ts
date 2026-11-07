// @ts-nocheck
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const stylesheet = readFileSync(
  new URL('../MasteryAnalyticsPanel.css', import.meta.url),
  'utf8',
)

function colorForRule(selector: string): string {
  const normalizedStylesheet = stylesheet.replace(/\s+/g, ' ')
  const normalizedSelector = selector.replace(/\s+/g, ' ')
  const start = normalizedStylesheet.indexOf(normalizedSelector)
  assert.notEqual(start, -1, `Missing selector: ${selector}`)

  const blockStart = normalizedStylesheet.indexOf('{', start)
  const blockEnd = normalizedStylesheet.indexOf('}', blockStart)
  assert.notEqual(blockStart, -1, `Missing rule body: ${selector}`)
  assert.notEqual(blockEnd, -1, `Unclosed rule body: ${selector}`)

  const color = normalizedStylesheet
    .slice(blockStart, blockEnd)
    .match(/\bcolor:\s*(#[0-9a-f]{6})\b/i)?.[1]
  assert.ok(color, `Missing foreground color: ${selector}`)
  return color
}

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)?.map((channel) =>
    Number.parseInt(channel, 16) / 255,
  )
  assert.ok(channels?.length === 3, `Invalid color: ${hex}`)

  const linear = channels.map((channel) =>
    channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4,
  )

  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2])
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground)
  const backgroundLuminance = relativeLuminance(background)
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  )
}

test('mastery analytics small text meets AA contrast on its surfaces', () => {
  const failingRules = [
    ['.mastery-overview-grid span', '#ffffff'],
    [
      '.mastery-type-label span,\n.mastery-type-score span',
      '#ffffff',
    ],
    ['.mastery-trend-date', '#f7f8fe'],
    ['.mastery-page-list span', '#fffaf7'],
  ] as const

  for (const [selector, background] of failingRules) {
    const ratio = contrastRatio(colorForRule(selector), background)
    assert.ok(
      ratio >= 4.5,
      `${selector} contrast ${ratio.toFixed(2)}:1 is below 4.5:1`,
    )
  }
})

