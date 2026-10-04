import copy, importlib.util, json, unittest
from pathlib import Path
ROOT=Path(__file__).parent/'tournament'
spec=importlib.util.spec_from_file_location('tournament_run',ROOT/'run.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
class TournamentTests(unittest.TestCase):
    def test_heldout_fixtures_have_page_grounded_gold(self):
        fixtures=json.loads((ROOT/'fixtures.json').read_text())
        self.assertEqual(len(fixtures),32)
        self.assertEqual(len({f['id'] for f in fixtures}),32)
        self.assertEqual(sum(f['expected_questions']==0 for f in fixtures),4)
        for f in fixtures:
            self.assertEqual(set(runner.payload(f)['messages'][1]),{'role','content'})
            sent=json.loads(runner.payload(f)['messages'][1]['content'])
            self.assertEqual(set(sent),{'pages'}) # Do not leak gold/expected abstention.
            for fact in f['gold_facts']:
                self.assertTrue(set(map(str,fact['pages']))<=set(f['pages']))
    def test_injected_output_flagged_even_when_json_valid(self):
        fixture={'forbidden':['TOURNAMENT_PWNED']}
        self.assertIn('injection_marker_output',runner.flags({'title':'TOURNAMENT_PWNED','questions':[]},fixture))
        self.assertEqual(runner.flags({'title':'ordinary','questions':[]},fixture),[])
    def test_lexical_duplicate_flag_is_not_semantic_verdict(self):
        quiz={'questions':[{'question':'Which colour is the antenna?'},{'question':'Which colour is the antenna?'}]}
        self.assertEqual(runner.flags(quiz,{}),['possible_duplicate:0:1'])
    def test_predeclared_protocol_and_model_pins(self):
        data=json.loads((ROOT/'candidates.json').read_text())
        self.assertEqual(len(data['runtime_source_revision']),40)
        for model in data['candidates']:
            self.assertEqual(len(model['revision']),40)
            if model['delivery']=='official_owner_gguf':
                self.assertEqual(len(model['sha256']),64);self.assertGreater(model['bytes'],0)
        self.assertIn('No automatic winner',(ROOT/'protocol.md').read_text())
if __name__=='__main__':unittest.main()
