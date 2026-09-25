import assert from 'node:assert/strict';
import test from 'node:test';
import { selectMandarinVoice, SPEECH_PROMPTS } from '../lib/audio.ts';
import { CHARACTERS } from '../lib/learning.ts';

test('each taught character and example word has a reviewed speech prompt', () => {
  for (const c of CHARACTERS) {
    assert.equal(SPEECH_PROMPTS[c.id], c.hanzi);
    assert.equal(SPEECH_PROMPTS[`${c.id}-word`], c.word);
  }
  for (const key of ['welcome', 'write', 'pinyin', 'recognition']) assert.ok(SPEECH_PROMPTS[key]);
});

test('Mandarin selection prefers an installed voice and excludes Cantonese', () => {
  const cantonese = { lang: 'zh-HK', localService: true };
  const remoteMandarin = { lang: 'zh-CN', localService: false };
  const installedMandarin = { lang: 'zh_CN', localService: true };
  const voices = [cantonese, remoteMandarin, installedMandarin];
  assert.equal(selectMandarinVoice(voices), installedMandarin);
  assert.deepEqual(voices, [cantonese, remoteMandarin, installedMandarin]);
  assert.equal(selectMandarinVoice([cantonese]), undefined);
  assert.equal(selectMandarinVoice([]), undefined);
});
