// ask-llm.mjs — 走宿主 LLM 服务（零配置：用用户 DSH 里已配好的默认模型）
import { randomUUID } from 'node:crypto';

const SRC = { kind: 'plugin:neuron-explore' };

export function makeHostAsk(ctx, override = {}) {
  const get = (name) => {
    try { return typeof ctx.get === 'function' ? ctx.get(name) : undefined; } catch { return undefined; }
  };
  const llm = get('llm');
  if (!llm || typeof llm.stream !== 'function') return null;

  function route() {
    try {
      const svc = get('agentDefaultModel');
      const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : null;
      const s = sel && (sel.selection || sel);
      const provider = (s && (s.provider || (s.route && s.route.provider))) || '';
      const model = (s && (s.model || (s.route && s.route.model))) || '';
      const useProvider = override.provider || provider;
      const useModel = override.model || model;
      if (useProvider && useModel) return { provider: useProvider, model: useModel };
    } catch {}
    return null;
  }

  const msg = (role, text) => ({ id: randomUUID(), role, content: [{ type: 'text', text }], source: SRC });

  function collect(chunk, out) {
    if (!chunk) return;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') { out.text += chunk.text; return; }
    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') { out.thinking += chunk.text; return; }
    if (typeof chunk.delta === 'string') { out.text += chunk.delta; return; }
    if (chunk.type === 'text' && typeof chunk.text === 'string') { out.text += chunk.text; return; }
  }

  return async function ask(messages, opts = {}) {
    const r = route();
    if (!r) return { text: '', thinking: '', error: 'NO_DEFAULT_MODEL: DSH 里没有设置默认模型' };
    const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const rest = messages.filter((m) => m.role !== 'system')
      .map((m) => msg(m.role === 'assistant' ? 'assistant' : 'user', m.content));
    const out = { text: '', thinking: '' };
    try {
      const stream = llm.stream({
        provider: r.provider,
        model: r.model,
        messages: rest,
        ...(sys ? { system: sys } : {}),
        ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      });
      for await (const chunk of stream) {
        collect(chunk, out);
        if (opts.maxChars && (out.thinking.length + out.text.length) >= opts.maxChars) break;
      }
    } catch (e) {
      return { text: '', thinking: '', error: 'HOST_LLM: ' + String(e && e.message ? e.message : e).slice(0, 200) };
    }
    if (opts.maxChars) {
      const all = out.thinking + out.text;
      if (all.length > opts.maxChars) return { text: all.slice(0, opts.maxChars), thinking: '' };
    }
    return out;
  };
}
