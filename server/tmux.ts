import { execFile } from "node:child_process";

/**
 * tmux 会话/窗口管理：Terminal 面板的 tmux 集成后端。
 *
 * 约定：
 * - 本应用创建的会话统一 `pi-web-ui-<terminalId>` 前缀（`TMUX_SESSION_PREFIX`），
 *   与用户自有会话天然隔离；领养列表只收非此前缀会话。
 * - 所有命令走 execFile（无 shell 注入面）；会话名/窗口 id 只允许安全字符。
 * - tmux 未安装时全部函数抛错，调用方回退 node-pty 并标记非 tmux 标签。
 */

export const TMUX_SESSION_PREFIX = "pi-web-ui-";

/**  adoption 轮询间隔（ms）：发现用户在真终端新建/detach 的会话。 */
export const TMUX_ADOPT_POLL_MS = 30_000;

let cachedHasTmux: boolean | null = null;

/** 主机是否有 tmux（启动时探测一次，结果缓存）。 */
export async function hasTmux(): Promise<boolean> {
	if (cachedHasTmux !== null) return cachedHasTmux;
	try {
		await tmux(["-V"]);
		cachedHasTmux = true;
	} catch {
		cachedHasTmux = false;
	}
	return cachedHasTmux;
}

function tmux(args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile("tmux", args, { timeout: 10_000 }, (err, stdout, stderr) => {
			if (err) reject(err);
			else resolve({ stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

/** 会话名/窗口 id 白名单：字母数字 + 安全标点，防止参数注入。
 *  tmux 分配的 id 形如 `$N`（会话）/`@N`（窗口），`$@` 在白名单内。 */
function assertSafeToken(v: string, what: string): void {
	if (!v || v.length > 128 || !/^[A-Za-z0-9._:=@$-]+$/.test(v)) {
		throw new Error(`invalid tmux ${what}: ${JSON.stringify(v)}`);
	}
}

export function tmuxSessionName(terminalId: string): string {
	assertSafeToken(terminalId, "terminal id");
	return `${TMUX_SESSION_PREFIX}${terminalId}`;
}

export interface TmuxWindow {
	id: string;
	name: string;
	active: boolean;
	index: number;
}

export interface TmuxSession {
	name: string;
	attached: boolean;
	windows: number;
	adopted: boolean;
}

/** 新建 detach 会话（v1：单窗口；cwd 由 tmux 负责）。返回会话 id（`$N`，改名后不变）。失败抛错。 */
export async function newSession(name: string, cwd: string): Promise<string> {
	assertSafeToken(name, "session name");
	const args = ["new-session", "-d", "-s", name, "-P", "-F", "#{session_id}"];
	if (cwd) args.push("-c", cwd);
	let sessionId = "";
	try {
		const { stdout } = await tmux(args);
		sessionId = stdout.trim().split("\n").pop() ?? "";
	} catch (err) {
		throw new Error(`tmux new-session failed: ${(err as Error).message}`);
	}
	// 小浏览器窗口不压缩真客户端：各自按最大尺寸渲染。
	try {
		await tmux(["set-option", "-t", name, "aggressive-resize", "on"]);
		await tmux(["set-option", "-t", name, "window-size", "latest"]);
	} catch {
		// best-effort：老版本 tmux 缺这些选项也不致命
	}
	if (!sessionId) {
		// -P 无输出的老版本：回查当前名拿 id。
		try {
			const { stdout } = await tmux(["display-message", "-p", "-t", name, "#{session_id}"]);
			sessionId = stdout.trim();
		} catch {
			// best-effort：调用方回退用名
		}
	}
	return sessionId;
}

/** 会话改名（面板铅笔 / 真终端 rename-session 都会走到这里看到的新名）。
 *  id 寻址，会话不存在视为成功（与 killSession 同语义）。 */
export async function renameSession(sessionIdOrName: string, name: string): Promise<void> {
	assertSafeToken(sessionIdOrName, "session id");
	const trimmed = (name ?? "").trim().slice(0, 64);
	if (!trimmed) return;
	assertSafeToken(trimmed, "session name");
	try {
		await tmux(["rename-session", "-t", sessionIdOrName, trimmed]);
	} catch (err) {
		const msg = (err as Error).message;
		if (/can't find session|no server running|session not found/i.test(msg)) return;
		throw new Error(`tmux rename-session failed: ${msg}`);
	}
}

/** 取会话当前名（id 寻址；外部改名后树/标签同步用）。拿不到返回 ""。 */
export async function sessionName(sessionIdOrName: string): Promise<string> {
	assertSafeToken(sessionIdOrName, "session id");
	try {
		const { stdout } = await tmux(["display-message", "-p", "-t", sessionIdOrName, "#{session_name}"]);
		return stdout.trim();
	} catch {
		return "";
	}
}

/** 会话是否存在。 */
export async function hasSession(name: string): Promise<boolean> {
	assertSafeToken(name, "session name");
	try {
		await tmux(["has-session", "-t", name]);
		return true;
	} catch {
		return false;
	}
}

/** 杀掉整个会话（含其全部窗口）。会话已不存在视为成功
 *  （杀掉最后一个窗口时 tmux 会连带结束会话）。 */
export async function killSession(name: string): Promise<void> {
	assertSafeToken(name, "session name");
	try {
		await tmux(["kill-session", "-t", name]);
	} catch (err) {
		const msg = (err as Error).message;
		if (/can't find session|no server running|session not found/i.test(msg)) return;
		throw new Error(`tmux kill-session failed: ${msg}`);
	}
}

/** 列出某会话的窗口（tmux 权威状态，树/状态栏都以此为准）。 */
export async function listWindows(session: string): Promise<TmuxWindow[]> {
	assertSafeToken(session, "session name");
	try {
		const { stdout } = await tmux([
			"list-windows",
			"-t",
			session,
			"-F",
			"#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}",
		]);
		return stdout
			.split("\n")
			.map((l) => l.trimEnd())
			.filter((l) => l.length > 0)
			.map((l) => {
				const [id = "", index = "0", name = "", active = "0"] = l.split("\t");
				return { id, index: Number(index) || 0, name, active: active === "1" };
			});
	} catch {
		return [];
	}
}

/** 列出全部会话；adopted=true 表示非本应用前缀（领养候选）。 */
export async function listSessions(): Promise<TmuxSession[]> {
	try {
		const { stdout } = await tmux(["list-sessions", "-F", "#{session_name}\t#{session_attached}\t#{session_windows}"]);
		return stdout
			.split("\n")
			.map((l) => l.trimEnd())
			.filter((l) => l.length > 0)
			.map((l) => {
				const [name = "", attached = "0", windows = "0"] = l.split("\t");
				return {
					name,
					attached: attached === "1",
					windows: Number(windows) || 0,
					adopted: !name.startsWith(TMUX_SESSION_PREFIX),
				};
			});
	} catch {
		return [];
	}
}

/** 新窗口（名字可选，tmux 自动编号）。返回窗口 id（尽力解析，拿不到返回 ""）。 */
export async function newWindow(session: string, name?: string): Promise<string> {
	assertSafeToken(session, "session name");
	const args = ["new-window", "-t", session, "-P", "-F", "#{window_id}"];
	if (name && name.trim()) args.push("-n", name.trim().slice(0, 64));
	try {
		const { stdout } = await tmux(args);
		return stdout.trim().split("\n").pop() ?? "";
	} catch (err) {
		throw new Error(`tmux new-window failed: ${(err as Error).message}`);
	}
}

/** 选中窗口（树点击 / 切换都走这里，tmux 重绘收敛）。 */
export async function selectWindow(windowId: string): Promise<void> {
	assertSafeToken(windowId, "window id");
	try {
		await tmux(["select-window", "-t", windowId]);
	} catch (err) {
		throw new Error(`tmux select-window failed: ${(err as Error).message}`);
	}
}

/** 重命名窗口（仅原生会话；领养会话由调用方拒绝）。 */
export async function renameWindow(windowId: string, name: string): Promise<void> {
	assertSafeToken(windowId, "window id");
	const trimmed = (name ?? "").trim().slice(0, 64);
	if (!trimmed) return;
	try {
		await tmux(["rename-window", "-t", windowId, trimmed]);
	} catch (err) {
		throw new Error(`tmux rename-window failed: ${(err as Error).message}`);
	}
}

/** 杀窗口（仅原生会话；两步确认在 UI 侧）。 */
export async function killWindow(windowId: string): Promise<void> {
	assertSafeToken(windowId, "window id");
	try {
		await tmux(["kill-window", "-t", windowId]);
	} catch (err) {
		throw new Error(`tmux kill-window failed: ${(err as Error).message}`);
	}
}
