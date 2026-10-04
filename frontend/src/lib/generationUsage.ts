export type LocalGenerationUsageKind =
  | 'quiz'
  | 'targeted_practice'

export async function reportLocalGenerationUsage(
  send: (
    path: string,
    init?: RequestInit,
  ) => Promise<Response>,
  kind: LocalGenerationUsageKind,
) {
  try {
    const response = await send(
      '/api/generation-usage/local',
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json',
        },
        body: JSON.stringify({ kind }),
      },
    )
    return response.ok
  } catch {
    return false
  }
}
