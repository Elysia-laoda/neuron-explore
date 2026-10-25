/**
 * neuron-explore — DSH 插件入口（防御式：拿不到宿主 API 也不会崩）
 *
 * 暴露一个服务 neuronExplore.run({ prompt, mode, ... })，
 * 并尽力注册一个同名工具；注册失败只记一条日志，不影响宿主。
 */
import { makeEngine } from './engine.mjs';
import { makeHttpAsk } from './ask-http.mjs';

export const name = 'neuron-explore';
export const inject = [];

const DEFAULTS = {
  enabled: false,
  mode: 'fuse',
  workers: 3,
  rounds: 2,
  mid: 1800,
  tail: 900,
  budget: 2500,
  baseUrl: '',
  model: '',
  apiKeyEnv: '',
  judgeModel: '',
  judgeBaseUrl: '',
  judgeApiKeyEnv: '',
};

function normalize(raw) {
  const c = { ...DEFAULTS, ...(raw || {}) };
  c.workers = Math.max(1, Number(c.workers) || 3);
  c.rounds = Math.max(1, Number(c.rounds) || 2);
  c.mid = Math.max(100, Number(c.mid) || 1800);
  c.tail = Math.max(50, Number(c.tail) || 900);
  c.budget = Math.max(100, Number(c.budget) || 2500);
  if (!['single', 'agent', 'fuse'].includes(c.mode)) c.mode = 'fuse';
  return c;
}

export function apply(ctx, rawConfig) {
  const config = normalize(rawConfig);
  const keyOf = (n) => (n ? String(process.env[String(n)] || '') : '');
  const baseAsk = makeHttpAsk({ baseUrl: config.baseUrl, apiKey: keyOf(config.apiKeyEnv), model: config.model });
  const judgeModel = config.judgeModel || config.model;
  const judgeAsk = judgeModel === config.model && (config.judgeBaseUrl || '') === (config.baseUrl || '')
    ? baseAsk
    : makeHttpAsk({
      baseUrl: config.judgeBaseUrl || config.baseUrl,
      apiKey: keyOf(config.judgeApiKeyEnv || config.apiKeyEnv),
      model: judgeModel,
    });
  const engine = makeEngine({ ask: baseAsk, judge: judgeAsk });
  const configured = !!(config.baseUrl && config.model && keyOf(config.apiKeyEnv));

  async function run(args = {}) {
    if (!configured) {
      return { ok: false, code: 'NOT_CONFIGURED',
        message: '未配置 AI：请在插件设置里填写 baseUrl、model、apiKeyEnv（环境变量名）。' };
    }
    const mode = ['single', 'agent', 'fuse'].includes(args.mode) ? args.mode : config.mode;
    const opts = {
      prompt: String(args.prompt || ''),
      n: Math.max(1, Number(args.n || args.workers || config.workers)),
      rounds: Math.max(1, Number(args.rounds || config.rounds)),
      mid: Math.max(100, Number(args.mid || config.mid)),
      tail: Math.max(50, Number(args.tail || config.tail)),
      budget: Math.max(100, Number(args.budget || config.budget)),
    };
    if (!opts.prompt) return { ok: false, code: 'NO_PROMPT' };
    const t0 = Date.now();
    try {
      const r = await engine[mode](opts);
      return { ok: true, mode, seconds: Math.round((Date.now() - t0) / 1000), result: r };
    } catch (e) {
      return { ok: false, code: 'RUN_FAILED', message: String(e.message || e).slice(0, 300) };
    }
  }

  const service = {
    run,
    status: () => ({
      enabled: config.enabled, configured, mode: config.mode, workers: config.workers,
      rounds: config.rounds, mid: config.mid, tail: config.tail, budget: config.budget,
      model: config.baseUrl ? config.model || '(未填)' : '',
    }),
    config: () => ({ ...config }),
  };
  try { ctx.provide('neuronExplore', service); } catch { /* 服务名冲突就跳过 */ }

  // 尽力注册工具：不同宿主版本的 API 不同，全部包在 try 里
  const toolSpec = {
    name: 'neuron_explore',
    description: '多 AI 并行思考并互相注入，返回综合结果。参数：prompt（必填）、mode（single|agent|fuse）、n、rounds。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '要解决的问题' },
        mode: { type: 'string', enum: ['single', 'agent', 'fuse'] },
        n: { type: 'number', description: '并行线程数' },
        rounds: { type: 'number', description: '轮数' },
      },
      required: ['prompt'],
    },
    execute: async (args) => run(args || {}),
  };
  let registered = false;
  for (const attempt of [
    () => ctx.tools?.register?.(toolSpec),
    () => ctx.tool?.(toolSpec),
    () => ctx.registerTool?.(toolSpec),
  ]) {
    try { if (attempt()) { registered = true; break; } } catch { /* 下一个 */ }
  }
  if (!registered) {
    try { ctx.logger?.info?.('neuron-explore: 未找到工具注册 API，已仅提供 neuronExplore 服务（可用 CLI 调用）'); } catch { /* ignore */ }
  }
  try {
    ctx.logger?.info?.('neuron-explore: mode=' + config.mode + ' workers=' + config.workers
      + ' mid=' + config.mid + ' tail=' + config.tail + ' configured=' + configured + ' tool=' + registered);
  } catch { /* ignore */ }
}

export const META = { DEFAULTS };
