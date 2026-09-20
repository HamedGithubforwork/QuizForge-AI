import copy
import unittest

from ocr_comparison import PAIRS, order, summarize


def samples():
    return [{'pair': pair, 'position': position, 'variant': variant, 'corpora': [
        {'name': name, 'fixture_sha256': name, 'text_sha256': 'same',
         'timings': {'total_wall': 9 if variant == 'gray' else 10, 'total_cpu': 4},
         'pages': [{'name': 'sample', 'precision': 1, 'recall': 1, 'reading_order': 1}]}
        for name in ('capacity', 'quality')]}
        for pair in range(PAIRS) for position, variant in enumerate(order(pair))]


class ControlledComparison(unittest.TestCase):
    def test_alternating_pairs_preserve_effect_direction(self):
        result = summarize(samples())['capacity']
        self.assertEqual(result['gray_faster_pairs'], PAIRS)
        self.assertAlmostEqual(result['gray_wall_change_percent'], -10)
        self.assertTrue(result['identical_text_in_all_pairs'])
        self.assertTrue(result['gray_quality_no_worse'])

    def test_incomplete_duplicate_or_mismatched_inputs_are_rejected(self):
        for change in ('missing', 'duplicate', 'input', 'order'):
            rows = samples()
            if change == 'missing':
                rows.pop()
            elif change == 'duplicate':
                rows[-1] = copy.deepcopy(rows[0])
            elif change == 'input':
                rows[-1]['corpora'][0]['fixture_sha256'] = 'different'
            else:
                rows[-1]['position'] = 1 - rows[-1]['position']
            with self.subTest(change=change), self.assertRaises(AssertionError):
                summarize(rows)

    def test_faster_but_worse_text_is_not_mistaken_for_quality_pass(self):
        rows = samples()
        gray = next(row for row in rows if row['variant'] == 'gray')
        gray['corpora'][1]['pages'][0]['reading_order'] = .8
        result = summarize(rows)['quality']
        self.assertEqual(result['gray_faster_pairs'], PAIRS)
        self.assertFalse(result['quality_passed'])
        self.assertFalse(result['gray_quality_no_worse'])


if __name__ == '__main__':
    unittest.main()
