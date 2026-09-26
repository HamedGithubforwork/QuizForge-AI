import type {
  QuestionMode,
  QuestionType,
  QuizResult,
} from '../types/quiz.ts'

export type QuizGenerationRequest = {
  file: File
  questionCount: number
  difficulty: string
  questionType: QuestionMode
  focusPages?: number[]
  focusQuestionTypes?: QuestionType[]
  avoidQuestions?: string[]
}

type ApiFetch = (
  path: string,
  init?: RequestInit,
) => Promise<Response>

function appendOptionalFields(
  formData: FormData,
  request: QuizGenerationRequest,
) {
  if (request.focusPages) {
    formData.append(
      'focus_pages',
      request.focusPages.join(','),
    )
  }

  if (request.focusQuestionTypes) {
    formData.append(
      'focus_question_types',
      request.focusQuestionTypes.join(','),
    )
  }

  if (request.avoidQuestions) {
    formData.append(
      'avoid_questions',
      JSON.stringify(request.avoidQuestions),
    )
  }
}

export function buildQuizGenerationFormData(
  request: QuizGenerationRequest,
) {
  const formData = new FormData()
  formData.append('file', request.file)
  formData.append(
    'question_count',
    request.questionCount.toString(),
  )
  formData.append(
    'difficulty',
    request.difficulty,
  )
  formData.append(
    'question_type',
    request.questionType,
  )
  appendOptionalFields(
    formData,
    request,
  )
  return formData
}

export async function requestQuizGeneration(
  fetcher: ApiFetch,
  request: QuizGenerationRequest,
  responseError: string,
): Promise<QuizResult> {
  const response = await fetcher(
    '/api/quizzes/generate',
    {
      method: 'POST',
      body: buildQuizGenerationFormData(
        request,
      ),
    },
  )

  const data = await response.json() as
    | QuizResult
    | { detail?: string }

  if (!response.ok) {
    throw new Error(
      'detail' in data && data.detail
        ? data.detail
        : responseError,
    )
  }

  return data as QuizResult
}
