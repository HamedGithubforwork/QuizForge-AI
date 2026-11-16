// @ts-nocheck
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const stylesheet = readFileSync(
  new URL('../MasteryAnalyticsPanel.css', import.meta.url),
  'utf8',
).replace(/\s+/g, ' ')

function propertyForRule(selector: string, property: string): string {
  const normalizedSelector = selector.replace(/\s+/g, ' ')
  const start = stylesheet.indexOf(`${normalizedSelector} {`)
  assert.notEqual(start, -1, `Missing selector: ${selector}`)

  const blockStart = stylesheet.indexOf('{', start)
  const blockEnd = stylesheet.indexOf('}', blockStart)
  assert.notEqual(blockStart, -1, `Missing rule body: ${selector}`)
  assert.notEqual(blockEnd, -1, `Unclosed rule body: ${selector}`)

  const value = stylesheet
    .slice(blockStart, blockEnd)
    .match(new RegExp(`\\b${property}:\\s*([^;]+);`, 'i'))?.[1]
  assert.ok(value, `Missing ${property} declaration: ${selector}`)
  return value.trim()
}

function colorForRule(selector: string): string {
  const color = propertyForRule(selector, 'color')
  assert.match(color, /^#[0-9a-f]{6}$/i, `Invalid foreground: ${color}`)
  return color
}

function backgroundsForRule(selector: string): string[] {
  const background = propertyForRule(selector, 'background')
  const gradient = background.match(/linear-gradient\(([^)]+)\)/i)

  if (gradient) {
    const stops = gradient[1].match(/#[0-9a-f]{6}/gi) ?? []
    assert.ok(stops.length > 0, `No gradient colors found: ${selector}`)
    return stops
  }

  if (background.toLowerCase() === 'white') {
    return ['#ffffff']
  }

  assert.match(background, /^#[0-9a-f]{6}$/i, `Unsupported background: ${background}`)
  return [background]
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
  const textRules = [
    {
      selector: '.mastery-overview-grid span',
      backgroundSelector: '.mastery-overview-grid article',
    },
    {
      selector: '.mastery-type-label span,\n.mastery-type-score span',
      backgroundSelector: '.mastery-type-row',
    },
    {
      selector: '.mastery-trend-date',
      backgroundSelector: '.mastery-panel',
    },
    {
      selector: '.mastery-page-list span',
      backgroundSelector: '.mastery-page-list article',
    },
    {
      selector: '.mastery-status-pending',
      backgroundSelector: '.mastery-status-pending',
    },
    {
      selector: '.mastery-file span',
      backgroundSelector: '.mastery-panel',
    },
    {
      selector: '.mastery-subheading span',
      backgroundSelector: '.mastery-panel',
    },
    {
      selector: '.mastery-method-note',
      backgroundSelector: '.mastery-method-note',
    },
  ] as const

  assert.equal(textRules.length, 8)

  for (const { selector, backgroundSelector } of textRules) {
    const foreground = colorForRule(selector)
    for (const background of backgroundsForRule(backgroundSelector)) {
      const ratio = contrastRatio(foreground, background)
      assert.ok(
        ratio >= 4.5,
        `${selector} on ${background} is ${ratio.toFixed(2)}:1, below 4.5:1`,
      )
    }
  }
})

