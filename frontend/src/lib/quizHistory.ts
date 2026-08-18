import { supabase } from './supabase'

type StoredSelectedAnswers =
  Record<string, number | string>

export type QuizHistoryRow = {
  id: string
  user_id: string
  quiz_title: string
  source_filename: string
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

  const { error } =
    await supabase
      .from('quiz_history')
      .insert({
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
          input.quizData,

        selected_answers:
          input.selectedAnswers,
      })

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
