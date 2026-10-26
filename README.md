# 神经元探索 · neuron-explore

多路 AI 并行思考，再用它们的结果替代（或辅助）单模型思考。
一个引擎，三种形态，按"你要把它挂在哪儿"分：

| 形态 | 是什么 | 适合 |
|---|---|---|
| **通用插件版** | 一个不带界面的包：CLI + 可 import 的库 | 任何 agent 框架 / 脚本 / 其他语言的宿主 |
| **三模式版** | 引擎内部的三种思考方式（single / agent / fuse） | 选型与研究：不同任务的收益差别很大 |
| **DSH 插件版** | DeepSeek Harness 插件：注册成模型 provider | 在 DSH 里用，**选中即替代单思考** |

三者共用同一份引擎（`lib/engine.mjs`）和同一套收敛策略（`lib/loop.mjs`）。

---

## 一、通用插件版（CLI / 库）

不依赖任何宿主，也不预设 AI——**必须自己配**，不配就返回 `NOT_CONFIGURED`。

    node cli.mjs --baseUrl=https://xxx/v1 --model=deepseek-v4.1-flash \
                 --apiKeyEnv=NEURON_KEY --mode=agent --prompt="你的题目"

| 参数 | 默认 | 含义 |
|---|---|---|
| `--baseUrl` / `--model` / `--apiKeyEnv` | 空 | OpenAI 兼容端点 / 模型名 / **密钥所在环境变量名**（密钥不落盘） |
| `--mode` | agent | single / agent / fuse |
| `--n` | 3 | 并行线程数 |
| `--rounds` | 0 | 0 = 跑到收敛；>0 = 固定轮数（调试用） |
| `--budget` | 0 | 思考预算，0 = 不限 |
| `--mid` / `--tail` | 1800 / 900 | 仅在 fuse 模式生效 |

作为库：

    import { makeEngine } from './lib/engine.mjs';
    import { makeHttpAsk } from './lib/ask-http.mjs';

    const ask = makeHttpAsk({ baseUrl, apiKey, model });
    const eng = makeEngine({ ask, judge: ask, onProgress: (p) => render(p) });
    const r = await eng.agent({ prompt, n: 3, rounds: 0 });
    // r.answer  r.log  r.rounds  r.stopReason

`onProgress` 每轮回调一次，用来做进度显示。

---

## 二、三模式版（引擎的三种思考方式）

| 模式 | 做法 | 前提 | 速度 |
|---|---|---|---|
| `agent` **（推荐）** | 每轮：各路完整思考 → 评审打分 → 换主 → 互相注入 | 所有模型 | 基准 |
| `fuse` | 轮内：截断 → 交叉投递对方末尾 → 续写 → 打分换主 | **需断点续写** | 比 agent 慢 1.5–2.2× |
| `single` | 一个线程边想边被塞入别人的片段 | **需断点续写** | 最快，但**无工具通道** |

**模型兼容性（实测，非推测）**：真正能从断点续写的是 `deepseek-v4.1-flash` 与 `glm-5.3`；
qwen 全系、kimi-k2.6、glm-5.2 / 5.3-prime、deepseek-v4-pro 被截断后会**复述题目重新起跑**——
这些模型只用 `agent`。

`single` 有个结构性限制：它不调用任何工具，无法中途取证。只适合纯思辨题。
需要查证、读文件、跑代码的任务一律用 `agent`。

「断点续写」为什么只对部分模型成立、以及各模型 »thinking_budget` 的实际软上限，见 `HANDOVER.md`。

---

## 三、DSH 插件版

装进 DeepSeek Harness 之后，有四个接入面：

| 接入面 | 是什么 |
|---|---|
| **模型 provider**（主用法） | 模型选择器里多一项「神经元探索」。**选中它，DSH 每一轮对话都由多路引擎产出** |
| 设置页 | 总开关 / 模式 / 并行数 / 后端模型 / 收敛参数 |
| 工具 `neuron_explore` | 让 agent 在需要时显式调用一次多路思考 |
| 对话面板 | 输入框上方实时显示主模型的逐轮思考 |

### 它怎么替代单模型

    ┌─ 阶段一（本插件）  多路引擎思考 → 写进 reasoning 通道（只显示主模型）
    └─ 阶段二（后端模型）原样带上 messages + tools + 系统提示，产出真正的助手回合
                        工具调用、正文、finish 全部逐块转发

也就是说：**思考被多路替换，执行仍然由真正的模型带着工具完成**。
这保证了工具调用、并行工具、工具循环都不受影响。

### 配置

设置页只有 6 项：

| 设置 | 说明 |
|---|---|
| **开启多路思考（替代模型回复）** | 总开关：勾上把 DSH 默认模型切成 neuron，取消则恢复原模型 |
| 模式 | agent / fuse |
| 并行数 | 开几路（默认 3） |
| 后端模型 | `provider/model`，多路思考背后真正干活的模型 |
| 卡住判定轮 | 连续多少轮无变化判定收敛（默认 3） |
| 总时长上限 | 分钟，0 = 不限 |

**后端模型不能填 `neuron` 自己**（会自我递归），插件会拒绝并提示。

### 实测（Win11-Lab / deepseek-flash）

| 场景 | 结果 |
|---|---|
| 计数题（agent，3 路） | 173 秒收敛（`model-done`），答案 44 |
| 同一题（fuse，3 路） | 264–381 秒收敛，答案 44，**分区方式不同**（独立佐证） |
| 端到端 adapter | `chunks=66`，思考 5761 字，正文干净 |

---

## 收敛方式（对齐传统单模型 agent）

DSH 的单模型 agent 不数轮数，只在两种语义信号下结束
（`core/agent-loop/src/agent.ts:547-555`）：

1. 模型不再调用工具 → 它说完了；
2. 某个工具返回 `concludesTurn` → 执行方宣告收工。

本引擎沿用同一套：

| 信号 | 触发条件 | `stopReason` |
|---|---|---|
| **主信号** | 评审连续 2 轮给主模型 `DONE=1` | `model-done` |
| 兜底 | 分数与产出连续 `noProgress` 轮无变化 | `stalled` |
| 硬上限 | 超过 `maxRounds` | `maxRounds` |
| 硬上限 | 超过 `maxMinutes` | `timeout` |
| 调试 | `rounds > 0` | `fixed-rounds` |

默认三项上限全为 **0 = 不限**，只由语义信号结束。策略在 `lib/loop.mjs`，
`npm test` 可离线验证全部判定（13 项，不调模型）。

---

## 安装

通用版：直接拷目录，`node cli.mjs` 即可，无需依赖。

DSH 版：

    # 1) 放进档案
    Expand-Archive neuron-explore.zip -DestinationPath $env:USERPROFILE\.dsh\profiles\<profile>\node_modules\neuron-explore
    # 2) 档案的 cordis.patch.yml 追加
    - insert:
        - id: neuron-explore
          name: 'neuron-explore'
          config:
            enabled: true
            backend: 'deepseek-official/deepseek-flash'
    # 3) 重启 DSH

## 已知边界

- `fuse` 的 HTTP 适配器是**事后截断**（拿完整回答再切），不是真正的流式中断。
- 评审靠行格式解析（`A|85|短板|0/1`），解析失败该轮评分为空，不会中断。
- 参数调优的天花板：重复实验显示 mid / tail / n 的效应**低于温度 1.0 的采样噪声**，别指望微调翻盘。
- 多路思考 = 3–5 倍时延与成本。日常闲聊建议关掉总开关。

## 许可

MIT。见 `LICENSE`；维护与排障见 `HANDOVER.md`。
