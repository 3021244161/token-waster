/**
 * Provider catalog.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  READ THIS BEFORE TRUSTING ANY NUMBER IN THIS FILE
 * ────────────────────────────────────────────────────────────────────────────
 *  Every limit and price below was transcribed by hand on 2026-10-29 from
 *  public docs. Vendors change context windows, output caps and prices
 *  constantly, and several of them vary by account tier, region or billing
 *  plan. Anything marked `est: true` is an estimate that we could not confirm
 *  against first-party docs.
 *
 *  This catalog is therefore a *starting point*, not a source of truth.
 *  The UI lets you override model id / context / max output / price for every
 *  run, and the engine always believes the `usage` field the API returns over
 *  anything in here. If you are about to spend real money, verify in the
 *  vendor's console first.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Protocol values:
 *   openai-chat        POST {base}/chat/completions          (Bearer auth)
 *   openai-responses   POST {base}/responses                 (Bearer auth)
 *   anthropic-messages POST {base}/v1/messages               (x-api-key)
 *   gemini-generate    POST {base}/v1beta/models/{m}:streamGenerateContent
 *   azure-openai       POST {base}/openai/deployments/{m}/chat/completions
 */

export const CATALOG_VERSION = '2026-10-29';

/** Approximate FX used only to display a single comparable cost figure. */
export const FX_TO_USD = { USD: 1, CNY: 1 / 7.2, EUR: 1.08 };

const M = (id, ctx, maxOut, inp, out, extra = {}) => ({
  id,
  ctx,
  maxOut,
  price: { in: inp, out, currency: extra.currency || 'USD' },
  vision: extra.vision !== false,
  reasoning: extra.reasoning || false,
  est: extra.est || false,
  note: extra.note || '',
});

export const PROVIDERS = [
  {
    id: 'openai',
    label: 'OpenAI',
    protocol: 'openai-chat',
    baseUrl: 'https://api.openai.com/v1',
    keyHint: 'sk-…',
    consoleUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs/models',
    maxImagesPerRequest: 500,
    imageLongEdge: 2048,
    notes:
      'Automatic prefix caching kicks in at ≥1024 tokens and keys off the first ~256 tokens. ' +
      'A random leading nonce therefore guarantees a cache miss. GPT-5.6+ bills cache *writes* at 1.25×.',
    limitsNote: 'RPM/TPM depend on your tier; check the Limits page in the dashboard.',
    models: [
      M('gpt-5.6-sol', 1050000, 128000, 5, 30, { reasoning: true }),
      M('gpt-5.6-terra', 1050000, 128000, 2, 12, { reasoning: true }),
      M('gpt-5.6-luna', 1050000, 128000, 0.2, 1.2, { reasoning: true }),
      M('gpt-5.5', 1000000, 128000, 5, 30, { reasoning: true }),
      M('gpt-4.1', 1047576, 32768, 2, 8),
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    keyHint: 'sk-ant-…',
    consoleUrl: 'https://console.anthropic.com/settings/keys',
    docsUrl: 'https://platform.claude.com/docs/en/about-claude/models/overview',
    maxImagesPerRequest: 600,
    imageLongEdge: 1568,
    notes:
      'Caching is opt-in via cache_control blocks — we never set it, so nothing is cached. ' +
      'Images are downscaled to a 1568px long edge before billing, so bigger than that buys you nothing ' +
      'except upload time. Up to 600 images per request on 1M-context models.',
    limitsNote: 'Rate limits scale with your usage tier (RPM + input/output TPM).',
    models: [
      M('claude-sonnet-5-5', 1000000, 128000, 2, 10, { reasoning: true }),
      M('claude-opus-5', 1000000, 128000, 5, 25, { reasoning: true, est: true }),
      M('claude-haiku-5-5', 1000000, 128000, 0.1, 0.5),
      M('claude-sonnet-4-6', 1000000, 128000, 3, 15, { reasoning: true, est: true }),
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    protocol: 'gemini-generate',
    baseUrl: 'https://generativelanguage.googleapis.com',
    keyHint: 'AIza…',
    consoleUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/models',
    maxImagesPerRequest: 900,
    imageLongEdge: 2048,
    notes:
      'Images are tiled in 384px patches, so — unlike Claude — a larger image really does cost more tokens. ' +
      'Implicit context caching can still fire, so keep the leading content random. ' +
      'Total request size is capped at 20 MB including base64 overhead.',
    limitsNote: 'Per-model RPM/TPM in AI Studio; free tier limits are much stricter than paid.',
    models: [
      M('gemini-3-pro-preview', 1048576, 65536, 2, 12),
      M('gemini-3-flash', 1048576, 65536, 0.5, 3, { est: true }),
      M('gemini-3.1-pro-preview', 1048576, 65536, 2, 12, { est: true }),
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    keyHint: 'sk-…',
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com/',
    maxImagesPerRequest: 0,
    imageLongEdge: 0,
    notes:
      'Text only — the image bomb does nothing here, lean on output. Disk-based prefix cache means ' +
      'a repeated prompt is nearly free; random filler is what keeps the meter running. ' +
      'Off-peak pricing shown; peak hours are roughly 2×.',
    limitsNote: 'Concurrency caps apply per model (higher on flash).',
    models: [
      M('deepseek-v4-pro', 1000000, 384000, 0.66, 1.98, { vision: false, reasoning: true }),
      M('deepseek-v4-flash', 1000000, 128000, 0.22, 0.66, { vision: false, reasoning: true, est: true }),
    ],
  },
  {
    id: 'moonshot',
    label: 'Moonshot / Kimi',
    protocol: 'openai-chat',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyHint: 'sk-…',
    consoleUrl: 'https://platform.moonshot.cn/console/api-keys',
    docsUrl: 'https://platform.moonshot.cn/docs/',
    maxImagesPerRequest: 20,
    imageLongEdge: 2048,
    notes: 'Long context, vision on the newer models. Prices in USD per their intl docs.',
    limitsNote: 'Tiered concurrency; long-context requests are slower to start.',
    models: [
      M('kimi-k3', 1000000, 128000, 3, 15, { reasoning: true }),
      M('kimi-k2-turbo-preview', 256000, 32768, 1.2, 8, { est: true }),
    ],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM (Z.ai)',
    protocol: 'openai-chat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyHint: '…',
    consoleUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    docsUrl: 'https://docs.bigmodel.cn/',
    maxImagesPerRequest: 20,
    imageLongEdge: 2048,
    notes: 'GLM-5.x forces thinking on, which bills as output — good for burning. Flash tier is free.',
    limitsNote: 'Free tiers are rate limited hard; expect 429s and let the backoff handle it.',
    models: [
      M('glm-5.3', 1000000, 128000, 1.4, 4.4, { reasoning: true, est: true }),
      M('glm-5.2', 1000000, 128000, 1.4, 4.4, { reasoning: true, est: true }),
      M('glm-4.7-flash', 131072, 16384, 0, 0, { est: true, note: '免费档' }),
    ],
  },
  {
    id: 'dashscope',
    label: '阿里云百炼 / 通义千问',
    protocol: 'openai-chat',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyHint: 'sk-…',
    consoleUrl: 'https://bailian.console.aliyun.com/',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/',
    maxImagesPerRequest: 20,
    imageLongEdge: 2048,
    notes:
      'OpenAI-compatible mode. qwen-long has a 10M window — the single largest context in this catalog. ' +
      'Prices are CNY per 1M tokens.',
    limitsNote: 'Tiered QPS by account; qwen-flash has a free grant.',
    models: [
      M('qwen3.8-max', 1000000, 65536, 12, 36, { currency: 'CNY', reasoning: true }),
      M('qwen3.7-plus', 256000, 32768, 2, 8, { currency: 'CNY' }),
      M('qwen3.8-flash', 1000000, 32768, 0.8, 2.4, { currency: 'CNY', est: true }),
      M('qwen-long', 10000000, 8192, 0.5, 2, { currency: 'CNY', vision: false }),
    ],
  },
  {
    id: 'volcengine',
    label: '火山方舟 / 豆包',
    protocol: 'openai-chat',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    keyHint: '…',
    consoleUrl: 'https://console.volcengine.com/ark',
    docsUrl: 'https://www.volcengine.com/docs/82379',
    maxImagesPerRequest: 20,
    imageLongEdge: 2048,
    notes:
      'Accepts either a model id or an endpoint id (ep-xxxx) that you create in the console. ' +
      'CNY pricing. Region-specific base URL if you are not on cn-beijing.',
    limitsNote: 'Per-endpoint TPU limits set at provisioning time.',
    models: [
      M('doubao-seed-2.1-pro', 256000, 32768, 6, 30, { currency: 'CNY', reasoning: true, est: true }),
      M('doubao-seed-1.6', 256000, 16384, 0.8, 8, { currency: 'CNY', est: true }),
    ],
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    protocol: 'openai-chat',
    baseUrl: 'https://api.minimax.io/v1',
    keyHint: '…',
    consoleUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    docsUrl: 'https://platform.minimax.io/docs',
    maxImagesPerRequest: 20,
    imageLongEdge: 1568,
    notes: 'Model ids and limits here are placeholders — fill them in from your console before burning.',
    limitsNote: 'Verify in console.',
    models: [M('minimax-m2', 200000, 32768, 0.3, 1.2, { est: true, note: '示例，请核对' })],
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    protocol: 'openai-chat',
    baseUrl: 'https://api.x.ai/v1',
    keyHint: 'xai-…',
    consoleUrl: 'https://console.x.ai/',
    docsUrl: 'https://docs.x.ai/docs/models',
    maxImagesPerRequest: 20,
    imageLongEdge: 2048,
    notes: 'OpenAI-compatible. Reasoning models bill thinking as output.',
    limitsNote: 'RPM by tier.',
    models: [
      M('grok-4.5', 256000, 32768, 3, 15, { reasoning: true, est: true }),
      M('grok-4', 256000, 32768, 3, 15, { est: true }),
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    protocol: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyHint: 'sk-or-…',
    consoleUrl: 'https://openrouter.ai/keys',
    docsUrl: 'https://openrouter.ai/docs',
    maxImagesPerRequest: 100,
    imageLongEdge: 2048,
    notes:
      'One key, hundreds of models — the easiest way to reach a model that is not otherwise listed here. ' +
      'Pass the upstream id, e.g. `deepseek/deepseek-v4-pro`. Rate limits are per-provider behind the scenes.',
    limitsNote: 'Free models are heavily throttled; paid models inherit upstream limits.',
    models: [
      M('deepseek/deepseek-v4-pro', 1000000, 384000, 0.66, 1.98, { reasoning: true, est: true }),
      M('anthropic/claude-sonnet-5-5', 1000000, 128000, 2, 10, { est: true }),
      M('google/gemini-3-pro-preview', 1048576, 65536, 2, 12, { est: true }),
    ],
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    protocol: 'openai-chat',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keyHint: 'sk-…',
    consoleUrl: 'https://cloud.siliconflow.cn/account/ak',
    docsUrl: 'https://docs.siliconflow.cn/',
    maxImagesPerRequest: 20,
    imageLongEdge: 2048,
    notes: 'Aggregator with a generous free tier on some models — cheap way to stress the pipeline.',
    limitsNote: 'Free models: strict RPM. Paid: higher.',
    models: [
      M('deepseek-ai/DeepSeek-V4.1-Flash', 1000000, 128000, 0.13, 0.28, { est: true }),
      M('Qwen/Qwen3.8-Max', 1000000, 65536, 1.6, 5, { est: true }),
    ],
  },
  {
    id: 'groq',
    label: 'Groq',
    protocol: 'openai-chat',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyHint: 'gsk_…',
    consoleUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs/models',
    maxImagesPerRequest: 5,
    imageLongEdge: 1024,
    notes: 'Extremely fast tokens/second — best choice if you want to watch a big number climb quickly.',
    limitsNote: 'Daily token caps on free tier are easy to exhaust.',
    models: [M('llama-3.3-70b-versatile', 131072, 32768, 0.59, 0.79, { vision: false, est: true })],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    protocol: 'openai-chat',
    baseUrl: 'https://api.mistral.ai/v1',
    keyHint: '…',
    consoleUrl: 'https://console.mistral.ai/api-keys',
    docsUrl: 'https://docs.mistral.ai/getting-started/models/models_overview/',
    maxImagesPerRequest: 8,
    imageLongEdge: 1540,
    notes: 'OpenAI-compatible endpoint. Pixtral handles images.',
    limitsNote: 'Tier based.',
    models: [
      M('mistral-large-latest', 131072, 32768, 2, 6, { est: true }),
      M('pixtral-large-latest', 131072, 32768, 2, 6, { est: true }),
    ],
  },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    protocol: 'azure-openai',
    baseUrl: 'https://YOUR-RESOURCE.openai.azure.com',
    apiVersion: '2024-10-21',
    keyHint: '32-hex…',
    consoleUrl: 'https://portal.azure.com/',
    docsUrl: 'https://learn.microsoft.com/azure/ai-services/openai/',
    maxImagesPerRequest: 100,
    imageLongEdge: 2048,
    notes:
      '`model` is your *deployment name*, not the model id. Auth uses the api-key header. ' +
      'Billing is capacity-based (PTU) or per-token depending on your deployment type.',
    limitsNote: 'Governed by TPM/RPM quota assigned to the deployment.',
    models: [M('gpt-5.6-sol', 1050000, 128000, 5, 30, { reasoning: true, est: true })],
  },
  {
    id: 'ollama',
    label: '本地 Ollama（不花钱，只烧电）',
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:11434/v1',
    keyHint: 'ollama',
    consoleUrl: 'https://ollama.com/',
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
    maxImagesPerRequest: 4,
    imageLongEdge: 1024,
    notes:
      'Zero marginal cost — useful for testing the whole pipeline, including image generation, ' +
      'before you point it at a paid endpoint. Token counts are still real.',
    limitsNote: 'Limited by your GPU. Concurrency above 2–4 will just queue.',
    models: [M('qwen3:8b', 32768, 8192, 0, 0, { note: '本地模型' })],
  },
  {
    id: 'custom',
    label: '自定义 / OpenAI 兼容',
    protocol: 'openai-chat',
    baseUrl: 'https://',
    keyHint: 'any',
    consoleUrl: '',
    docsUrl: '',
    maxImagesPerRequest: 20,
    imageLongEdge: 1568,
    notes: 'Any endpoint that speaks POST {base}/chat/completions. Fill in base URL and model id yourself.',
    limitsNote: 'Unknown — assume conservative limits.',
    models: [M('your-model-id', 128000, 16384, 0, 0, { est: true, note: '请填写' })],
  },
];

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

export function getModel(providerId, modelId) {
  const p = getProvider(providerId);
  if (!p) return null;
  return p.models.find((m) => m.id === modelId) || null;
}

/** Convert a price entry to USD per 1M tokens. */
export function toUsd(amount, currency) {
  return amount * (FX_TO_USD[currency] ?? 1);
}

/**
 * Cost in USD for a request, given real usage numbers.
 * `cachedIn` is billed at the cached rate when the provider reports it; when it
 * does not, we assume nothing was cached (worst case for the user's wallet,
 * which is the honest direction for a burn tool to guess in).
 */
export function estimateCostUsd(model, { input = 0, output = 0, cached = 0 }) {
  if (!model || !model.price) return 0;
  const cur = model.price.currency || 'USD';
  const inRate = toUsd(model.price.in, cur);
  const outRate = toUsd(model.price.out, cur);
  const uncached = Math.max(0, input - cached);
  // Cached input is typically 10–25% of the normal rate across vendors.
  return (uncached * inRate + cached * inRate * 0.2 + output * outRate) / 1e6;
}
