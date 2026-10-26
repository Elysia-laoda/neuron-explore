// adapter.mjs — 把多路引擎伪装成一个 LLM provider：选中它，就等于用多路思考替代单思考
import { makeEngine } from './engine.mjs';
import { randomUUID } from 'node:crypto';

// 只有一个通用模型：具体并行数/模式全部由设置页决定
const MODELS = [
  { id: 'neuron', name: '神经元探索', description: '多路思考替代单思考（并行数与模式见插件设置）' },
];

const textOf = (m) => {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  return '';
};
// 只取「真人发的」那条：DSH 会把运行时快照/技能清单/记忆快照也塞成 user 角色，
// 取最后一条会把它们当成用户问题。
const lastUser = (messages) => {
  const list = messages || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.role !== 'user') continue;
    const kind = m.source && m.source.kind;
    if (kind && kind !== 'user') continue;
    return textOf(m);
  }
  // 没有带来源标记的，退回到最后一条 user
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].role === 'user') return textOf(list[i]);
  }
  return '';
};

export function makeNeuronAdapter({ llm, getConfig, resolveBackend }) {
  const askBackend = async (messages, opts = {}) => {
    const backend = resolveBackend();
    if (!backend || !backend.provider || !backend.model) {
      return { text: '', thinking: '', error: 'NO_BACKEND: 没有可用的后端模型（不要把我们自己的 provider 设为后端）' };
    }
    const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const rest = messages.filter((m) => m.role !== 'system').map((m) => ({
      id: randomUUID(), role: m.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text: m.content }], source: { kind: 'plugin:neuron-explore' },
    }));
    let text = '', thinking = '';
    for await (const chunk of llm.stream({
      provider: backend.provider, model: backend.model,
      messages: rest, ...(sys ? { system: sys } : {}),
      ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
    })) {
      if (chunk.type === 'text-delta') text += chunk.text;
      else if (chunk.type === 'reasoning-delta') thinking += chunk.text;
      if (opts.maxChars && (text.length + thinking.length) >= opts.maxChars) break;
    }
    return { text, thinking };
  };

  function stream(options) {
    return (async function* run() {
      try {
      console.error('[neuron-explore] adapter stream start model=' + (options && options.model) + ' msgs=' + ((options && options.messages) || []).length);
      const c = getConfig();
      const prompt = lastUser(options.messages);
      const spec = { mode: c.mode === 'fuse' ? 'fuse' : 'agent', n: Math.max(1, Math.min(8, Number(c.workers) || 3)) };
      console.error('[neuron-explore] adapter prompt=' + JSON.stringify(prompt.slice(0, 40)) + ' mode=' + spec.mode + ' n=' + spec.n);
      let index = 0;
      yield { type: 'block-start', index, blockType: 'reasoning' };
      let reasoning = '';
      const push = (t) => { reasoning += t; };

      // 已经进入工具循环（历史里出现过工具调用/结果）就不再重跑多路思考，
      // 直接交给后端模型，省时省钱
      const hasToolHistory = (options.messages || []).some((m) => Array.isArray(m.content)
        && m.content.some((b) => b && (b.type === 'tool-call' || b.type === 'tool-result')));
      if (hasToolHistory) console.error('[neuron-explore] tool loop step — adapters skip multi-route');

      const queue = [];
      let finished = false, result = null, failure = '';
      const engine = makeEngine({
        ask: askBackend, judge: askBackend,
        onProgress: (p) => queue.push(p),
      });
      const job = (hasToolHistory
        ? Promise.resolve({ answer: '' })
        : engine[spec.mode]({ prompt, n: spec.n, rounds: 0, budget: c.budget || 0 }))
        .then((r) => { result = r; })
        .catch((e) => { failure = String(e && e.message ? e.message : e); })
        .finally(() => { finished = true; });

      while (!finished || queue.length > 0) {
        const p = queue.shift();
        if (p) {
          // 只显示主模型的输出
          const mainItem = (p.items || []).find((it) => it.i === p.main) || (p.items || [])[0];
          const body = mainItem ? String(mainItem.text || '') : '';
          if (body) {
            const piece = '\n【第 ' + p.round + ' 轮 · 主模型】\n' + body + '\n';
            push(piece);
            yield { type: 'reasoning-delta', index, text: piece };
          }
        } else {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      await job;

      yield { type: 'block-end', index, block: { type: 'reasoning', text: reasoning } };

      // 第二阶段：真正的助手回合交给后端模型，**带着工具**跑，工具调用原样转发
      const backend = resolveBackend();
      if (!backend) {
        const msg = '【神经元探索】没有可用的后端模型，请检查设置里的「后端模型」。';
        yield { type: 'block-start', index: 1, blockType: 'text' };
        yield { type: 'text-delta', index: 1, text: msg };
        yield { type: 'block-end', index: 1, block: { type: 'text', text: msg } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      const analysis = reasoning
        ? ('\n\n【多路思考摘要｜仅供参考，不要复述，也不要提到它来自插件】\n' + reasoning.slice(-4000))
        : '';
      const sys = [options.system || '', analysis].filter(Boolean).join('');
      const fwd = { ...options, provider: backend.provider, model: backend.model };
      delete fwd.reasoningEffort;
      if (sys) fwd.system = sys;
      let finishReason = { kind: 'stop' };
      for await (const chunk of llm.stream(fwd)) {
        if (!chunk) continue;
        if (chunk.type === 'finish') { finishReason = chunk.reason || finishReason; continue; }
        if (chunk.type === 'usage') { yield chunk; continue; }
        // 索引整体 +1，避免与推理块冲突
        yield typeof chunk.index === 'number' ? { ...chunk, index: chunk.index + 1 } : chunk;
      }
      yield { type: 'finish', reason: finishReason };
      } catch (e) {
        const msg = '神经元探索 adapter 出错：' + String(e && e.message ? e.message : e);
        try { console.error('[neuron-explore] adapter stream error: ' + msg); } catch {}
        yield { type: 'block-start', index: 9, blockType: 'text' };
        yield { type: 'text-delta', index: 9, text: msg };
        yield { type: 'block-end', index: 9, block: { type: 'text', text: msg } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    })();
  }

  const api = {
    providerInfo(provider) { return { id: provider, name: '神经元探索（多路思考）' }; },
    // 基类默认是「无策略 / 无定价」，这里是纯对象，得显式给出
    providerRetryPolicy() { return undefined; },
    imageRequestPricing() { return undefined; },
    imageRequestTarget() { return undefined; },
    async listModels(provider) {
      return MODELS.map((m) => ({ provider, id: m.id, name: m.name, description: m.description }));
    },
    async resolveModel(provider, model) {
      const m = MODELS.find((x) => x.id === model);
      return {
        provider, id: model, name: m ? m.name : model,
        // 对外声明支持的思考档位，否则上层配置 reasoningEffort=max 会被拒绝
        reasoning: {
          efforts: [
            { id: 'low', name: '低' },
            { id: 'medium', name: '中' },
            { id: 'high', name: '高' },
            { id: 'max', name: '最高' },
          ],
          defaultEffort: 'high',
        },
      };
    },
    stream,
    MODELS,
  };
  // 运行时通过 prepareCall 绑定一次生成：不给它，stream 永远不会被调用
  api.prepareCall = async (provider, model, signal) => ({
    model: await api.resolveModel(provider, model, signal),
    stream: (options) => api.stream(options),
  });
  return api;
}
