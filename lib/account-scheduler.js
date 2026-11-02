import { evaluateAccountAvailability, applicableGeminiQuotaGroups } from './pool-health.js';

export const accountFamily = modelId => /^(claude-|gpt-oss-)/.test(modelId) ? '3p' : modelId;
const readiness = state => state === 'available' ? 0 : state === 'unknown' ? 1 : state === 'blocked' ? 2 : 3;
function fraction(row, now) {
  if (!row) return null;
  const reset = typeof row.resetTime === 'number' ? row.resetTime : Date.parse(row.resetTime);
  if (Number.isFinite(reset) && reset <= now) return null;
  const value = Number.isFinite(row.remainingFraction) ? row.remainingFraction
    : Number.isFinite(row.remainingPercent) ? row.remainingPercent / 100 : null;
  return value === null ? null : Math.max(0, Math.min(1, value));
}

// A missing/expired constraint is unknown, not zero (nor an invented full bucket).
export function effectiveQuota(account, modelId, now = Date.now()) {
  if (!account || account.stale || account.error || (Number.isFinite(account.fetchedAt) && now - account.fetchedAt >= 120000)) return null;
  const rows = [...(account.bucketRows || []), ...(account.groups || []).flatMap(group => group.buckets || [])];
  const buckets = new Map();
  for (const row of rows) { const id = row.id || row.bucketId; if (id && !buckets.has(id)) buckets.set(id, row); }
  const model = account.models?.options?.find(row => row.id === modelId);
  const constraints = [];
  if (accountFamily(modelId) === '3p') {
    constraints.push(buckets.get('3p-weekly'), buckets.get('3p-5h'));
    if (model && (Number.isFinite(model.remainingFraction) || Number.isFinite(model.remainingPercent))) constraints.push(model);
  } else {
    constraints.push(model);
    if (/^gemini/i.test(modelId)) {
      for (const group of applicableGeminiQuotaGroups(account, modelId)) constraints.push(...(group.buckets || []));
    }
  }
  const values = constraints.map(row => fraction(row, now));
  return !values.length || values.some(value => value === null) ? null : Math.min(...values);
}

// Host-independent, synchronous scheduling. Selection + binding + first reservation MUST
// happen in one turn, before an async candidate function returns to its caller.
export class AccountScheduler {
  constructor({ now = Date.now, cooldownMs = 30000, maxAffinities = 2048 } = {}) {
    this.now = now; this.cooldownMs = cooldownMs; this.maxAffinities = maxAffinities;
    this.affinity = new Map(); this.cooldowns = new Map(); this.inflight = new Map(); this.lastUsed = new Map();
    this.selection = undefined; this.epoch = 0; this.sequence = 0;
  }
  observeSelection(id) {
    if (id !== this.selection) { this.selection = id; this.epoch++; this.affinity.clear(); }
    // Real rate limits survive manual selection changes and A -> B -> A switches.
    return this.epoch;
  }
  key(modelId, sessionId) { return JSON.stringify([sessionId || null, accountFamily(modelId)]); }
  bind(modelId, id, sessionId, epoch = this.epoch) {
    if (!id || epoch !== this.epoch) return;
    const key = this.key(modelId, sessionId);
    this.affinity.delete(key); this.affinity.set(key, id);
    while (this.affinity.size > this.maxAffinities) this.affinity.delete(this.affinity.keys().next().value);
  }
  cooldownsFor(id) {
    const result = {};
    for (const [key, item] of this.cooldowns) {
      if (item.until <= this.now()) { this.cooldowns.delete(key); continue; }
      if (item.id === id) result[item.family] = item.until;
    }
    return result;
  }
  recordQuotaFailure(modelId, id) {
    if (!id) return;
    const family = accountFamily(modelId);
    this.cooldowns.set(JSON.stringify([id, family]), { id, family, until: this.now() + this.cooldownMs });
  }
  reserve(id, { modelId, sessionId, epoch = this.epoch } = {}) {
    // Session calls bind before output; legacy calls keep success-only global sticky.
    if (sessionId) this.bind(modelId, id, sessionId, epoch);
    this.inflight.set(id, (this.inflight.get(id) || 0) + 1);
    this.lastUsed.set(id, ++this.sequence);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.inflight.get(id) || 0) - 1;
      if (count > 0) this.inflight.set(id, count); else this.inflight.delete(id);
    };
  }
  select(accounts, { modelId, sessionId, selection } = {}) {
    const epoch = this.observeSelection(selection);
    const now = this.now();
    const preferred = this.affinity.get(this.key(modelId, sessionId)) || (!sessionId ? selection : undefined);
    const entries = accounts.filter(account => account.hasCredential !== false).map(account => {
      const snapshot = { ...account, cooldowns: { ...account.cooldowns, ...this.cooldownsFor(account.id) } };
      return { account, decision: evaluateAccountAvailability(snapshot, modelId, now), quota: effectiveQuota(snapshot, modelId, now), epoch };
    });
    const load = item => this.inflight.get(item.account.id) || 0;
    const score = item => item.quota === null ? null : item.quota / (1 + load(item));
    entries.sort((a, b) => readiness(a.decision.state) - readiness(b.decision.state)
      || (score(a) === null ? score(b) === null ? 0 : 1 : score(b) === null ? -1 : score(b) - score(a))
      || load(a) - load(b)
      || (this.lastUsed.get(a.account.id) || 0) - (this.lastUsed.get(b.account.id) || 0));
    let reasonCode = sessionId ? 'new-balanced' : 'legacy-sticky';
    const prior = entries.find(item => item.account.id === preferred);
    if (prior && readiness(prior.decision.state) === readiness(entries[0]?.decision.state)) {
      const alternative = sessionId && prior.quota !== null && prior.quota <= 0.1
        ? entries.find(item => item.account.id !== preferred && item.decision.state === 'available' && item.quota !== null && item.quota - prior.quota >= 0.1 - Number.EPSILON) : undefined;
      const chosen = alternative || prior;
      reasonCode = alternative ? 'low-quota-switch' : sessionId ? 'affinity' : 'legacy-sticky';
      entries.splice(entries.indexOf(chosen), 1); entries.unshift(chosen);
    }
    // Do NOT filter blocked accounts: preserve upstream-authoritative last-resort fallback.
    if (entries.length) {
      entries[0].reasonCode = reasonCode;
      entries[0].release = this.reserve(entries[0].account.id, { modelId, sessionId, epoch });
    }
    return entries;
  }
}
