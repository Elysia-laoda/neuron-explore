# 神经元探索 · neuron-explore

多 AI 并行思考 + 互相注入。三种模式：

| 模式 | 形态 | 适合 |
|---|---|---|
| `single` | 单思考注入：一个线程边想边被中途塞入别人的片段 | 断点续写型模型 |
| `agent` | agent 注入：每轮完整思考 → 评审打分 → 换主 → 注入 | 所有模型 |
| `fuse` | 融合式：轮内「截断 → 交叉投递 → 续写」，再打分换主 | 断点续写型模型 |

**模型兼容性**：`single` 与 `fuse` 依赖**断点续写**（被截断后能接着上文写）。实测支持：**deepseek-v4.1-flash**、**glm-5.3**；qwen 系、kimi-k2.6、glm-5.2 / 5.3-prime、deepseek-v4-pro 被截断后会复述题目重新起跑，**请只用 agent 模式**。

## 配置

通用版**不预设任何 AI**，必须自己配（不配就返回 `NOT_CONFIGURED`）：

| 参数 | 说明 |
|---|---|
| `baseUrl` | OpenAI 兼容端点，如 `https://xxx/compatible-mode/v1` |
| `model` | 模型名 |
| `apiKeyEnv` | 存放密钥的**环境变量名**（密钥不落盘） |

## 用法

    node cli.mjs --baseUrl=... --model=deepseek-v4.1-flash --apiKeyEnv=NEURON_KEY --mode=fuse --prompt="你的题目"

| 参数 | 默认 | 含义 |
|---|---|---|
| `--mode` | fuse | single / agent / fuse |
| `--n` | 3 | 并行线程数（赛道数默认与之相同） |
| `--rounds` | 2 | 轮数 |
| `--mid` | 1800 | 中途截断字数 |
| `--tail` | 900 | 交叉投递取对方末尾多少字 |
| `--budget` | 2500 | 每次调用的思考预算 |

输出 JSON：`{ ok, mode, seconds, result }`。

## 作为库使用

    import { makeEngine } from './lib/engine.mjs';
    import { makeHttpAsk } from './lib/ask-http.mjs';
    const ask = makeHttpAsk({ baseUrl, apiKey, model });
    const eng = makeEngine({ ask, judge: ask });
    await eng.fuse({ prompt, n: 3, mid: 1800, tail: 900, rounds: 2 });

## 已知边界

- 无 UI，纯 AI 侧可调。
- HTTP 适配器里的 `mid` 是**事后截断**（拿完整回答再切），不是真正的流式中断，行为接近但不完全等价。
- 评审靠行格式解析（`A|85|短板`），解析失败会让该轮评分为空，不中断运行。
- 参数调优的结论：mid=1800 / tail=900 / n=3 是默认值，但重复实验显示**参数效应低于采样噪声**，不要指望微调能翻盘。

## 收敛方式（对齐传统单模型 agent）

DSH 的单模型 agent 不数轮数，它在两种**语义信号**下结束这一轮：

1. 模型不再调用任何工具 → 它说完了；
2. 某个工具返回 \`concludesTurn\` → 执行方宣告收工。

神经元探索沿用同一套：

| 信号 | 触发条件 | stopReason |
|---|---|---|
| **主信号** | 评审连续 2 轮给主模型打 \`DONE=1\`（答案已完整） | \`model-done\` |
| 兜底 | 分数与产出连续 \`noProgress\` 轮无变化（卡住） | \`stalled\` |
| 硬上限 | 超过 \`maxRounds\` | \`maxRounds\` |
| 硬上限 | 超过 \`maxMinutes\` | \`timeout\` |
| 调试 | \`rounds > 0\`，只跑固定轮数 | \`fixed-rounds\` |

默认 \`rounds = 0\`：跑到收敛为止。策略实现在 \`lib/loop.mjs\`，两种模式共用，\`node --test\` 可离线验证全部判定。

## 零配置（默认）

插件直接走宿主 LLM 服务：读取 DSH 里已配置的默认模型（\`agentDefaultModel\`）并调用
\`ctx.get('llm').stream(...)\`，**不需要填端点、模型或密钥**。只有想强制指定别的模型时，
才在设置里填 \`baseUrl\` / \`model\` / \`apiKeyEnv\`（三项都填才会覆盖宿主模型）。

实测（Win11-Lab 虚机、宿主模型 deepseek-flash）：

| 项目 | 结果 |
|---|---|
| 配置 | 零配置，直接可用 |
| 收敛 | \`stopReason=model-done\`，第 3 轮自行停止 |
| 耗时 | 173 秒 |
| 答案 | 44（36+8 分类，附防漏说明） |

\`POST /neuron-explore/run\` 可直接试跑：\`{"prompt":"...","mode":"agent","n":3,"rounds":0}\`。


## 模式选择

| 模式 | 适用 | 注意 |
|---|---|---|
| **agent**（推荐） | 绝大多数任务 | 每轮完整思考 + 评审打分 + 换主 + 互相注入 |
| fuse | 想要更充分的交叉，且模型支持断点续写 | 每轮多一次请求，实测比 agent 慢 1.5–2.2 倍 |
| single | **仅纯推理/对话** | 不调用任何工具，无法中途取证；一般任务不要用 |

`single` 保留只是因为它在纯思辨类问题上确实有效（历史上 69 秒解出计数题），但它在结构上就没有工具通道——需要查证、读文件、跑代码的任务一律用 agent。

## 子代理

工具注册在宿主的**全局工具表**上（`core/tools/src/index.ts:698` 的 `ToolRestriction` 只做「按作用域过滤」，不影响全局注册）。子代理是另一个会话作用域，默认继承父会话可见的全部工具，因此**子代理同样可以调用 `neuron_explore`**，除非它所在的 preset 配了排除该工具的 restriction。
