import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApiServer } from './index.ts';
import { ApiError, LIMITS } from './generation.ts';
import type { ProviderConfig } from './generation.ts';
import { analyzeProsody, constrainProsody, dictionaryProsody, parseProsody, PROSODY_LIMITS, prosodyProviderBody, validateProsodyRequest } from './prosody.ts';
import type { ProsodyRequest } from './prosody.ts';
import { tokenizeWords } from '../src/lib/prosody.ts';
import { dictionaryReading, loadStressDictionary } from './dictionary.ts';
import type { StressDictionary } from './dictionary.ts';

const config: ProviderConfig = { mode: 'ai', provider: 'ChatMock', baseUrl: 'http://127.0.0.1:8000/v1', model: 'gpt-6-luna', apiKey: '' };
const input = { lines: ['😀 Я храню́ старый замок.', '', 'На двери висит замок, ёж рядом.'] };
const fixtureDictionary: StressDictionary = {
  accents: { голубыми: 'голуб+ыми', мглою: 'мгл+ою', небесами: 'небес+ами', замок: 'з+амок', лесу: 'л+есу', берёза: 'бер+ёза', звезды: 'звезд+ы', звёзды: 'зв+ёзды', из: '+из', молоко: 'молок+о' },
  omographs: { замок: ['з+амок', 'зам+ок'], дорога: ['дор+ога', 'дорог+а'], лесу: ['л+есу', 'лес+у'] },
  yoWords: { береза: 'берёза' }, yoHomographs: { звезды: 'звёзды' },
};
function result(request: ProsodyRequest = input) {
  return { lines: request.lines.map((text, index) => ({ index, words: tokenizeWords(text).map(word => ({ index: word.index, text: word.text, stressVowel: null as number | null, status: 'unknown' })) })) };
}
function envelope(value: unknown) {
  return { status: 'completed', model: config.model, output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] };
}
async function listening(options: Parameters<typeof createApiServer>[0] = {}) {
  const server = createApiServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}/api/prosody`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
const echoProvider = (async (_url, options) => {
  const sent = JSON.parse(String(options?.body));
  return Response.json(envelope(result({ lines: JSON.parse(sent.input).lines.map((line: { text: string }) => line.text) })));
}) as typeof fetch;

test('dictionary lookup prioritizes homographs, restores certain ё, and exposes е/ё stress alternatives', () => {
  assert.deepEqual(dictionaryReading('ГОЛУБЫ́МИ', fixtureDictionary), { choices: [2], ambiguous: false });
  assert.deepEqual(dictionaryReading('замок', fixtureDictionary), { choices: [0, 1], ambiguous: true });
  assert.deepEqual(dictionaryReading('береза', fixtureDictionary), { choices: [1], ambiguous: false });
  assert.deepEqual(dictionaryReading('звезды', fixtureDictionary), { choices: [0, 1], ambiguous: true });
  assert.deepEqual(dictionaryReading('квазизюзя', fixtureDictionary), { choices: [], ambiguous: false });
  for (const malformed of ['голубыми', 'гол+уб+ыми', 'голуб+мы', '+голубыми']) {
    assert.deepEqual(dictionaryReading('голубыми', { ...fixtureDictionary, accents: { голубыми: malformed } }).choices, []);
  }
});

test('dictionary overrides a linguistically wrong model index and unsupported weak/OOV guesses', () => {
  const request = { lines: ['Под голубыми небесами мглою квазизюзя'] };
  const payload = result(request);
  payload.lines[0]!.words.forEach(word => Object.assign(word, { status: 'known', stressVowel: 0 }));
  Object.assign(payload.lines[0]!.words[1]!, { stressVowel: 1 }); // Observed model error: голу́быми.
  Object.assign(payload.lines[0]!.words[2]!, { status: 'weak', stressVowel: null });
  const constrained = constrainProsody(parseProsody(payload, request, config.model), fixtureDictionary);
  const tokens = tokenizeWords(request.lines[0]!);
  assert.equal(constrained.lines[0]!.words[0]!.status, 'weak');
  assert.equal(constrained.lines[0]!.words[1]!.stress, tokens[1]!.vowels[2]);
  assert.equal(constrained.lines[0]!.words[2]!.stress, tokens[2]!.vowels[2]);
  assert.equal(constrained.lines[0]!.words[3]!.stress, tokens[3]!.vowels[0]);
  assert.equal(constrained.lines[0]!.words[4]!.status, 'unknown');
  assert.equal(constrained.lines[0]!.words[4]!.stress, null);
});

test('only admissible contextual homograph choices survive; bare homographs remain unknown', () => {
  const request = { lines: ['замок дорога звезды'] };
  const payload = result(request);
  Object.assign(payload.lines[0]!.words[0]!, { status: 'known', stressVowel: 1 });
  Object.assign(payload.lines[0]!.words[1]!, { status: 'known', stressVowel: 0 });
  const constrained = constrainProsody(parseProsody(payload, request, config.model), fixtureDictionary);
  assert.equal(constrained.lines[0]!.words[0]!.stress, tokenizeWords(request.lines[0]!)[0]!.vowels[1]);
  assert.equal(constrained.lines[0]!.words[1]!.status, 'unknown');
  assert.equal(constrained.lines[0]!.words[2]!.status, 'unknown');
});

test('dictionary fast path preserves author accents, ё, weak function words and unknown OOVs', () => {
  const request = { lines: ['Я под голубыми небесами, из‑за квазизюзи, за́мок, ёж.'] };
  const { analysis, needsContext } = dictionaryProsody(request, fixtureDictionary, config.model);
  assert.equal(needsContext, false);
  assert.deepEqual(analysis.lines[0]!.words.map(word => word.status), ['weak', 'weak', 'known', 'known', 'weak', 'unknown', 'known', 'known']);
  assert.equal(analysis.lines[0]!.words[6]!.stress, request.lines[0]!.indexOf('а́'));
});

test('weak polysyllables require a contiguous adjacent stressed preposition', () => {
  for (const [text, prepKnown, weak] of [['из лесу', true, true], ['из лесу', false, false], ['из, лесу', true, false]] as const) {
    const request = { lines: [text] };
    const payload = result(request);
    Object.assign(payload.lines[0]!.words[0]!, { status: prepKnown ? 'known' : 'weak', stressVowel: prepKnown ? 0 : null });
    Object.assign(payload.lines[0]!.words[1]!, { status: 'weak', stressVowel: null });
    const constrained = constrainProsody(parseProsody(payload, request, config.model), fixtureDictionary);
    assert.equal(constrained.lines[0]!.words[1]!.status, weak ? 'weak' : 'unknown');
    assert.equal(constrained.lines[0]!.words[0]!.status, weak ? 'known' : 'weak');
  }
});

test('a model-stressed preposition cannot arbitrarily deaccent a certain dictionary word', () => {
  const request = { lines: ['замок за молоко'] };
  const payload = result(request);
  Object.assign(payload.lines[0]!.words[1]!, { status: 'known', stressVowel: 0 });
  Object.assign(payload.lines[0]!.words[2]!, { status: 'weak', stressVowel: null });
  const constrained = constrainProsody(parseProsody(payload, request, config.model), fixtureDictionary);
  assert.equal(constrained.lines[0]!.words[1]!.status, 'weak');
  assert.equal(constrained.lines[0]!.words[2]!.status, 'known');
  assert.equal(constrained.lines[0]!.words[2]!.stress, tokenizeWords(request.lines[0]!)[2]!.vowels[2]);
});

test('an author-stressed noun prevents automatic stress transfer onto its preposition', () => {
  const request = { lines: ['замок из ле́су'] };
  const payload = result(request);
  Object.assign(payload.lines[0]!.words[1]!, { status: 'known', stressVowel: 0 });
  Object.assign(payload.lines[0]!.words[2]!, { status: 'weak', stressVowel: null });
  const constrained = constrainProsody(parseProsody(payload, request, config.model), fixtureDictionary);
  assert.equal(constrained.lines[0]!.words[1]!.status, 'weak');
  assert.equal(constrained.lines[0]!.words[2]!.status, 'known');
  assert.equal(constrained.lines[0]!.words[2]!.stress, request.lines[0]!.indexOf('е́'));
});

test('real pinned dictionary prevents голубыми regression and ordinary/OOV text needs no provider', async () => {
  const dictionary = await loadStressDictionary();
  assert.deepEqual(dictionaryReading('голубыми', dictionary), { choices: [2], ambiguous: false });
  assert.deepEqual(dictionaryReading('звезды', dictionary), { choices: [0, 1], ambiguous: true });
  assert.deepEqual(dictionaryReading('замок', dictionary), { choices: [0, 1], ambiguous: true });
  const fetcher = (async () => { throw new Error('Unambiguous/OOV text must not invoke a model.'); }) as typeof fetch;
  const response = await analyzeProsody({ lines: ['Под голубыми небесами квазизюзя.'] }, config, new AbortController().signal, fetcher);
  assert.deepEqual(response.lines[0]!.words.map(word => word.status), ['weak', 'known', 'known', 'unknown']);
  assert.equal((await analyzeProsody({ lines: ['замок'] }, config, new AbortController().signal, fetcher)).lines[0]!.words[0]!.status, 'unknown');
});

test('prosody request limits reuse text bounds and cap structured response size explicitly', () => {
  assert.deepEqual(validateProsodyRequest(input), input);
  for (const value of [null, [], {}, { lines: [] }, { lines: ['a\nb'] }, { lines: ['a'.repeat(501)] }, { lines: Array(101).fill('') }, { lines: Array(100).fill('a'.repeat(121)) }]) {
    assert.throws(() => validateProsodyRequest(value), error => error instanceof ApiError && error.status === 400);
  }
  assert.throws(() => validateProsodyRequest({ lines: Array(10).fill('а '.repeat(61)) }), error => error instanceof ApiError && error.code === 'PROSODY_TOO_LARGE');
  const max = validateProsodyRequest({ lines: Array(100).fill('слово '.repeat(6)) });
  assert.ok(prosodyProviderBody(max).max_output_tokens < 32_768);
});

test('strict prosody mapping preserves all original text, UTF-16 indices, unknowns and manual acutes', () => {
  const payload = result();
  Object.assign(payload.lines[0]!.words[1]!, { status: 'known', stressVowel: 1 });
  Object.assign(payload.lines[2]!.words[0]!, { status: 'weak', stressVowel: null });
  Object.assign(payload.lines[2]!.words[4]!, { status: 'known', stressVowel: 0 });
  const parsed = parseProsody(payload, input, config.model);
  assert.deepEqual(parsed.lines.map(line => line.text), input.lines);
  assert.deepEqual(parsed.lines[1]!.words, []);
  const accented = parsed.lines[0]!.words[1]!;
  assert.equal(input.lines[0]!.slice(accented.start, accented.end), 'храню́');
  assert.equal(accented.stress, input.lines[0]!.indexOf('ю'));
  assert.equal(parsed.lines[0]!.words[3]!.status, 'unknown');
  assert.equal(parsed.lines[0]!.words[3]!.stress, null);
  assert.equal(parsed.lines[2]!.words[0]!.status, 'weak');
  assert.equal(parsed.lines[2]!.words[4]!.stress, input.lines[2]!.indexOf('ё'));
  assert.equal(parsed.mode, 'ai');
  assert.equal(parsed.model, config.model);
});

test('contextual stress transfer can make a polysyllabic word weak without inventing a stressed vowel', () => {
  const request = { lines: ['Я из лесу вышел; был сильный мороз.'] };
  const payload = result(request);
  Object.assign(payload.lines[0]!.words[1]!, { status: 'known', stressVowel: 0 });
  Object.assign(payload.lines[0]!.words[2]!, { status: 'weak', stressVowel: null });
  const parsed = parseProsody(payload, request, config.model);
  assert.equal(parsed.lines[0]!.words[1]!.stress, request.lines[0]!.indexOf('и'));
  assert.equal(parsed.lines[0]!.words[2]!.status, 'weak');
  assert.equal(parsed.lines[0]!.words[2]!.stress, null);
});

test('prosody rejects missing, duplicate, changed and out-of-range line/token/stress entries', () => {
  const mutations = [
    (v: ReturnType<typeof result>) => v.lines.pop(),
    (v: ReturnType<typeof result>) => { v.lines[2]!.index = 0; },
    (v: ReturnType<typeof result>) => { v.lines[0]!.index = 3; },
    (v: ReturnType<typeof result>) => v.lines[0]!.words.pop(),
    (v: ReturnType<typeof result>) => { v.lines[0]!.words[1]!.index = 0; },
    (v: ReturnType<typeof result>) => { v.lines[0]!.words[1]!.index = 50; },
    (v: ReturnType<typeof result>) => { v.lines[0]!.words[1]!.text = 'храню'; },
    (v: ReturnType<typeof result>) => Object.assign(v.lines[0]!.words[1]!, { status: 'known', stressVowel: 2 }),
    (v: ReturnType<typeof result>) => Object.assign(v.lines[0]!.words[1]!, { status: 'known', stressVowel: null }),
    (v: ReturnType<typeof result>) => Object.assign(v.lines[0]!.words[1]!, { status: 'known', stressVowel: 0.5 }),
    (v: ReturnType<typeof result>) => Object.assign(v.lines[0]!.words[1]!, { status: 'unknown', stressVowel: 0 }),
    (v: ReturnType<typeof result>) => Object.assign(v.lines[0]!.words[1]!, { status: 'guessed', stressVowel: null }),
  ];
  for (const mutate of mutations) {
    const value = result(); mutate(value);
    assert.throws(() => parseProsody(value, input, config.model), error => error instanceof ApiError && error.code === 'INVALID_PROSODY');
  }
});

test('prosody provider sends original context with no target meter and does not disguise errors', async () => {
  let called = 0;
  const fetcher = (async (url, options) => {
    called++;
    assert.equal(url, `${config.baseUrl}/responses`);
    const body = JSON.parse(String(options?.body));
    assert.equal(body.model, config.model);
    assert.equal(body.reasoning.effort, 'medium');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.text.format.name, 'russian_word_stress');
    const context = JSON.parse(body.input);
    assert.deepEqual(context.lines.map((line: { text: string }) => line.text), input.lines);
    assert.ok(!('meter' in context) && !('feet' in context));
    return Response.json(envelope(result()));
  }) as typeof fetch;
  const response = await analyzeProsody(input, config, new AbortController().signal, fetcher);
  assert.equal(response.lines.length, input.lines.length);
  assert.equal(called, 1);
  await assert.rejects(analyzeProsody(input, { ...config, mode: 'demo' }, new AbortController().signal, fetcher), error => error instanceof ApiError && error.code === 'PROSODY_UNAVAILABLE');
  await assert.rejects(analyzeProsody(input, config, new AbortController().signal, (async () => new Response('private details', { status: 401 })) as typeof fetch), error => error instanceof ApiError && error.code === 'PROVIDER_AUTH' && !error.message.includes('private'));
  await assert.rejects(analyzeProsody(input, config, new AbortController().signal, (async () => Response.json({ ...envelope(result()), model: undefined })) as typeof fetch), error => error instanceof ApiError && error.code === 'MODEL_MISMATCH');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(analyzeProsody(input, config, controller.signal, fetcher));
  assert.equal(called, 1);
});

test('HTTP prosody validates origin, methods, bodies and demo without fake analysis', async t => {
  const { server, url } = await listening({ config: { ...config, mode: 'demo' } });
  t.after(() => server.close());
  assert.equal((await fetch(`${url}/api/prosody`)).status, 405);
  assert.equal((await post(url, input, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await post(url, { lines: ['x'.repeat(LIMITS.line + 1)] })).status, 400);
  assert.equal((await fetch(`${url}/api/prosody`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await post(url, { lines: ['x'.repeat(LIMITS.body)] })).status, 413);
  const response = await post(url, input);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Автоматические ударения доступны при подключённой модели. Запустите ChatMock или настройте сервер генерации.', code: 'PROSODY_UNAVAILABLE' });
});

test('completed context analyses use a bounded LRU; changed text is analyzed again', async t => {
  let calls = 0;
  const fetcher = (async (...args: Parameters<typeof fetch>) => { calls++; return echoProvider(...args); }) as typeof fetch;
  const { server, url } = await listening({ config, fetcher });
  t.after(() => server.close());
  for (let index = 0; index < PROSODY_LIMITS.cache; index++) assert.equal((await post(url, { lines: [`Старый замок ${index}`] })).status, 200);
  assert.equal((await post(url, { lines: ['Старый замок 0'], meter: 'iamb' })).status, 200);
  assert.equal(calls, PROSODY_LIMITS.cache);
  assert.equal((await post(url, { lines: ['Старый замок 32'] })).status, 200);
  assert.equal((await post(url, { lines: ['Старый замок 0'], meter: 'trochee' })).status, 200);
  assert.equal(calls, PROSODY_LIMITS.cache + 1);
  assert.equal((await post(url, { lines: ['Старый замок 1'] })).status, 200);
  assert.equal(calls, PROSODY_LIMITS.cache + 2);
  assert.equal((await post(url, { lines: ['Старый замок 33'] })).status, 200);
  assert.equal(calls, PROSODY_LIMITS.cache + 3);
});

test('prosody cancellation releases shared concurrency and never caches a late completed result', async t => {
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let markAborted!: () => void;
  const aborted = new Promise<void>(resolve => { markAborted = resolve; });
  let complete!: (value: Response) => void;
  let calls = 0;
  const request = { lines: ['Старый замок 0'] };
  const fetcher = (async (...args: Parameters<typeof fetch>) => {
    calls++;
    if (calls > 1) return echoProvider(...args);
    args[1]?.signal?.addEventListener('abort', markAborted, { once: true });
    began();
    return new Promise<Response>(resolve => { complete = resolve; });
  }) as typeof fetch;
  const { server, url } = await listening({ config, fetcher, maxConcurrent: 1 });
  t.after(() => server.close());
  const client = httpRequest(`${url}/api/prosody`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  client.on('error', () => {}); client.end(JSON.stringify(request));
  await started;
  assert.equal((await post(url, { lines: ['Старый замок 1'] })).status, 429);
  client.destroy();
  await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error('provider not aborted')), 1_000))]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await post(url, { lines: ['Старый замок 1'] })).status, 200);
  complete(Response.json(envelope(result(request))));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await post(url, request)).status, 200);
  assert.equal(calls, 3);
});

test('prosody timeout remains controlled even if provider ignores cancellation', async t => {
  const fetcher = (async () => new Promise<Response>(() => {})) as typeof fetch;
  const { server, url } = await listening({ config, fetcher, timeout: 20 });
  t.after(() => server.close());
  const response = await post(url, input);
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, 'GENERATION_TIMEOUT');
});
