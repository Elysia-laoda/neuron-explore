#!/usr/bin/env node
// cli.mjs — 通用入口
import { makeEngine } from './lib/engine.mjs';
import { makeHttpAsk } from './lib/ask-http.mjs';

const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : ['_', a];
}));

const baseUrl = String(argv.baseUrl ?? process.env.NEURON_BASE_URL ?? '');
const model = String(argv.model ?? process.env.NEURON_MODEL ?? '');
const keyEnv = String(argv.apiKeyEnv ?? 'NEURON_KEY');
const apiKey = String(process.env[keyEnv] ?? '');
const judgeModel = String(argv.judgeModel ?? model);
const prompt = String(argv.prompt ?? '');

if (!baseUrl || !model || !apiKey) {
  console.error(JSON.stringify({
    ok: false, code: 'NOT_CONFIGURED',
    message: '未配置 AI。至少需要 baseUrl、model、apiKeyEnv（环境变量名）。',
    example: 'node cli.mjs --baseUrl=https://xxx/compatible-mode/v1 --model=xx --apiKeyEnv=NEURON_KEY --mode=fuse --prompt="..."',
  }));
  process.exit(2);
}
if (!prompt) { console.error(JSON.stringify({ ok: false, code: 'NO_PROMPT' })); process.exit(2); }

const ask = makeHttpAsk({ baseUrl, apiKey, model });
const judge = judgeModel === model ? ask : makeHttpAsk({ baseUrl: String(argv.judgeBaseUrl ?? baseUrl), apiKey, model: judgeModel });
const eng = makeEngine({ ask, judge });

const mode = String(argv.mode ?? 'fuse');
const opts = {
  prompt,
  n: Number(argv.n ?? argv.workers ?? 3),
  rounds: Number(argv.rounds ?? 2),
  mid: Number(argv.mid ?? 1800),
  tail: Number(argv.tail ?? 900),
  budget: Number(argv.budget ?? 2500),
};
const t0 = Date.now();
try {
  const fn = eng[mode] || eng.fuse;
  const r = await fn(opts);
  console.log(JSON.stringify({ ok: true, mode, seconds: Math.round((Date.now() - t0) / 1000), result: r }, null, 1));
} catch (e) {
  console.log(JSON.stringify({ ok: false, code: 'RUN_FAILED', message: String(e.message || e).slice(0, 300) }));
  process.exit(1);
}
