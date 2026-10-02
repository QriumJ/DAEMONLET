"""CPU-only synthetic GGUF admission checks; no model/runtime downloads."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'electron' / 'voice'))
from windows_model_check import check_model,check_gguf_model
import windows_model_check


class GgufChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.files = {}
        for name, data in [('talker.gguf', b'talker'), ('codec.gguf', b'codec')]:
            (self.root / name).write_bytes(data)
            self.files[name] = dict(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
        self.receipt = dict(schemaVersion=1,owner='daemonlet-managed-public-gguf-model',scope='public-base',
                            id='qwen3-tts-06b-gguf',fingerprint='a'*64,repository='Serveurperso/Qwen3-TTS-GGUF',
                            revision='b'*40,files=[dict(name=name,**entry) for name,entry in self.files.items()])
        self.policy = dict(engine=self.receipt['id'],modelRepository=self.receipt['repository'],modelRevision=self.receipt['revision'],
                           models=self.files,managedModelReceipt=self.receipt)

    def write_receipt(self,value=None):
        (self.root/'model-receipt.json').write_text(json.dumps(self.receipt if value is None else value)+'\n',encoding='utf-8')

    def tearDown(self):
        self.temp.cleanup()

    def test_installed_option_still_hashes_both_gguf_weights(self):
        result = check_model(self.root, self.files, 'installed', exact=True)
        self.assertEqual(result['modelHashedBytes'], 11)
        self.assertEqual(result['modelSkippedWeightBytes'], 0)
        self.assertTrue(result['weightIntegrityChecked'])
        (self.root / 'talker.gguf').write_bytes(b'evil!!')
        with self.assertRaises(ValueError):
            check_model(self.root, self.files, 'installed', exact=True)

    def test_missing_codec_and_extra_model_are_rejected(self):
        (self.root / 'wrong-custom-voice.gguf').write_bytes(b'other')
        with self.assertRaises(ValueError):
            check_model(self.root, self.files, exact=True)
        (self.root / 'wrong-custom-voice.gguf').unlink()
        (self.root / 'codec.gguf').unlink()
        with self.assertRaises(ValueError):
            check_model(self.root, self.files, exact=True)

    def test_model_file_links_and_parent_traversal_are_rejected(self):
        codec = self.root / 'codec.gguf'
        codec.unlink()
        codec.symlink_to(self.root / 'talker.gguf')
        with self.assertRaises(ValueError):
            check_model(self.root, self.files, exact=True)
        with self.assertRaises(ValueError):
            check_model(self.root, {'../outside.gguf': self.files['talker.gguf']})

    def test_manual_pair_and_exact_managed_receipt_both_require_full_hashes(self):
        result=check_gguf_model(self.root,self.policy)
        self.assertFalse(result['managedModelReceiptVerified']);self.assertEqual(result['modelHashedBytes'],11)
        self.write_receipt();result=check_gguf_model(self.root,self.policy)
        self.assertTrue(result['managedModelReceiptVerified']);self.assertTrue(result['weightIntegrityChecked'])
        self.assertEqual(result['modelVerification'],'full');self.assertEqual(result['modelSkippedWeightBytes'],0)
        (self.root/'talker.gguf').write_bytes(b'evil!!')
        with self.assertRaisesRegex(ValueError,'QWEN_GGUF_MODEL_CHANGED'):
            check_gguf_model(self.root,self.policy)

    def test_foreign_receipt_owner_identity_and_file_contracts_are_rejected(self):
        cases=[dict(self.receipt,owner='foreign'),dict(self.receipt,id='voxcpm2-gguf-f16'),dict(self.receipt,scope='private-lora'),
               dict(self.receipt,repository='foreign/repository'),dict(self.receipt,revision='c'*40),dict(self.receipt,fingerprint='c'*64),
               dict(self.receipt,schemaVersion=True),dict(self.receipt,schemaVersion=1.0),dict(self.receipt,unexpected='field')]
        for field,value in [('name','foreign.gguf'),('sha256','c'*64),('bytes',7)]:
            changed=json.loads(json.dumps(self.receipt));changed['files'][0][field]=value;cases.append(changed)
        for case in cases:
            with self.subTest(receipt=case):
                self.write_receipt(case)
                with self.assertRaisesRegex(ValueError,'QWEN_GGUF_MODEL_CHANGED'):
                    check_gguf_model(self.root,self.policy)

    def test_receipt_cannot_enable_extra_files_folders_or_unscoped_legacy_acceptance(self):
        self.write_receipt()
        with self.assertRaises(ValueError):
            check_model(self.root,self.files,exact=True)
        (self.root/'unrelated.json').write_text('{}')
        with self.assertRaisesRegex(ValueError,'QWEN_GGUF_MODEL_CHANGED'):
            check_gguf_model(self.root,self.policy)
        (self.root/'unrelated.json').unlink();(self.root/'empty-unknown').mkdir()
        with self.assertRaisesRegex(ValueError,'QWEN_GGUF_MODEL_CHANGED'):
            check_gguf_model(self.root,self.policy)

    def test_duplicate_fields_invalid_json_size_and_linked_receipts_are_rejected(self):
        valid=json.dumps(self.receipt)
        for content in [valid.replace('"schemaVersion": 1','"schemaVersion": 1, "schemaVersion": 1'),
                        '{"schemaVersion":NaN}', ' '*65537,'[]','not json']:
            with self.subTest(content=content[:50]):
                (self.root/'model-receipt.json').write_text(content)
                with self.assertRaisesRegex(ValueError,'QWEN_GGUF_MODEL_CHANGED'):
                    check_gguf_model(self.root,self.policy)
        (self.root/'model-receipt.json').unlink()
        (self.root/'model-receipt.json').symlink_to(self.root/'talker.gguf')
        with self.assertRaisesRegex(ValueError,'QWEN_GGUF_MODEL_CHANGED'):
            check_gguf_model(self.root,self.policy)

    def test_hardlinked_receipt_is_rejected(self):
        self.write_receipt()
        try:os.link(self.root/'model-receipt.json',self.root/'linked-receipt.json')
        except OSError:self.skipTest('host cannot create hard links')
        with self.assertRaisesRegex(ValueError,'QWEN_GGUF_MODEL_CHANGED'):
            check_gguf_model(self.root,self.policy)

    def test_policy_receipt_must_match_admitted_model_identity(self):
        for key,value in [('modelRevision','c'*40),('modelRepository','foreign/repository'),('engine','foreign')]:
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'QWEN_GGUF_MODEL_CHANGED'):
                check_gguf_model(self.root,dict(self.policy,**{key:value}))

    def test_receipt_replacement_during_weight_checks_is_rejected(self):
        self.write_receipt();real=windows_model_check.public_receipt;calls=0
        def checked(*args):
            nonlocal calls
            value=real(*args);calls+=1
            if calls==1:self.write_receipt(dict(self.receipt,owner='replaced-during-hash'))
            return value
        with patch.object(windows_model_check,'public_receipt',checked),self.assertRaisesRegex(ValueError,'QWEN_GGUF_MODEL_CHANGED'):
            check_gguf_model(self.root,self.policy)


if __name__ == '__main__':
    unittest.main()
