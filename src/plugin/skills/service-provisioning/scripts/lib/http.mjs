import { redact } from './secrets.mjs';

export class ApiError extends Error {
  constructor(service, method, path, status, bodyText) {
    const snippet = redact(String(bodyText ?? '')).slice(0, 600);
    super(`${service} ${method} ${path} -> HTTP ${status}\n${snippet}`);
    this.name = 'ApiError';
    this.service = service;
    this.status = status;
  }
}

// allowWrite=false のクライアントは GET 以外を送出前に拒否する（dry-run と check の読み取り専用契約）
export function createHttpClient({ service, baseUrl, headers = {}, fetchImpl = globalThis.fetch, allowWrite = false }) {
  // readOnlySafe: 状態を変えない POST（所有権確認トークンの取得など）だけに付ける
  async function request(method, path, { query, body, headers: extra, readOnlySafe = false } = {}) {
    const upper = method.toUpperCase();
    if (upper !== 'GET' && !readOnlySafe && !allowWrite) {
      throw new Error(`${service}: 読み取り専用モードで ${upper} ${path} が呼ばれました（dry-run では書き込みを行いません）`);
    }
    const url = new URL(path.startsWith('http') ? path : `${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    const init = { method: upper, headers: { ...headers, ...extra } };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(url.toString(), init);
    const text = await response.text();
    if (!response.ok) throw new ApiError(service, upper, url.pathname, response.status, text);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiError(service, upper, url.pathname, response.status, `JSON として解釈できない応答: ${text.slice(0, 200)}`);
    }
  }

  return {
    service,
    allowWrite,
    request,
    get: (path, options) => request('GET', path, options),
    post: (path, body, options) => request('POST', path, { ...options, body }),
    put: (path, body, options) => request('PUT', path, { ...options, body }),
    patch: (path, body, options) => request('PATCH', path, { ...options, body }),
  };
}
