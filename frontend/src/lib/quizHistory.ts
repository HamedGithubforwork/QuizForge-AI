import {
  getCurrentDocumentSha256,
  withDocumentIdentityInQuizData,
} from './documentIdentity'
import { supabase } from './supabase'

type StoredSelectedAnswers =
  Record<string, number | string>

export type QuizHistoryRow = {
  id: string
  user_id: string
  quiz_title: string
  source_filename: string
  document_sha256?: string | null
  difficulty: string
  question_type: string
  question_count: number
  score: number
  percentage: number
  quiz_data: unknown
  selected_answers: StoredSelectedAnswers
  created_at: string
}

type SaveQuizHistoryInput = {
  quizTitle: string
  sourceFilename: string
  difficulty: string
  questionType: string
  questionCount: number
  score: number
  percentage: number
  quizData: unknown
  selectedAnswers: StoredSelectedAnswers
}

type SupabaseInsertError = {
  code?: string
  message?: string
}

function isMissingDocumentSha256Column(
  error: SupabaseInsertError,
) {
  const message =
    (error.message ?? '').toLowerCase()

  return (
    message.includes('document_sha256') &&
    (
      error.code === 'PGRST204' ||
      error.code === '42703' ||
      message.includes('column')
    )
  )
}

export async function saveQuizHistory(
  input: SaveQuizHistoryInput,
) {
  const {
    data: userData,
    error: userError,
  } =
    await supabase.auth.getUser()

  if (userError) {
    throw userError
  }

  if (!userData.user) {
    throw new Error(
      'You must be logged in to save a quiz.',
    )
  }

  const documentSha256 =
    getCurrentDocumentSha256(
      input.sourceFilename,
    )

  const payload = {
    user_id:
      userData.user.id,

    quiz_title:
      input.quizTitle,

    source_filename:
      input.sourceFilename,

    difficulty:
      input.difficulty,

    question_type:
      input.questionType,

    question_count:
      input.questionCount,

    score:
      input.score,

    percentage:
      input.percentage,

    quiz_data:
      withDocumentIdentityInQuizData(
        input.quizData,
        documentSha256,
      ),

    selected_answers:
      input.selectedAnswers,
  }

  if (documentSha256) {
    const { error } =
      await supabase
        .from('quiz_history')
        .insert({
          ...payload,
          document_sha256:
            documentSha256,
        })

    if (!error) {
      return
    }

    if (
      !isMissingDocumentSha256Column(
        error,
      )
    ) {
      throw error
    }
  }

  const { error } =
    await supabase
      .from('quiz_history')
      .insert(payload)

  if (error) {
    throw error
  }
}

export async function getQuizHistory() {
  const {
    data,
    error,
  } =
    await supabase
      .from('quiz_history')
      .select('*')
      .order(
        'created_at',
        {
          ascending: false,
        },
      )

  if (error) {
    throw error
  }

  return (
    data ?? []
  ) as QuizHistoryRow[]
}

export async function deleteQuizHistory(
  id: string,
) {
  const { error } =
    await supabase
      .from('quiz_history')
      .delete()
      .eq('id', id)

  if (error) {
    throw error
  }
}
