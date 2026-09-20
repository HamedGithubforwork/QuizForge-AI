export function normalizePageSelection(value: string): string {
  if (value.length > 400) throw new Error('The page selection is too long.')
  if (!value.trim()) return ''
  const pages = new Set<number>()
  for (const part of value.split(',')) {
    const match = /^\s*([0-9]{1,3})(?:\s*-\s*([0-9]{1,3}))?\s*$/.exec(part)
    if (!match) throw new Error('Use page numbers or ranges, for example 1, 3-5.')
    const start = Number(match[1])
    const end = match[2] ? Number(match[2]) : start
    if (start < 1 || end > 100 || start > end) {
      throw new Error('Page ranges must be between 1 and 100, in ascending order.')
    }
    for (let page = start; page <= end; page += 1) pages.add(page)
  }
  return [...pages].sort((a, b) => a - b).join(',')
}
