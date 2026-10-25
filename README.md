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
