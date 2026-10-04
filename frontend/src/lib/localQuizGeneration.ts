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
): Promise<DesktopLocalQuizRequest> {
  if (
    !status.available ||
    !status.constraints ||
    status.constraints.questionCount !== 5 ||
    status.constraints.questionType !==
      'multiple_choice'
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
      'This selection is too large for the current Local AI preview. Choose fewer pages or use Cloud AI.',
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
      'This selection is too large for the current Local AI preview. Choose fewer pages or use Cloud AI.',
    )
  }

  return {
    pages,
    questionCount: 5,
    difficulty:
      difficulty as
        DesktopLocalQuizRequest['difficulty'],
    questionType: 'multiple_choice',
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
      'This selection is too large for the current Local AI preview. Choose fewer pages or use Cloud AI.',
    unsupported_quiz_mode:
      'The Local AI preview currently supports only five multiple-choice questions.',
    quiz_validation_failed:
      'The local model returned an invalid quiz. Try again or use Cloud AI.',
    insufficient_source:
      'The selected pages do not contain enough distinct factual material for five local questions. Choose more pages or use Cloud AI.',
    invalid_request:
      'The Local AI quiz request was invalid.',
    invalid_response:
      'The local model returned an invalid response.',
    generation_failed:
      'Local quiz generation failed. Try again or use Cloud AI.',
  }

  return messages[result.error]
}
