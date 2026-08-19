// Anthropic client — thin fetch wrapper for /v1/messages.
//
// Handles the standard call shape, timeouts, error normalization, and
// tool-forcing for structured output. Cost accounting lives here too so
// every caller records a row in ai_usage without repeating math.

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Default model — Sonnet 5 is fast + smart enough for both drafting and
// scoring. Swap to Opus for extra rigor at higher cost.
export const DEFAULT_MODEL = 'claude-sonnet-5';

// Ballpark USD-per-token in micro-USD (millionths of a dollar).
// Sonnet 5 rates. Change here if pricing shifts — the math flows everywhere.
const PRICING = {
  'claude-sonnet-5': { input_micro: 3, output_micro: 15 },
  'claude-opus-5':   { input_micro: 15, output_micro: 75 },
  'claude-haiku-4-5-20251001': { input_micro: 1, output_micro: 5 },
};

// Timeout used for both drafting and scoring calls. Long enough for
// thoughtful output, short enough that a hung request can't tie up the
// dashboard for minutes.
const TIMEOUT_MS = 45_000;

/**
 * Call the Anthropic Messages API and return {output, usage}.
 * If `tool` is supplied, the model is forced to call it and its `input`
 * object is returned as `output.tool_input`.
 */
export async function callClaude(env, {
  system,
  messages,
  tool,
  model = DEFAULT_MODEL,
  maxTokens = 1024,
  temperature = 0.7,
}) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY secret is not configured');
  }

  const body = {
    model,
    max_tokens: maxTokens,
    temperature,
    system,
    messages,
  };
  if (tool) {
    body.tools = [tool];
    body.tool_choice = { type: 'tool', name: tool.name };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = Date.now();

  let resp;
  try {
    resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const msg = e.name === 'AbortError' ? 'anthropic_timeout' : 'anthropic_network_error';
    throw Object.assign(new Error(msg), { cause: e });
  }
  clearTimeout(timer);

  const latencyMs = Date.now() - t0;
  let json;
  try { json = await resp.json(); } catch { json = null; }

  if (!resp.ok) {
    const detail = json?.error?.message || `HTTP ${resp.status}`;
    throw Object.assign(new Error('anthropic_' + resp.status), { detail, latencyMs });
  }

  const usage = json?.usage ?? { input_tokens: 0, output_tokens: 0 };
  const rate = PRICING[model] ?? PRICING[DEFAULT_MODEL];
  const cost_micro_usd =
    (usage.input_tokens  || 0) * rate.input_micro +
    (usage.output_tokens || 0) * rate.output_micro;

  // Extract text and tool_use blocks from the response content.
  let text = '';
  let toolInput = null;
  for (const block of json?.content ?? []) {
    if (block.type === 'text') text += block.text;
    if (block.type === 'tool_use' && (!tool || block.name === tool.name)) {
      toolInput = block.input;
    }
  }

  return {
    output: { text, tool_input: toolInput, stop_reason: json?.stop_reason },
    usage: {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cost_micro_usd,
      latency_ms: latencyMs,
      model,
    },
  };
}

/**
 * Record a call to the ai_usage table. Never throws — logging must not
 * take down the actual API request that succeeded.
 */
export async function recordUsage(env, contactId, purpose, usage, error) {
  try {
    await env.DB.prepare(
      `INSERT INTO ai_usage
       (contact_id, purpose, model, input_tokens, output_tokens, cost_micro_usd, latency_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      contactId ?? null,
      purpose,
      usage.model,
      usage.input_tokens,
      usage.output_tokens,
      usage.cost_micro_usd,
      usage.latency_ms,
      error ?? null,
    ).run();
  } catch (e) {
    console.error('ai_usage log failed:', e?.message || e);
  }
}
