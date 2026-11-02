import { randomUUID } from 'node:crypto';

// Only structural error codes are retained. Never store error messages, headers or prompts.
export function describeRuntimeFailure(error, phase = 'request-prepare', emitted = false) {
  const codes = [];
  const visit = (value, depth = 0) => {
    if (!value || depth > 4) return;
    if (typeof value.code === 'string' && /^[A-Z0-9_:-]{1,64}$/.test(value.code)) codes.push(value.code);
    visit(value.cause, depth + 1);
    if (Array.isArray(value.errors)) value.errors.slice(0, 4).forEach(item => visit(item, depth + 1));
  };
  visit(error);
  const message = String(error?.message || '');
  // Messages are inspected only to classify legacy errors, never returned or persisted.
  const code = codes.find(value => /^(?:UND_ERR_|E(?:CONN|TIMED|NOTFOUND|AI_AGAIN)|CERT_|ERR_TLS|UNABLE_TO_VERIFY|DEPTH_ZERO)/.test(value)) || codes[0];
  let kind = 'request', label = '请求失败';
  if (codes.includes('ABORTED') || error?.name === 'AbortError') { kind = 'aborted'; label = '请求已取消'; }
  else if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT/.test(code || '')) { kind = 'connection-timeout'; label = '连接超时'; }
  else if (/UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT/.test(code || '') || codes.includes('TIMEOUT') || error?.name === 'TimeoutError') { kind = 'read-timeout'; label = '等待响应超时'; }
  else if (/ECONNRESET|EPIPE|UND_ERR_SOCKET/.test(code || '')) { kind = 'connection-reset'; label = '连接被重置'; }
  else if (/ENOTFOUND|EAI_AGAIN/.test(code || '')) { kind = 'dns'; label = '域名解析失败'; }
  else if (/CERT_|ERR_TLS|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(code || '')) { kind = 'tls'; label = 'TLS 连接验证失败'; }
  else if (/quota (?:reached|exceeded|exhausted)|RESOURCE_EXHAUSTED/i.test(message) || codes.some(value => /QUOTA_EXCEEDED/.test(value))) { kind = 'quota'; label = '额度耗尽'; }
  else if (/\b429\b|rate.?limit/i.test(message) || codes.includes('RATE_LIMIT')) { kind = 'rate-limit'; label = '请求限流'; }
  else if (/\b(?:401|403)\b/.test(message) || codes.includes('AUTH')) { kind = 'auth'; label = '登录或访问权限异常'; }
  else if (/\b5\d\d\b/.test(message) || codes.includes('SERVER')) { kind = 'server'; label = '上游服务异常'; }
  else if (codes.includes('TRANSPORT') || /fetch failed|network|socket/i.test(message)) { kind = 'network-unknown'; label = '网络传输失败，底层原因未提供'; }
  const safeToRetry = !emitted && (kind === 'quota' || kind === 'rate-limit');
  return { kind, label, phase, ...(code ? { code } : {}), safeToRetry };
}

export class RuntimeStatus {
  #records = new Map();
  #unresolved = new Map();
  #now;
  #sequence = 0;
  constructor(now = Date.now) { this.#now = now; }
  start(modelId, maxAttempts) {
    const requestId = randomUUID();
    const record = { requestId, modelId, order: ++this.#sequence, phase: 'requesting', reason: '等待选择账户',
      startedAt: this.#now(), updatedAt: this.#now(), attempt: 0, maxAttempts, recovered: false };
    this.#records.set(requestId, record);
    while (this.#records.size > 20) this.#records.delete(this.#records.keys().next().value);
    return requestId;
  }
  limit(requestId, maxAttempts) {
    const record = this.#records.get(requestId);
    if (record) record.maxAttempts = maxAttempts;
  }
  attempt(requestId, accountId, reason, attempt, switchedFrom) {
    const record = this.#records.get(requestId);
    if (!record) return;
    Object.assign(record, { accountId, reason, attempt, phase: 'requesting', updatedAt: this.#now() });
    if (switchedFrom) record.switchedFrom = switchedFrom;
  }
  output(requestId) {
    const record = this.#records.get(requestId);
    if (record) Object.assign(record, { phase: 'streaming', updatedAt: this.#now() });
  }
  fail(requestId, error, phase, emitted, retrying = false) {
    const record = this.#records.get(requestId);
    if (!record) return;
    const failure = describeRuntimeFailure(error, phase, emitted);
    Object.assign(record, { failure, phase: failure.kind === 'aborted' ? 'aborted' : retrying ? 'requesting' : 'failed',
      retrying, updatedAt: this.#now() });
    if (failure.kind !== 'aborted') {
      this.#unresolved.set(record.modelId, failure);
      while (this.#unresolved.size > 32) this.#unresolved.delete(this.#unresolved.keys().next().value);
    }
  }
  succeed(requestId) {
    const record = this.#records.get(requestId);
    if (!record) return;
    const prior = record.failure || this.#unresolved.get(record.modelId);
    Object.assign(record, { phase: 'succeeded', retrying: false, recovered: !!prior,
      ...(prior ? { failure: prior } : {}), updatedAt: this.#now() });
    this.#unresolved.delete(record.modelId);
  }
  cancel(requestId) { this.fail(requestId, { code: 'ABORTED' }, 'consumer', false); }
  snapshot(accounts = []) {
    const byId = new Map(accounts.map(account => [account.id, account]));
    const routes = [...this.#records.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.startedAt - a.startedAt || b.order - a.order).map(record => {
      const account = byId.get(record.accountId);
      // Drop identity of removed accounts; expose only allowlisted roster metadata.
      return { ...record, accountId: account ? record.accountId : undefined,
        ...(account ? { label: account.label, email: account.email } : {}) };
    });
    const last = routes[0];
    const state = !last ? 'idle' : last.phase === 'succeeded' ? last.recovered ? 'recovered' : 'ok'
      : last.retrying ? 'retrying' : last.phase;
    return { provider: 'antigravity', updatedAt: this.#now(), routes,
      health: last ? { state, requestId: last.requestId, modelId: last.modelId, accountId: last.accountId,
        updatedAt: last.updatedAt, attempt: last.attempt, maxAttempts: last.maxAttempts, ...(last.failure ? { failure: last.failure } : {}) }
        : { state, updatedAt: this.#now() } };
  }
}
