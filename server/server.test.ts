import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createApiServer } from './index.ts';
import { ApiError, LIMITS, demoSuggestions, generate, parseProviderResponse, parseSuggestions, providerBody, readConfig, readLimited, validateRequest } from './generation.ts';
import type { GenerationRequest, ProviderConfig } from './generation.ts';
import { countSyllables, getReferenceLine, getRhymeLabel, analyzeMeter } from '../src/lib/poetry.ts';

const input: GenerationRequest = { lines: ['Тихий вечер принёс тишину', 'Ветер уносит следы', 'Я храню'], activeLine: 2, settings: { meter: 'iamb', feet: 4, scheme: 'ABAB', precision: 'near', referenceLine: null, autoSuggest: true }, variation: 0 };
const config: ProviderConfig = { mode: 'ai', provider: 'ChatMock', baseUrl: 'http://127.0.0.1:8000/v1', model: 'gpt-6-luna', apiKey: '' };
function modelResponse(prefix = input.lines[input.activeLine]!) {
  return { status: 'completed', model: config.model, output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ suggestions: Array.from({ length: 10 }, (_, i) => `${prefix} воспоминания о ${['весне', 'дожде', 'саде', 'доме', 'свете', 'тебе', 'тишине', 'ночи', 'дне', 'море'][i]}`) }) }] }] };
}
async function listening(options: Parameters<typeof createApiServer>[0] = {}) {
  const server = createApiServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test('syllables and meter report length without asserting stress', () => {
  assert.equal(countSyllables('Ёж и чай — любовь!'), 5);
  assert.deepEqual(analyzeMeter('Вечер', 'free', 4), { syllables: 2, expected: null, status: 'free' });
  assert.deepEqual(analyzeMeter('Вечер', 'iamb', 4), { syllables: 2, expected: 8, status: 'short' });
  assert.equal(analyzeMeter('Я и ты', 'dactyl', 1).status, 'match');
  assert.equal(analyzeMeter('Я и ты опять', 'trochee', 1).status, 'long');
});

test('rhyme references use a previous matching label within a stanza and respect manual choice', () => {
  const lines = ['река', 'дома', 'рука', 'свет', '', 'снова', 'любовь', 'слова'];
  assert.equal(getRhymeLabel(5, 'ABBA'), 'B');
  assert.equal(getRhymeLabel(0, 'free'), null);
  assert.equal(getReferenceLine(lines, 2, { scheme: 'ABAB', referenceLine: null }), 0);
  assert.equal(getReferenceLine(lines, 3, { scheme: 'ABAB', referenceLine: null }), 1);
  assert.equal(getReferenceLine(lines, 1, { scheme: 'ABAB', referenceLine: null }), null);
  assert.equal(getReferenceLine(lines, 5, { scheme: 'ABAB', referenceLine: null }), null);
  assert.equal(getRhymeLabel(5, 'ABAB', lines), 'A');
  assert.equal(getReferenceLine(lines, 7, { scheme: 'ABAB', referenceLine: null }), 5);
  assert.equal(getReferenceLine(lines, 4, { scheme: 'free', referenceLine: null }), null);
  assert.equal(getReferenceLine(lines, 4, { scheme: 'free', referenceLine: 3 }), 3);
  assert.equal(getReferenceLine(lines, 4, { scheme: 'ABAB', referenceLine: 4 }), null);
  assert.equal(getReferenceLine(lines, 5, { scheme: 'ABAB', referenceLine: 4 }), null);
});

test('request validation rejects malformed input and bounds all configurable fields', () => {
  assert.deepEqual(validateRequest(input), input);
  for (const invalid of [null, [], { ...input, lines: [] }, { ...input, lines: ['a\nb'] }, { ...input, activeLine: 3 }, { ...input, variation: -1 }, { ...input, variation: 1.2 }, { ...input, lines: ['a'.repeat(LIMITS.line + 1)] }, { ...input, lines: Array(101).fill('') }, { ...input, lines: Array(100).fill('a'.repeat(121)) }, { ...input, settings: { ...input.settings, feet: 9 } }, { ...input, settings: { ...input.settings, meter: 'sonnet' } }, { ...input, settings: { ...input.settings, referenceLine: 2 } }, { ...input, settings: { ...input.settings, autoSuggest: 'yes' } }]) {
    assert.throws(() => validateRequest(invalid), error => error instanceof ApiError && error.status === 400);
  }
});

test('local ChatMock has AI mode without key, remote without key is demo, credentials never enter config response', async t => {
  assert.equal(readConfig({}).mode, 'ai');
  assert.equal(readConfig({ OPENAI_BASE_URL: 'https://api.openai.com/v1' }).mode, 'demo');
  assert.equal(readConfig({ LIRICA_MODE: 'demo' }).mode, 'demo');
  assert.throws(() => readConfig({ OPENAI_BASE_URL: 'http://external.example/v1' }), ApiError);
  assert.throws(() => readConfig({ OPENAI_BASE_URL: 'https://user:secret@example.com/v1' }), ApiError);
  const { server, url } = await listening({ config: { ...config, apiKey: 'private-test-key' } });
  t.after(() => server.close());
  const response = await fetch(`${url}/api/config`);
  const data = await response.json();
  assert.deepEqual(data, { mode: 'ai', provider: 'ChatMock', model: 'gpt-6-luna' });
  assert.ok(!JSON.stringify(data).includes('private-test-key'));
});

test('demonstration yields ten unique append-only contextual lines and changes the next set', () => {
  const poem = { ...input, lines: ['На мокрых улицах горит рассвет', 'Тихий город'], activeLine: 1, settings: { ...input.settings, referenceLine: 0 } };
  const first = demoSuggestions(poem);
  assert.equal(first.mode, 'demo');
  assert.equal(first.referenceLine, 0);
  assert.equal(first.suggestions.length, 10);
  assert.equal(new Set(first.suggestions.map(item => item.text)).size, 10);
  assert.ok(first.suggestions.every(item => item.text.startsWith('Тихий город') && /(?:свет|ответ|лет|след|привет|секрет|нет)$/u.test(item.rhymeWord)));
  assert.notDeepEqual(demoSuggestions({ ...poem, variation: 1 }).suggestions, first.suggestions);
  assert.equal(demoSuggestions({ ...poem, lines: [''], activeLine: 0, settings: { ...input.settings } }).suggestions.length, 10);
});

test('response parser ignores reasoning, checks model, prefix, exact count, unique lines and refusal', () => {
  const valid = modelResponse();
  const results = parseProviderResponse(valid, 'Я храню', config.model);
  assert.equal(results.length, 10);
  assert.equal(results[0]?.rhymeWord, 'весне');
  assert.equal(results[0]?.id, parseProviderResponse(valid, 'Я храню')[0]?.id);
  for (const value of [{ status: 'incomplete', output: [] }, { ...valid, model: 'gpt-5.6-luna' }, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] }, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }] }]) {
    assert.throws(() => parseProviderResponse(value, 'Я храню', config.model), ApiError);
  }
  const texts = results.map(item => item.text);
  assert.throws(() => parseSuggestions({ suggestions: texts.slice(0, 9) }, 'Я храню'), ApiError);
  assert.throws(() => parseSuggestions({ suggestions: [...texts.slice(0, 9), texts[0]] }, 'Я храню'), ApiError);
  assert.throws(() => parseSuggestions({ suggestions: ['Исправленное начало', ...texts.slice(1)] }, 'Я храню'), ApiError);
  assert.throws(() => parseSuggestions({ suggestions: ['Я храню\nперенос', ...texts.slice(1)] }, 'Я храню'), ApiError);
  assert.throws(() => parseSuggestions({ suggestions: ['Я храню', ...texts.slice(1)] }, 'Я храню'), ApiError);
  const structured = texts.map(text => ({ text, rhymeWord: text.split(' ').at(-1) }));
  assert.equal(parseSuggestions({ suggestions: structured }, 'Я храню').length, 10);
  assert.throws(() => parseSuggestions({ suggestions: [{ ...structured[0], rhymeWord: 'другое' }, ...structured.slice(1)] }, 'Я храню'), ApiError);
  assert.throws(() => parseSuggestions({ suggestions: structured }, 'Я храню', ['рекой', 'тобой']), ApiError);
});

test('mock provider receives exact GPT-6 Luna and structured schema; configured errors never become demo', async () => {
  let sent: Record<string, unknown> = {};
  const fetcher = (async (url, options) => {
    assert.equal(url, `${config.baseUrl}/responses`);
    assert.equal(options?.redirect, 'error');
    sent = JSON.parse(String(options?.body));
    assert.ok(!JSON.stringify(options?.headers).includes('Authorization'));
    return Response.json(modelResponse());
  }) as typeof fetch;
  const unanchored = { ...input, settings: { ...input.settings, scheme: 'free' as const } };
  assert.equal((await generate(unanchored, config, new AbortController().signal, fetcher)).mode, 'ai');
  assert.equal(sent.model, 'gpt-6-luna');
  assert.equal((sent.text as { format: { strict: boolean } }).format.strict, true);
  const requestData = JSON.parse(providerBody(input).input);
  assert.equal(requestData.referenceLine, 0);
  assert.equal(requestData.prefix, 'Я храню');
  await assert.rejects(generate(input, config, new AbortController().signal, (async () => new Response('secret upstream body', { status: 401 })) as typeof fetch), error => error instanceof ApiError && error.code === 'PROVIDER_AUTH' && !error.message.includes('secret'));
  await assert.rejects(readLimited(new Response('a'.repeat(20)), 10), ApiError);
});

test('precision constrains exact rhymes while near and loose permit other endings', async () => {
  const fetcher = (async () => Response.json(modelResponse())) as typeof fetch;
  const exactRequest = { ...input, settings: { ...input.settings, precision: 'exact' as const } };
  const exact = providerBody(exactRequest);
  const exactWord = exact.text.format.schema.properties.suggestions.items.properties.rhymeWord;
  assert.ok('enum' in exactWord && (exactWord.enum?.length ?? 0) > 0);
  assert.ok(JSON.parse(exact.input).allowedRhymeWords.length > 0);
  await assert.rejects(generate(exactRequest, config, new AbortController().signal, fetcher), error => error instanceof ApiError && error.code === 'INVALID_RHYME');
  for (const precision of ['near', 'loose'] as const) {
    const request = { ...input, settings: { ...input.settings, precision } };
    const body = providerBody(request);
    const rhymeWord = body.text.format.schema.properties.suggestions.items.properties.rhymeWord;
    assert.deepEqual(rhymeWord, { type: 'string' });
    assert.equal(JSON.parse(body.input).allowedRhymeWords, undefined);
    assert.match(JSON.parse(body.input).precision, precision === 'near' ? /ветер — вечер/u : /ассонанс/u);
    assert.equal((await generate(request, config, new AbortController().signal, fetcher)).suggestions.length, 10);
  }
});

test('HTTP rejects bad JSON, oversized and cross-origin requests with controlled errors', async t => {
  const { server, url } = await listening({ config: { ...config, mode: 'demo' } });
  t.after(() => server.close());
  const post = (body: string, headers: Record<string, string> = {}) => fetch(`${url}/api/suggestions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  assert.equal((await post('{')).status, 400);
  assert.equal((await post(JSON.stringify(input), { Origin: 'https://attacker.example' })).status, 403);
  const big = await post('x'.repeat(LIMITS.body + 1));
  assert.equal(big.status, 413);
  assert.equal((await big.json()).code, 'REQUEST_TOO_LARGE');
  const chunked = await new Promise<{ status: number; code: string }>((resolve, reject) => {
    const client = httpRequest(`${url}/api/suggestions`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, code: JSON.parse(body).code }));
    });
    client.on('error', reject);
    client.write('a'.repeat(20_000));
    client.end('b'.repeat(20_000));
  });
  assert.deepEqual(chunked, { status: 413, code: 'REQUEST_TOO_LARGE' });
  assert.equal((await fetch(`${url}/api/suggestions`)).status, 405);
  const demo = await post(JSON.stringify(input));
  assert.equal(demo.status, 200);
  assert.equal((await demo.json()).suggestions.length, 10);
});

test('concurrency is bounded and closing the client aborts the provider request', async t => {
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  let aborted!: () => void;
  const cancelled = new Promise<void>(resolve => { aborted = resolve; });
  const fetcher = (async (_url, options) => new Promise<Response>((_resolve, reject) => {
    started();
    options?.signal?.addEventListener('abort', () => { aborted(); reject(new Error('cancelled')); }, { once: true });
  })) as typeof fetch;
  const { server, url } = await listening({ config, fetcher, maxConcurrent: 1 });
  t.after(() => server.close());
  const client = httpRequest(`${url}/api/suggestions`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  client.on('error', () => {});
  client.end(JSON.stringify(input));
  await began;
  const busy = await fetch(`${url}/api/suggestions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(busy.status, 429);
  client.destroy();
  await Promise.race([cancelled, new Promise((_, reject) => setTimeout(() => reject(new Error('provider not aborted')), 1_000))]);
});

test('provider timeout has a controlled retryable response', async t => {
  const fetcher = (async (_url, options) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('private failure details')), { once: true });
  })) as typeof fetch;
  const { server, url } = await listening({ config, fetcher, timeout: 20 });
  t.after(() => server.close());
  const response = await fetch(`${url}/api/suggestions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(response.status, 504);
  const data = await response.json();
  assert.equal(data.code, 'GENERATION_TIMEOUT');
  assert.ok(!JSON.stringify(data).includes('private'));
});

test('manual accents keep exact-rhyme candidates and the authored prefix intact', () => {
  const request = { ...input, lines: ['Тихий вечер принёс тишину́', 'Ветер уносит следы', 'Я храню́'], settings: { ...input.settings, precision: 'exact' as const } };
  const payload = JSON.parse(providerBody(request).input);
  assert.ok(Array.isArray(payload.allowedRhymeWords) && payload.allowedRhymeWords.length > 0);
  assert.equal(payload.prefix, 'Я храню́');
  assert.equal(payload.referenceText, request.lines[0]);
});
