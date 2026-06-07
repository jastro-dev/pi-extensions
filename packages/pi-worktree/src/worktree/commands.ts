import path from "node:path";

import type { CleanupClassification, ParsedArgs, SelectItem, WorktreeEntry, WorktreeStatus } from "./types.ts";

export function slugifyTask(input: string): string {
	const slug = input
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80)
		.replace(/-+$/g, "");

	return slug || "task";
}

export function parseIssueUrl(input: string): { owner: string; repo: string; number: number; url: string } | null {
	const parsed = parseGitHubWorkItemUrl(input);
	return parsed?.kind === "issue" ? { owner: parsed.owner, repo: parsed.repo, number: parsed.number, url: parsed.url } : null;
}

export function parseGitHubWorkItemUrl(input: string): { kind: "issue" | "pull"; owner: string; repo: string; number: number; url: string } | null {
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		return null;
	}

	if (url.hostname.toLowerCase() !== "github.com") return null;
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length < 4 || (parts[2] !== "issues" && parts[2] !== "pull")) return null;
	const number = Number(parts[3]);
	if (!Number.isInteger(number) || number <= 0) return null;

	return { kind: parts[2] === "pull" ? "pull" : "issue", owner: parts[0], repo: parts[1], number, url: input };
}

export function tokenizeArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;

	for (const char of input) {
		if ((char === '"' || char === "'") && quote === null) {
			quote = char;
			continue;
		}

		if (char === quote) {
			quote = null;
			continue;
		}

		if (/\s/.test(char) && quote === null) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (quote !== null) throw new Error("Unclosed quote in /worktree arguments");
	if (current) tokens.push(current);
	return tokens;
}

export function parseWorktreeArgs(input: string): ParsedArgs {
	const tokens = tokenizeArgs(input.trim());
	if (tokens.length === 0 || tokens[0] === "help" || tokens[0] === "--help" || tokens[0] === "-h") {
		return { command: "help" };
	}

	const [command, ...rest] = tokens;
	if (command === "list") {
		if (rest.length > 0) throw new Error("Usage: /worktree list");
		return { command: "list" };
	}

	if (command === "cd") {
		if (rest.length === 0) return { command: "cd" };
		if (rest.some((token) => token.startsWith("--"))) throw new Error("Usage: /worktree cd [path|branch|folder-name]");
		return { command: "cd", target: rest.join(" ").trim() };
	}

	if (command === "clean" || command === "cleanup") {
		let apply = false;
		for (const token of rest) {
			if (token === "--apply") {
				apply = true;
				continue;
			}
			throw new Error("Usage: /worktree clean [--apply]");
		}
		return { command: "cleanup", apply };
	}

	if (command === "scratch") {
		if (rest.length === 0) return { command: "scratch" };
		if (rest.length === 1 && /^\d+$/.test(rest[0]) && Number(rest[0]) > 0) {
			return { command: "scratch", slot: Number(rest[0]) };
		}
		throw new Error("Usage: /worktree scratch [slot-number]");
	}

	if (command !== "create" && command !== "ccd") throw new Error(`Unknown /worktree command: ${command}`);

	const taskTokens: string[] = [];
	const options: { base?: string; branch?: string; path?: string } = {};
	for (let i = 0; i < rest.length; i += 1) {
		const token = rest[i];
		if (token === "--base" || token === "--branch" || token === "--path") {
			const value = rest[i + 1];
			if (!value) throw new Error(`Missing value for ${token}`);
			if (token === "--base") options.base = value;
			if (token === "--branch") options.branch = value;
			if (token === "--path") options.path = value;
			i += 1;
			continue;
		}

		if (token.startsWith("--")) throw new Error(`Unknown option: ${token}`);
		taskTokens.push(token);
	}

	const task = taskTokens.join(" ").trim();
	if (!task) throw new Error(`Usage: /worktree ${command} <task-or-issue-url> [--base <ref>] [--branch <name>] [--path <path>]`);
	return { command, task, ...options };
}

export function parseWorktreePorcelain(output: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | null = null;

	const finish = () => {
		if (current?.path) entries.push(current);
		current = null;
	};

	for (const line of output.split(/\r?\n/)) {
		if (!line.trim()) {
			finish();
			continue;
		}

		const separator = line.indexOf(" ");
		const key = separator === -1 ? line : line.slice(0, separator);
		const value = separator === -1 ? "" : line.slice(separator + 1);

		if (key === "worktree") {
			finish();
			current = { path: value };
			continue;
		}

		if (!current) continue;
		if (key === "HEAD") current.head = value;
		if (key === "branch") current.branch = value;
		if (key === "detached") current.detached = true;
		if (key === "bare") current.bare = true;
		if (key === "locked") current.locked = value || true;
		if (key === "prunable") current.prunable = value || true;
	}

	finish();
	return entries;
}

export function localBranchName(ref?: string): string | null {
	if (!ref) return null;
	if (!ref.startsWith("refs/heads/")) return null;
	return ref.slice("refs/heads/".length);
}

export function formatCdCommand(targetPath: string, platform: NodeJS.Platform = process.platform): string {
	const quoted = `'${targetPath.replace(/'/g, "''")}'`;
	return platform === "win32" ? `Set-Location ${quoted}` : `cd ${quoted}`;
}

export function normalizePathForComparison(value: string, platform: NodeJS.Platform = process.platform): string {
	const resolved = path.resolve(value).replace(/[\\/]+$/, "");
	return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function chooseGeneratedNames(input: {
	repoName: string;
	parentDir: string;
	slug: string;
	pathSlug?: string;
	branchOverride?: string;
	pathOverride?: string;
	pathBase?: string;
	existingBranches: ReadonlySet<string>;
	existingPaths: ReadonlySet<string>;
	platform?: NodeJS.Platform;
}): { branch: string; worktreePath: string } {
	for (let suffixNumber = 0; ; suffixNumber += 1) {
		const suffix = suffixNumber === 0 ? "" : `-${suffixNumber + 1}`;
		const generatedBranch = `worktree/${input.slug}${suffix}`;
		const generatedPath = path.join(input.parentDir, `${input.repoName}-wt-${input.pathSlug ?? input.slug}${suffix}`);
		const branch = input.branchOverride ?? generatedBranch;
		const worktreePath = input.pathOverride ? path.resolve(input.pathBase ?? process.cwd(), input.pathOverride) : generatedPath;
		const pathKey = normalizePathForComparison(worktreePath, input.platform);

		const branchOk = Boolean(input.branchOverride) || !input.existingBranches.has(branch);
		const pathOk = Boolean(input.pathOverride) || !input.existingPaths.has(pathKey);
		if (branchOk && pathOk) return { branch, worktreePath };
	}
}

export function classifyCleanupEntries(entries: WorktreeStatus[], mergedBranches: ReadonlySet<string>): CleanupClassification[] {
	const [primary, ...linked] = entries;
	if (!primary) return [];

	return linked.map((entry) => {
		const branch = localBranchName(entry.branch);
		if (entry.prunable) {
			return { action: "eligible", entry, branch: branch && mergedBranches.has(branch) ? branch : undefined, pruneStale: true };
		}
		if (entry.locked) {
			return { action: "skip", entry, reason: "locked worktree", next: `Unlock manually if safe: git worktree unlock ${entry.path}` };
		}
		if (entry.dirty) {
			return { action: "skip", entry, reason: "dirty worktree", next: `Review or commit changes in ${entry.path}` };
		}
		if (entry.detached) {
			return { action: "skip", entry, reason: "detached HEAD", next: `Inspect manually: git -C ${entry.path} status` };
		}
		if (!entry.branch) {
			return { action: "skip", entry, reason: "missing branch", next: `Inspect manually: git -C ${entry.path} status` };
		}
		if (!branch) {
			return { action: "skip", entry, reason: "branch is not a local refs/heads branch", next: `Inspect manually: git -C ${entry.path} branch -vv` };
		}
		if (!mergedBranches.has(branch)) {
			return { action: "skip", entry, reason: "local branch is not strictly merged", next: `Merge ${branch} or remove it manually if it was squash-merged` };
		}

		return { action: "eligible", entry, branch, pruneStale: false };
	});
}

export function formatHelp(): string {
	return [
		"/worktree commands:",
		"  /worktree create <task-or-issue-url> [--base <ref>] [--branch <name>] [--path <path>]",
		"  /worktree ccd <task-or-issue-url> [--base <ref>] [--branch <name>] [--path <path>]",
		"  /worktree cd [path|branch|folder-name]",
		"  /worktree scratch [slot-number]",
		"  /worktree list",
		"  /worktree clean [--apply]",
	].join("\n");
}

export function sortWorktreeCdEntries(entries: WorktreeEntry[]): WorktreeEntry[] {
	const [primary, ...linked] = entries;
	const sortedLinked = linked
		.map((entry, index) => ({ entry, index }))
		.sort((left, right) => {
			const recentDelta = (right.entry.recentAtMs ?? Number.NEGATIVE_INFINITY) - (left.entry.recentAtMs ?? Number.NEGATIVE_INFINITY);
			return recentDelta || left.index - right.index;
		})
		.map(({ entry }) => entry);

	return primary ? [primary, ...sortedLinked] : sortedLinked;
}

export function buildWorktreeCdItems(entries: WorktreeEntry[]): { items: SelectItem[]; pathByValue: Map<string, string> } {
	const sortedEntries = sortWorktreeCdEntries(entries);
	const primary = sortedEntries[0];
	const selectable = sortedEntries.filter((entry): entry is WorktreeEntry => Boolean(entry) && !entry.prunable);
	const pathByValue = new Map<string, string>();
	const longestName = Math.min(
		36,
		Math.max(
			1,
			...selectable.map((entry) => (localBranchName(entry.branch) ?? (path.basename(entry.path) || entry.path)).length),
		),
	);

	const items = selectable.map((entry) => {
		const branch = localBranchName(entry.branch) ?? (entry.detached ? "detached" : "missing");
		const name = branch === "missing" ? path.basename(entry.path) || entry.path : branch;
		const label = name.length > longestName ? `${name.slice(0, Math.max(0, longestName - 1))}…` : name.padEnd(longestName);
		const role = entry === primary ? "primary" : "linked";

		pathByValue.set(entry.path, entry.path);
		return {
			value: entry.path,
			label,
			description: `${role.padEnd(7)} ${entry.path}`,
		};
	});

	return { items, pathByValue };
}

export function selectWorktreeCdTarget(entries: WorktreeEntry[], cwd: string, target: string, platform: NodeJS.Platform = process.platform): string {
	const resolvedTargetPath = normalizePathForComparison(path.resolve(cwd, target), platform);
	const matches = entries.filter((entry) => {
		const branch = localBranchName(entry.branch);
		return (
			normalizePathForComparison(entry.path, platform) === resolvedTargetPath
			|| path.basename(entry.path) === target
			|| branch === target
			|| entry.branch === target
		);
	});

	if (matches.length === 1) return matches[0].path;
	if (matches.length > 1) throw new Error(`Ambiguous worktree target: ${target}`);
	throw new Error(`No worktree matched target: ${target}`);
}

export function escapeTableCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
