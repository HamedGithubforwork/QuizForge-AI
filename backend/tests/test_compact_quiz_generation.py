"""Exercise the real SDK parser with synthetic model output; no paid model calls."""
import asyncio
import copy
import json

from fastapi import HTTPException
import httpx
from openai import AsyncOpenAI
import pytest

import quiz_service as service
from test_document_retrieval import _multiple_choice_quiz
from test_quiz_validation import make_concept_question


def compact(quiz):
    payload = quiz.model_dump()
    for question in payload['questions']:
        if question['question_type'] in ('multiple_choice', 'true_false'):
            for name in ('correct_answer', 'accepted_answers', 'grading'):
                del question[name]
    return payload


def true_false():
    question = _multiple_choice_quiz(7).questions[0].model_copy(deep=True)
    question.question_type = 'true_false'
    question.question = 'Photosynthesis stores chemical energy.'
    question.choices = ['True', 'False']
    question.correct_index = 0
    question.correct_answer = 'True'
    question.accepted_answers = ['True']
    return question


def fixtures(mode):
    if mode == 'multiple_choice': return _multiple_choice_quiz(7)
    if mode == 'true_false':
        questions = [true_false().model_copy(deep=True) for _ in range(5)]
        for n, question in enumerate(questions): question.question += f' Statement {n}.'
    elif mode == 'short_answer':
        questions = [make_concept_question().model_copy(deep=True) for _ in range(5)]
        for n, question in enumerate(questions): question.question += f' Topic {n}.'
    else:
        questions = [_multiple_choice_quiz(7).questions[0], true_false(), make_concept_question()]
        exact = make_concept_question().model_copy(deep=True)
        exact.question = 'What is the protocol abbreviation?'
        exact.correct_answer = 'TCP'
        exact.accepted_answers = ['TCP']
        exact.grading = service.ShortAnswerGradingSpec(grading_version=2, grading_mode='exact',
            answer_groups=[], required_group_count=0, numeric_value=0, numeric_tolerance=0, numeric_unit='')
        numeric = exact.model_copy(deep=True)
        numeric.question = 'What mass is specified in grams?'
        numeric.correct_answer = '2 g'
        numeric.accepted_answers = ['2 g']
        numeric.grading = service.ShortAnswerGradingSpec(grading_version=2, grading_mode='numeric',
            answer_groups=[], required_group_count=0, numeric_value=2, numeric_tolerance=0, numeric_unit='g')
        questions.extend([exact, numeric])
    for question in questions: question.source_pages = [7]
    return service.Quiz(title='Synthetic quiz', questions=questions)


def generate(monkeypatch, outputs, mode):
    requests = []
    async def scenario():
        def handler(request):
            requests.append(json.loads(request.content))
            payload = outputs[min(len(requests) - 1, len(outputs) - 1)]
            return httpx.Response(200, json={'id': 'resp_synthetic', 'object': 'response', 'created_at': 0,
                'status': 'completed', 'model': 'gpt-5.6-luna', 'parallel_tool_calls': False,
                'tool_choice': 'auto', 'tools': [], 'output': [{'id': 'msg_synthetic', 'type': 'message',
                'role': 'assistant', 'status': 'completed', 'content': [{'type': 'output_text',
                'text': json.dumps(payload), 'annotations': []}]}]})
        async with AsyncOpenAI(api_key='synthetic', base_url='https://synthetic.invalid/v1', max_retries=0,
                              http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler))) as client:
            async def get_client(_): return client
            monkeypatch.setenv('OPENAI_API_KEY', 'synthetic')
            monkeypatch.setattr(service, 'get_openai_client', get_client)
            result = await service.generate_quiz_from_pages(pages=[{'page_number': 7,
                'text': 'Photosynthesis stores chemical energy. TCP provides reliable delivery. The mass is 2 g. ' * 20}],
                question_count=5, difficulty='medium', question_type=mode)
            return result, requests
    return asyncio.run(scenario())


@pytest.mark.parametrize('mode', ['multiple_choice', 'true_false', 'short_answer', 'mixed'])
def test_sdk_schema_and_expansion_preserve_complete_public_quiz(monkeypatch, mode):
    expected = fixtures(mode)
    result, requests = generate(monkeypatch, [compact(expected)], mode)
    assert result == expected
    assert len(requests) == 1
    schema = requests[0]['text']['format']['schema']
    if mode != 'short_answer':
        fields = schema['$defs']['GeneratedChoiceQuestion']['properties']
        assert not {'correct_answer', 'accepted_answers', 'grading'} & fields.keys()
    prompt = requests[0]['input'][0]['content']
    if mode in ('multiple_choice', 'true_false'):
        assert 'SHORT ANSWER GRADING RUBRIC' not in prompt
        assert 'grading.numeric_unit' not in prompt
    assert all(q.source_pages == [7] for q in result.questions)


@pytest.mark.parametrize('failure', ['index', 'choices', 'source', 'duplicate', 'count', 'schema', 'mode'])
def test_bad_output_still_requires_retry_and_full_validation(monkeypatch, failure):
    expected = fixtures('multiple_choice')
    bad = compact(expected)
    first = bad['questions'][0]
    if failure == 'index': first['choices'] = ['Only one']; first['correct_index'] = 3
    if failure == 'choices': first['choices'] = ['A', 'B', 'C']
    if failure == 'source': first['source_pages'] = [1]
    if failure == 'duplicate': bad['questions'][1] = copy.deepcopy(first)
    if failure == 'count': bad['questions'].pop()
    if failure == 'schema': del first['explanation']
    if failure == 'mode': first.update(question_type='true_false', choices=['True', 'False'])
    result, requests = generate(monkeypatch, [bad, compact(expected)], 'multiple_choice')
    assert result == expected and len(requests) == 2
    assert 'VALIDATION RETRY' in requests[1]['input'][0]['content']
    with pytest.raises(HTTPException) as error:
        generate(monkeypatch, [bad], 'multiple_choice')
    assert error.value.status_code == 502


def test_invalid_short_answer_rubric_remains_rejected_in_mixed_quiz(monkeypatch):
    expected = fixtures('mixed')
    bad = compact(expected)
    bad['questions'][2]['grading']['required_group_count'] = 999
    result, requests = generate(monkeypatch, [bad, compact(expected)], 'mixed')
    assert result == expected and len(requests) == 2


def test_choice_output_is_smaller_for_the_same_content():
    expected = fixtures('multiple_choice')
    full = len(expected.model_dump_json().encode())
    smaller = len(json.dumps(compact(expected), separators=(',', ':')).encode())
    assert smaller < full
    print(json.dumps({'synthetic_questions': 5, 'full_response_bytes': full,
                      'compact_response_bytes': smaller, 'reduction_percent': round(100 * (1 - smaller / full), 1)}))
