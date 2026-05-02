export function validateClaudeModelAndEffort(
  model: string | null | undefined,
  reasoningEffort: string | null | undefined,
): string | null {
  const normalized = normalizeClaudeModel(model);
  if (reasoningEffort === 'none' || reasoningEffort === 'minimal') {
    return 'Claude reasoning_effort must be one of low, medium, high, xhigh, or max';
  }
  if (normalized && isClaudeAlias(normalized)) {
    return 'Claude model must be a direct model id such as claude-opus-4-7 or claude-opus-4-7[1m]; aliases like opus and sonnet can drift';
  }
  if (reasoningEffort && !normalized) {
    return 'Claude reasoning_effort requires an explicit direct model id such as claude-opus-4-7 so fallback behavior is visible';
  }
  if (reasoningEffort === 'xhigh' && normalized && !isClaudeOpus47(normalized)) {
    return 'Claude xhigh effort requires claude-opus-4-7 or claude-opus-4-7[1m]; other Claude models can fall back to high';
  }
  if (reasoningEffort && normalized && isAnthropicClaudeModelId(normalized) && !isKnownClaudeEffortModel(normalized)) {
    return 'Claude effort levels are documented for Opus 4.7, Opus 4.6, and Sonnet 4.6; use one of those direct model ids';
  }
  return null;
}

function normalizeClaudeModel(model: string | null | undefined): string | null {
  const value = model?.trim().toLowerCase();
  return value ? value.replace(/\[1m\]$/, '') : null;
}

function isClaudeAlias(model: string): boolean {
  return model === 'default'
    || model === 'best'
    || model === 'opus'
    || model === 'sonnet'
    || model === 'haiku'
    || model === 'opusplan';
}

function isClaudeOpus47(model: string): boolean {
  return model === 'claude-opus-4-7';
}

function isKnownClaudeEffortModel(model: string): boolean {
  return knownClaudeEffortModels.has(model);
}

function isAnthropicClaudeModelId(model: string): boolean {
  return model.includes('claude-');
}

const knownClaudeEffortModels = new Set([
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
]);
