# pi-compact-tree

[English](README.md) | 简体中文

Pi 终端界面的紧凑过程视图。agent 的每一步都收成一行：连续的工具调用合并为一句汇总（例如 `Read 2 files, ran 1 shell command`），思考过程收成一行标题，文件编辑则保留 diff。终端滚动历史里只留下实际做过的事，而不会被原始输出刷屏。

![修一个小 bug 时的 pi-compact-tree](https://raw.githubusercontent.com/GhabiX/pi-compact-tree/main/media/compact-tree.gif)

同一段会话，启用插件前后的对比：

![同一段会话：Pi 默认显示 63 行，pi-compact-tree 31 行](https://raw.githubusercontent.com/GhabiX/pi-compact-tree/main/media/compare.png)

## 为什么这样设计

- **只改显示。** 插件只将 Pi 已有的界面内容投影为更紧凑的视图，从不修改 transcript、会话历史或工具执行逻辑。关闭插件即可恢复 Pi 原生界面；RPC、JSON 和 print 模式保持原生。
- **一步一行。** 执行过程按来源顺序平铺为条目：思考、编辑与写文件、provider 错误等提示，以及由连续工具调用组成的组。每个组只显示一句汇总，并为每次失败调用单独留出一行，因此连续读取二十个文件也只占一行。
- **不会远远落后于 agent。** 所有运动共用同一个音乐节拍时钟（♩ = 100，每行一个十六分音符）。流式文本按实际到达速率加上积压量推进；若某个条目尚未开始播放而后面已有新条目排队，则直接以收起后的最终形态进入。模型停止输出后，无论此前积压了多少内容，画面最多只需"当前条目剩余时间 + 一次休止 + 一小节"即可完全跟上。
- **正文仍由 Pi 绘制。** 助手回复、用户消息和诊断信息仍由 Pi 自己渲染，插件只控制显示的行数，因此终端链接、鼠标热区和自动换行均保持原生。

## 特性

- Claude Code 风格的过程条目：运行中的 `●` 呈呼吸闪烁，完成后变绿、失败变红；每组工具调用合成一句汇总，失败的调用单独列在下方。
- 思考过程在 8 行高的窗口内流式播放，结束后收成首个分句作为标题。输入 `/thoughts` 可打开只读浮层，查看当前会话已保存的完整思考内容。
- 编辑和写文件各占一个条目：编辑带一段简短的 diff（`Updated src/price.js with 1 addition and 1 removal`），写文件显示一行（`Wrote 12 lines to src/price.js`）。
- Ctrl+O 沿用 Pi 的快捷键。展开后每个工具块和每段思考最多显示 8 行，编辑的 diff 最多 20 行。
- 无边框输入面板与单行 footer：左侧为 `模型 思考等级 · 目录`，右侧为 `72% context left`。
- 内置两套主题：`spine-dark` 和 `spine-light`。

## 安装

```sh
pi install npm:@spinejit/pi-compact-tree
```

本插件按 Pi 的 regular 终端模式设计。Pi 默认是 fullscreen 模式，需要在 `/settings` 或 `~/.pi/agent/settings.json` 中设置：

```json
{ "tuiMode": "regular" }
```

可在 `/settings` 中选择内置主题，或直接配置 `"theme": "spine-dark"`。主题仅在通过包安装后注册，使用 `-e` 直接加载入口文件时不会注册。

请勿与其他重画聊天区的插件（`pi-quiet`、`pi-compact-display`、`pi-compact-ui`）同时使用。若与 `@each1024/pi-mini-mode` 同时加载，请只让其中一个插件提供 footer。

## 原理

条目按来源顺序逐个进入。当前正在播放的条目播完后，画面休止到下一拍，下一个条目才开始进入，因此任何时刻只有最新的条目在运动。每行高度变化耗时一个十六分音符（150 ms），超过 16 行的变化会压缩在一小节内完成。长出、收起和 Ctrl+O 切换均使用同一套运动机制，且每一步都会先核对 Pi 实际画到屏幕上的内容，确认后再推进下一步。

视口上方的终端滚动历史无法改写。插件会保留已滚出视口的行字节，并将已完成的历史前缀封存，不再重复投影。行拼接与 Pi 自身的逐行比较仍随历史总长度增长：恢复 2000 轮历史（约 2.2 万行）时，空闲帧耗时约 14 ms，动画帧耗时约 20 ms，均在 25 ms 的时钟预算之内（2026 年 10 月在 Pi 1.1 上测得）。

输入面板直接沿用 Pi 自己的编辑器对象，粘贴折叠标记、撤销、历史记录、自动补全和快捷键都照常可用。按 Esc 或提交新消息时，插件在保持 Pi 原生中断和 steer 行为的同时，会立即跳过上一轮尚未播完的显示积压。

## 限制

- 仅支持 regular 模式，不支持 fullscreen。
- 已进入终端滚动历史的部分会保持滚出时的画面，未必能收起为单行。
- 当终端高度只有 8 行左右时，8 行高的思考窗口无法完整放入视口，播放会暂停，直到终端高度增加后恢复。
- 测试尚未覆盖：Termux、手动鼠标操作、图片、很大的动态浮层、alternate screen。

## 兼容性

已在 Pi 1.3.0 和 1.4.0、Node 22.23 下测试通过。要求 Node >= 22.19。插件适配 Pi regular 模式界面的内部组件结构，Pi 升级后可能需要同步更新本插件。Pi 相关包均声明为 `"*"` peer dependencies。

## 开发

```sh
npm test          # 单元测试，以及在 Pi 真实 InteractiveMode 和虚拟时钟上逐帧检查的场景
npm run test:e2e  # 在 tmux 里用脚本化模型跑真实会话
```

端到端测试需要 tmux，以及 `PATH` 上的 `pi`。测试在 tmux 中启动 Pi，并单独设置 `PI_CODING_AGENT_DIR`，不会改动本机的用户 Pi 配置。`user_stack` 场景只在点名时运行（`node test/e2e/run.mjs user_stack`）：它加载你自己 Pi 设置里的本地包，其中有 SpineTree 时需要 `st` 命令。

## @spinejit 的其他插件

- [pi-btw-cached](https://github.com/GhabiX/pi-btw-cached)：在主会话自己的请求上发起 `/btw` 侧问。
- [pi-background-job](https://github.com/GhabiX/pi-background-job)：后台任务与输出监视，事件发生时自动通知 agent。
- [pi-timeout-policy](https://github.com/GhabiX/pi-timeout-policy)：为 bash、grep、find 提供统一的超时策略。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
