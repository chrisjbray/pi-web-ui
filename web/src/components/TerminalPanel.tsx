import { useEffect, useRef, useState } from "react";
import { randomUuid } from "../uuid";
import { FiCheck, FiEdit2, FiMenu, FiPlay, FiPlus, FiRefreshCw, FiTerminal, FiTrash2, FiX } from "react-icons/fi";
import type { ChatState, TerminalMeta } from "../use-chat";
import type { ClientMessage, CommandDef } from "../types";
import { TermXterm } from "./TermXterm";
import { useT } from "../i18n";

interface TerminalPanelProps {
	chat: ChatState;
	send: (msg: ClientMessage) => boolean;
	terminal: {
		create: (meta: TerminalMeta) => void;
		close: (id: string) => void;
		register: (
			conversationId: string,
			id: string,
			writer: { write(data: string): void; dispose(): void },
		) => () => void;
		restart: (id: string) => void;
		select: (id: string) => void;
	};
}

interface Draft {
	name: string;
	command: string;
	cwd: string;
}

const EMPTY_DRAFT: Draft = { name: "", command: "", cwd: "${pwd}" };

/**
 * Built-in terminal — two panes:
 *   left : user command list (.pi/commands.json) on top + terminal tabs below
 *          (on mobile this whole column slides in as a drawer)
 *   right: the active terminal (one xterm per tab, kept mounted)
 */
export function TerminalPanel({ chat, send, terminal }: TerminalPanelProps) {
	const t = useT();
	const [activeId, setActiveId] = useState<string | null>(null);
	// Mobile: the left column (commands + tabs) slides in as a drawer.
	const [sideOpen, setSideOpen] = useState(false);
	// Command list editing state.
	const [isNew, setIsNew] = useState(false);
	const [editingIdx, setEditingIdx] = useState<number | null>(null);
	const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
	// Two-step delete confirmation.
	const [confirmDel, setConfirmDel] = useState<number | null>(null);
	const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// 终端接管 bash 的「AI bash」折叠分组开关（默认展开）。
	const [aiBashOpen, setAiBashOpen] = useState(true);
	const [renamingTab, setRenamingTab] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");
	// tmux：会话展开（窗口树）、窗口重命名草稿、窗口删除两步确认。
	const [tmuxOpen, setTmuxOpen] = useState<Record<string, boolean>>({});
	const [renamingWin, setRenamingWin] = useState<string | null>(null);
	const [winDraft, setWinDraft] = useState("");
	const [confirmWinKill, setConfirmWinKill] = useState<string | null>(null);

	// When the connection drops the server kills all PTYs and the reducer clears
	// the tab list — make sure the active selection doesn't dangle.
	useEffect(() => {
		if (chat.terminals.length === 0) setActiveId(null);
		else if (!chat.terminals.some((t) => t.id === activeId)) {
			setActiveId(chat.terminals[chat.terminals.length - 1].id);
		}
	}, [chat.terminals, activeId]);

	// tmux 领养列表：面板挂载/就绪即取一次，服务端 30s 轮询后续推送。
	useEffect(() => {
		if (chat.ready) send({ type: "list_tmux_sessions" });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [chat.ready]);

	// The SCM / settings panel asked to focus a specific terminal tab (git write
	// ops, uninstall runs) — follow the request so the user sees the command run.
	useEffect(() => {
		if (chat.terminalActiveId) {
			setActiveId(chat.terminalActiveId);
			setSideOpen(false);
		}
	}, [chat.terminalActiveId]);

	useEffect(() => {
		return () => {
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
		};
	}, []);

	// -- tab management --------------------------------------------------------

	// 终端接管 bash 的 ai-bash 终端单独归到「AI bash」折叠分组，与用户终端分开。
	const userTabs = chat.terminals.filter((t) => !t.agentBash);
	const agentTabs = chat.terminals.filter((t) => t.agentBash);

	const openTab = (
		meta: Omit<TerminalMeta, "running" | "exitCode" | "id" | "conversationId" | "cols" | "rows"> &
			Partial<Pick<TerminalMeta, "cols" | "rows">>,
	) => {
		if (!chat.ready) return; // topbar already shows the connection state
		const id = randomUuid();
		const conversationId = chat.activeConversationId || chat.state?.conversationId || "";
		terminal.create({
			...meta,
			id,
			conversationId,
			cols: meta.cols ?? 80,
			rows: meta.rows ?? 24,
			running: true,
			exitCode: null,
		});
		setActiveId(id);
		setSideOpen(false);
	};

	const openShell = () =>
		openTab({
			title: t("terminalTitle", { n: userTabs.length + 1 }),
			cwd: chat.state?.cwd ?? "",
		});

	const runCommand = (cmd: CommandDef) => {
		const title = cmd.name || cmd.command;
		// Reuse a terminal with the same title (VSCode-style task reuse): the
		// command is re-run in the SAME tab — a running process is interrupted
		// first (the server kills the PTY's process group and starts fresh).
		const existing = chat.terminals.find((t) => t.title === title);
		if (existing) {
			terminal.restart(existing.id);
			setActiveId(existing.id);
			send({
				type: "run_command",
				terminalId: existing.id,
				conversationId: existing.conversationId,
				command: cmd,
				cols: 80,
				rows: 24,
			});
			return;
		}
		openTab({ title, cwd: chat.state?.cwd ?? "", command: cmd });
	};

	const closeTab = (id: string) => {
		const tab = chat.terminals.find((item) => item.id === id);
		if (tab) send({ type: "terminal_kill", terminalId: id, conversationId: tab.conversationId });
		terminal.close(id);
		if (activeId === id) {
			const rest = chat.terminals.filter((t) => t.id !== id);
			setActiveId(rest.length > 0 ? rest[rest.length - 1].id : null);
		}
	};

	// tmux 窗口行：选择 / 内联重命名 / 两步确认删除（仅原生会话；领养只读）。
	const renderTmuxWindow = (tab: TerminalMeta, w: { id: string; name: string; active: boolean; index: number }) => {
		const key = `${tab.id}:${w.id}`;
		const killing = confirmWinKill === key;
		return (
			<div key={w.id} className={`term-win ${w.active ? "active" : ""}`}>
				<button
					type="button"
					className="term-win-main"
					title={w.name}
					onClick={() => {
						if (renamingWin) return;
						setActiveId(tab.id);
						send({
							type: "tmux_select_window",
							terminalId: tab.id,
							conversationId: tab.conversationId,
							windowId: w.id,
						});
					}}
				>
					<span className="term-win-idx">{w.index}</span>
					{renamingWin === key ? (
						<input
							autoFocus
							className="term-tab-rename-input"
							value={winDraft}
							placeholder={w.name}
							onClick={(e) => e.stopPropagation()}
							onChange={(e) => setWinDraft(e.target.value)}
							onKeyDown={(e) => {
								e.stopPropagation();
								if (e.key === "Enter" && !e.nativeEvent.isComposing) {
									const name = winDraft.trim();
									if (name)
										send({
											type: "tmux_rename_window",
											terminalId: tab.id,
											conversationId: tab.conversationId,
											windowId: w.id,
											name,
										});
									setRenamingWin(null);
								} else if (e.key === "Escape") {
									setRenamingWin(null);
								}
							}}
							onBlur={() => setRenamingWin(null)}
						/>
					) : (
						<span className="term-win-name">{w.name}</span>
					)}
				</button>
				{!tab.tmuxAdopted && (
					<>
						<button
							type="button"
							className="term-tab-close term-tab-rename"
							title={t("renameTerminal")}
							onClick={(e) => {
								e.stopPropagation();
								setWinDraft(w.name);
								setRenamingWin(key);
							}}
						>
							<FiEdit2 />
						</button>
						<button
							type="button"
							className={`term-tab-close ${killing ? "confirm" : ""}`}
							title={killing ? t("confirmQ") : t("delete")}
							onClick={(e) => {
								e.stopPropagation();
								if (killing) {
									setConfirmWinKill(null);
									send({
										type: "tmux_kill_window",
										terminalId: tab.id,
										conversationId: tab.conversationId,
										windowId: w.id,
									});
								} else {
									setConfirmWinKill(key);
								}
							}}
						>
							{killing ? <FiCheck /> : <FiX />}
						</button>
					</>
				)}
			</div>
		);
	};

	// tmux 会话操作行：新窗口 + 只读徽标/take control + detach（原生会话无 detach）。
	const renderTmuxActions = (tab: TerminalMeta) => {
		if (!tab.tmuxSession) return null;
		return (
			<div className="term-tmux-tree">
				<div className="term-tmux-head">
					<button
						type="button"
						className="term-tmux-act"
						title={t("tmuxNewWindow")}
						onClick={() => send({ type: "tmux_new_window", terminalId: tab.id, conversationId: tab.conversationId })}
					>
						<FiPlus />
					</button>
					<button
						type="button"
						className="term-tmux-act"
						title={tab.tmuxReadonly ? t("tmuxTakeControl") : t("tmuxRelease")}
						onClick={() =>
							send({
								type: "tmux_take_control",
								terminalId: tab.id,
								conversationId: tab.conversationId,
								readonly: !tab.tmuxReadonly,
							})
						}
					>
						{tab.tmuxReadonly ? t("tmuxTakeControlShort") : t("tmuxReleaseShort")}
					</button>
					{tab.tmuxAdopted && (
						<button
							type="button"
							className="term-tmux-act"
							title={t("tmuxDetach")}
							onClick={() => {
								terminal.close(tab.id);
								send({ type: "tmux_detach", terminalId: tab.id, conversationId: tab.conversationId });
							}}
						>
							{t("tmuxDetachShort")}
						</button>
					)}
				</div>
			</div>
		);
	};

	// 单个终端标签（用户终端 + ai-bash 分组共用）。
	// tmux 标签直接显示会话名：重命名/删除即作用于会话本身；窗口树挂在标签下方。
	const renderTab = (tab: TerminalMeta) => {
		const sessionName = tab.tmuxSession;
		const open = tmuxOpen[tab.id] ?? true;
		const wins = tab.tmuxWindows ?? [];
		return (
			<div key={tab.id}>
				<div className={`term-tab ${tab.id === activeId ? "active" : ""}`}>
					{sessionName && wins.length > 0 && (
						<button
							type="button"
							className="term-tmux-act"
							onClick={(e) => {
								e.stopPropagation();
								setTmuxOpen((m) => ({ ...m, [tab.id]: !open }));
							}}
						>
							{open ? "▾" : "▸"}
						</button>
					)}
					<button
						type="button"
						className="term-tab-main"
						title={`${tab.cwd}${tab.command ? `\n> ${tab.command.command}` : ""}`}
						onClick={() => {
							if (renamingTab) return;
							setActiveId(tab.id);
							setSideOpen(false);
						}}
					>
						<span className={`term-tab-dot ${tab.running ? "run" : "exit"}`} />
						<span className="term-tab-title">
							{renamingTab === tab.id ? (
								<input
									autoFocus
									className="term-tab-rename-input"
									value={renameDraft}
									placeholder={sessionName ?? tab.title}
									onClick={(e) => e.stopPropagation()}
									onChange={(e) => setRenameDraft(e.target.value)}
									onKeyDown={(e) => {
										e.stopPropagation();
										if (e.key === "Enter" && !e.nativeEvent.isComposing) {
											const title = renameDraft.trim();
											if (title)
												send({
													type: "rename_terminal",
													terminalId: tab.id,
													conversationId: tab.conversationId,
													title,
												});
											setRenamingTab(null);
										} else if (e.key === "Escape") {
											setRenamingTab(null);
										}
									}}
									onBlur={() => setRenamingTab(null)}
								/>
							) : (
								(sessionName ?? tab.title)
							)}
							{sessionName && tab.tmuxAdopted && <span className="term-tmux-badge">{t("tmuxAdopted")}</span>}
							{sessionName && tab.tmuxReadonly && !tab.tmuxAdopted && (
								<span className="term-tmux-badge">{t("tmuxReadonly")}</span>
							)}
							{!tab.running && (
								<span className="term-tab-exit">
									{t("exited", {
										code: tab.exitCode === null ? "" : ` ${tab.exitCode}`,
									})}
								</span>
							)}
						</span>
					</button>
					{(!sessionName || !tab.tmuxAdopted) && (
						<button
							type="button"
							className="term-tab-close term-tab-rename"
							title={t("renameTerminal")}
							onClick={(e) => {
								e.stopPropagation();
								setRenameDraft(sessionName ?? tab.title);
								setRenamingTab(tab.id);
							}}
						>
							<FiEdit2 />
						</button>
					)}
					{(!sessionName || !tab.tmuxAdopted) && (
						<button
							type="button"
							className="term-tab-close"
							title={t("closeTerminal")}
							onClick={() => closeTab(tab.id)}
						>
							<FiX />
						</button>
					)}
				</div>
				{sessionName && renderTmuxActions(tab)}
				{sessionName && open && <div className="term-tmux-wins">{wins.map((w) => renderTmuxWindow(tab, w))}</div>}
			</div>
		);
	};

	const startNew = () => {
		setIsNew(true);
		setEditingIdx(null);
		setDraft(EMPTY_DRAFT);
	};

	const startEdit = (idx: number) => {
		const c = chat.commands[idx];
		if (!c) return;
		setIsNew(false);
		setEditingIdx(idx);
		setDraft({ name: c.name, command: c.command, cwd: c.cwd ?? "" });
	};

	const cancelEdit = () => {
		setIsNew(false);
		setEditingIdx(null);
	};

	const saveDraft = () => {
		const name = draft.name.trim();
		const command = draft.command.trim();
		if (!name || !command) return;
		const cwd = draft.cwd.trim();
		const def: CommandDef = { name, command, cwd: cwd ? cwd : undefined };
		const next = isNew
			? [...chat.commands, def]
			: editingIdx !== null
				? chat.commands.map((c, i) => (i === editingIdx ? def : c))
				: chat.commands;
		send({ type: "save_commands", commands: next });
		cancelEdit();
	};

	const requestDelete = (idx: number) => {
		if (confirmDel === idx) {
			const next = chat.commands.filter((_, i) => i !== idx);
			send({ type: "save_commands", commands: next });
			setConfirmDel(null);
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
		} else {
			setConfirmDel(idx);
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
			confirmTimer.current = setTimeout(() => setConfirmDel(null), 2500);
		}
	};

	const editing = isNew || editingIdx !== null;

	return (
		<div className="terminal-view">
			{/* ---------------- left: command list + terminal tabs ---------------- */}
			<aside className={`term-side term-commands ${sideOpen ? "open" : ""}`}>
				<div className="panel-header">
					<span className="panel-title">{t("commands")}</span>
					<div className="panel-header-actions">
						<button
							type="button"
							className="panel-refresh"
							title={t("rerun")}
							onClick={() => send({ type: "list_commands" })}
						>
							<FiRefreshCw />
						</button>
						<button type="button" className="panel-new" title={t("newCommand")} onClick={startNew}>
							<FiPlus />
						</button>
					</div>
				</div>

				<div className="panel-body">
					{editing ? (
						<div className="cmd-form">
							<label htmlFor="cmd-name">{t("name")}</label>
							<input
								id="cmd-name"
								className="cmd-input"
								value={draft.name}
								placeholder={t("exampleName")}
								autoFocus
								onChange={(e) => setDraft({ ...draft, name: e.target.value })}
							/>
							<label htmlFor="cmd-command">{t("command")}</label>
							<input
								id="cmd-command"
								className="cmd-input"
								value={draft.command}
								placeholder={t("exampleCommand")}
								onChange={(e) => setDraft({ ...draft, command: e.target.value })}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.nativeEvent.isComposing) {
										saveDraft();
									}
								}}
							/>
							<label htmlFor="cmd-cwd">
								{t("directory")} <span className="cmd-hint">{t("cwdHint")}</span>
							</label>
							<input
								id="cmd-cwd"
								className="cmd-input"
								value={draft.cwd}
								placeholder="${pwd}"
								onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.nativeEvent.isComposing) {
										saveDraft();
									}
								}}
							/>
							<div className="cmd-form-actions">
								<button type="button" className="btn" onClick={cancelEdit}>
									{t("cancel")}
								</button>
								<button
									type="button"
									className="btn primary"
									disabled={!draft.name.trim() || !draft.command.trim()}
									onClick={saveDraft}
								>
									{t("save")}
								</button>
							</div>
						</div>
					) : (
						<>
							{chat.commands.length === 0 && <div className="panel-empty">{t("noCommands")}</div>}
							{chat.commands.map((c, i) => (
								<div key={i} className="cmd-item">
									<button type="button" className="cmd-run" title={t("clickToRun")} onClick={() => runCommand(c)}>
										<FiPlay />
									</button>
									<button type="button" className="cmd-main" title={t("clickToRun")} onClick={() => runCommand(c)}>
										<span className="cmd-name">{c.name}</span>
										<span className="cmd-command">{c.command}</span>
										{c.cwd && <span className="cmd-cwd">{c.cwd}</span>}
									</button>
									<button type="button" className="cmd-act" title={t("edit")} onClick={() => startEdit(i)}>
										<FiEdit2 />
									</button>
									<button
										type="button"
										className={`cmd-act del ${confirmDel === i ? "confirm" : ""}`}
										title={t("delete")}
										onClick={() => requestDelete(i)}
									>
										{confirmDel === i ? t("confirmQ") : <FiTrash2 />}
									</button>
								</div>
							))}
						</>
					)}
				</div>

				{/* ---------------- tabs (below the command list) ---------------- */}
				<div className="term-tabs-block">
					<div className="panel-header">
						<span className="panel-title">{t("terminal")}</span>
						<button type="button" className="panel-new" title={t("newTerminal")} onClick={openShell}>
							<FiPlus />
						</button>
					</div>
					<div className="panel-body">
						{chat.terminals.length === 0 && <div className="panel-empty">{t("noTerminal")}</div>}
						{userTabs.map(renderTab)}
						{agentTabs.length > 0 && (
							<div className="term-folder">
								<button
									type="button"
									className={`term-folder-header ${aiBashOpen ? "open" : ""}`}
									title={t("aiBashGroup")}
									onClick={() => setAiBashOpen((v) => !v)}
								>
									<span className="term-folder-caret">{aiBashOpen ? "▾" : "▸"}</span>
									<span className="term-folder-title">{t("aiBashGroup")}</span>
									<span className="term-folder-count">{agentTabs.length}</span>
								</button>
								{aiBashOpen && <div className="term-folder-body">{agentTabs.map(renderTab)}</div>}
							</div>
						)}
						{chat.tmuxSessions.length > 0 && (
							<div className="term-folder">
								<div className="term-folder-header">
									<span className="term-folder-title">{t("tmuxAdoptGroup")}</span>
									<span className="term-folder-count">{chat.tmuxSessions.length}</span>
								</div>
								<div className="term-folder-body">
									{chat.tmuxSessions.map((s) => (
										<div key={s.name} className="term-tab">
											<button
												type="button"
												className="term-tab-main"
												title={`${s.name} (${s.windows})`}
												onClick={() =>
													send({
														type: "tmux_adopt",
														session: s.name,
														conversationId: chat.activeConversationId || chat.state?.conversationId || "",
													})
												}
											>
												<span className="term-tab-title">{s.name}</span>
												<span className="term-folder-count">{s.windows}</span>
											</button>
											<button
												type="button"
												className="term-tab-close term-tab-rename"
												title={t("tmuxAdopt")}
												onClick={() =>
													send({
														type: "tmux_adopt",
														session: s.name,
														conversationId: chat.activeConversationId || chat.state?.conversationId || "",
													})
												}
											>
												<FiPlus />
											</button>
										</div>
									))}
								</div>
							</div>
						)}
					</div>
				</div>
			</aside>

			{/* ---------------- right: terminals ---------------- */}
			<div className="term-main">
				{sideOpen && <div className="drawer-backdrop" onClick={() => setSideOpen(false)} />}
				<button type="button" className="term-side-toggle" title={t("commands")} onClick={() => setSideOpen((v) => !v)}>
					<FiMenu />
				</button>
				{chat.terminals.length === 0 ? (
					<div className="term-empty">
						<FiTerminal className="term-empty-icon" />
						<div className="term-empty-title">{t("builtinTerminal")}</div>
						<div className="term-empty-sub">{t("termEmptySub")}</div>
					</div>
				) : (
					<>
						{chat.terminals.map((t) => (
							<TermXterm
								key={`${t.conversationId}:${t.id}`}
								conversationId={t.conversationId}
								terminalId={t.id}
								command={t.command}
								cwd={t.cwd}
								title={t.title}
								active={t.id === activeId}
								running={t.running}
								exitCode={t.exitCode}
								send={send}
								register={terminal.register}
							/>
						))}
						{(() => {
							const cur = chat.terminals.find((x) => x.id === activeId);
							const wins = cur?.tmuxWindows;
							if (!cur?.tmuxSession || !wins || wins.length === 0) return null;
							return (
								<div className="term-statusbar">
									<span className="term-statusbar-session">{cur.tmuxSession}</span>
									{wins.map((w) => (
										<button
											key={w.id}
											type="button"
											className={`term-statusbar-win ${w.active ? "active" : ""}`}
											title={w.name}
											onClick={() => {
												setActiveId(cur.id);
												send({
													type: "tmux_select_window",
													terminalId: cur.id,
													conversationId: cur.conversationId,
													windowId: w.id,
												});
											}}
										>
											[{w.index}:{w.name}
											{w.active ? "*" : ""}]
										</button>
									))}
								</div>
							);
						})()}
					</>
				)}
			</div>
		</div>
	);
}
