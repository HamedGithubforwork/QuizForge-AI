import { useEffect, useRef, useState, type FormEvent } from 'react'
import { apiFetch } from '../../lib/api'
import { createStudyDeck } from '../../lib/decks'
import type { DeckDetail } from '../../types/api.generated'

export default function CreateDeckForm({ onCreated, onCancel }: {
  onCreated: (deck: DeckDetail) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const active = useRef(true)

  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending.current) return
    const cleanName = name.trim()
    if (!cleanName) {
      setError('Enter a deck name.')
      return
    }
    pending.current = true
    setSaving(true)
    setError('')
    try {
      const deck = await createStudyDeck({
        name: cleanName,
        description: description.trim() || null,
        cards: [],
      }, apiFetch)
      if (active.current) onCreated(deck)
    } catch (caught) {
      if (active.current) setError(caught instanceof Error ? caught.message : 'Could not create this deck.')
    } finally {
      pending.current = false
      if (active.current) setSaving(false)
    }
  }

  return (
    <form className="create-deck-form card-editor" aria-labelledby="create-deck-heading" onSubmit={submit}>
      <div>
        <h2 id="create-deck-heading">Create a study deck</h2>
        <p>Start with an empty deck, then add your own questions and answers.</p>
      </div>
      <label className="card-editor-field">
        <span>Deck name</span>
        <input type="text" value={name} onChange={event => setName(event.target.value)}
          maxLength={200} required autoFocus disabled={saving} />
      </label>
      <label className="card-editor-field">
        <span>Description (optional)</span>
        <textarea value={description} onChange={event => setDescription(event.target.value)}
          maxLength={2000} rows={3} disabled={saving} />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="deck-management-panel-actions">
        <button className="decks-primary-button" type="submit" disabled={saving}>
          {saving ? 'Creating…' : 'Create Deck'}
        </button>
        <button className="decks-secondary-button" type="button" disabled={saving} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}
