import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoundLoop } from '../lib/loop.mjs';

test('固定轮数：rounds>0 时跑满就停', () => {
  const L = makeRoundLoop({ rounds: 3 });
  let n = 0;
  while (L.more()) { L.begin(); L.end({ mainDone: false }); n += 1; }
  assert.equal(n, 3);
  assert.equal(L.stopReason, 'fixed-rounds');
});

test('主信号：评审连续两轮宣告完成就停', () => {
  const L = makeRoundLoop({ rounds: 0, maxRounds: 50 });
  let n = 0;
  while (L.more()) {
    L.begin(); n += 1;
    const { stop } = L.end({ mainDone: n >= 2, scores: [n], topText: 'x' + n });
    if (stop) break;
  }
  assert.equal(n, 3);              // 第 2、3 轮连续 done
  assert.equal(L.stopReason, 'model-done');
});

test('兜底：分数与产出都不变，连续 noProgress 轮判 stalled', () => {
  const L = makeRoundLoop({ rounds: 0, maxRounds: 50, noProgress: 3 });
  let n = 0;
  while (L.more()) {
    L.begin(); n += 1;
    if (L.end({ mainDone: false, scores: [80], topText: '同一段话' }).stop) break;
  }
  assert.equal(L.stopReason, 'stalled');
  assert.ok(n >= 4, 'same 从第 2 轮开始累积，应在第 4 轮停，实际 ' + n);
});

test('换措辞但实质不变：不会永远跑（靠 stalled 兜底）', () => {
  const L = makeRoundLoop({ rounds: 0, maxRounds: 50, noProgress: 3 });
  let n = 0;
  while (L.more()) {
    L.begin(); n += 1;
    // 每轮头尾文字都在变，但分数恒定
    if (L.end({ mainDone: false, scores: [80], topText: '措辞' + n + '结尾' + n }).stop) break;
  }
  assert.ok(n <= 51, '必须停下来');
});

test('硬上限：永不变化的信号也会被 maxRounds 截断', () => {
  const L = makeRoundLoop({ rounds: 0, maxRounds: 3, noProgress: 99 });
  let n = 0;
  while (L.more()) { L.begin(); n += 1; L.end({ mainDone: false, scores: [n], topText: 'y' + n }); }
  assert.equal(n, 3);
  assert.equal(L.stopReason, 'maxRounds');
});
