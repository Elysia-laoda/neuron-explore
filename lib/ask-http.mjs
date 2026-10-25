// ask-http.mjs — OpenAI 兼容端点适配器（唯一模型入口，带重试）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeHttpAsk({ baseUrl, apiKey, model, temperature = 1, maxTokens = 2000 }) {
  if (!baseUrl || !apiKey || !model) {
    return async () => ({ text: '', thinking: '',
      error: 'NOT_CONFIGURED: 请先配置至少一个 AI（baseUrl / model / apiKeyEnv）' });
  }
  const url = String(baseUrl).replace(/\/+$/, '') + '/chat/completions';
  return async function ask(messages, opts = {}) {
    const body = {
      model: opts.model || model,
      temperature: opts.temperature ?? temperature,
      max_tokens: opts.maxTokens ?? maxTokens,
      messages,
    };
    if (opts.thinking !== false) {
      body.enable_thinking = true;
      if (opts.budget) body.thinking_budget = opts.budget;
    }
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          lastErr = 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120);
          if (r.status < 500 && r.status !== 429) break;
          await sleep(800 * (attempt + 1));
          continue;
        }
        const j = await r.json();
        const m = j.choices?.[0]?.message || {};
        let text = m.content || '';
        const thinking = m.reasoning_content || '';
        if (opts.maxChars && (thinking + text).length > opts.maxChars) {
          return { text: (thinking + text).slice(0, opts.maxChars), thinking: '' };
        }
        return { text, thinking, usage: j.usage || null };
      } catch (e) {
        lastErr = String(e.message || e).slice(0, 80);
        await sleep(800 * (attempt + 1));
      }
    }
    return { text: '', thinking: '', error: lastErr };
  };
}
