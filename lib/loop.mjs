// loop.mjs — 轮次驱动与终止策略（唯一实现，agent / fuse 共用）
//
// 收敛语义对齐传统单模型 agent（DSH core/agent-loop）：
//   主信号 = 模型/评审宣告「已完成」（对应工具的 concludesTurn）
//   兜底   = 还在动但实质不变（stalled）、轮数上限、时间上限
// rounds > 0 时退化为固定轮数，仅供调试。
export function makeRoundLoop({ rounds = 0, maxRounds = 30, maxMinutes = 20, noProgress = 3, doneRounds = 2, now = () => Date.now() } = {}) {
  const t0 = now();
  let r = 0, doneStreak = 0, same = 0, prevSig = null;
  let stopReason = rounds > 0 ? 'fixed-rounds' : 'auto';

  return {
    get round() { return r; },
    get stopReason() { return stopReason; },
    /** 还能不能再跑一轮；返回 false 时 stopReason 已确定。 */
    more() {
      if (rounds > 0) return r < rounds;
      if (r >= maxRounds) { stopReason = 'maxRounds'; return false; }
      if (now() - t0 >= maxMinutes * 60000) { stopReason = 'timeout'; return false; }
      return true;
    },
    /** 进入下一轮。 */
    begin() { r += 1; return r; },
    /**
     * 一轮结束时判定是否收敛。
     * @param {{ mainDone?: boolean, scores?: unknown, topText?: string }} round
     * @returns {{ stop: boolean, reason?: string }}
     */
    end({ mainDone = false, scores = null, topText = '' } = {}) {
      if (rounds > 0) return { stop: false };
      if (mainDone) doneStreak += 1; else doneStreak = 0;
      if (doneStreak >= doneRounds) { stopReason = 'model-done'; return { stop: true, reason: stopReason }; }
      const text = topText || '';
      const sig = JSON.stringify(scores) + '|' + text.length + '|' + text.slice(0, 160) + '|' + text.slice(-160);
      if (sig === prevSig) same += 1; else { same = 0; prevSig = sig; }
      if (same >= noProgress) { stopReason = 'stalled'; return { stop: true, reason: stopReason }; }
      return { stop: false };
    },
  };
}
