# dsh-memory-plugin

**一个极简的记忆插件。** 每轮对话结束后问你要不要记住，勾了就写进当前工作区的 `MEMORY.md`；之后每次对话，助手都会带上这份文件的最新内容。

*A minimal memory plugin for DeepSeek Harness. MIT.*

## 它做什么

1. 每轮对话结束，让模型判断这轮有没有值得长期记住的东西。
2. 有的话就在**那条回复的下面**出现一张确认卡片，让你**逐条勾选**——默认全选，可以取消某条、全要、或全部跳过。卡片只出现在产生它的会话里，不会跳到别的会话去。
3. 勾中的以 `- …` 追加到当前工作区的 `MEMORY.md`。
4. 之后每次拼装系统提示都重新读这个文件，所以改动下一句就生效。

界面上有三处：输入框下方一枚 **正在提取记忆** 的蓝色胶囊（带呼吸光点，等待变长时文案会自动改成"仍在提取…"）、对话里的确认卡片、右侧边栏的 **记忆** 标签页（可增、改、删）。

确认卡片是会话内元素而不是模态框：没有遮罩、不抢焦点、不劫持 Esc。它挂在该回合的"回合尾部"槽位（`conversation.chat.turnTail`）上，靠回合号认领自己的批次——所以每个会话只会看到自己那张。

## 安装

一行：

```powershell
dsh plugin --profile web add github:sxxmk/dsh-memory-plugin
```

装完自动注册成 bundle，不用手改 `package.json`。然后重启 `dsh`、**刷新浏览器页面**——侧边栏和确认卡片是浏览器半，不刷新不出现。

想改代码而不是用发布版，把最后一段换成 `link:D:/code/dsh-memory-plugin`，之后改完源码重载插件即可。

## MEMORY.md 的格式

```markdown
## Remembered facts

- 未经明确指令，不得执行 git commit 和 git push。
- 本项目测试命令是 `pnpm test`。
```

只有 `- ` 开头的行算记忆，文件里其他内容原样保留，插件不动。

## 配置

默认值写在 `cordis.patch.yml`，要在 profile 自己的 patch 里覆盖，用 id 定位：

```yaml
- id: dsh-memory-plugin
  name: '@local/dsh-memory-plugin'
  config:
    reasoningEffort: high
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `provider` / `model` | `''` | 分析用哪个模型。留空 = 跟着这轮对话用的模型走。 |
| `reasoningEffort` | `high` | 固定 high，不继承对话的 MAX。 |
| `file` | `MEMORY.md` | 记忆文件，相对会话工作目录。 |
| `maxItems` | `5` | 单次最多几条候选。 |
| `injectPrompt` | `true` | 是否回灌进新对话。 |
| `enabled` | `true` | 临时关掉整个插件。 |

其余键（`maxItemChars`、`maxTranscriptChars`、`confirmTimeoutMs`、`debounceMs` 等）见 `cordis.patch.yml` 里的注释。

## 拒绝也会被记住

没勾的项会记进 `.dsh-memory-declined.json`，下一轮不会再提。超时没回答的不算拒绝——沉默不是拒绝。删掉这个文件就等于清空黑名单。

## 注意

- 只分析每个会话的**最近一轮**，工具调用结果不发给分析模型。
- 批次按会话排队，两个工作区不会串写进同一个文件。

## 开发

```powershell
node test/declinement-check.mjs
```

改完 `index.js` 记得把 `PLUGIN_BUILD` 加一位——`GET /dsh-memory-plugin/status` 靠它证明当前加载的是哪份代码。

## License

MIT
