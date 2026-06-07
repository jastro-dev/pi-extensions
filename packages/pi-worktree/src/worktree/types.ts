import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type ExecResult = {
	code: number;
	stdout: string;
	stderr: string;
};

export type Exec = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;

export type WorktreeEntry = {
	path: string;
	head?: string;
	branch?: string;
	detached?: boolean;
	bare?: boolean;
	locked?: string | boolean;
	prunable?: string | boolean;
	recentAtMs?: number;
};

export type WorktreeStatus = WorktreeEntry & {
	dirty: boolean;
	merged: boolean | null;
};

export type Runtime = {
	cwd: string;
	exec: Exec;
	platform?: NodeJS.Platform;
	worktreeConfigPath?: string;
};

export type WorktreeConfig = {
	autoSymlinkEnvFiles: boolean | string[];
};

export type EnvLinkSummary = {
	linked: string[];
	skipped: string[];
	failed: string[];
};

export type ParsedArgs =
	| { command: "help" }
	| { command: "list" }
	| { command: "cd"; target?: string }
	| {
			command: "ccd";
			task: string;
			base?: string;
			branch?: string;
			path?: string;
	  }
	| { command: "cleanup"; apply: boolean }
	| { command: "scratch"; slot?: number }
	| {
			command: "create";
			task: string;
			base?: string;
			branch?: string;
			path?: string;
	  };

export type CreateWorktreeArgs = Extract<ParsedArgs, { command: "create" | "ccd" }>;

export type CleanupClassification =
	| { action: "skip"; entry: WorktreeStatus; reason: string; next: string }
	| { action: "eligible"; entry: WorktreeStatus; branch?: string; pruneStale: boolean };

export type MoveSessionContext = {
	cwd: string;
	sessionManager: {
		getSessionFile(): string | null | undefined;
		getLeafId(): unknown;
	};
	ui: {
		notify(message: string, level?: string): void;
	};
	switchSession(sessionFile: string, options?: { withSession?: (ctx: MoveSessionContext) => void | Promise<void> }): Promise<unknown>;
};

export type SessionManagerStatic = {
	open(sessionFile: string): { getEntries(): unknown[]; getLeafId(): unknown };
	create(targetCwd: string): { getSessionFile(): string | null | undefined; getHeader(): unknown };
	forkFrom(sessionFile: string, targetCwd: string): { getSessionFile(): string | null | undefined; getHeader(): unknown };
};

export type WorktreeListOverlayDeps = {
	getMarkdownTheme(): unknown;
	Key: { escape: string; up: string; down: string; ctrl(key: string): string };
	Markdown: new (markdown: string, x: number, y: number, theme: unknown) => { render(width: number): string[] };
	matchesKey(data: string, key: string): boolean;
	truncateToWidth(content: string, width: number, suffix: string): string;
	visibleWidth(content: string): number;
};

export type SelectItem = { value: string; label: string; description?: string };

export type CreatedWorktree = {
	primaryPath: string;
	worktreePath: string;
	branch: string;
	base: string;
};

export type ScratchWorktreeResult =
	| { action: "created"; worktree: CreatedWorktree }
	| { action: "selected"; worktreePath: string; branch: string };

export type WorktreeCommandResult =
	| { kind: "noop" }
	| { kind: "notify"; message: string; level?: "info" | "warning" | "error" }
	| { kind: "overlay"; title: string; markdown: string }
	| { kind: "move-session"; targetCwd: string; commandName: string; message?: string };

export type InteractiveCommandOptions = {
	mode?: "message" | "interactive";
	selectWorktreeTarget?: (ctx: ExtensionCommandContext, entries: WorktreeEntry[]) => Promise<string | null>;
	commandContext?: ExtensionCommandContext;
	assertCanMoveSession?: () => void;
};
