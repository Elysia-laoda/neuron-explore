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
import { makeHostAsk } from './ask-llm.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STATE_FILE = join(homedir(), '.dsh', 'neuron-explore.json');
const PUBLIC_KEYS = ['enabled', 'mode', 'workers', 'rounds', 'maxRounds', 'maxMinutes', 'noProgress', 'mid', 'tail', 'budget', 'ais', 'allowInSubagent',
  'baseUrl', 'model', 'apiKeyEnv', 'judgeModel', 'judgeBaseUrl', 'judgeApiKeyEnv'];
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveState(next) {
  try {
    mkdirSync(join(homedir(), '.dsh'), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
    return true;
  } catch (e) { console.error('[neuron-explore] save failed: ' + String(e.message || e)); return false; }
}

try { console.error('[neuron-explore] module imported at ' + new Date().toISOString()); } catch {}

export const name = 'neuron-explore';
export const inject = ['tools'];

let z = null;
try { z = (await import('schemastery')).default; } catch (e) { console.error('[neuron-explore] schemastery missing: ' + String(e.message || e)); }
try { console.error('[neuron-explore] schemastery=' + (z ? 'ok' : 'missing')); } catch {}

const DEFAULTS = {
  enabled: false,
  mode: 'agent',
  workers: 3,
  rounds: 0,
  maxRounds: 0,
  maxMinutes: 0,
  noProgress: 3,
  mid: 1800,
  tail: 900,
  budget: 0,
  ais: [],
  allowInSubagent: false,
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
    mode: z.string().default('agent').description('agent（推荐）/ fuse（更慢但更充分）/ single（仅纯推理，不能用工具）'),
    workers: z.number().min(1).max(8).default(3).description('并行线程数（赛道数默认与之相同）'),
    rounds: z.number().min(0).max(50).default(0).description('轮数；0 = 跑到收敛（调试时才填固定值）'),
    maxRounds: z.number().min(0).max(500).default(0).description('轮数硬上限；0 = 不限'),
    maxMinutes: z.number().min(0).max(1440).default(0).description('整轮任务的总时长上限（分钟）；0 = 不限'),
    noProgress: z.number().min(1).max(10).default(3).description('连续多少轮无变化判定为收敛'),
    mid: z.number().min(100).default(1800).description('中途截断字数（single/fuse 生效）'),
    tail: z.number().min(50).default(900).description('交叉投递取对方末尾多少字'),
    budget: z.number().min(0).default(0).description('每次调用的思考预算；0 = 不限（不发送 thinking_budget）'),
    ais: z.array(z.object({
      name: z.string().default(''),
      baseUrl: z.string().default(''),
      model: z.string().default(''),
      apiKeyEnv: z.string().default(''),
    })).default([]).description('工作 AI 列表：每行一个，线程按顺序轮流使用；留空则用 DSH 当前模型'),
    allowInSubagent: z.boolean().default(false).description('是否允许子代理调用（默认关闭）'),
    baseUrl: z.string().default('').description('兼容旧配置：单 AI 端点'),
    model: z.string().default('').description('模型名（必填）'),
    apiKeyEnv: z.string().default('').description('存放密钥的环境变量名（必填，密钥不落盘）'),
    judgeModel: z.string().default('').description('评审模型；空 = 同 model'),
    judgeBaseUrl: z.string().default('').description('评审端点；空 = 同 baseUrl'),
    judgeApiKeyEnv: z.string().default('').description('评审密钥环境变量；空 = 同 apiKeyEnv'),
  })
  : null;

// 判断这次调用是否来自子代理：DSH 的工具执行上下文里可能带 agent/session 信息，
// 这里对已知字段做保守探测，并在首次命中时打印一次字段名便于校准。
let subagentProbeLogged = false;
function isSubagentCall(exec) {
  try {
    if (!exec) return false;
    const a = exec.agent || {};
    const hit = Number(a.depth) > 0 || a.parent || a.parentSessionId || a.subagent === true
      || exec.subagent === true || Number(exec.depth) > 0 || exec.parentSessionId;
    if (hit && !subagentProbeLogged) {
      subagentProbeLogged = true;
      try { console.error('[neuron-explore] subagent detected; exec keys=' + Object.keys(exec).join(',') + ' agent keys=' + Object.keys(a).join(',')); } catch {}
    }
    return !!hit;
  } catch { return false; }
}

function normalize(raw) {
  const c = { ...DEFAULTS, ...(raw || {}) };
  c.workers = Math.max(1, Math.min(8, Number(c.workers) || 3));
  c.rounds = Math.max(0, Math.min(50, Number(c.rounds) || 0));
  c.maxRounds = Math.max(0, Math.min(500, Number(c.maxRounds) || 0));
  c.maxMinutes = Math.max(0, Math.min(1440, Number(c.maxMinutes) || 0));
  c.noProgress = Math.max(1, Math.min(10, Number(c.noProgress) || 3));
  c.mid = Math.max(100, Number(c.mid) || 1800);
  c.tail = Math.max(50, Number(c.tail) || 900);
  c.budget = Math.max(0, Number(c.budget) || 0);
  c.ais = Array.isArray(c.ais) ? c.ais.filter((e) => e && typeof e === 'object').map((e) => ({
    name: String(e.name || '').slice(0, 40),
    baseUrl: String(e.baseUrl || '').slice(0, 300),
    model: String(e.model || '').slice(0, 120),
    apiKeyEnv: String(e.apiKeyEnv || '').slice(0, 120),
  })).slice(0, 8) : [];
  c.allowInSubagent = c.allowInSubagent === true;
  if (!['single', 'agent', 'fuse'].includes(c.mode)) c.mode = 'agent';
  return c;
}

export function apply(ctx, rawConfig) {
  try { console.error('[neuron-explore] apply() called, config=' + JSON.stringify(rawConfig || {})); } catch {}
  let config = normalize({ ...rawConfig, ...loadState() });
  const current = () => config;
  const keyOf = (n, c = config) => (n ? String(process.env[String(n)] || '') : '');

  // 宿主 LLM 服务：有它就不需要用户填任何 AI 配置
  const hostAsk = (() => { try { return makeHostAsk(ctx); } catch (e) { console.error('[neuron-explore] host llm: ' + String(e.message || e)); return null; } })();
  if (hostAsk) console.error('[neuron-explore] host llm available — 零配置模式');

  // 一个 AI 条目 → 一个 ask 函数；条目留空则回落到宿主模型
  const hostCache = new Map();
  function hostWith(model, provider) {
    const key = (provider || '') + '|' + (model || '');
    if (!hostCache.has(key)) hostCache.set(key, makeHostAsk(ctx, { model, provider }));
    return hostCache.get(key);
  }

  function askOf(entry, c) {
    if (!entry || (!entry.baseUrl && !entry.model)) return hostAsk;
    // 只填模型名：走宿主 provider，换个模型（不需要另配密钥）
    if (!entry.baseUrl && entry.model) return hostWith(entry.model, entry.provider || '') || hostAsk;
    return makeHttpAsk({
      baseUrl: entry.baseUrl || c.baseUrl,
      apiKey: keyOf(entry.apiKeyEnv || c.apiKeyEnv, c),
      model: entry.model || c.model,
    });
  }

  function build(c) {
    // 工作 AI 列表：空列表 = 只用宿主模型（或单条 baseUrl 兼容旧配置）
    const list = Array.isArray(c.ais) && c.ais.length > 0
      ? c.ais
      : (c.baseUrl && c.model ? [{ baseUrl: c.baseUrl, model: c.model, apiKeyEnv: c.apiKeyEnv }] : []);
    const asks = list.map((e) => askOf(e, c)).filter(Boolean);
    const ask = asks[0] || hostAsk;
    const judgeExplicit = !!(c.judgeBaseUrl || c.judgeModel);
    const judge = !judgeExplicit || !ask ? ask : makeHttpAsk({
      baseUrl: c.judgeBaseUrl || c.baseUrl,
      apiKey: keyOf(c.judgeApiKeyEnv || c.apiKeyEnv, c),
      model: c.judgeModel || c.model,
    });
    return makeEngine({ ask, asks: asks.length > 1 ? asks : undefined, judge });
  }
  let engine = build(config);

  const configured = () => {
    const c = current();
    if (!c.enabled) return false;
    const list = Array.isArray(c.ais) ? c.ais : [];
    if (list.length > 0) {
      // 有 baseUrl 的条目要自己的密钥；没 baseUrl 的走宿主 provider，不需要密钥
      return list.some((e) => (e.baseUrl ? !!keyOf(e.apiKeyEnv || c.apiKeyEnv, c) : !!hostAsk));
    }
    if (c.baseUrl && c.model) return !!keyOf(c.apiKeyEnv, c);
    return !!hostAsk;                      // 零配置：宿主模型可用即可
  };

  async function run(args = {}) {
    const c = current();
    if (!c.enabled) return { ok: false, code: 'DISABLED', message: '插件未启用：请在 DSH 设置里打开。' };
    if (!configured()) {
      return { ok: false, code: 'NOT_CONFIGURED',
        message: '既没有 DSH 默认模型，也没有填写 baseUrl / model / apiKeyEnv。' };
    }
    const mode = ['single', 'agent', 'fuse'].includes(args.mode) ? args.mode : c.mode;
    const opts = {
      prompt: String(args.prompt || ''),
      n: Math.max(1, Math.min(8, Number(args.n || args.workers || c.workers))),
      rounds: Math.max(0, Math.min(50, Number(args.rounds === undefined ? c.rounds : args.rounds))),
      maxRounds: c.maxRounds ?? 0,
      maxMinutes: c.maxMinutes ?? 0,
      noProgress: c.noProgress ?? 3,
      mid: Math.max(100, Number(args.mid || c.mid)),
      tail: Math.max(50, Number(args.tail || c.tail)),
      budget: Math.max(0, Number(args.budget === undefined ? c.budget : args.budget)),
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
        console.error('[neuron-explore] settings inject fired; Config=' + (Config ? 'ok' : 'null') + ' installSection=' + (typeof s.settings?.installSection));
        if (Config && typeof s.settings?.installSection === 'function') {
          try { console.error('[neuron-explore] installSection invoked, namespace=neuron-explore'); } catch {}
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
      } catch (e) { try { console.error('[neuron-explore] settings error: ' + String(e.message || e)); } catch {} }
    });
  } catch (e) { /* 无 settings 服务 */ }

  // ② 工具（inject 已声明，可直接取 ctx.tools）
  let registered = false;
  try {
    {
      const toolsCtx = ctx;
      try {
    if (toolsCtx.tools && typeof toolsCtx.tools.register === 'function') {
      ctx.tools.register({
        name: 'neuron_explore',
        description: '多 AI 并行思考并互相注入，返回综合结果。适合单模型容易卡住、或需要多路线互相校验的问题。'
          + 'mode=agent（默认推荐：每轮完整思考+评审打分+换主+互相注入）；'
          + 'mode=fuse（轮内截断→交叉投递→续写，收益可能更高但更慢，且要求模型支持断点续写）；'
          + 'mode=single 仅供纯推理/对话使用——它不调用任何工具，也不能中途取证，一般任务不要用。',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '要解决的问题（必填）' },
            mode: { type: 'string', description: 'agent（推荐）| fuse | single（仅纯推理）' },
            n: { type: 'number', description: '并行线程数（默认取设置）' },
            rounds: { type: 'number', description: '轮数（默认取设置）' },
          },
          required: ['prompt'],
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              mode: { type: 'string' },
              seconds: { type: 'number' },
              code: { type: 'string' },
              message: { type: 'string' },
            },
          },
          render: (_args, value) => {
            const v = value || {};
            if (v.ok) {
              const r = v.result || {};
              const lines = ['神经元探索完成（mode=' + v.mode + '，' + v.seconds + 's）'];
              if (Array.isArray(r.log)) {
                for (const row of r.log) lines.push('第' + row.round + '轮 分数=' + JSON.stringify(row.scores) + ' 主=' + row.mainAfter);
              }
              if (Array.isArray(r.traces)) lines.push('线程产出：' + r.traces.map((t) => t.worker + ':' + t.chars).join(' '));
              return [{ type: 'text', text: lines.join(String.fromCharCode(10)) }];
            }
            return [{ type: 'text', text: '神经元探索未运行：' + (v.code || '') + ' ' + (v.message || '') }];
          },
        },
        timeoutMs: 4 * 60 * 60 * 1000,   // 默认不限时，这里只留一个极宽松的天花板
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          if (!current().allowInSubagent && isSubagentCall(exec)) {
            return { ok: false, code: 'DISABLED_IN_SUBAGENT',
              message: '子代理默认不能调用神经元探索。需要时请在设置里勾选「允许子代理调用」。' };
          }
          return run(args || {});
        },
      });
      registered = true;
    }
      } catch (e) { try { console.error('[neuron-explore] tools error: ' + String(e.message || e)); } catch {} }
      try { console.error('[neuron-explore] tool registered=' + registered); } catch {}
    }
  } catch (e) { try { console.error('[neuron-explore] tools outer error: ' + String(e.message || e)); } catch {} }

  // ②b 配置读写路由（客户端设置面板用）
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (wc) => {
        try {
          const route = {
            name: 'neuron-explore-config',
            kind: 'exact',
            path: '/neuron-explore/config',
            handler: async (req, res) => {
              const send = (status, body) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(body));
              };
              const origin = req.headers.origin;
              const originOk = !origin || origin.indexOf('://127.0.0.1') > 0 || origin.indexOf('://localhost') > 0;
              if (!originOk) { send(403, { error: 'origin' }); return; }
              if (req.method === 'GET') {
                const c = current();
                const pub = {};
                for (const k of PUBLIC_KEYS) pub[k] = c[k];
                send(200, pub);
                return;
              }
              if (req.method !== 'POST') { res.writeHead(405).end(); return; }
              try {
                const chunks = [];
                let total = 0;
                for await (const ch of req) {
                  total += ch.length;
                  if (total > 64 * 1024) { send(413, { error: 'too large' }); return; }
                  chunks.push(ch);
                }
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                const next = { ...loadState() };
                for (const k of PUBLIC_KEYS) if (body[k] !== undefined) next[k] = body[k];
                saveState(next);
                config = normalize({ ...rawConfig, ...next });
                engine = build(config);
                send(200, { ok: true });
              } catch (e) { send(400, { error: String(e.message || e) }); }
            },
          };
          const runRoute = {
            name: 'neuron-explore-run',
            kind: 'exact',
            path: '/neuron-explore/run',
            handler: async (req, res) => {
              const send = (status, body) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(body));
              };
              if (req.method !== 'POST') { res.writeHead(405).end(); return; }
              try {
                const chunks = [];
                for await (const ch of req) chunks.push(ch);
                const args = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
                const out = await run(args);
                send(out.ok ? 200 : 400, out);
              } catch (e) { send(500, { ok: false, error: String(e.message || e) }); }
            },
          };
          ctx.effect(() => wc.webServer.register(route), 'neuron-explore: settings route');
          ctx.effect(() => wc.webServer.register(runRoute), 'neuron-explore: run route');
          console.error('[neuron-explore] config route registered + run route');
        } catch (e) { console.error('[neuron-explore] route error: ' + String(e.message || e)); }
      });
    }
  } catch (e) { console.error('[neuron-explore] webServer inject error: ' + String(e.message || e)); }

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
