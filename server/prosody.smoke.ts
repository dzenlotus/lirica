// Explicit live check: node --expose-gc --env-file-if-exists=.env server/prosody.smoke.ts
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApiServer } from './index.ts';
import { readConfig } from './generation.ts';
import { loadStressDictionary } from './dictionary.ts';
import { tokenizeWords } from '../src/lib/prosody.ts';
import type { ProsodyResponse } from '../src/lib/prosody.ts';

type Expected = number | null | 'unknown';
const cases: Array<{ name: string; lines: string[]; expected: Expected[][] }> = [
  { name: 'classics and contextual homographs', lines: ['Буря мглою небо кроет,', 'Вихри снежные крутя;', 'Под голубыми небесами', 'Великолепными коврами,', 'Блестя на солнце, снег лежит;', 'На холме стоит старинный замок.', 'Ключ открывает дверной замок.'], expected: [[0, 0, 0, 0], [0, 0, 1], [null, 2, 2], [3, 1], [1, null, 0, 0, 1], [null, 1, 1, 1, 0], [0, 2, 1, 1]] },
  { name: 'ambiguous bare homograph', lines: ['замок'], expected: [['unknown']] },
  { name: 'author acute and ё', lines: ['За́мок и ёж.'], expected: [[0, null, 0]] },
  { name: 'historical stress transfer', lines: ['Я из лесу вышел; был сильный мороз.'], expected: [[null, 0, null, 0, 0, 0, 1]] },
  { name: 'held-out ordinary words and е/ё ambiguity', lines: ['Туман над рекою струится, колокольчик звенит.', 'Черешня дрожит под невесомым ветром.', 'В полуденном небе сверкает зарница.', 'Звезды мерцают в небе.', 'Свет далёкой звезды достиг земли.'], expected: [[1, null, 1, 1, 2, 1], [1, 1, null, 2, 0], [1, 0, 1, 1], [0, 1, 0], [0, 1, 1, 1, 1]] },
  { name: 'dictionary fast path', lines: ['Под голубыми небесами'], expected: [[null, 2, 2]] },
  { name: 'OOV stays unknown', lines: ['Квазизюзя'], expected: [['unknown']] },
];
const config = readConfig();
assert.equal(config.mode, 'ai', 'The live check needs a configured model.');
assert.equal(config.model, 'gpt-6-luna', 'This check verifies GPT-6 Luna.');
const loadStarted = performance.now();
await loadStressDictionary();
if (typeof global.gc === 'function') global.gc();
console.log(JSON.stringify({ dictionaryLoadMs: Math.round(performance.now() - loadStarted), heapMiB: Math.round(process.memoryUsage().heapUsed / 1_048_576), rssMiB: Math.round(process.memoryUsage().rss / 1_048_576) }));
let providerCalls = 0;
const fetcher = ((...args: Parameters<typeof fetch>) => { providerCalls++; return fetch(...args); }) as typeof fetch;
for (let run = 1; run <= 2; run++) {
  // Fresh HTTP server prevents its completed-context cache from masking model variance.
  const server = createApiServer({ config, fetcher });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/prosody`;
  try {
    for (let index = 0; index < cases.length; index += 2) await Promise.all(cases.slice(index, index + 2).map(async item => {
      const start = performance.now();
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: item.lines }), signal: AbortSignal.timeout(50_000) });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      const result = body as ProsodyResponse;
      assert.equal(result.model, config.model);
      assert.deepEqual(result.lines.map(line => line.text), item.lines);
      const failures: string[] = [];
      result.lines.forEach((line, lineIndex) => {
        const tokens = tokenizeWords(line.text);
        assert.equal(line.words.length, item.expected[lineIndex]!.length);
        line.words.forEach((word, wordIndex) => {
          const expected = item.expected[lineIndex]![wordIndex];
          const correct = expected === null ? word.status === 'weak' && word.stress === null : expected === 'unknown' ? word.status === 'unknown' && word.stress === null : word.status === 'known' && word.stress === tokens[wordIndex]!.vowels[expected!];
          if (!correct) failures.push(`${tokens[wordIndex]!.text}: ${word.status}/${word.stress === null ? 'null' : tokens[wordIndex]!.vowels.indexOf(word.stress)} expected ${expected}`);
        });
      });
      await new Promise<void>(resolve => process.stdout.write(JSON.stringify({ run, case: item.name, elapsedMs: Math.round(performance.now() - start), words: item.expected.flat().length, failures }) + '\n', () => resolve()));
      assert.deepEqual(failures, [], item.name);
    }));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
console.log(JSON.stringify({ status: 'PASS', runs: 2, verifiedWordsPerRun: cases.reduce((count, item) => count + item.expected.flat().length, 0), providerCalls, cases: cases.map(item => item.name) }));
