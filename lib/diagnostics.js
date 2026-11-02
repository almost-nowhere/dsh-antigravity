import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_TOOL_CALLS = 600;
const MAX_OUTLINE = 120;

function safeName(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value) ? value : '[nonstandard-name]';
}

function classifyErrorText(value) {
  const text = String(value ?? '');
  let category = 'other';
  if (/missing (?:a |the )?[`'\"]?thought_signature|function.?call.*thought.?signature/i.test(text)) category = 'missing-thought-signature';
  else if (/thought.?signature/i.test(text)) category = 'thought-signature-error';
  else if (/Invalid JSON payload|Unknown name|unknown field/i.test(text)) category = 'request-format';
  else if (/Request contains an invalid argument|INVALID_ARGUMENT/i.test(text)) category = 'invalid-argument';
  else if (/quota|RESOURCE_EXHAUSTED/i.test(text)) category = 'quota';
  else if (/rate.?limit/i.test(text)) category = 'rate-limit';
  else if (/invalid authentication credentials|API_KEY_INVALID|unauthorized/i.test(text)) category = 'authentication';
  const block = category === 'missing-thought-signature' ? text.match(/(?:in the|at)\s+(\d{1,7})\.?\s+content block/i) : undefined;
  return { category, characters: text.length,
    ...(block ? { contentIndex: Number(block[1]) } : {}) };
}

function safeStatus(value) {
  return ['INVALID_ARGUMENT', 'UNAUTHENTICATED', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'INTERNAL', 'NOT_FOUND', 'FAILED_PRECONDITION', 'DEADLINE_EXCEEDED'].includes(value)
    ? value : 'other';
}

function safeField(value) {
  return typeof value === 'string' && /^(?:contents|request|generationConfig|tools|systemInstruction|model)(?:\[\d{1,7}\]|\.[A-Za-z][A-Za-z0-9]{0,60}){0,16}$/.test(value)
    ? value : '[unrecognized-field]';
}

function hash(value) {
  return typeof value === 'string' && value ? createHash('sha256').update(value).digest('hex').slice(0, 16) : undefined;
}

export function summarizeAntigravityRequest(payload) {
  const request = payload?.request || {};
  const contents = Array.isArray(request.contents) ? request.contents : [];
  const toolCalls = [];
  const missingFirstSignatures = [];
  let lastStandardUser = -1;
  for (let i = 0; i < contents.length; i++) {
    const content = contents[i];
    if (content?.role === 'user' && content.parts?.some(part => typeof part?.text === 'string' || part?.inlineData)) lastStandardUser = i;
  }
  let totalToolCalls = 0;
  for (let i = 0; i < contents.length; i++) {
    const content = contents[i];
    let firstInStep = true;
    for (const [partIndex, part] of (content?.parts || []).entries()) {
      if (!part?.functionCall) continue;
      totalToolCalls++;
      const signed = typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0;
      const item = { contentIndex: i, partIndex, nameHash: hash(part.functionCall.name), signed,
        signatureLength: signed ? part.thoughtSignature.length : 0,
        argumentChars: JSON.stringify(part.functionCall.args || {}).length };
      toolCalls.push(item);
      if (i >= lastStandardUser && firstInStep && !signed) missingFirstSignatures.push({ contentIndex: i, partIndex, nameHash: item.nameHash });
      firstInStep = false;
    }
  }
  return {
    model: safeName(payload?.model), requestId: safeName(payload?.requestId),
    projectHash: hash(payload?.project), sessionHash: hash(request.sessionId),
    requestType: safeName(payload?.requestType),
    contentCount: contents.length, currentTurnStartIndex: lastStandardUser,
    toolCallCount: totalToolCalls, omittedToolCalls: Math.max(0, toolCalls.length - MAX_TOOL_CALLS),
    toolCalls: toolCalls.slice(-MAX_TOOL_CALLS), missingFirstSignatures,
    recentContentOutline: contents.slice(-MAX_OUTLINE).map((content, offset) => ({
      index: contents.length - Math.min(contents.length, MAX_OUTLINE) + offset,
      role: content?.role === 'model' ? 'model' : content?.role === 'user' ? 'user' : 'other',
      parts: (content?.parts || []).slice(0, 30).map(part => part?.functionCall ? 'functionCall' : part?.functionResponse ? 'functionResponse' : part?.thought ? 'thought' : part?.text !== undefined ? 'text' : part?.inlineData ? 'inlineData' : 'other'),
    })),
    thinkingConfig: request.generationConfig?.thinkingConfig ? {
      level: safeName(request.generationConfig.thinkingConfig.thinkingLevel),
      budget: Number.isFinite(request.generationConfig.thinkingConfig.thinkingBudget) ? request.generationConfig.thinkingConfig.thinkingBudget : undefined,
    } : undefined,
    maxOutputTokens: request.generationConfig?.maxOutputTokens,
    toolDeclarationCount: request.tools?.reduce((count, group) => count + (group?.functionDeclarations?.length || 0), 0) || 0,
  };
}

export function summarizeAntigravityServerError(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { /* A plain text error is also valid. */ }
  const error = parsed?.error;
  if (!error || typeof error !== 'object') return { message: classifyErrorText(text) };
  return {
    status: safeStatus(error.status), code: Number.isInteger(error.code) ? error.code : undefined,
    message: classifyErrorText(error.message),
    details: Array.isArray(error.details) ? error.details.slice(0, 12).map(detail => ({
      type: ['type.googleapis.com/google.rpc.BadRequest', 'type.googleapis.com/google.rpc.ErrorInfo',
        'type.googleapis.com/google.rpc.QuotaFailure', 'type.googleapis.com/google.rpc.PreconditionFailure'].includes(detail?.['@type'])
        ? detail['@type'] : '[other-type]',
      reason: safeStatus(detail?.reason),
      fieldViolations: Array.isArray(detail?.fieldViolations) ? detail.fieldViolations.slice(0, 12).map(item => ({
        field: safeField(item?.field), description: classifyErrorText(item?.description),
      })) : undefined,
      keys: detail && typeof detail === 'object' ? ['@type', 'reason', 'domain', 'metadata', 'fieldViolations', 'violations'].filter(key => Object.hasOwn(detail, key)) : [],
    })) : [],
  };
}

export async function writeAntigravityFailure(directory, { phase, payload, endpoint, status, serverText, transportError, attempts = [] }) {
  const id = `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomBytes(5).toString('hex')}`;
  const record = {
    version: 1, id, time: new Date().toISOString(), phase: safeName(phase),
    endpointHost: (() => { try { return new URL(endpoint).hostname; } catch { return 'unknown'; } })(),
    httpStatus: Number.isInteger(status) ? status : undefined,
    request: summarizeAntigravityRequest(payload),
    ...(serverText !== undefined ? { backend: summarizeAntigravityServerError(serverText) } : {}),
    ...(transportError ? { transport: classifyErrorText(transportError) } : {}),
    attempts: attempts.slice(-12).map(item => ({
      model: safeName(item.model), endpointHost: (() => { try { return new URL(item.endpoint).hostname; } catch { return 'unknown'; } })(),
      status: Number.isInteger(item.status) ? item.status : undefined,
      elapsedMs: Number.isFinite(item.elapsedMs) ? Math.round(item.elapsedMs) : undefined,
    })),
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('Unsafe diagnostic directory');
  }
  await chmod(directory, 0o700);
  const path = join(directory, `${id}.json`);
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(`${JSON.stringify(record, null, 2)}\n`); }
  finally { await file.close(); }
  return { id, path };
}
