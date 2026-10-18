import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApiServer } from './index.ts';
import { LIMITS } from './generation.ts';
import type { ProviderConfig } from './generation.ts';
import { analyzeLineProsody, tokenizeWords } from '../src/lib/prosody.ts';
import { PROSODY_LIMITS } from './prosody.ts';

const config: ProviderConfig = { mode: 'ai', provider: 'ChatMock', baseUrl: 'http://127.0.0.1:8000/v1', model: 'gpt-6-luna', apiKey: '' };
const input = { lines: ['Буря мглою небо кроет,', 'Вихри снежные крутя;'], activeLine: 0, settings: { meter: 'iamb', feet: 4, scheme: 'ABAB', precision: 'near', referenceLine: null, autoSuggest: true } };
const candidates = ['И буря мглою небо кроет', 'Вот буря мглою небо кроет', 'Вновь буря мглою небо кроет', 'Там буря мглою небо кроет', 'А буря мглою небо кроет', 'Но буря мглою небо кроет'];
function envelope(value: unknown) {
  return { status: 'completed', model: config.model, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] };
}
function provider(suggestions: unknown = candidates, inspect?: (body: Record<string, any>) => void): typeof fetch {
  return (async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    inspect?.(body);
    if (body.text.format.name === 'poetry_repairs') return Response.json(envelope({ suggestions }));
    const lines = JSON.parse(body.input).lines;
    return Response.json(envelope({ lines: lines.map((line: { index: number; text: string; words: Array<{ index: number; text: string; allowedStressVowels: number[] }> }) => ({ index: line.index, words: line.words.map(word => ({ index: word.index, text: word.text, stressVowel: word.allowedStressVowels[0] ?? null, status: word.allowedStressVowels.length ? 'known' : 'unknown' })) })) }));
  }) as typeof fetch;
}
async function listening(options: Parameters<typeof createApiServer>[0] = {}) {
  const server = createApiServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
function post(url: string, value: unknown = input) {
  return fetch(`${url}/api/repairs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
}

test('repairs return up to three independently checked full replacements with source identity', async t => {
  let generationBody: Record<string, any> | undefined;
  const { server, url } = await listening({ config, fetcher: provider(candidates, body => { if (body.text.format.name === 'poetry_repairs') generationBody = body; }) });
  t.after(() => server.close());
  const response = await post(url);
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const result = await response.json();
  assert.equal(result.source, input.lines[0]);
  assert.equal(result.mode, 'ai');
  assert.equal(result.model, config.model);
  assert.equal(result.suggestions.length, 3);
  assert.deepEqual(result.suggestions.map((item: { text: string }) => item.text), candidates.slice(0, 3));
  assert.ok(result.suggestions.every((item: { id: string; syllables: number }) => /^[a-f0-9]{16}$/u.test(item.id) && item.syllables === 9));
  assert.equal(result.suggestions[0].accentedText, 'И бу́ря мгло́ю не́бо кро́ет');
  assert.deepEqual(input.lines, ['Буря мглою небо кроет,', 'Вихри снежные крутя;']);
  assert.equal(generationBody?.model, config.model);
  assert.equal(generationBody?.text.format.strict, true);
  assert.equal(generationBody?.text.format.schema.properties.suggestions.maxItems, 6);
  assert.equal(generationBody?.text.format.schema.properties.suggestions.items.type, 'string');
  const task = JSON.parse(generationBody!.input);
  assert.deepEqual(task.poem, input.lines);
  assert.equal(task.source, input.lines[0]);
  assert.equal(task.ending, 'кроет');
  assert.equal('prefix' in task, false);
});

test('repairs filter bad rhythm, unknown words, changed endings, duplicates and multiline or overlong text', async t => {
  const values = ['Буря снова небо кроет', 'И квазизюзя небо кроет', 'И буря мглою небо скроет', 'И буря\nмглою небо кроет', 'а'.repeat(501) + ' кроет', candidates[0]];
  const { server, url } = await listening({ config, fetcher: provider(values) });
  t.after(() => server.close());
  const response = await post(url);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.suggestions.map((item: { text: string }) => item.text), [candidates[0]]);
  const second = await listening({ config, fetcher: provider([candidates[0], candidates[0], candidates[0].toUpperCase()]) });
  t.after(() => second.server.close());
  assert.equal((await (await post(second.url)).json()).suggestions.length, 1);
});

test('repairs preserve every authored acute word occurrence and its order, and forbid invented acutes', async t => {
  const manualInput = { ...input, lines: ['Бу́ря мгло́ю небо кроет'] };
  const valid = 'И бу́ря мгло́ю небо кроет';
  const values = ['И буря мглою небо кроет', 'И бу́ря мглою небо кроет', 'И мгло́ю бу́ря небо кроет', 'И бу́ря мгло́ю не́бо кроет', 'И бу́ря мгло́ю бу́ря небо кроет', valid];
  const { server, url } = await listening({ config, fetcher: provider(values) });
  t.after(() => server.close());
  const response = await post(url, manualInput);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).suggestions.map((item: { text: string }) => item.text), [valid]);
  const repeated = await listening({ config, fetcher: provider(['И бу́ря буря небо кроет', 'И бу́ря бу́ря небо кроет']) });
  t.after(() => repeated.server.close());
  const repeatedResponse = await post(repeated.url, { ...input, lines: ['Бу́ря бу́ря небо кроет'] });
  assert.equal(repeatedResponse.status, 200);
  assert.deepEqual((await repeatedResponse.json()).suggestions.map((item: { text: string }) => item.text), ['И бу́ря бу́ря небо кроет']);
});

test('no acceptable repair yields an understandable 422 rather than an unchecked replacement', async t => {
  const { server, url } = await listening({ config, fetcher: provider(['Буря снова небо кроет', 'И квазизюзя небо кроет']) });
  t.after(() => server.close());
  const response = await post(url);
  assert.equal(response.status, 422);
  const result = await response.json();
  assert.equal(result.code, 'NO_VALID_REPAIRS');
  assert.match(result.error, /Не удалось подобрать/u);
  assert.equal(result.suggestions, undefined);
});

test('repairs cannot extend a foot count with an unstressed terminal particle', async t => {
  const { server, url } = await listening({ config, fetcher: provider(['И буря мглою небо кроет же']) });
  t.after(() => server.close());
  const response = await post(url, { ...input, lines: ['Буря мглою небо кроет же'], settings: { ...input.settings, feet: 5 } });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, 'NO_VALID_REPAIRS');
});

test('repairs validate input and candidate count and give an explicit demo error', async t => {
  const { server, url } = await listening({ config, fetcher: provider() });
  t.after(() => server.close());
  assert.equal((await fetch(`${url}/api/repairs`)).status, 405);
  for (const value of [null, {}, { ...input, lines: [] }, { ...input, lines: ['а\nб'] }, { ...input, lines: ['а'.repeat(501)] }, { ...input, activeLine: 2 }, { ...input, lines: [''] }, { ...input, settings: { ...input.settings, meter: 'free' } }]) assert.equal((await post(url, value)).status, 400);
  for (const values of [[], Array(7).fill(candidates[0]), ['строка', 1], 'строка']) {
    const invalid = await listening({ config, fetcher: provider(values) });
    t.after(() => invalid.server.close());
    const result = await post(invalid.url);
    assert.equal(result.status, 502);
    assert.equal((await result.json()).code, 'INVALID_REPAIRS');
  }
  const demo = await listening({ config: { ...config, mode: 'demo' } });
  t.after(() => demo.server.close());
  const response = await post(demo.url);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'REPAIRS_UNAVAILABLE');
});

test('repairing the saved rhyme reference line is allowed because repairs preserve its ending', async t => {
  const { server, url } = await listening({ config, fetcher: provider() });
  t.after(() => server.close());
  const response = await post(url, { ...input, settings: { ...input.settings, referenceLine: 0 } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).source, input.lines[0]);
});

test('repair ending comparison preserves the full word with Unicode hyphens', async t => {
  for (const hyphen of ['‐', '‑']) {
    let sentEnding = '';
    const { server, url } = await listening({ config, fetcher: provider([`Я вижу кто${hyphen}то`], body => { if (body.text.format.name === 'poetry_repairs') sentEnding = JSON.parse(body.input).ending; }) });
    t.after(() => server.close());
    const response = await post(url, { ...input, lines: [`Вижу что${hyphen}то`], settings: { ...input.settings, feet: 2 } });
    assert.equal(response.status, 422);
    assert.equal(sentEnding, `что${hyphen}то`);
  }
});

test('dictionary-verified repairs survive other ambiguous candidates without a model stress call', async t => {
  let calls = 0;
  const fetcher = (async (_url, options) => {
    calls++;
    const body = JSON.parse(String(options?.body));
    assert.equal(body.text.format.name, 'poetry_repairs', 'A valid deterministic candidate needs no contextual request.');
    return Response.json(envelope({ suggestions: ['И буря мглою небо кроет', 'Зима туманом небо кроет'] }));
  }) as typeof fetch;
  const { server, url } = await listening({ config, fetcher });
  t.after(() => server.close());
  const response = await post(url);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).suggestions.map((item: { text: string }) => item.text), ['Зима туманом небо кроет']);
  assert.equal(calls, 1);
});

test('repair candidates share one bounded contextual prosody request without target meter', async t => {
  let stressCalls = 0;
  const lines = Array(100).fill('На дворе старый замок. '.repeat(5));
  lines[50] = input.lines[0];
  const { server, url } = await listening({ config, fetcher: provider(candidates, body => {
    if (body.text.format.name !== 'russian_word_stress') return;
    stressCalls++;
    const context = JSON.parse(body.input);
    const texts = context.lines.map((line: { text: string }) => line.text);
    assert.ok(texts.length <= LIMITS.lines);
    assert.ok(texts.join('').length <= LIMITS.poem);
    assert.ok(texts.every((text: string) => text.length <= LIMITS.line));
    assert.ok(texts.reduce((count: number, text: string) => count + tokenizeWords(text).length, 0) <= PROSODY_LIMITS.words);
    assert.ok(candidates.every(candidate => texts.includes(candidate)));
    assert.ok(texts.includes(lines[49]));
    assert.equal('meter' in context, false);
    assert.equal('feet' in context, false);
  }) });
  t.after(() => server.close());
  const response = await post(url, { ...input, lines, activeLine: 50 });
  assert.equal(response.status, 200);
  assert.equal(stressCalls, 1);
});

test('repair candidates cannot move certain lexical stress even when contextual model tries', async t => {
  const values = ['Буря снова замок кроет'];
  const { server, url } = await listening({ config, fetcher: provider(values) });
  t.after(() => server.close());
  const response = await post(url);
  assert.equal(response.status, 422);
  // All certain dictionary stresses remain independent of the generation model.
  const { dictionaryProsody } = await import('./prosody.ts');
  const { loadStressDictionary } = await import('./dictionary.ts');
  const analysis = dictionaryProsody({ lines: values }, await loadStressDictionary(), config.model).analysis.lines[0];
  assert.ok(analyzeLineProsody(values[0], analysis, 'iamb', 4).issues.length > 0);
});

test('closing repair client cancels upstream, releases shared concurrency, and late result is discarded', async t => {
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let markAborted!: () => void;
  const aborted = new Promise<void>(resolve => { markAborted = resolve; });
  let complete!: (response: Response) => void;
  let calls = 0;
  const immediate = provider();
  const fetcher = (async (...args: Parameters<typeof fetch>) => {
    if (++calls > 1) return immediate(...args);
    args[1]?.signal?.addEventListener('abort', markAborted, { once: true });
    began();
    return new Promise<Response>(resolve => { complete = resolve; });
  }) as typeof fetch;
  const { server, url } = await listening({ config, fetcher, maxConcurrent: 1 });
  t.after(() => server.close());
  const client = httpRequest(`${url}/api/repairs`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  client.on('error', () => {}); client.end(JSON.stringify(input));
  await started;
  assert.equal((await post(url)).status, 429);
  client.destroy();
  await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error('provider not aborted')), 1_000))]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await post(url)).status, 200);
  complete(Response.json(envelope({ suggestions: candidates })));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await post(url)).status, 200);
  assert.equal(calls, 5); // Three generation calls; only the two live requests reach contextual stress verification.
});

test('repair timeout is controlled even if provider ignores cancellation', async t => {
  const fetcher = (async () => new Promise<Response>(() => {})) as typeof fetch;
  const { server, url } = await listening({ config, fetcher, timeout: 20 });
  t.after(() => server.close());
  const response = await post(url);
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'GENERATION_TIMEOUT');
});
