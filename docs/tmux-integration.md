# tmux 集成设计（Terminal 面板）

> 状态：设计已确认，未实现。v1 只做新建终端；存量 node-pty 标签页保持可用直到关闭。

## 目标

每个新建 Terminal 变成一个 tmux 会话，浏览器是哑终端：tmux 自己画状态栏、
分屏、窗口列表，前缀键直通。树只做遥控（选择/重命名/删除窗口）与领养外部会话。

## 决策记录

| # | 决策 | 理由 |
|---|------|------|
| 1 | 会话名 `pi-web-ui-<id>` | 命名空间隔离，`tmux ls` 一眼区分 |
| 2 | 只读默认 + take control 切换 | 只读 `-r` 接入避免光标争夺；接管是显式动作 |
| 3 | tmux 自己渲染（状态栏/分屏/窗口列表） | 零 UI 代码；浏览器只传字节 |
| 4 | 树镜像窗口列表（选择/重命名/删除） | tmux 是权威状态，树发命令、tmux 重绘收敛 |
| 5 | v1 单窗格每窗口，分屏 v2 | 分屏要多一层窗格选择，先不做 |
| 6 | 仅新建终端走 tmux | 存量 node-pty 标签页不动，关掉即止 |
| 7 | ai-bash 保持 node-pty | 哨兵协议依赖直连 PTY 输入解析 |
| 8 | 领养外部会话（轮询 `tmux ls` 30s） | 真终端开工、detach、浏览器接手 |
| 9 | 领养会话不重命名不杀 | 真终端是权威；UI 只看只接管只 detach |
| 10 | 状态栏放底部、用 tmux 名 | 像 tmux 默认；纯 CSS + 渲染移动 |
| 11 | Ctrl+b 直通 | xterm 发 `0x02` 字节；已审计 `attachCustomKeyEventHandler` 只劫持 Ctrl+V 与选中时 Ctrl+C，Ctrl+B 直达 tmux |

## 协议（`terminal_*` 家族，统一分发）

| 消息 | 方向 | tmux 命令 |
|------|------|-----------|
| `terminal_create`（扩展：tmux 会话） | C→S | `tmux new-session -d -s pi-web-ui-<id> -c <cwd>`，PTY 接入（只读 `-r`） |
| `tmux_new_window { terminalId, title? }` | C→S | `tmux new-window -t piweb-<id>` |
| `terminal_windows { terminalId, windows[] }` | S→C | `list-windows -t pi-web-ui-<id> -F '...'` 推送（输出活动时刷新，或 control-mode） |
| `tmux_select_window { terminalId, windowId }` | C→S | `tmux select-window -t <windowId>` |
| `tmux_rename_window { terminalId, windowId, name }` | C→S | `tmux rename-window -t <windowId> <name>`（仅原生会话） |
| `tmux_kill_window { terminalId, windowId }` | C→S | `tmux kill-window -t <windowId>`（仅原生会话，两步确认） |
| `tmux_take_control { terminalId, readonly }` | C→S | 只读 `-r` / 读写重接入 |
| 领养轮询 | S 内部 | `tmux ls` 30s，非 `pi-web-ui-` 前缀进 Adopted 组（只读接入，可 detach，不可改名/杀） |

## 数据模型

- `TerminalInfo` += `tmuxSession?: string`，`windows?: { id, name, active }[]`
- `TermEntry` += `tmuxSession` + `windowId`
- 输出流不变（`terminal_output` 通道不关心 PTY 后面是什么）

## UI

- 树：会话行展开为窗口行（选择/重命名内联编辑/两步确认删除）；Adopted 组只读（选择/detach）
- 底部 tmux 风格状态栏（`[0:name*] [1:name]`，用 tmux 窗口名）
- 每标签只读徽标 + take control 切换
- 新窗口 `+`，窗口数显示

## 风险

1. 主机无 tmux → 回退 node-pty，标签标非 tmux（启动时 `tmux -V` 探测一次）
2. 尺寸争夺 → 创建时 `aggressive-resize on` + `window-size latest`；小浏览器窗口会压缩真客户端（文档说明）
3. 鼠标模式 → `set -g mouse on` 后可点状态栏，需确认 `TermXterm` 转发鼠标
4. tmux 不稳定输出（单次 prettier 式展开问题）→ 提交前跑两次 format（如 prettier 经验）

---

# tmux Integration Design (Terminal Panel)

> Status: design confirmed, not implemented. v1 covers new terminals only; existing node-pty tabs keep working until closed.

## Goal

Each new Terminal becomes a tmux session and the browser is a dumb terminal: tmux draws its own status bar, splits and window list, and the prefix key passes straight through. The tree is only a remote control (select/rename/delete windows) plus adoption of foreign sessions.

## Decision Log

| # | Decision | Reason |
|---|----------|--------|
| 1 | Session names `pi-web-ui-<id>` | Namespace isolation, instantly distinct in `tmux ls` |
| 2 | Read-only by default + take-control toggle | Read-only `-r` attach avoids cursor fights; takeover is explicit |
| 3 | tmux renders itself (status bar / splits / window list) | Zero UI code; the browser only moves bytes |
| 4 | Tree mirrors the window list (select/rename/delete) | tmux is authoritative; the tree sends commands and converges on redraw |
| 5 | v1 single pane per window, splits in v2 | Splits need another pane-selection layer; deferred |
| 6 | tmux for new terminals only | Existing node-pty tabs untouched, die on close |
| 7 | ai-bash stays node-pty | The sentinel protocol depends on direct PTY input parsing |
| 8 | Adopt foreign sessions (`tmux ls` poll every 30s) | Start work in a real terminal, detach, pick up in the browser |
| 9 | Never rename/kill adopted sessions | The real terminal is authoritative; UI observes, takes over, detaches only |
| 10 | Status bar at the bottom, tmux names | Like tmux defaults; pure CSS + render move |
| 11 | Ctrl+b passes through | xterm emits the `0x02` byte; audit `attachCustomKeyEventHandler` for browser hijack first |

## Protocol (`terminal_*` family, shared dispatch)

| Message | Direction | tmux command |
|---------|-----------|--------------|
| `terminal_create` (extended: tmux session) | C→S | `tmux new-session -d -s pi-web-ui-<id> -c <cwd>`, PTY attach (read-only `-r`) |
| `tmux_new_window { terminalId, title? }` | C→S | `tmux new-window -t piweb-<id>` |
| `terminal_windows { terminalId, windows[] }` | S→C | `list-windows -t pi-web-ui-<id> -F '...'` push (refresh on output activity, or control-mode) |
| `tmux_select_window { terminalId, windowId }` | C→S | `tmux select-window -t <windowId>` |
| `tmux_rename_window { terminalId, windowId, name }` | C→S | `tmux rename-window -t <windowId> <name>` (native sessions only) |
| `tmux_kill_window { terminalId, windowId }` | C→S | `tmux kill-window -t <windowId>` (native sessions only, two-step confirm) |
| `tmux_take_control { terminalId, readonly }` | C→S | Re-attach read-only `-r` / read-write |
| Adoption poll | server-internal | `tmux ls` every 30s; non-`pi-web-ui-` sessions enter the Adopted group (read-only attach, detach allowed, no rename/kill) |

## Data Model

- `TerminalInfo` += `tmuxSession?: string`, `windows?: { id, name, active }[]`
- `TermEntry` += `tmuxSession` + `windowId`
- Output streaming unchanged (the `terminal_output` channel does not care what feeds the PTY)

## UI

- Tree: session rows expand to window rows (select / inline-rename / two-step-confirm delete); Adopted group is read-only (select/detach)
- Bottom tmux-style status bar (`[0:name*] [1:name]`, tmux window names)
- Per-tab read-only badge + take-control toggle
- New-window `+`, window count

## Risks

1. No tmux on host → fall back to node-pty, tab marked non-tmux (probe once at startup with `tmux -V`)
2. Size fights → `aggressive-resize on` + `window-size latest` at creation; a tiny browser window shrinks real clients (documented)
3. Mouse mode → clickable status bar after `set -g mouse on`; confirm `TermXterm` forwards mouse
4. Unstable tmux output (single-pass expansion issue) → run format twice before commit (per prettier experience)
