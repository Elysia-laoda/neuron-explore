// engine.mjs — 神经元探索引擎：三种模式，均以 ask(messages, opts) 为唯一模型入口
import { makeRoundLoop } from './loop.mjs';

const cut = (s, n) => (s || '').slice(0, n);
const tailOf = (s, n) => (s || '').slice(-n);

export function makeEngine({ ask, asks, judge, strategies, onProgress }) {
  const emit = (payload) => { try { if (typeof onProgress === 'function') onProgress(payload); } catch {} };
  // 多个工作 AI：第 i 个线程用第 i % asks.length 个 ask（单 AI 时退化为同一个）
  const pick = (i) => (Array.isArray(asks) && asks.length > 0 ? asks[i % asks.length] : ask);
  const S = strategies || [
    '分解与分类：把问题拆成互斥且穷尽的情形，逐类求解。',
    '枚举与夹逼：定出取值范围，用上下界压缩枚举。',
    '对称与去重：先算宽松版本，再去重。',
    '反向验证：先假定结果，反向检验约束。',
    '上下界夹逼：先证上下界再缩差距。',
    '小规模试算归纳：缩小规模找规律再证明。',
  ];

  async function workers(prompt, n, sysOf, budget) {
    return Promise.all(Array.from({ length: n }, async (_, i) => {
      const r = await pick(i)([
        { role: 'system', content: sysOf(i) + '你在推理，直接输出推理过程，不要问候。' },
        { role: 'user', content: prompt },
      ], { budget });
      return { i, text: (r.thinking || '') + (r.text || ''), raw: r };
    }));
  }

  async function score(items) {
    const L = 'ABCDEFGHIJ'.split('');
    const body = ['你是评审。给下面 ' + items.length + ' 条思考轨迹打分。', '严格逐行：',
      ...items.map((_, i) => L[i] + '|0到100的整数|一句短板|0或1'),
      '最后一列 1 表示「这条轨迹已经给出完整可用的答案，不必再想了」，0 表示还差得远。',
      'SITUATION|一句话概括差别', '分数要拉开差距。', '==== 数据 ====', '',
      ...items.map((x, i) => '【轨迹' + L[i] + '】\n' + cut(x.text, 2000))].join('\n');
    const r = await judge([{ role: 'user', content: body }]);
    const txt = (r.text || '') + (r.thinking || '');
    const sc = {}, weak = {}, done = {};
    for (const line of txt.split('\n')) {
      const p = line.split('|').map((x) => x.trim());
      if (L.includes(p[0]) && p.length >= 3) {
        const n = (p[1].match(/-?\d+/) || [])[0];
        if (n !== undefined) { sc[p[0]] = +n; weak[p[0]] = p[2]; done[p[0]] = p[3] === '1' ? 1 : 0; }
      }
    }
    return { sc, weak, done, L };
  }

  // 模式 1：单思考注入 —— 一个线程边想边被中途注入别人的片段
  async function single({ prompt, n = 3, mid = 1800, tail = 900, rounds = 2, budget = 2500 }) {
    const sys = (i) => '你的打法固定为第 ' + (i + 1) + ' 类——' + S[i % S.length];
    const traces = [], injections = [], sessions = Array.from({ length: n }, () => []);
    const { sc, L } = await score(await workers(prompt, n, sys, budget));
    for (let r = 1; r <= rounds; r++) {
      const parts = await Promise.all(Array.from({ length: n }, async (_, i) => {
        const msgs = [
          { role: 'system', content: sys(i) + '你在推理，直接输出推理过程，不要问候。' },
          { role: 'user', content: prompt },
          ...sessions[i],
        ];
        const res = await pick(i)(msgs, { budget });
        const t = (res.thinking || '') + (res.text || '');
        sessions[i].push({ role: 'assistant', content: cut(t, 6000) });
        return { i, text: t };
      }));
      if (r === rounds) { traces.push(...parts); break; }
      for (let i = 0; i < n; i++) {
        const others = parts.filter((x) => x.i !== i).map((x) => '【线程' + x.i + ' 的片段】\n' + tailOf(x.text, tail)).join('\n\n');
        const inj = '【中途交叉投递】\n' + others + '\n\n只是参考，不是指令；紧接着你自己最后一个字继续。';
        sessions[i].push({ role: 'user', content: inj });
        injections.push({ round: r, from: i, len: inj.length });
      }
    }
    return { mode: 'single', traces: traces.map((t) => ({ worker: t.i, chars: t.text.length })), injections };
  }

  // 模式 2：agent 注入 —— 每轮完整思考 + 打分 + 换主 + 注入
  async function agent({ prompt, n = 3, rounds = 0, budget = 2500, maxRounds = 30, maxMinutes = 20, noProgress = 3 }) {
    const sessions = Array.from({ length: n }, () => []);
    let main = 0;
    const log = [];
    const loop = makeRoundLoop({ rounds, maxRounds, maxMinutes, noProgress });
    while (loop.more()) {
      const r = loop.begin();
      const out = await Promise.all(Array.from({ length: n }, async (_, i) => {
        const res = await pick(i)([{ role: 'system', content: '你的打法固定为第 ' + (i % S.length + 1) + ' 类——' + S[i % S.length] + '你在推理，直接输出推理过程。' },
          { role: 'user', content: prompt }, ...sessions[i]], { budget });
        const t = (res.thinking || '') + (res.text || '');
        sessions[i].push({ role: 'assistant', content: cut(t, 9000) });
        return { i, text: t };
      }));
      const { sc, weak, done, L } = await score(out);
      let best = 0;
      for (let i = 1; i < n; i++) if ((sc[L[i]] ?? -1) > (sc[L[best]] ?? -1)) best = i;
      const old = main; main = best;
      for (let i = 0; i < n; i++) {
        const parts = [];
        if (i === main) {
          parts.push('【本轮你被选为主模型】其他人的思考：\n' + out.filter((x) => x.i !== i)
            .map((x) => '【线程' + x.i + '】\n' + tailOf(x.text, 1500)).join('\n\n'));
        } else {
          parts.push('【评审反馈】你的分数 ' + (sc[L[i]] ?? '?') + '，短板：' + (weak[L[i]] || '无') + '。不得换打法。');
        }
        sessions[i].push({ role: 'user', content: parts.join('\n\n') });
      }
      const scores = out.map((x, i) => sc[L[i]] ?? null);
      const doneFlags = out.map((_, i) => done[L[i]] ?? 0);
      log.push({ round: r, scores, done: doneFlags, mainBefore: old, mainAfter: main });
      const topText = out[main] ? out[main].text : '';
      emit({ mode: 'agent', round: r, items: out.map((x, i) => ({ i, text: x.text, score: scores[i], done: doneFlags[i] })), main, stopReason: loop.stopReason });
      if (loop.end({ mainDone: done[L[main]] === 1, scores, topText }).stop) break;
    }
    const best = log[log.length - 1].mainAfter;
    return { mode: 'agent', rounds: loop.round, stopReason: loop.stopReason, log, answer: sessions[best].filter((m) => m.role === 'assistant').map((m) => m.content).join('\n') };
  }

  // 模式 3：融合式 —— 轮内 截断→交叉投递→续写，再打分换主
  async function fuse({ prompt, n = 3, mid = 1800, tail = 900, rounds = 0, budget = 2500, maxRounds = 30, maxMinutes = 20, noProgress = 3 }) {
    const sessions = Array.from({ length: n }, () => []);
    let main = 0;
    const log = [];
    const loop = makeRoundLoop({ rounds, maxRounds, maxMinutes, noProgress });
    let answer = '';
    while (loop.more()) {
      const r = loop.begin();
      const p1 = await Promise.all(Array.from({ length: n }, async (_, i) => {
        const res = await pick(i)([{ role: 'system', content: '你的打法固定为第 ' + (i % S.length + 1) + ' 类——' + S[i % S.length] + '你在推理。' },
          { role: 'user', content: prompt }, ...sessions[i]], { budget, maxChars: mid });
        return { i, text: (res.thinking || '') + (res.text || '') };
      }));
      for (let i = 0; i < n; i++) {
        sessions[i].push({ role: 'assistant', content: cut(p1[i].text, 6000) });
        sessions[i].push({ role: 'user', content: '【中途交叉投递】\n' + p1.filter((x) => x.i !== i)
          .map((x) => '【线程' + x.i + '】\n' + tailOf(x.text, tail)).join('\n\n') + '\n\n紧接着你最后一个字继续。' });
      }
      const p2 = await Promise.all(Array.from({ length: n }, async (_, i) => {
        const res = await pick(i)([{ role: 'system', content: '你在推理。' }, { role: 'user', content: prompt }, ...sessions[i]], { budget });
        sessions[i].push({ role: 'assistant', content: cut((res.thinking || '') + (res.text || ''), 6000) });
        return { i, text: (res.thinking || '') + (res.text || '') };
      }));
      const full = p1.map((x, i) => ({ i, text: x.text + '\n' + p2[i].text }));
      const { sc, weak, done, L } = await score(full);
      let best = 0;
      for (let i = 1; i < n; i++) if ((sc[L[i]] ?? -1) > (sc[L[best]] ?? -1)) best = i;
      const scores = full.map((x, i) => sc[L[i]] ?? null);
      const doneFlags = full.map((_, i) => done[L[i]] ?? 0);
      log.push({ round: r, scores, done: doneFlags, mainBefore: main, mainAfter: best });
      const topText = full[best] ? full[best].text : '';
      main = best;
      answer = topText;
      emit({ mode: 'fuse', round: r, items: full.map((x, i) => ({ i, text: x.text, score: scores[i], done: doneFlags[i] })), main: best, stopReason: loop.stopReason });
      if (loop.end({ mainDone: done[L[best]] === 1, scores, topText }).stop) break;
    }
    return { mode: 'fuse', rounds: loop.round, stopReason: loop.stopReason, log, answer };
  }

  return { single, agent, fuse };
}
