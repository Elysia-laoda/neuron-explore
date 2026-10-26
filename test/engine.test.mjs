import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine } from '../lib/engine.mjs';

const askThat = (text) => async () => ({ text });
const judgeSaying = (doneFlag) => async () => ({
  text: 'A|80|短板一|' + doneFlag + '\nB|70|短板二|' + doneFlag + '\nSITUATION|差别不大',
});

test('agent：评审宣告完成后收敛，不跑满轮数', async () => {
  const eng = makeEngine({ ask: askThat('思考内容'), judge: judgeSaying(1) });
  const r = await eng.agent({ prompt: 'q', n: 2, rounds: 0, maxRounds: 20 });
  assert.equal(r.stopReason, 'model-done');
  assert.equal(r.rounds, 2);
  assert.ok(r.answer.length > 0);
});

test('agent：评审永不宣告完成时不会无限跑（stalled 兜底）', async () => {
  const eng = makeEngine({ ask: askThat('一模一样的思考'), judge: judgeSaying(0) });
  const r = await eng.agent({ prompt: 'q', n: 2, rounds: 0, maxRounds: 20, noProgress: 2 });
  assert.ok(['stalled', 'maxRounds'].includes(r.stopReason), '实际 ' + r.stopReason);
  assert.ok(r.rounds < 20);
});

test('agent：固定轮数（调试）只跑指定轮', async () => {
  const eng = makeEngine({ ask: askThat('x'), judge: judgeSaying(0) });
  const r = await eng.agent({ prompt: 'q', n: 2, rounds: 3 });
  assert.equal(r.rounds, 3);
  assert.equal(r.stopReason, 'fixed-rounds');
});

test('fuse：同样按评审宣告收敛', async () => {
  const eng = makeEngine({ ask: askThat('思考'), judge: judgeSaying(1) });
  const r = await eng.fuse({ prompt: 'q', n: 2, rounds: 0, maxRounds: 20, mid: 100, tail: 50 });
  assert.equal(r.stopReason, 'model-done');
  assert.equal(r.rounds, 2);
  assert.equal(r.log[0].done.length, 2);
});
