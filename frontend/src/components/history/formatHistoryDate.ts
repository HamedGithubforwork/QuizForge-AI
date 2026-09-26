export function formatHistoryDate(
  dateString: string,
) {
  return new Date(dateString).toLocaleString(
    undefined,
    {
      dateStyle: 'medium',
      timeStyle: 'short',
    },
  )
}
