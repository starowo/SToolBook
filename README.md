# SToolBook

> SoliUmbra 的工具书。把世界书条目直接变成可编写、可启用、可注册的 SillyTavern Function Tool，并提供无缝工具循环与工具运行时 API。

- 作者：SoliUmbra
- 当前版本：1.3.0
- 入口文件：`index.js`

---

## 目录

- [功能简介](#功能简介)
- [核心特性](#核心特性)
- [快速开始](#快速开始)
- [插件设置说明](#插件设置说明)
- [如何编写一个工具](#如何编写一个工具)
- [工具定义格式](#工具定义格式)
- [运行时 API 文档](#运行时-api-文档)
- [跨扩展 API / 兼容接口](#跨扩展-api--兼容接口)
- [完整示例](#完整示例)
- [行为说明与注意事项](#行为说明与注意事项)
- [常见问题](#常见问题)

---

## 功能简介

SToolBook 会将世界书条目变成可编辑代码的工具容器。

你可以在世界书条目里直接编写一段 JavaScript，保存后它会被注册为工具函数。只要该世界书条目当前被激活，对应工具就会自动注册到 SillyTavern 的工具系统里；条目失活、关闭启用、代码失效或内容更新时，工具也会自动同步注销/重新注册。

除了工具注册本身，SToolBook 还扩展了整个工具调用流程，提供：

1. **无缝工具循环**
   - 多轮工具调用只保留为一条最终 assistant 消息。
   - 中间工具轮次通过 `continue` 自动续写。
   - 工具调用摘要会被合并进 reasoning。

2. **工具回合合并（Deperacated）**
   - 把常规工具调用产生的多条 assistant/tool 消息合并成单条 assistant 消息。
   - 工具参数与结果会以内联折叠块显示在 reasoning 区域中。

3. **Prompt 兼容补丁（Deperacated）**
   - 修复与 SPreset 等修改 prompt 的扩展共存时，seamless tail 丢失的问题。

4. **工具运行时 API**
   - 工具内可直接读写当前步骤的回复正文、思维链。
   - 支持后台请求、静默请求、并发请求。
   - 支持工具主动停止 seamless 后续循环。

---

## 核心特性

### 1. 世界书条目绑定工具函数
每个世界书条目都可以存一份 SToolBook 配置，保存在：

```js
entry.extensions.SToolBook
```

包含：

- 是否启用
- 工具代码
- 校验结果
- 版本 UUID

### 2. 自动注册 / 自动同步
当世界书条目加载和激活状态变化时，SToolBook 会自动：

- 扫描带有 `extensions.SToolBook` 的条目
- 校验代码
- 注册为 Function Tool
- 在代码变更后自动重新注册
- 在条目失活或禁用后自动注销

### 3. 无缝工具循环
开启后，SToolBook 会接管工具调用循环：

- 模型输出工具调用时，不立即结束整轮回复
- 工具结果执行完后自动触发 `continue`
- 中间轮的 reasoning 和工具调用摘要会记录进历史
- 当循环结束时，再把多轮 reasoning 合并到最终那条 assistant 消息里

## 快速开始

### 1. 安装插件

在SillyTavern中，打开扩展菜单，点击安装插件并输入本仓库地址：
`https://github.com/starowo/SToolBook.git`

---

### 2. 打开世界书条目编辑器
进入世界书条目列表后，SToolBook 会在条目右侧注入一个按钮：点击后会展开一个内联面板。

---

### 3. 编写工具代码
在编辑面板里写一段 JavaScript。代码必须：

- **直接 `return` 一个工具定义对象**
- 至少包含 `name`、`description`、`parameters`、`action`

最小示例：

```js
return {
    name: 'hello_tool',
    description: '返回一个简单问候',
    parameters: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: '要问候的名字'
            }
        },
        required: ['name']
    },
    action: async (args, api) => {
        return `你好，${args.name}！`;
    },
};
```

---

### 4. 保存并启用
在面板中：

1. 勾选 `启用工具函数`
2. 点击 `保存`

保存后：

- 代码会先做校验
- 校验通过则提示成功
- 对应世界书条目被激活时，工具会自动注册

如果代码非空但校验失败，配置仍会被保存，但不会作为有效工具运行。

---

### 5. 激活世界书条目
只有**当前激活**的世界书条目里的工具才会注册。

所以如果你保存后发现模型调用不到工具，优先检查：

- 该条目是否启用工具函数
- 代码是否校验通过
- 世界书条目是否已激活
- 模型 / 后端是否允许使用工具调用

---

## 插件设置说明

插件设置面板中包含以下选项：

### 无缝工具循环 
> 接管工具调用循环：整轮只产生一条消息，利用 continue 预填充无缝续写。与下方的合并/置底功能不可以同时开启，强烈建议优先使用无缝工具循环。

开启后：

- `合并工具调用回合` 会失效
- `置底最新回合` 会失效

---

### 合并工具调用回合
> 将多步工具调用的消息合并为单条消息显示，工具结果以可折叠行内嵌推理块中。

适用于**非无缝模式**。

效果：

- assistant/tool/assistant/... 多条消息会被压成一条 assistant
- 工具参数和结果会被整理到 reasoning 区

---

### 置底最新回合
> 将最新回合（user/assistant/tool）置于 prompt 最底部，防止被 jailbreak 等注入打断工具调用循环。

适用于非无缝模式场景下，希望确保最近一轮工具上下文不被其它 prompt 段打断。

---

### 回传推理内容
> 将 `tool_calls` 消息上的 reasoning 回传为 `reasoning_content`，修复 DeepSeek reasoner 思考模式下工具调用 400 错误。

如果你的模型 / 兼容层要求 `reasoning_content`，建议开启。

---

### Debug Mode
默认隐藏。点击设置标题 **5 次** 可显示该开关。

开启后会输出更详细的控制台日志，适合排查各种疑难杂症

---

## 如何编写一个工具

SToolBook 工具代码的执行方式是：

```js
const factory = new Function('api', code);
const toolDef = factory(api);
```

也就是说：

- 你写的是一段“工厂代码”
- 代码运行时会收到一个 `api`
- 最后必须 `return` 出工具定义对象

### 推荐模板

```js
return {
    name: 'my_tool',
    displayName: '我的工具',
    description: '工具用途说明',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: '输入内容'
            }
        },
        required: ['query']
    },
    action: async (args, api) => {
        api.util.log('收到参数', args);

        toastr.info(`开始处理参数：${JSON.stringify(args)}`);
        toastr.info(`正在处理：${args.query}`);

        return JSON.stringify({ ok: true, query: args.query });
    },
};
```

---

## 工具定义格式

### 必填字段

#### `name: string`
工具名称。

#### `description: string`
工具描述，提供给模型选择工具时参考。

#### `parameters: object`
JSON Schema 风格的参数定义。

#### `action: function`
工具主体逻辑。

签名通常为：

```js
action: async (args, api) => { ... }
```

---

### 可选字段

#### `displayName: string`
工具显示名称。未提供时默认使用 `name`。

#### `formatMessage: function`
自定义工具消息格式化函数。

签名：

```js
formatMessage: async (args, api) => { ... }
```

#### `stealth: boolean`
是否作为 stealth tool 注册。未提供时默认 `false`。

> 注意：在无缝模式下，SToolBook 会临时把工具视为 stealth，以接管循环流程。

---

## 运行时 API 文档

工具执行时，第二个参数 `api` 由 SToolBook 注入。

```js
action: async (args, api) => {
    // 使用 api
}
```

下面是完整可用接口。

---

### `api.tool`

#### `api.tool.getInfo()`
返回当前工具的元信息副本。

典型返回结构：

```js
{
    toolId: 'xxx',
    originalName: 'my_tool',
    displayName: '我的工具',
    worldName: '某世界书',
    uid: '123',
    entryKey: '某世界书::123'
}
```

#### `api.tool.getInvocation()`
返回当前这次工具调用的调用信息副本。

适合用于：

- 记录当前 tool name
- 检查参数
- 调试嵌套调用

---

### `api.step`
表示“当前步骤”的回复状态。

#### `api.step.get()`
获取当前步骤完整状态。

结构大致为：

```js
{
    messageId: number | null,
    content: string,
    reasoning: string,
    reasoningDisplayText: string | null,
    reasoningSignature: string | null,
    existsInChat: boolean,
}
```

#### `api.step.getMessageId()`
获取当前步骤绑定的消息 id。

#### `api.step.getSourceData()`
获取当前工具批次的源数据副本。

通常在工具链批处理或调试时有用。

#### `api.step.reply`
与 `api.reply` 相同，是别名。

---

### `api.reply`
用于读写当前步骤的 assistant 回复正文与 reasoning。

#### `api.reply.get()`
获取当前 reply 状态。

#### `api.reply.set(patch, options?)`
按 patch 方式更新当前 reply。

常见 patch 字段：

```js
{
    content,
    reasoning,
    reasoningDisplayText,
}
```

#### `api.reply.update(updater, options?)`
用函数式 updater 更新当前 reply。

#### `api.reply.getContent()`
获取当前正文内容。

#### `api.reply.setContent(content, options?)`
直接设置正文。

#### `api.reply.appendContent(content, options?)`
在正文后追加内容。

#### `api.reply.getReasoning()`
获取当前 reasoning 文本。

#### `api.reply.setReasoning(reasoning, options?)`
直接设置 reasoning。

可选通过 `options.reasoningDisplayText` 同时指定展示文本。

#### `api.reply.appendReasoning(reasoning, options?)`
在 reasoning 后追加内容。

适合在工具内部逐步记录思考过程。

---

### `api.loop`
用于控制无缝模式的工具循环。

#### `api.loop.stop(reason?)`
请求在**当前批工具执行完成后**停止 seamless 后续循环。

```js
api.loop.stop();
api.loop.stop('已经拿到足够信息');
```

行为：

- 当前工具继续执行到结束
- 当前批工具结果仍会记录进 `turnHistory`
- 不再发送下一条 `continue`
- 当前批工具调用仍会并入本轮 reasoning

返回值示例：

```js
{
    stopRequested: true,
    request: {
        requestedAt: 1710000000000,
        reason: '已经拿到足够信息',
        tool: { ... }
    }
}
```

#### `api.loop.getState()`
查看当前是否已经存在 stop 请求。

示例：

```js
const state = api.loop.getState();
if (!state.stopRequested) {
    api.loop.stop('done');
}
```

---

### `api.seamless`
`api.loop` 的别名。

也就是说这两种写法等价：

```js
api.loop.stop('done');
api.seamless.stop('done');
```

---

### `api.request`
用于发起静默请求、后台请求与并发请求。

#### 1. `api.request.quiet(params)`
#### 2. `api.request.quietPrompt(params)`
调用：

```js
SillyTavern.getContext().generateQuietPrompt(params)
```

会占用主生成流程，不建议使用。

---

#### 3. `api.request.raw(params)`
调用：

```js
SillyTavern.getContext().generateRaw(params)
```

适合短文本静默补全，不走主聊天消息流。

---

#### 4. `api.request.rawData(params)`
调用：

```js
SillyTavern.getContext().generateRawData(params)
```

返回更底层的数据对象。

---

#### 5. `api.request.background(params)`
#### 6. `api.request.backgroundChat(params)`
后台构造完整聊天上下文（聊天记录 / 预设 / 世界书）后发起补全，不占主任务。

适合：

- 工具内部做二次分析
- 不想打断主生成流程
- 不希望污染主聊天状态

---

#### 7. `api.request.backgroundData(params)`
#### 8. `api.request.backgroundChatData(params)`
与 background 类似，但返回原始数据对象而不是简化文本结果。

---

#### 9. `api.request.parallel(tasks, options?)`
并发执行多个静默任务。

示例：

```js
const results = await api.request.parallel([
    { mode: 'quietPrompt', params: { quietPrompt: '任务 A' } },
    { mode: 'background', params: { quietPrompt: '任务 B' } },
]);
```

---

#### 10. `api.request.parallelQuiet(tasks, options?)`
默认按 `quietPrompt` 模式并发。

#### 11. `api.request.parallelRaw(tasks, options?)`
默认按 `raw` 模式并发。

#### 12. `api.request.parallelBackground(tasks, options?)`
默认按 `background` 模式并发。

#### 13. `api.request.allSettled(tasks, options?)`
类似 `Promise.allSettled()`，即使有任务失败也能拿到完整结果。

---

### `api.util`

#### `api.util.log(...args)`
输出带 SToolBook 工具标识的日志。

#### `api.util.sleep(ms)`
简单 sleep。

```js
await api.util.sleep(300);
```

#### `api.util.clone(value)`
深拷贝一个值，适合对参数、状态做安全副本处理。

---

## 跨扩展 API / 兼容接口

除了工具内部 `api` 之外，SToolBook 还暴露了两个全局接口，供别的扩展使用。

---

### 1. `globalThis.SToolBookToolAPI`

由 `installGlobalToolApiBridge()` 暴露。

#### `globalThis.SToolBookToolAPI.getApi(toolName?)`
获取某个工具上下文可用的 API 对象。

#### `globalThis.SToolBookToolAPI.current(toolName?)`
`getApi()` 的别名。

用途：

- 非 SToolBook 注册的工具也可以拿到同一套 API
- 其它扩展通过 `registerFunctionTool()` 注册的工具也能访问 `api.request.background()` 等能力

---

### 2. `globalThis.SToolBookPromptCompat`

由 `installGlobalPromptCompat()` 暴露。

#### `applySeamlessPromptInjection(prompt, source?)`
把 seamless 工具历史重新注入到 prompt 尾部。

#### `getSeamlessPromptMessages()`
获取 SToolBook 当前构造出的 seamless prompt messages。

用途：

- 给 SPreset 这类会重写 `data.prompt` 的扩展做最后兼容补丁
- 在 prompt 重组后恢复 assistant tool_calls / tool result 尾部

---

## 完整示例

### 示例 1：后台分析后写回正文

```js
return {
    name: 'background_analyze',
    displayName: '后台分析',
    description: '后台补全并把结果补充到当前回复',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: '需要分析的问题'
            }
        },
        required: ['query']
    },
    action: async (args, api) => {
        await api.reply.appendReasoning(`\n开始后台分析：${args.query}`);

        const result = await api.request.background({
            quietPrompt: `请简洁分析以下问题：${args.query}`
        });

        await api.reply.appendContent(`\n\n分析结果：${result}`);
        return JSON.stringify({ ok: true, result });
    },
};
```

---

### 示例 2：并发请求多个结果

```js
return {
    name: 'parallel_lookup',
    description: '并发执行多个静默分析任务',
    parameters: {
        type: 'object',
        properties: {
            topic: {
                type: 'string',
                description: '主题'
            }
        },
        required: ['topic']
    },
    action: async (args, api) => {
        const results = await api.request.parallelBackground([
            { quietPrompt: `从优点角度分析：${args.topic}` },
            { quietPrompt: `从缺点角度分析：${args.topic}` }
        ]);

        await api.reply.appendReasoning(`\n已完成并发分析，共 ${results.length} 项`);
        return JSON.stringify(results);
    },
};
```

---

### 示例 3：工具主动终止 seamless 循环

```js
return {
    name: 'finish_now',
    description: '当前批工具结束后直接停止 seamless 循环',
    parameters: {
        type: 'object',
        properties: {
            summary: {
                type: 'string',
                description: '结论摘要'
            }
        },
        required: ['summary']
    },
    action: async (args, api) => {
        await api.reply.appendReasoning(`\n工具决定提前结束循环：${args.summary}`);
        await api.reply.appendContent(`\n\n最终结论：${args.summary}`);

        api.loop.stop('已拿到最终结论');

        return JSON.stringify({
            ok: true,
            summary: args.summary,
        });
    },
};
```

---

### 示例 4：读取工具自身信息

```js
return {
    name: 'who_am_i',
    description: '输出工具自身的注册信息',
    parameters: {
        type: 'object',
        properties: {},
        required: []
    },
    action: async (args, api) => {
        const info = api.tool.getInfo();
        const invocation = api.tool.getInvocation();
        return JSON.stringify({ info, invocation }, null, 2);
    },
};
```

---

## 行为说明与注意事项

### 1. 工具代码不是模块文件
不要写：

```js
export default ...
```

也不要写整套 bundler 语法。

你写的是一段直接被 `new Function('api', code)` 执行的代码，所以正确写法是：

```js
return {
    ...
};
```

---

### 2. 校验通过 ≠ 一定会被调用
工具要真正生效，还必须满足：

- 世界书条目已激活
- 工具启用开关已打开
- 当前后端支持工具调用
- 模型在这一轮确实选择了该工具

---

### 3. `api.loop.stop()` 不会中断当前函数
它只是“请求在当前批工具结束后，不再继续下一轮 seamless”。

也就是说：

- 当前 `action()` 仍会继续执行到 `return`
- 当前批次其它工具也会正常完成
- 只是后续不会再自动发 `continue`

---

### 4. 合并模式与 Seamless 模式的区别

#### 合并工具调用回合
- 适合普通工具调用流程
- 事后整理聊天记录
- 会把多条消息压成一条

#### Seamless Tool Loop
- 适合全程接管工具循环
- 从生成流程阶段就开始接管
- 最终只保留一条 assistant 主消息

两者目标相似，但实现阶段不同。

---

### 5. Reasoning 展示优先级
SToolBook 会同时维护：

- `extra.reasoning`
- `extra.reasoning_display_text`

其中展示层优先使用 `reasoning_display_text`。因此工具摘要 HTML 会放在 display text 中，而纯文本版会放在 reasoning 中。

---

### 6. 与 SPreset 的兼容
SToolBook 已提供 prompt compat 接口，专门处理：

- `CHAT_COMPLETION_PROMPT_READY`
- `GENERATE_AFTER_DATA`
- `CHAT_COMPLETION_SETTINGS_READY`

这些阶段的 seamless 尾部恢复问题。

如果你在写其它 prompt 改写扩展，建议在重写 `data.prompt` 或 `data.messages` 后调用：

```js
globalThis.SToolBookPromptCompat?.applySeamlessPromptInjection?.(target, 'your-source');
```

---

## 常见问题

### Q1：保存后提示“验证未通过”怎么办？
检查以下内容：

- 是否 `return` 了一个对象
- 是否包含 `name / description / parameters / action`
- `name` 是否为非空字符串
- `description` 是否为字符串
- `parameters` 是否为对象
- `action` 是否为函数

---

### Q2：为什么工具没有注册？
优先检查：

1. 世界书条目是否启用工具函数
2. 校验是否通过
3. 世界书条目是否激活
4. 控制台是否有注册报错
5. 当前模型 / 预设是否允许工具调用

---

### Q3：为什么工具调用后正文没变化？
如果你想让工具直接修改当前回复内容，需要在 `action()` 中显式调用：

```js
await api.reply.appendContent('...');
await api.reply.appendReasoning('...');
```

否则工具只会返回结果，不一定自动写回当前 assistant 正文。

---

### Q4：什么时候用 `background()`，什么时候用 `quietPrompt()`？
简化理解：

- `quietPrompt()`：更轻量，适合简单静默文本生成
- `background()`：更完整，适合需要完整聊天上下文 / 预设 / 世界书参与的后台补全

---

### Q5：如何调试工具？
推荐方式：

1. 打开浏览器控制台
2. 连点 SToolBook 设置标题 5 次，显示 Debug Mode
3. 勾选 Debug Mode
4. 在工具里使用：

```js
api.util.log('debug info', data);
```

---

## 推荐开发习惯

- 给每个工具写清晰的 `description`
- 参数 schema 尽量完整，方便模型正确调用
- 复杂工具尽量把中间状态写入 `api.reply.appendReasoning()`
- 需要最终收束时，明确调用 `api.loop.stop()`
- 并发请求优先用 `api.request.parallel*()`，不要手搓重复逻辑
- 调试时优先用 `api.util.log()` 而不是裸 `console.log()`

---

## 结语

SToolBook 适合以下场景：

- 想把世界书条目直接变成工具
- 想让工具逻辑和 lore / entry 一起维护
- 想增强 SillyTavern 的多轮工具调用体验
- 想在工具里直接操作正文、reasoning、后台补全与循环控制

如果你已经在使用 SPreset 或其它 prompt 重写扩展，SToolBook 也提供了额外的兼容桥接接口，方便做联动开发。
