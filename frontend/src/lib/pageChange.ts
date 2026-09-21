export async function verifySamePdf(file: File, sourceSha256: string): Promise<void> {
  if (!file.size || file.size > 15 * 1024 * 1024) throw new Error('Choose a PDF between 1 byte and 15 MB.')
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  if (actual !== sourceSha256) throw new Error('This is a different PDF. Select the original file to change its pages.')
}
