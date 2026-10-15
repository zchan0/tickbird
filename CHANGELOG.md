# 更新记录

这里记录每一版改了什么，只写使用者看得到的变化。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)：

- 改动随提交记在「未发布」下面。
- `npm run release` 发版时，把这一节改成版本号和日期，并把它用作 GitHub Release 的说明。

## 未发布

### 新增

- 终端版：拖动鼠标就能选中文字，松开时自动复制到剪贴板。终端支持剪贴板协议（kitty、iTerm2、WezTerm）时用协议，不支持时在 Mac 上用系统剪贴板。单击照常打开详情。
- 侧栏：调用行、Agent 行和 Changes 里的文件行都能拖动选中、复制。单击照常打开详情。

### 改动

- SendMessage、Skill、Workflow 调用改成和 Agent 调用一样的写法：
  - SendMessage：写「→ 对方 Agent 的任务」，下面一行写消息摘要。
  - Skill：写「◆ 技能名」，下面一行写传给它的参数。
  - Workflow：工具名旁边写名字，下面写说明和各个阶段；圆点表示状态，后台跑完时变色。
- subagent 页的标签改为 Task（主 Agent 交给它的任务）和 Result（它交回去的结果）。
- 侧栏字体跟随 `chat.fontSize`、`chat.fontFamily` 和 `chat.editor.*`，和 Claude Code 扩展的面板一致。其他字号按正文字号等比例缩放。

### 修复

- 侧栏：Agent 的话先以草稿显示，写进记录后不再从头重新打字。提前显示的调用写进记录时，不再先消失再出现。
- 终端：话分几段到达时，下面的调用会等这段话打完再出现。

## 0.8.0 · 2026-10-13

### 改动

- 两个版本用同一套版式：你的请求是页面上唯一凸起的部分；调用直接排在页面上；Prompt、Final Answer、Changes 是灰色小标签。
- 颜色从文字色和背景色混出一组灰阶。指针或光标所在的那一行不另外上色：灰字变成正文色，正文色的字加下划线。
- 动效两边一致：Agent 的话以打字机效果出现，下面的调用随后依次淡入；等待时是一个呼吸的金色圆点。

### 修复

- Agent 执行的斜杠命令按输入的命令显示，不再露出 `<command-message>` 标签。

更早的版本见 [GitHub Releases](https://github.com/zchan0/tickbird/releases)。
