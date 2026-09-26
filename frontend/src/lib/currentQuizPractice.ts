import type {
  AnswerValue,
  QuestionType,
  QuizQuestion,
  QuizResult,
} from '../types/quiz.ts'

export type CurrentQuizPracticeFocus = {
  pages: number[]
  questionType: QuestionType
  avoidQuestions: string[]
  baselinePercent: number
  baselineQuestionCount: number
}

export function buildCurrentQuizPracticeFocus(
  quiz: QuizResult,
  selectedAnswers: Record<number, AnswerValue>,
  isQuestionCorrect: (
    question: QuizQuestion,
    answer: AnswerValue | undefined,
  ) => boolean,
): CurrentQuizPracticeFocus | null {
  const incorrectIndexes =
    quiz.questions
      .map((_, index) => index)
      .filter(
        (index) =>
          !isQuestionCorrect(
            quiz.questions[index],
            selectedAnswers[index],
          ),
      )

  if (incorrectIndexes.length === 0) {
    return null
  }

  const pages = Array.from(
    new Set(
      incorrectIndexes.flatMap(
        (index) =>
          quiz.questions[index].source_pages,
      ),
    ),
  ).sort((first, second) => first - second)

  const typeCounts: Record<QuestionType, number> = {
    multiple_choice: 0,
    true_false: 0,
    short_answer: 0,
  }

  incorrectIndexes.forEach((index) => {
    typeCounts[
      quiz.questions[index].question_type
    ] += 1
  })

  const questionType = (
    Object.entries(typeCounts) as [
      QuestionType,
      number,
    ][]
  ).sort(
    (first, second) =>
      second[1] - first[1],
  )[0][0]

  const baselineQuestions =
    quiz.questions
      .map((question, index) => ({
        question,
        answer: selectedAnswers[index],
      }))
      .filter(
        (item) =>
          item.question.question_type ===
          questionType,
      )

  const baselineScore =
    baselineQuestions.filter((item) =>
      isQuestionCorrect(
        item.question,
        item.answer,
      ),
    ).length

  const baselineQuestionCount =
    baselineQuestions.length

  return {
    pages,
    questionType,
    avoidQuestions:
      incorrectIndexes.map(
        (index) =>
          quiz.questions[index].question,
      ),
    baselinePercent:
      baselineQuestionCount > 0
        ? Math.round(
            (
              baselineScore /
              baselineQuestionCount
            ) * 100,
          )
        : 0,
    baselineQuestionCount,
  }
}
