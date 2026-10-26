// adapter.mjs — 把多路引擎伪装成一个 LLM provider：选中它，就等于用多路思考替代单思考
import { makeEngine } from './engine.mjs';
import { randomUUID } from 'node:crypto';

const MODELS = [
  { id: 'neuron-agent-2', mode: 'agent', n: 2, name: '神经元 · agent ×2', description: '两路并行，评审换主' },
  { id: 'neuron-agent-3', mode: 'agent', n: 3, name: '神经元 · agent ×3', description: '三路并行，评审换主' },
  { id: 'neuron-agent-4', mode: 'agent', n: 4, name: '神经元 · agent ×4', description: '四路并行，评审换主' },
  { id: 'neuron-fuse-3', mode: 'fuse', n: 3, name: '神经元 · fuse ×3', description: '轮内截断+交叉投递（需断点续写）' },
];

const textOf = (m) => {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  return '';
};
const lastUser = (messages) => {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'user') return textOf(messages[i]);
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
      const modelId = String(options.model || '');
      const spec = MODELS.find((m) => m.id === modelId) || MODELS[1];
      let index = 0;
      yield { type: 'block-start', index, blockType: 'reasoning' };
      let reasoning = '';
      const push = (t) => { reasoning += t; };

      const queue = [];
      let finished = false, result = null, failure = '';
      const engine = makeEngine({
        ask: askBackend, judge: askBackend,
        onProgress: (p) => queue.push(p),
      });
      const job = engine[spec.mode]({ prompt, n: spec.n, rounds: 0, budget: c.budget || 0 })
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
      index += 1;
      yield { type: 'block-start', index, blockType: 'text' };
      let answer = result && result.answer ? String(result.answer) : '';
      if (answer) {
        // 主模型产出的是推理；这里再合成一次，只留干净答复
        try {
          const fin = await askBackend([
            { role: 'system', content: '你是最终答复者。根据给定的推理，用用户使用的语言直接给出答案；不要复述推理过程，不要提评分、评审或“内部反馈”，不要解释你是怎么想出来的。' },
            { role: 'user', content: '问题：' + prompt + '\n\n推理过程：\n' + answer.slice(-4000) },
          ], { maxChars: 6000 });
          if (fin && fin.text && fin.text.trim()) answer = fin.text.trim();
        } catch (e) { try { console.error('[neuron-explore] finalize failed: ' + String(e.message || e)); } catch {} }
      }
      if (!answer) answer = '神经元探索没有产出答案' + (failure ? '：' + failure : '');
      for (let i = 0; i < answer.length; i += 400) {
        yield { type: 'text-delta', index, text: answer.slice(i, i + 400) };
      }
      yield { type: 'block-end', index, block: { type: 'text', text: answer } };
      yield { type: 'finish', reason: { kind: 'stop' } };
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
          efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'max' }],
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
