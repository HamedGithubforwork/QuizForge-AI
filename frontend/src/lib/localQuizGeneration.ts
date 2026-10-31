import type {
  DesktopLocalAiQuizStatus,
  DesktopLocalQuizRequest,
  DesktopLocalQuizResult,
} from './desktop'
import type {
  UploadResult,
} from '../types/quiz'
export type QuizGenerationMode =
  | 'cloud'
  | 'local'

const MAX_LOCAL_PDF_BYTES = 15 * 1024 * 1024

export async function readLocalPdfBytes(
  file: { size: number; arrayBuffer(): Promise<ArrayBuffer> },
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(file.size) || file.size < 1) {
    throw new Error('Choose a valid PDF file.')
  }
  if (file.size > MAX_LOCAL_PDF_BYTES) {
    throw new Error('This PDF is over the 15 MB limit for local processing.')
  }
  return new Uint8Array(await file.arrayBuffer())
}

export async function buildLocalQuizRequest(
  document: UploadResult,
  difficulty: string,
  status: DesktopLocalAiQuizStatus,
  loadPage:
    (
      documentSha256: string,
      pageNumber: number,
      signal?: AbortSignal,
    ) => Promise<string>,
  signal?: AbortSignal,
  questionCount: 5 | 10 | 15 = 5,
  questionType: 'multiple_choice' | 'true_false' | 'short_answer' | 'mixed' = 'multiple_choice',
): Promise<DesktopLocalQuizRequest> {
  if (
    !status.available ||
    !status.constraints ||
    !(status.constraints.questionCounts?.includes(questionCount) ?? status.constraints.questionCount === questionCount) ||
    !(status.constraints.questionTypes?.includes(questionType) ?? status.constraints.questionType === questionType)
  ) {
    throw new Error(
      'Local AI quiz generation is not ready on this desktop.',
    )
  }

  if (
    !['easy', 'medium', 'hard']
      .includes(difficulty)
  ) {
    throw new Error(
      'Choose a supported quiz difficulty.',
    )
  }

  if (
    document.character_count >
      status.constraints.maxSourceBytes
  ) {
    throw new Error(
      'This selection is too large for Local AI. Choose fewer pages or use Cloud AI.',
    )
  }

  signal?.throwIfAborted()
  const pages = await Promise.all(
    document.pages.map(async page => ({
      pageNumber: page.page_number,
      text: await loadPage(
        document.pdf_sha256,
        page.page_number,
        signal,
      ),
    })),
  )
  signal?.throwIfAborted()

  const bytes = pages.reduce(
    (total, page) =>
      total +
      new TextEncoder()
        .encode(page.text).byteLength,
    0,
  )

  if (
    bytes >
      status.constraints.maxSourceBytes
  ) {
    throw new Error(
      'This selection is too large for Local AI. Choose fewer pages or use Cloud AI.',
    )
  }

  return {
    pages,
    questionCount,
    difficulty:
      difficulty as
        DesktopLocalQuizRequest['difficulty'],
    questionType,
  }
}

export async function buildLocalPracticeRequest(
  document: UploadResult,
  difficulty: string,
  status: DesktopLocalAiQuizStatus,
  focusPages: number[],
  avoidQuestions: string[],
  loadPage:
    (
      documentSha256: string,
      pageNumber: number,
      signal?: AbortSignal,
    ) => Promise<string>,
  signal?: AbortSignal,
): Promise<DesktopLocalQuizRequest> {
  if (
    !Array.isArray(focusPages) ||
    focusPages.length < 1 ||
    focusPages.length > 20 ||
    new Set(focusPages).size !==
      focusPages.length ||
    focusPages.some(
      page =>
        !Number.isSafeInteger(page) ||
        page < 1,
    )
  ) {
    throw new Error(
      'Choose valid source pages for Local AI practice.',
    )
  }

  if (
    !Array.isArray(avoidQuestions) ||
    avoidQuestions.length > 20
  ) {
    throw new Error(
      'Local AI practice has too many prior questions to avoid.',
    )
  }

  const availablePages =
    new Set(
      document.pages.map(
        page => page.page_number,
      ),
    )

  if (
    focusPages.some(
      page =>
        !availablePages.has(page),
    )
  ) {
    throw new Error(
      'Reprocess or select the weak-area pages before using Local AI practice.',
    )
  }

  const focusedDocument: UploadResult = {
    ...document,
    pages: document.pages.filter(
      page =>
        focusPages.includes(
          page.page_number,
        ),
    ),
    character_count:
      document.pages
        .filter(
          page =>
            focusPages.includes(
              page.page_number,
            ),
        )
        .reduce(
          (sum, page) =>
            sum +
            page.character_count,
          0,
        ),
  }

  const request =
    await buildLocalQuizRequest(
      focusedDocument,
      difficulty,
      status,
      loadPage,
      signal,
    )

  return {
    ...request,
    practice: {
      avoidQuestions:
        avoidQuestions.map(
          question =>
            question.trim(),
        ),
    },
  }
}

export function localQuizErrorMessage(
  result: Extract<
    DesktopLocalQuizResult,
    { ok: false }
  >,
) {
  const messages: Record<
    typeof result.error,
    string
  > = {
    cancelled:
      'Local quiz generation was cancelled.',
    timed_out:
      'Local AI took too long. Try again or use Cloud AI.',
    busy:
      'Local AI is already working on another quiz.',
    model_missing:
      'Download the Local AI model in Local AI settings first.',
    invalid_model:
      'The local model failed verification. Remove it in Local AI settings and download it again.',
    runtime_invalid:
      'The Local AI runtime failed verification.',
    runtime_unavailable:
      'The Local AI runtime is not available in this desktop build yet.',
    source_too_large:
      'This selection is too large for Local AI. Choose fewer pages or use Cloud AI.',
    unsupported_quiz_mode:
      'That question count or type is not available in this Local AI build. Update the app and try again.',
    quiz_validation_failed:
      'Local AI could not create a valid quiz after retrying. Try fewer pages or use Cloud AI.',
    insufficient_source:
      'The selected pages do not contain enough distinct factual material for the requested local quiz. Choose more pages or use Cloud AI.',
    invalid_request:
      'The Local AI quiz request was invalid.',
    invalid_response:
      'The local model returned an invalid response.',
    generation_failed:
      'Local quiz generation failed. Try again or use Cloud AI.',
  }

  if (result.error !== 'quiz_validation_failed' || !result.diagnostic) {
    return messages[result.error]
  }

  const validationHints: Record<string, string> = {
    json: 'The model returned malformed JSON.',
    top_level_shape: 'The model response did not match the quiz format.',
    question_count: 'The model returned the wrong number of questions.',
    question_shape: 'At least one question was missing required fields.',
    multiple_choice_shape: 'A multiple-choice question did not have four valid choices and one answer.',
    true_false_shape: 'A true/false question did not match the required format.',
    short_answer_shape: 'A short-answer question did not match the required format or source.',
    mixed_type_coverage: 'The quiz did not include all requested question types.',
    requested_type_mismatch: 'The quiz included a question type different from the one selected.',
    duplicate_question: 'The quiz contained repeated questions.',
    unexpected_output_script: 'The quiz language did not match the source material.',
    truncated_output: 'The model response was cut off before the quiz was complete.',
    invalid_abstention: 'The model returned an invalid insufficient-source response.',
  }
  const hint = validationHints[result.diagnostic] ??
    `The quiz failed the “${result.diagnostic.replaceAll('_', ' ')}” validation check.`
  return `${messages[result.error]} ${hint}`
}
