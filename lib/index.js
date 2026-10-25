/**
 * neuron-explore — DSH 插件入口
 *
 * 三个接入面：
 *   1) 工具 neuron_explore（AI 调用）
 *   2) 服务 neuronExplore（其他插件调用）
 *   3) 设置区块（installSection，出现在 DSH 设置里）
 *
 * 任何一面初始化失败都只记日志，不影响宿主启动。
 */
import { makeEngine } from './engine.mjs';
import { makeHttpAsk } from './ask-http.mjs';

export const name = 'neuron-explore';
export const inject = [];

let z = null;
try { z = (await import('schemastery')).default; } catch { /* 宿主外出跑时没有 schemastery */ }

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

export const Config = z
  ? z.object({
    enabled: z.boolean().default(false).description('总开关；关掉后工具返回 NOT_CONFIGURED'),
    mode: z.string().default('fuse').description('single / agent / fuse'),
    workers: z.number().min(1).max(8).default(3).description('并行线程数（赛道数默认与之相同）'),
    rounds: z.number().min(1).max(6).default(2).description('轮数'),
    mid: z.number().min(100).default(1800).description('中途截断字数（single/fuse 生效）'),
    tail: z.number().min(50).default(900).description('交叉投递取对方末尾多少字'),
    budget: z.number().min(100).default(2500).description('每次调用的思考预算'),
    baseUrl: z.string().default('').description('OpenAI 兼容端点（必填）'),
    model: z.string().default('').description('模型名（必填）'),
    apiKeyEnv: z.string().default('').description('存放密钥的环境变量名（必填，密钥不落盘）'),
    judgeModel: z.string().default('').description('评审模型；空 = 同 model'),
    judgeBaseUrl: z.string().default('').description('评审端点；空 = 同 baseUrl'),
    judgeApiKeyEnv: z.string().default('').description('评审密钥环境变量；空 = 同 apiKeyEnv'),
  })
  : null;

function normalize(raw) {
  const c = { ...DEFAULTS, ...(raw || {}) };
  c.workers = Math.max(1, Math.min(8, Number(c.workers) || 3));
  c.rounds = Math.max(1, Math.min(6, Number(c.rounds) || 2));
  c.mid = Math.max(100, Number(c.mid) || 1800);
  c.tail = Math.max(50, Number(c.tail) || 900);
  c.budget = Math.max(100, Number(c.budget) || 2500);
  if (!['single', 'agent', 'fuse'].includes(c.mode)) c.mode = 'fuse';
  return c;
}

export function apply(ctx, rawConfig) {
  let config = normalize(rawConfig);
  const current = () => config;
  const keyOf = (n, c = config) => (n ? String(process.env[String(n)] || '') : '');

  function build(c) {
    const ask = makeHttpAsk({ baseUrl: c.baseUrl, apiKey: keyOf(c.apiKeyEnv, c), model: c.model });
    const jm = c.judgeModel || c.model;
    const judge = (jm === c.model && (c.judgeBaseUrl || '') === (c.baseUrl || ''))
      ? ask
      : makeHttpAsk({
        baseUrl: c.judgeBaseUrl || c.baseUrl,
        apiKey: keyOf(c.judgeApiKeyEnv || c.apiKeyEnv, c),
        model: jm,
      });
    return makeEngine({ ask, judge });
  }
  let engine = build(config);

  const configured = () => {
    const c = current();
    return !!(c.enabled && c.baseUrl && c.model && keyOf(c.apiKeyEnv, c));
  };

  async function run(args = {}) {
    const c = current();
    if (!c.enabled) return { ok: false, code: 'DISABLED', message: '插件未启用：请在 DSH 设置里打开。' };
    if (!c.baseUrl || !c.model || !keyOf(c.apiKeyEnv, c)) {
      return { ok: false, code: 'NOT_CONFIGURED',
        message: '未配置 AI：请在 DSH 设置 → 神经元探索 里填写 baseUrl、model、apiKeyEnv。' };
    }
    const mode = ['single', 'agent', 'fuse'].includes(args.mode) ? args.mode : c.mode;
    const opts = {
      prompt: String(args.prompt || ''),
      n: Math.max(1, Math.min(8, Number(args.n || args.workers || c.workers))),
      rounds: Math.max(1, Math.min(6, Number(args.rounds || c.rounds))),
      mid: Math.max(100, Number(args.mid || c.mid)),
      tail: Math.max(50, Number(args.tail || c.tail)),
      budget: Math.max(100, Number(args.budget || c.budget)),
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

  // ① 设置区块（出现在 DSH 设置里）
  try {
    ctx.inject(['settings'], (s) => {
      try {
        if (Config && typeof s.settings?.installSection === 'function') {
          s.settings.installSection(ctx, 'neuron-explore', Config, rawConfig ?? {}, {
            setSource: (source) => {
              const next = typeof source === 'function' ? source() : source;
              if (next && typeof next === 'object') { config = normalize(next); engine = build(config); }
            },
            onChange: (next) => {
              if (next && typeof next === 'object') { config = normalize(next); engine = build(config); }
            },
          });
        }
      } catch (e) { try { ctx.logger?.warn?.('neuron-explore: settings ' + String(e.message || e)); } catch {} }
    });
  } catch (e) { /* 无 settings 服务 */ }

  // ② 工具
  let registered = false;
  try {
    if (ctx.tools && typeof ctx.tools.register === 'function') {
      ctx.tools.register({
        name: 'neuron_explore',
        description: '多 AI 并行思考并互相注入，返回综合结果。适合单模型容易卡住的问题：mode=single（单思考注入）/ agent（每轮完整思考+打分换主）/ fuse（轮内截断+交叉投递）。',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '要解决的问题（必填）' },
            mode: { type: 'string', description: 'single | agent | fuse' },
            n: { type: 'number', description: '并行线程数（默认取设置）' },
            rounds: { type: 'number', description: '轮数（默认取设置）' },
          },
          required: ['prompt'],
        },
        timeoutMs: 900000,
        isConcurrencySafe: () => false,
        async execute(args) { return run(args || {}); },
      });
      registered = true;
    }
  } catch (e) { try { ctx.logger?.warn?.('neuron-explore: tools ' + String(e.message || e)); } catch {} }

  // ③ 服务
  try {
    ctx.provide('neuronExplore', {
      run,
      status: () => ({ enabled: current().enabled, configured: configured(), mode: current().mode,
        workers: current().workers, mid: current().mid, tail: current().tail, tool: registered }),
      config: () => ({ ...current() }),
    });
  } catch { /* 名字冲突 */ }

  try {
    ctx.logger?.info?.('neuron-explore: tool=' + registered + ' settings=' + !!Config
      + ' mode=' + current().mode + ' workers=' + current().workers);
  } catch { /* ignore */ }
}

export const META = { DEFAULTS };
