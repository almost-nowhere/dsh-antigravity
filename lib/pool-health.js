// Pure quota predicates. Availability is an intersection within ONE account, never pooled percentages.
const isThirdParty = id => id === '3p' || /^(claude-|gpt-oss-)/.test(id);
// A vendor substring is not evidence of a shared limit: e.g. Gemini 4 Argon
// must not block unrelated Gemini models. Unmapped groups stay display-only.
export function applicableGeminiQuotaGroups(account, modelId) {
  if (!/^gemini/i.test(modelId)) return [];
  const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return (account.groups || []).filter(group => {
    const label = String(group.displayName || '').trim();
    return /^Gemini(?: models)?$/i.test(label) || normalize(label) === normalize(modelId);
  });
}
function rowState(row, now) {
  if (!row) return 'unknown';
  const reset = typeof row.resetTime === 'number' ? row.resetTime : Date.parse(row.resetTime);
  if (Number.isFinite(reset) && reset <= now) return 'unknown';
  const value = Number.isFinite(row.remainingFraction) ? row.remainingFraction : Number.isFinite(row.remainingPercent) ? row.remainingPercent / 100 : undefined;
  return !Number.isFinite(value) ? 'unknown' : value > 0 ? 'positive' : 'zero';
}
export function evaluateAccountAvailability(account, modelId, now = Date.now()) {
  if (!account || account.hasCredential === false) return { state: 'signed-out', reasons: ['signed-out'] };
  const family = isThirdParty(modelId) ? '3p' : modelId;
  if ((account.cooldowns?.[family] || 0) > now) return { state: 'blocked', reasons: ['cooldown'] };
  if (account.stale || account.error || (Number.isFinite(account.fetchedAt) && now - account.fetchedAt >= 120000)) return { state: 'unknown', reasons: [account.error ? 'query-failed' : 'stale'] };
  const buckets = new Map();
  for (const row of [...(account.bucketRows || []), ...(account.groups || []).flatMap(group => group.buckets || [])]) {
    const id = row.id || row.bucketId;
    if (id && !buckets.has(id)) buckets.set(id, row);
  }
  const modelRow = account.models?.options?.find(row => row.id === modelId);
  const model = rowState(modelRow, now);
  const checks = [];
  if (isThirdParty(modelId)) {
    checks.push(['weekly', rowState(buckets.get('3p-weekly'), now)], ['short', rowState(buckets.get('3p-5h'), now)]);
    // An explicit per-model zero is limiting even if shared buckets are still unknown.
    if (modelId !== '3p' && modelRow) checks.push(['model', model]);
  } else {
    checks.push(['model', model]);
    if (/^gemini/i.test(modelId)) {
      const seen = new Set();
      for (const group of applicableGeminiQuotaGroups(account, modelId)) {
        for (const row of group.buckets || []) {
          const id = row.id || row.bucketId;
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          checks.push(['group', rowState(row, now)]);
        }
      }
    }
  }
  const zero = checks.filter(([, state]) => state === 'zero');
  if (zero.length) return { state: 'blocked', reasons: zero.map(([name]) => `${name}-empty`) };
  // Missing optional per-model data does not invalidate a fully known shared bucket pair.
  const explicitModelValue = modelRow && (Number.isFinite(modelRow.remainingFraction) || Number.isFinite(modelRow.remainingPercent));
  const required = isThirdParty(modelId) ? checks.filter(([name]) => name !== 'model' || explicitModelValue) : checks;
  const unknown = required.filter(([, state]) => state === 'unknown');
  return unknown.length ? { state: 'unknown', reasons: unknown.map(([name]) => `${name}-unknown`) } : { state: 'available', reasons: [] };
}
function summarize(accounts, id, now) {
  const result = { accountCount: 0, availableCount: 0, blockedCount: 0, unknownCount: 0, accounts: [] };
  for (const account of accounts) {
    const decision = evaluateAccountAvailability(account, id, now);
    result.accounts.push({ id: account.id, ...decision });
    if (decision.state === 'signed-out') continue;
    result.accountCount++;
    result[`${decision.state === 'available' ? 'available' : decision.state === 'blocked' ? 'blocked' : 'unknown'}Count`]++;
  }
  return result;
}
export function buildPoolAvailability(accounts, now = Date.now()) {
  const ids = new Set(accounts.flatMap(account => (account.models?.options || []).map(row => row.id)).filter(id => typeof id === 'string'));
  const models = Object.create(null);
  for (const id of ids) models[id] = summarize(accounts, id, now);
  return { thirdParty: summarize(accounts, '3p', now), models };
}
