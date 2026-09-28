import {
  useEffect,
  useState,
  type FormEvent,
} from 'react'

import type {
  CardCreate,
  CardRow,
} from '../../types/api.generated'
import {
  parseCardTags,
} from '../../lib/cardTags'

type CardEditorProps = {
  card?: CardRow | null
  onCancel: () => void
  onSave: (
    payload: CardCreate,
  ) => Promise<void>
}

type CardType =
  CardCreate['question_type']

function savedAnswer(
  card?: CardRow | null,
) {
  const answer = card?.answer

  if (
    answer &&
    typeof answer === 'object' &&
    'correct_answer' in answer &&
    typeof answer.correct_answer ===
      'string'
  ) {
    return answer.correct_answer
  }

  return ''
}

function savedCorrectIndex(
  card?: CardRow | null,
) {
  const answer = card?.answer

  if (
    answer &&
    typeof answer === 'object' &&
    'correct_index' in answer &&
    typeof answer.correct_index ===
      'number'
  ) {
    return answer.correct_index
  }

  return 0
}

function startingChoices(
  card?: CardRow | null,
) {
  if (
    card?.choices &&
    card.choices.length >= 2
  ) {
    return [
      ...card.choices,
    ]
  }

  return [
    '',
    '',
    '',
    '',
  ]
}

export default function CardEditor({
  card,
  onCancel,
  onSave,
}: CardEditorProps) {
  const [questionType, setQuestionType] =
    useState<CardType>(
      card?.question_type ??
        'short_answer',
    )
  const [question, setQuestion] =
    useState(
      card?.question ?? '',
    )
  const [answer, setAnswer] =
    useState(
      savedAnswer(card),
    )
  const [choices, setChoices] =
    useState<string[]>(
      startingChoices(card),
    )
  const [
    correctIndex,
    setCorrectIndex,
  ] = useState(
    savedCorrectIndex(card),
  )
  const [
    explanation,
    setExplanation,
  ] = useState(
    card?.explanation ?? '',
  )
  const [tagText, setTagText] =
    useState(
      (card?.tags ?? [])
        .join(', '),
    )
  const [saving, setSaving] =
    useState(false)
  const [error, setError] =
    useState('')

  useEffect(() => {
    setQuestionType(
      card?.question_type ??
        'short_answer',
    )
    setQuestion(
      card?.question ?? '',
    )
    setAnswer(
      savedAnswer(card),
    )
    setChoices(
      startingChoices(card),
    )
    setCorrectIndex(
      savedCorrectIndex(card),
    )
    setExplanation(
      card?.explanation ?? '',
    )
    setTagText(
      (card?.tags ?? [])
        .join(', '),
    )
    setError('')
    setSaving(false)
  }, [
    card?.id,
  ])

  function changeType(
    next: CardType,
  ) {
    setQuestionType(next)
    setError('')

    if (
      next === 'true_false'
    ) {
      const currentAnswer =
        answer.toLowerCase()

      const nextIndex =
        currentAnswer ===
        'false'
          ? 1
          : 0

      setChoices([
        'True',
        'False',
      ])
      setCorrectIndex(
        nextIndex,
      )
      setAnswer(
        nextIndex === 0
          ? 'True'
          : 'False',
      )
      return
    }

    if (
      next ===
        'multiple_choice' &&
      choices.length < 2
    ) {
      setChoices([
        '',
        '',
      ])
      setCorrectIndex(0)
    }
  }

  function updateChoice(
    index: number,
    value: string,
  ) {
    setChoices(
      choices.map(
        (choice, choiceIndex) =>
          choiceIndex === index
            ? value
            : choice,
      ),
    )
  }

  function addChoice() {
    if (choices.length >= 8) {
      return
    }

    setChoices([
      ...choices,
      '',
    ])
  }

  function removeChoice(
    index: number,
  ) {
    if (choices.length <= 2) {
      return
    }

    const next =
      choices.filter(
        (
          _choice,
          choiceIndex,
        ) =>
          choiceIndex !== index,
      )

    setChoices(next)

    if (
      correctIndex === index
    ) {
      setCorrectIndex(0)
    } else if (
      correctIndex > index
    ) {
      setCorrectIndex(
        correctIndex - 1,
      )
    }
  }

  async function submit(
    event: FormEvent,
  ) {
    event.preventDefault()

    const cleanQuestion =
      question.trim()
    const cleanExplanation =
      explanation.trim()
    let tags: string[]

    try {
      tags = parseCardTags(
        tagText,
      )
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Tags are invalid.',
      )
      return
    }

    if (!cleanQuestion) {
      setError(
        'Enter a question.',
      )
      return
    }

    let payload:
      CardCreate

    if (
      questionType ===
      'multiple_choice'
    ) {
      const cleanChoices =
        choices.map(
          (choice) =>
            choice.trim(),
        )

      if (
        cleanChoices.length < 2 ||
        cleanChoices.some(
          (choice) =>
            !choice,
        )
      ) {
        setError(
          'Enter at least two non-blank choices.',
        )
        return
      }

      if (
        correctIndex < 0 ||
        correctIndex >=
          cleanChoices.length
      ) {
        setError(
          'Choose the correct answer.',
        )
        return
      }

      const correctAnswer =
        cleanChoices[
          correctIndex
        ]

      payload = {
        question_type:
          'multiple_choice',
        question:
          cleanQuestion,
        answer: {
          correct_index:
            correctIndex,
          correct_answer:
            correctAnswer,
          accepted_answers: [
            correctAnswer,
          ],
        },
        choices:
          cleanChoices,
        explanation:
          cleanExplanation ||
          null,
        source_filename:
          card?.source_filename ??
          null,
        document_sha256:
          card?.document_sha256 ??
          null,
        source_pages:
          card?.source_pages ??
          [],
        tags,
      }
    } else if (
      questionType ===
      'true_false'
    ) {
      const trueFalseIndex =
        correctIndex === 1
          ? 1
          : 0
      const correctAnswer =
        trueFalseIndex === 0
          ? 'True'
          : 'False'

      payload = {
        question_type:
          'true_false',
        question:
          cleanQuestion,
        answer: {
          correct_index:
            trueFalseIndex,
          correct_answer:
            correctAnswer,
          accepted_answers: [
            correctAnswer,
          ],
        },
        choices: [
          'True',
          'False',
        ],
        explanation:
          cleanExplanation ||
          null,
        source_filename:
          card?.source_filename ??
          null,
        document_sha256:
          card?.document_sha256 ??
          null,
        source_pages:
          card?.source_pages ??
          [],
        tags,
      }
    } else {
      const cleanAnswer =
        answer.trim()

      if (!cleanAnswer) {
        setError(
          'Enter the correct answer.',
        )
        return
      }

      payload = {
        question_type:
          'short_answer',
        question:
          cleanQuestion,
        answer: {
          correct_answer:
            cleanAnswer,
          accepted_answers: [
            cleanAnswer,
          ],
        },
        choices: null,
        explanation:
          cleanExplanation ||
          null,
        source_filename:
          card?.source_filename ??
          null,
        document_sha256:
          card?.document_sha256 ??
          null,
        source_pages:
          card?.source_pages ??
          [],
        tags,
      }
    }

    setSaving(true)
    setError('')

    try {
      await onSave(payload)
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not save this card.',
      )
      setSaving(false)
    }
  }

  return (
    <form
      className="card-editor"
      onSubmit={submit}
    >
      <div className="card-editor-heading">
        <div>
          <span className="decks-eyebrow">
            {card
              ? 'EDIT CARD'
              : 'NEW CARD'}
          </span>

          <h2>
            {card
              ? 'Edit study card'
              : 'Add a study card'}
          </h2>
        </div>

        <label>
          <span>
            Card type
          </span>

          <select
            value={questionType}
            disabled={saving}
            onChange={(event) =>
              changeType(
                event.target
                  .value as
                  CardType,
              )
            }
          >
            <option value="short_answer">
              Question → answer
            </option>
            <option value="multiple_choice">
              Multiple choice
            </option>
            <option value="true_false">
              True / false
            </option>
          </select>
        </label>
      </div>

      <label className="card-editor-field">
        <span>Question</span>

        <textarea
          value={question}
          rows={3}
          maxLength={10_000}
          disabled={saving}
          autoFocus
          onChange={(event) =>
            setQuestion(
              event.target.value,
            )
          }
        />
      </label>

      {questionType ===
        'short_answer' && (
        <label className="card-editor-field">
          <span>
            Correct answer
          </span>

          <textarea
            value={answer}
            rows={2}
            disabled={saving}
            onChange={(event) =>
              setAnswer(
                event.target.value,
              )
            }
          />
        </label>
      )}

      {questionType ===
        'true_false' && (
        <fieldset className="card-editor-options">
          <legend>
            Correct answer
          </legend>

          {[
            'True',
            'False',
          ].map(
            (
              choice,
              index,
            ) => (
              <label
                key={choice}
                className="card-editor-radio"
              >
                <input
                  type="radio"
                  name="true-false-answer"
                  checked={
                    correctIndex ===
                    index
                  }
                  disabled={saving}
                  onChange={() => {
                    setCorrectIndex(
                      index,
                    )
                    setAnswer(
                      choice,
                    )
                  }}
                />

                <span>
                  {choice}
                </span>
              </label>
            ),
          )}
        </fieldset>
      )}

      {questionType ===
        'multiple_choice' && (
        <fieldset className="card-editor-options">
          <legend>
            Answer choices
          </legend>

          <div className="card-editor-choice-list">
            {choices.map(
              (
                choice,
                index,
              ) => (
                <div
                  className="card-editor-choice"
                  key={index}
                >
                  <input
                    type="radio"
                    name="correct-choice"
                    aria-label={
                      `Mark choice ${index + 1} correct`
                    }
                    checked={
                      correctIndex ===
                      index
                    }
                    disabled={saving}
                    onChange={() =>
                      setCorrectIndex(
                        index,
                      )
                    }
                  />

                  <input
                    type="text"
                    value={choice}
                    maxLength={2000}
                    disabled={saving}
                    placeholder={
                      `Choice ${index + 1}`
                    }
                    onChange={(
                      event,
                    ) =>
                      updateChoice(
                        index,
                        event.target
                          .value,
                      )
                    }
                  />

                  <button
                    className="card-editor-remove"
                    type="button"
                    disabled={
                      saving ||
                      choices.length <=
                        2
                    }
                    aria-label={
                      `Remove choice ${index + 1}`
                    }
                    onClick={() =>
                      removeChoice(
                        index,
                      )
                    }
                  >
                    ×
                  </button>
                </div>
              ),
            )}
          </div>

          <button
            className="card-editor-add-choice"
            type="button"
            disabled={
              saving ||
              choices.length >= 8
            }
            onClick={
              addChoice
            }
          >
            + Add choice
          </button>
        </fieldset>
      )}

      <label className="card-editor-field">
        <span>
          Explanation
          <small>
            {' '}optional
          </small>
        </span>

        <textarea
          value={explanation}
          rows={3}
          maxLength={20_000}
          disabled={saving}
          onChange={(event) =>
            setExplanation(
              event.target.value,
            )
          }
        />
      </label>

      <label className="card-editor-field">
        <span>
          Tags
          <small>
            {' '}optional
          </small>
        </span>

        <input
          type="text"
          value={tagText}
          maxLength={1050}
          disabled={saving}
          placeholder="exam 1, high yield, biology"
          onChange={(event) =>
            setTagText(
              event.target.value,
            )
          }
        />

        <small>
          Separate tags with commas. Up to 20 tags, 50 characters each.
        </small>
      </label>

      {card?.source_filename && (
        <p className="card-editor-source">
          Source metadata from{' '}
          <strong>
            {
              card.source_filename
            }
          </strong>
          {' '}will be preserved.
        </p>
      )}

      {error && (
        <p
          className="card-editor-error"
          role="alert"
        >
          {error}
        </p>
      )}

      <div className="card-editor-actions">
        <button
          className="decks-primary-button"
          type="submit"
          disabled={saving}
        >
          {saving
            ? 'Saving…'
            : card
              ? 'Save Card'
              : 'Add Card'}
        </button>

        <button
          className="decks-secondary-button"
          type="button"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
