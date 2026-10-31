// An AI provider's refusal, sorted so the caller can try another provider and tell the person why:
//   kind "key"      the key isn't valid (or isn't allowed this model)
//   kind "credits"  the key is valid, but its account has no credits or quota left
//   kind "busy"     the service is overloaded or rate-limited for now
//   kind "other"    anything else
// The message is one sentence for the page, ending in a period.

export class ProviderError extends Error {
  constructor(provider, status, detail, kind, message) {
    super(message);
    Object.assign(this, { provider, status, detail, kind });
  }
}

// Where each provider's account gets credits.
const CREDITS_AT = {
  Claude: 'platform.claude.com (Settings, Billing)', Gemini: 'https://ai.studio/projects', OpenAI: 'platform.openai.com (Settings, Billing)',
  xAI: 'console.x.ai', Groq: 'console.groq.com (Settings, Billing)', Perplexity: 'perplexity.ai (API settings)', Pollinations: 'enter.pollinations.ai',
};

// provider: "Claude", "Gemini", "OpenAI", ... detail: the response body's text.
export function providerError(provider, status, detail = '') {
  const text = String(detail);
  const credits = provider === 'Claude'
    ? status === 400 && /credit balance/i.test(text)
    : status === 402 || ((status === 429 || status === 403) && /billing|prepay|credits|insufficient_quota|balance/i.test(text));
  if (credits) {
    const where = CREDITS_AT[provider] ? ` Add credits at ${CREDITS_AT[provider]}.` : '';
    return new ProviderError(provider, status, text, 'credits', `The ${provider} API key is valid, but its account has no credits left.${where}`);
  }
  if (status === 401 || status === 403 || (status === 400 && /API_KEY_INVALID|API key not valid|incorrect api key|invalid api key|invalid_api_key/i.test(text))) {
    return new ProviderError(provider, status, text, 'key', `The ${provider} API key isn't valid (${status}).`);
  }
  if (status === 429 || status === 503 || status === 529) {
    const message = status === 429 && /quota/i.test(text)
      ? `The ${provider} API key has used up its quota for now.`
      : `${provider} is busy right now (${status}).`;
    return new ProviderError(provider, status, text, 'busy', message);
  }
  return new ProviderError(provider, status, text, 'other', `${provider} API ${status}: ${text.slice(0, 300)}`);
}
