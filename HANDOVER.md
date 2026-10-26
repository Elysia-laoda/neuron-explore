# 交接与维护 · neuron-explore

> 面向接手者：这份文档记录**为什么这样做**、**哪些结论是实测的**、**改的时候哪里会炸**。
> 产品形态与用法看 `README.md`，这里不重复。

## 1. 一句话定位

把"多个模型并行思考、互相注入、评审换主"做成一个可替换单模型思考的引擎。
三种落地形态（通用 CLI/库、三模式引擎、DSH 插件）共用 `lib/engine.mjs`。

## 2. 文件地图

| 文件 | 职责 | 改动风险 |
|---|---|---|
| `lib/engine.mjs` | 三种模式实现、评审打分、进度回调 | 高——核心语义都在这 |
| `lib/loop.mjs` | **唯一的**轮次驱动与终止策略（两模式共用） | 中——改这里所有模式一起变 |
| `lib/ask-http.mjs` | OpenAI 兼容 HTTP 适配（自带重试） | 低 |
| `lib/ask-llm.mjs` | 走 DSH 宿主 LLM 服务（零配置路径） | 中——递归防护在这 |
| `lib/adapter.mjs` | 把引擎伪装成 LLM provider | **高**——DSH 私有契约都在这 |
| `lib/index.js` | 插件入口：工具/服务/路由/钩子/设置/开关 | 高——一个语法错误整插件不加载 |
| `lib/client.js` | 浏览器端：设置页 + 对话面板 | 中——纯对象注册，报错在 console |
| `test/*.mjs` | 13 项离线测试，不调模型 | 改引擎必跑 |
| `cli.mjs` | 通用版命令行 | 低 |

## 3. DSH 私有契约（全部实测，别按直觉改）

### 3.1 注册成 provider 必须提供的成员

只注册 `stream` 是不够的，注册会**静默失败**或流永不被调用：

| 成员 | 不提供的后果 |
|---|---|
| `providerRetryPolicy()` | 直接抛 adapter.providerRetryPolicy is not a function |
| `prepareCall(provider, model, signal)` | **stream() 永远不会被调用**：只收到 1 个 chunk、内容全空 |
| `resolveModel()` 返回带 `reasoning.efforts` | 配置里的 reasoningEffort 会被判不支持 |
| efforts 每项含 `id` + `name` 且 id 唯一 | 选择器报 INVALID_MODEL_REASONING |

### 3.2 流块词汇（StreamChunk）

    block-start { index, blockType }
    text-delta / reasoning-delta { index, text }
    tool-call-delta { index, id, name?, argumentsDelta }
    block-end { index, block }
    usage { usage }
    finish { reason: { kind: 'stop' | 'tool-calls' | 'max-tokens' } }

正文块是 `{ type:'text', text }`，思考块是 `{ type:'reasoning', text }`。

### 3.3 消息来源标记（**最坑的一条**）

DSH 发给模型的 messages 里会混入**多条 user 角色**的合成消息：运行时快照、技能清单、记忆快照。
取"最后一条 user"会把它们当成用户问题——现象是模型回答"本轮没有任何题目内容"。

**正确做法**：只取 `source.kind === 'user'` 的那条（见 `adapter.mjs` 的 `lastUser`）。

### 3.4 其它

- 工具必须声明 `output: { schema, render }`，否则注册直接抛。
- `ctx.tools` 必须先在插件里 `export const inject = ['tools']` 才拿得到。
- 设置区块：0.2.1-rc.3 里**没有** `settings.installSection`（源码搜不到）。想出现在设置页只能写客户端插件。
- 工具表是全局的，`ToolRestriction` 只做按作用域过滤；子代理默认**能看到**工具。
- `agentDefaultModel.saveSelection({ provider, model })` 是切换默认模型的唯一正路。

## 4. 验证手册

### 4.1 离线（不需要模型）

    npm test

### 4.2 端到端（虚机里跑）

    Select-String $env:LOCALAPPDATA\dsh\server.log -Pattern 'adapter registered|tool registered'

    Invoke-RestMethod -Uri http://127.0.0.1:3080/neuron-explore/providers

    Invoke-RestMethod -Uri http://127.0.0.1:3080/neuron-explore/selftest -Method POST -ContentType application/json -Body '{"q":"3 个不同正整数相加等于 10，有多少种组合？只给数字。"}'

预期：`resolveError: null`、`text` 含正确答案。

### 4.3 界面

模型选择器（对话框里，不是设置页）应出现「神经元探索」一项；
设置页应有 6 项；输入框上方在运行期间出现实时面板。

## 5. 已知坑

1. **反斜杠转义**：长文本经 run_code 传给文件时，反斜杠 n 会变成真换行把 JS 字符串撕开。
   用 `String.raw` + 哨兵（本仓库文档里的占位符就是为此）。
2. **NUL 字节**：写文件时曾混入 NUL，之后 edit 工具报 binary file 拒绝编辑；用字节级替换清掉。
3. **改 `lib/index.js` 后一律先 node --check**：一个漏逗号会让整个插件不加载，
   而 DSH 的报错只有一句 failed to import。
4. **工具循环**：一旦出现 tool-call/tool-result，adapter 会跳过阶段一，否则每次工具返回都重跑 3 路。
5. **后端不能用自己**：backend 填 neuron 会无限递归，插件已拒绝。
6. **参数噪声**：温度 1.0 下单次对比无意义。曾经"提交率 3/3→2/3→0/3"的结论就是噪声。
   要比较参数，用温度 0.4 或连续指标。

## 6. 版本与回滚

- 当前发布：**v1.0.0**（首个定型版）。
- 虚机部署点：`C:\Users\lab\.dsh\profiles\web\node_modules\neuron-explore`。
- 配置备份：同目录 `cordis.patch.yml.bak-*`；默认模型备份在 `~/.dsh/neuron-explore.json` 的 `prevModel`。
- 关掉多路思考最省事：设置页取消勾选「开启多路思考」，会调 saveSelection 恢复原模型。

## 7. 待办

- 阶段一目前只显示主模型；如需展示多路对比，改 `adapter.mjs` 的 emit 分支。
- fuse 的 HTTP 适配是事后截断，若要真正的流式中断需改 `ask-http.mjs`。
- 设置页已删到 6 项，若恢复高级项请放进折叠区而不是平铺。
