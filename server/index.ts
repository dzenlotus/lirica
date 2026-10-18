import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { ApiError, LIMITS, generate, isLoopback, readConfig, validateRequest } from './generation.ts';
import type { ProviderConfig } from './generation.ts';
import { analyzeProsody, PROSODY_LIMITS, prosodyCacheKey, validateProsodyRequest } from './prosody.ts';
import type { ProsodyResponse } from '../src/lib/prosody.ts';
import type { RepairResponse, SuggestionResponse } from '../src/types.ts';
import { generateRepairs, validateRepairRequest } from './repairs.ts';

function json(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.split(';')[0]?.trim().match(/^application\/json$/iu)) throw new ApiError(415, 'CONTENT_TYPE', 'Отправьте запрос в формате JSON.');
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > LIMITS.body) { request.resume(); throw new ApiError(413, 'REQUEST_TOO_LARGE', 'Текст запроса слишком большой.'); }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > LIMITS.body) { request.resume(); throw new ApiError(413, 'REQUEST_TOO_LARGE', 'Текст запроса слишком большой.'); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError(400, 'INVALID_JSON', 'Не удалось прочитать текст запроса.'); }
}

async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason ?? new Error('cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener('abort', cancel); }
}

export function createApiServer(options: { config?: ProviderConfig; fetcher?: typeof fetch; timeout?: number; maxConcurrent?: number } = {}) {
  let active = 0;
  const prosodyCache = new Map<string, ProsodyResponse>();
  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 }, async (request, response) => {
    const controller = new AbortController();
    const disconnect = () => { if (!response.writableEnded) controller.abort(); };
    request.on('aborted', disconnect);
    response.on('close', disconnect);
    let acquired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (request.headers.origin) {
        let allowed = false;
        try { allowed = isLoopback(new URL(request.headers.origin).hostname); } catch { /* reject malformed origin */ }
        if (!allowed) throw new ApiError(403, 'ORIGIN_REJECTED', 'Этот источник запросов не разрешён.');
      }
      const path = (request.url || '/').split('?')[0];
      if (path !== '/api/config' && path !== '/api/suggestions' && path !== '/api/prosody' && path !== '/api/repairs') throw new ApiError(404, 'NOT_FOUND', 'Адрес не найден.');
      const config = options.config ?? readConfig();
      if (request.method === 'GET' && path === '/api/config') {
        json(response, 200, { mode: config.mode, ...(config.mode === 'ai' ? { model: config.model, provider: config.provider } : {}) });
        return;
      }
      if (request.method !== 'POST' || path === '/api/config') {
        response.setHeader('Allow', path === '/api/config' ? 'GET' : 'POST');
        throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Метод запроса не поддерживается.');
      }
      const body = await readBody(request);
      const prosodyInput = path === '/api/prosody' ? validateProsodyRequest(body) : null;
      const repairInput = path === '/api/repairs' ? validateRepairRequest(body) : null;
      const suggestionInput = prosodyInput || repairInput ? null : validateRequest(body);
      if (controller.signal.aborted) return;
      const cacheKey = prosodyInput ? prosodyCacheKey(prosodyInput, config) : null;
      const cached = cacheKey ? prosodyCache.get(cacheKey) : undefined;
      if (cached) {
        prosodyCache.delete(cacheKey!);
        prosodyCache.set(cacheKey!, cached);
        json(response, 200, cached);
        return;
      }
      if (active >= (options.maxConcurrent ?? LIMITS.concurrent)) throw new ApiError(429, 'BUSY', 'Уже готовятся другие подсказки. Попробуйте через несколько секунд.');
      active++; acquired = true;
      timer = setTimeout(() => controller.abort(new Error('timeout')), options.timeout ?? LIMITS.timeout);
      const work = prosodyInput ? analyzeProsody(prosodyInput, config, controller.signal, options.fetcher) : repairInput ? generateRepairs(repairInput, config, controller.signal, options.fetcher) : generate(suggestionInput!, config, controller.signal, options.fetcher);
      const result = await untilAborted<SuggestionResponse | ProsodyResponse | RepairResponse>(work, controller.signal);
      controller.signal.throwIfAborted();
      if (cacheKey) {
        prosodyCache.set(cacheKey, result as ProsodyResponse);
        if (prosodyCache.size > PROSODY_LIMITS.cache) prosodyCache.delete(prosodyCache.keys().next().value!);
      }
      json(response, 200, result);
    } catch (error) {
      if (response.destroyed) return;
      const safe = controller.signal.aborted ? new ApiError(504, 'GENERATION_TIMEOUT', 'Модель не успела ответить. Попробуйте ещё раз.') :
        error instanceof ApiError ? error : new ApiError(502, 'GENERATION_UNAVAILABLE', 'Не удалось связаться с сервером генерации. Проверьте, запущен ли ChatMock.');
      json(response, safe.status, { error: safe.message, code: safe.code });
    } finally {
      if (timer) clearTimeout(timer);
      if (acquired) active--;
      request.off('aborted', disconnect);
      response.off('close', disconnect);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createApiServer();
  server.listen(3001, '127.0.0.1', () => { console.log('Лирика: сервер готов на http://127.0.0.1:3001'); });
  server.on('error', () => { console.error('Не удалось запустить сервер Лирики. Проверьте, свободен ли порт 3001.'); process.exitCode = 1; });
  for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, () => server.close());
}
