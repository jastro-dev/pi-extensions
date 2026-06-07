import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";

import { buildWorktreeCdItems } from "./commands.ts";
import { withWorktreeRecentness } from "./git-operations.ts";
import { moveSessionToWorktree } from "./session.ts";
import type { MoveSessionContext, SelectItem, WorktreeCommandResult, WorktreeEntry, WorktreeListOverlayDeps } from "./types.ts";

class WorktreeListOverlay {
	private scroll = 0;
	private readonly lines: string[];

	constructor(
		private readonly tui: { terminal?: { rows?: number }; requestRender(): void },
		private readonly theme: Theme,
		private readonly done: () => void,
		private readonly deps: WorktreeListOverlayDeps,
		private readonly title: string,
		markdown: string,
		width: number,
	) {
		this.lines = this.renderMarkdown(markdown, Math.max(40, width - 4));
	}

	handleInput(data: string): void {
		if (this.deps.matchesKey(data, this.deps.Key.escape) || this.deps.matchesKey(data, this.deps.Key.ctrl("c")) || data === "q" || data === "Q") {
			this.done();
			return;
		}
		if (this.deps.matchesKey(data, this.deps.Key.up)) this.scrollBy(-1);
		else if (this.deps.matchesKey(data, this.deps.Key.down)) this.scrollBy(1);
		else if (this.deps.matchesKey(data, "pageUp")) this.scrollBy(-10);
		else if (this.deps.matchesKey(data, "pageDown")) this.scrollBy(10);
		else if (this.deps.matchesKey(data, "home")) this.setScroll(0);
		else if (this.deps.matchesKey(data, "end")) this.setScroll(Number.MAX_SAFE_INTEGER);
	}

	render(width: number): string[] {
		const innerWidth = Math.max(40, width - 2);
		const terminalRows = this.tui.terminal?.rows ?? process.stdout.rows ?? 30;
		const panelHeight = Math.max(10, Math.min(terminalRows - 4, 28));
		const bodyHeight = Math.max(6, panelHeight - 5);
		const maxScroll = Math.max(0, this.lines.length - bodyHeight);
		this.scroll = Math.min(this.scroll, maxScroll);
		const visible = this.lines.slice(this.scroll, this.scroll + bodyHeight);
		const scrollInfo = maxScroll > 0 ? ` · ${this.scroll + 1}-${Math.min(this.lines.length, this.scroll + bodyHeight)}/${this.lines.length}` : "";

		const out = [
			this.theme.fg("borderAccent", `┌${"─".repeat(innerWidth)}┐`),
			this.frame(this.theme.fg("accent", this.theme.bold(` ${this.title} `)), innerWidth),
			this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`),
		];
		for (const line of visible) out.push(this.frame(line, innerWidth));
		while (out.length < bodyHeight + 3) out.push(this.frame("", innerWidth));
		out.push(this.theme.fg("borderMuted", `├${"─".repeat(innerWidth)}┤`));
		out.push(this.frame(this.theme.fg("dim", `↑↓/PgUp/PgDn scroll · q/Esc close${scrollInfo}`), innerWidth));
		out.push(this.theme.fg("borderAccent", `└${"─".repeat(innerWidth)}┘`));
		return out;
	}

	invalidate(): void {}

	private renderMarkdown(markdown: string, width: number): string[] {
		try {
			return new this.deps.Markdown(markdown, 0, 0, this.deps.getMarkdownTheme()).render(width);
		} catch {
			return markdown.split("\n");
		}
	}

	private scrollBy(delta: number): void {
		this.setScroll(this.scroll + delta);
	}

	private setScroll(value: number): void {
		const rows = this.tui.terminal?.rows ?? process.stdout.rows ?? 30;
		const maxScroll = Math.max(0, this.lines.length - Math.max(6, Math.min(rows - 4, 28) - 5));
		this.scroll = Math.max(0, Math.min(value, maxScroll));
		this.tui.requestRender();
	}

	private frame(content: string, innerWidth: number): string {
		const truncated = this.deps.truncateToWidth(content, innerWidth, "");
		return `${this.theme.fg("borderMuted", "│")}${truncated}${" ".repeat(Math.max(0, innerWidth - this.deps.visibleWidth(truncated)))}${this.theme.fg("borderMuted", "│")}`;
	}
}

export async function showWorktreeOutputOverlay(ctx: ExtensionCommandContext, title: string, markdown: string): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(markdown, "info");
		return;
	}

	const [{ getMarkdownTheme }, { Key, Markdown, matchesKey, truncateToWidth, visibleWidth }] = await Promise.all([
		import("@earendil-works/pi-coding-agent"),
		import("@earendil-works/pi-tui"),
	]);
	const deps: WorktreeListOverlayDeps = { getMarkdownTheme, Key, Markdown, matchesKey, truncateToWidth, visibleWidth };

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => new WorktreeListOverlay(tui, theme, done, deps, title, markdown, process.stdout.columns ?? 100),
		{
			overlay: true,
			overlayOptions: {
				anchor: "top-center",
				width: "88%",
				maxHeight: "78%",
				minWidth: 78,
				margin: { top: 1, left: 2, right: 2 },
			},
		},
	);
}

export async function selectWorktreeFromMenu(ctx: ExtensionCommandContext, entries: WorktreeEntry[]): Promise<string | null> {
	const { items, pathByValue } = buildWorktreeCdItems(await withWorktreeRecentness(entries));
	if (items.length === 0) throw new Error("No selectable worktrees found");
	if (!ctx.hasUI) throw new Error("Usage: /worktree cd <path|branch|folder-name>");

	const [{ Container, Key, SelectList, Text, matchesKey }] = await Promise.all([
		import("@earendil-works/pi-tui"),
	]);

	const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(`Open worktree (${items.length} worktrees)`)), 1, 0));

		const selectList = new SelectList(items, Math.min(items.length, 12), {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("dim", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		});
		selectList.onSelect = (item: SelectItem) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter open session • esc cancel"), 1, 0));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, Key.escape)) {
					done(null);
					return true;
				}

				selectList.handleInput(data);
				tui.requestRender();
				return true;
			},
		};
	});

	return selected ? pathByValue.get(selected) ?? null : null;
}

export async function presentWorktreeCommandResult(pi: ExtensionAPI, ctx: ExtensionCommandContext, getMoveCtx: () => MoveSessionContext, result: WorktreeCommandResult): Promise<void> {
	switch (result.kind) {
		case "noop":
			return;
		case "notify":
			ctx.ui.notify(result.message, result.level ?? "info");
			return;
		case "overlay":
			await showWorktreeOutputOverlay(ctx, result.title, result.markdown);
			return;
		case "move-session":
			if (result.message) ctx.ui.notify(result.message, "info");
			await moveSessionToWorktree(pi, getMoveCtx(), result.targetCwd, result.commandName);
			return;
		default: {
			const _exhaustive: never = result;
			return _exhaustive;
		}
	}
}
