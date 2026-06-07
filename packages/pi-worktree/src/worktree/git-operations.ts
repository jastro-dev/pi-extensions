import { promises as fs } from "node:fs";
import path from "node:path";

import { GIT_TIMEOUT_MS } from "./constants.ts";
import {
	chooseGeneratedNames,
	classifyCleanupEntries,
	escapeTableCell,
	formatCdCommand,
	localBranchName,
	normalizePathForComparison,
	parseGitHubWorkItemUrl,
	parseWorktreePorcelain,
	selectWorktreeCdTarget,
	slugifyTask,
} from "./commands.ts";
import type { CleanupClassification, CreateWorktreeArgs, CreatedWorktree, ExecResult, ParsedArgs, Runtime, ScratchWorktreeResult, WorktreeEntry, WorktreeStatus } from "./types.ts";

export async function git(runtime: Runtime, cwd: string, args: string[]): Promise<ExecResult> {
	return runtime.exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
}

export async function requireGit(runtime: Runtime, cwd: string, args: string[], description: string): Promise<string> {
	const result = await git(runtime, cwd, args);
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		throw new Error(`${description} failed: ${detail}`);
	}
	return result.stdout;
}

export async function loadWorktrees(runtime: Runtime): Promise<WorktreeEntry[]> {
	const stdout = await requireGit(runtime, runtime.cwd, ["worktree", "list", "--porcelain"], "git worktree list");
	const entries = parseWorktreePorcelain(stdout);
	if (entries.length === 0) throw new Error("No git worktrees found for the current repository");
	return entries;
}

function worktreeRecentAtMs(stats: { birthtimeMs: number; ctimeMs: number; mtimeMs: number }): number {
	return Math.max(...[stats.birthtimeMs, stats.ctimeMs, stats.mtimeMs].filter(Number.isFinite));
}

export async function withWorktreeRecentness(entries: WorktreeEntry[]): Promise<WorktreeEntry[]> {
	const [primary, ...linked] = entries;
	const annotated = await Promise.all(linked.map(async (entry) => {
		try {
			return { ...entry, recentAtMs: worktreeRecentAtMs(await fs.stat(entry.path)) };
		} catch {
			return entry;
		}
	}));

	return primary ? [primary, ...annotated] : annotated;
}

export async function resolveWorktreeCdTarget(runtime: Runtime, args: Extract<ParsedArgs, { command: "cd" }>): Promise<string> {
	const entries = await loadWorktrees(runtime);
	if (!args.target) throw new Error("No worktree selected");
	return selectWorktreeCdTarget(entries, runtime.cwd, args.target, runtime.platform);
}

async function currentGitRoot(runtime: Runtime): Promise<string> {
	return (await requireGit(runtime, runtime.cwd, ["rev-parse", "--show-toplevel"], "git rev-parse --show-toplevel")).trim();
}

async function branchExists(runtime: Runtime, cwd: string, branch: string): Promise<boolean> {
	const result = await git(runtime, cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
	return result.code === 0;
}

async function existingLocalBranches(runtime: Runtime, cwd: string): Promise<Set<string>> {
	const stdout = await requireGit(runtime, cwd, ["branch", "--format=%(refname:short)"], "git branch");
	return new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

async function mergedLocalBranches(runtime: Runtime, cwd: string, targetRef: string): Promise<Set<string>> {
	const stdout = await requireGit(runtime, cwd, ["branch", "--format=%(refname:short)", "--merged", targetRef], `git branch --merged ${targetRef}`);
	return new Set(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

async function cleanupMergeTarget(runtime: Runtime, primaryPath: string): Promise<string> {
	const defaultRemote = await git(runtime, primaryPath, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
	if (defaultRemote.code === 0 && defaultRemote.stdout.trim()) return defaultRemote.stdout.trim();
	return (await requireGit(runtime, primaryPath, ["rev-parse", "--verify", "HEAD"], "git rev-parse HEAD")).trim();
}

async function currentHead(runtime: Runtime): Promise<string> {
	return (await requireGit(runtime, runtime.cwd, ["rev-parse", "--verify", "HEAD"], "git rev-parse HEAD")).trim();
}

async function statusForEntries(runtime: Runtime, entries: WorktreeEntry[], mergedBranches: ReadonlySet<string>): Promise<WorktreeStatus[]> {
	const statuses: WorktreeStatus[] = [];
	for (const entry of entries) {
		if (entry.prunable) {
			const branch = localBranchName(entry.branch);
			statuses.push({
				...entry,
				dirty: false,
				merged: branch ? mergedBranches.has(branch) : null,
			});
			continue;
		}

		const result = await git(runtime, entry.path, ["status", "--porcelain"]);
		const branch = localBranchName(entry.branch);
		statuses.push({
			...entry,
			dirty: result.code !== 0 || result.stdout.trim().length > 0,
			merged: branch ? mergedBranches.has(branch) : null,
		});
	}
	return statuses;
}

async function resolveIssueSlugs(runtime: Runtime, task: string): Promise<{ branchSlug: string; pathSlug: string } | null> {
	const item = parseGitHubWorkItemUrl(task);
	if (!item) return null;
	const ghCommand = item.kind === "pull" ? "pr" : "issue";
	const prefix = `${item.kind === "pull" ? "pr" : "issue"}-${item.number}`;

	const result = await runtime.exec("gh", [ghCommand, "view", item.url, "--json", "title", "--jq", ".title"], {
		cwd: runtime.cwd,
		timeout: GIT_TIMEOUT_MS,
	});
	if (result.code !== 0 || !result.stdout.trim()) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		throw new Error(`Could not fetch GitHub ${item.kind === "pull" ? "pull request" : "issue"} title for ${item.url}: ${detail}`);
	}

	return { branchSlug: `${prefix}-${slugifyTask(result.stdout.trim())}`, pathSlug: prefix };
}

export async function createWorktreeWithPath(runtime: Runtime, args: CreateWorktreeArgs): Promise<CreatedWorktree> {
	const entries = await loadWorktrees(runtime);
	const primaryPath = entries[0].path;
	const repoName = path.basename(primaryPath);
	const parentDir = path.dirname(primaryPath);
	const existingPaths = new Set(entries.map((entry) => normalizePathForComparison(entry.path, runtime.platform)));
	const existingBranches = await existingLocalBranches(runtime, primaryPath);
	const issueSlugs = await resolveIssueSlugs(runtime, args.task);
	const slug = issueSlugs?.branchSlug ?? slugifyTask(args.task);
	const pathSlug = issueSlugs?.pathSlug ?? slug;
	const base = args.base ?? (await currentHead(runtime));

	for (;;) {
		const { branch, worktreePath } = chooseGeneratedNames({
			repoName,
			parentDir,
			slug,
			pathSlug,
			branchOverride: args.branch,
			pathOverride: args.path,
			pathBase: runtime.cwd,
			existingBranches,
			existingPaths,
			platform: runtime.platform,
		});

		if (args.path || !(await pathExists(worktreePath))) {
			return addWorktree(runtime, primaryPath, worktreePath, branch, base);
		}

		existingPaths.add(normalizePathForComparison(worktreePath, runtime.platform));
	}
}

export async function addWorktree(runtime: Runtime, primaryPath: string, worktreePath: string, branch: string, base: string): Promise<CreatedWorktree> {
	const result = await git(runtime, primaryPath, ["worktree", "add", "-b", branch, worktreePath, base]);
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		throw new Error(`git worktree add failed: ${detail}`);
	}
	return { primaryPath, worktreePath, branch, base };
}

export async function scratchWorktree(runtime: Runtime, slot?: number, beforeCreate?: () => Promise<void>): Promise<ScratchWorktreeResult> {
	const entries = await loadWorktrees(runtime);
	const primaryPath = entries[0].path;
	const repoName = path.basename(primaryPath);
	const parentDir = path.dirname(primaryPath);
	const mergedBranches = await mergedLocalBranches(runtime, primaryPath, await cleanupMergeTarget(runtime, primaryPath));
	const statuses = await statusForEntries(runtime, entries, mergedBranches);
	const existingByPath = new Map(statuses.map((entry) => [normalizePathForComparison(entry.path, runtime.platform), entry]));

	for (let candidate = slot ?? 1; candidate < 1000; candidate += 1) {
		const scratchPath = path.join(parentDir, `${repoName}-wt-${candidate}`);
		const key = normalizePathForComparison(scratchPath, runtime.platform);
		const existing = existingByPath.get(key);
		if (existing) {
			if (existing.dirty) {
				if (slot) throw new Error(`Scratch slot ${slot} is dirty: ${scratchPath}`);
				continue;
			}

			return { action: "selected", worktreePath: existing.path, branch: localBranchName(existing.branch) ?? "detached" };
		}

		if (await pathExists(scratchPath)) {
			if (slot) throw new Error(`Scratch slot path exists but is not a git worktree: ${scratchPath}`);
			continue;
		}

		const branch = await chooseScratchBranch(runtime, primaryPath, candidate);
		await beforeCreate?.();
		return { action: "created", worktree: await addWorktree(runtime, primaryPath, scratchPath, branch, await currentHead(runtime)) };
	}

	throw new Error("Could not find an available clean scratch slot below 1000");
}

async function chooseScratchBranch(runtime: Runtime, primaryPath: string, slot: number): Promise<string> {
	const base = `worktree/scratch-${slot}`;
	if (!(await branchExists(runtime, primaryPath, base))) return base;
	for (let suffix = 2; suffix < 1000; suffix += 1) {
		const branch = `${base}-${suffix}`;
		if (!(await branchExists(runtime, primaryPath, branch))) return branch;
	}
	throw new Error(`Could not choose a scratch branch for slot ${slot}`);
}

export async function listWorktrees(runtime: Runtime): Promise<string> {
	const entries = await loadWorktrees(runtime);
	const primaryPath = entries[0].path;
	const mergedBranches = await mergedLocalBranches(runtime, primaryPath, await cleanupMergeTarget(runtime, primaryPath));
	const statuses = await statusForEntries(runtime, entries, mergedBranches);
	const lines = [
		"## Current repository worktrees",
		"",
		"| Role | Branch | Dirty | Merged | Prunable | Path |",
		"| --- | --- | --- | --- | --- | --- |",
	];

	for (const [index, entry] of statuses.entries()) {
		const branch = localBranchName(entry.branch) ?? (entry.detached ? "detached" : "missing");
		const merged = entry.merged === null ? "n/a" : entry.merged ? "yes" : "no";
		const role = index === 0 ? "primary" : "linked";
		lines.push(`| ${role} | ${escapeTableCell(branch)} | ${entry.dirty ? "yes" : "no"} | ${merged} | ${entry.prunable ? "yes" : "no"} | ${escapeTableCell(entry.path)} |`);
	}

	return lines.join("\n");
}

export async function cleanupWorktrees(runtime: Runtime, apply: boolean): Promise<string> {
	const entries = await loadWorktrees(runtime);
	const primaryPath = entries[0].path;
	const currentRoot = await currentGitRoot(runtime);
	if (normalizePathForComparison(currentRoot, runtime.platform) !== normalizePathForComparison(primaryPath, runtime.platform)) {
		throw new Error(`Refusing cleanup from a linked worktree. Run from the primary worktree: ${primaryPath}`);
	}

	const mergeTarget = await cleanupMergeTarget(runtime, primaryPath);
	const mergedBranches = await mergedLocalBranches(runtime, primaryPath, mergeTarget);
	const statuses = await statusForEntries(runtime, entries, mergedBranches);
	const classifications = classifyCleanupEntries(statuses, mergedBranches);
	const eligible = classifications.filter((item): item is Extract<CleanupClassification, { action: "eligible" }> => item.action === "eligible");
	const skipped = classifications.filter((item): item is Extract<CleanupClassification, { action: "skip" }> => item.action === "skip");

	if (apply) {
		if (eligible.some((item) => item.pruneStale)) {
			const result = await git(runtime, primaryPath, ["worktree", "prune"]);
			if (result.code !== 0) {
				const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
				throw new Error(`git worktree prune failed: ${detail}`);
			}
		}

		for (const item of eligible) {
			if (!item.pruneStale) {
				const result = await git(runtime, primaryPath, ["worktree", "remove", item.entry.path]);
				if (result.code !== 0) {
					const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
					throw new Error(`git worktree remove failed for ${item.entry.path}: ${detail}`);
				}
			}

			if (item.branch) {
				const result = await git(runtime, primaryPath, ["branch", "-d", item.branch]);
				if (result.code !== 0) {
					const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
					throw new Error(`git branch -d failed for ${item.branch}: ${detail}`);
				}
			}
		}
	}

	return formatCleanupResult(eligible, skipped, apply);
}

function formatCleanupResult(
	eligible: Extract<CleanupClassification, { action: "eligible" }>[],
	skipped: Extract<CleanupClassification, { action: "skip" }>[],
	apply: boolean,
): string {
	const lines = [apply ? "Cleanup applied." : "Cleanup dry-run."];
	if (eligible.length === 0) {
		lines.push(apply ? "Applied cleanup actions: none" : "Eligible removals: none");
	} else {
		lines.push(apply ? "Applied cleanup actions:" : "Eligible removals:");
		for (const item of eligible) {
			const action = item.pruneStale ? (apply ? "pruned stale metadata" : "prune stale metadata") : (apply ? "removed worktree" : "remove worktree");
			const branch = item.branch ? ` | branch: ${item.branch}` : " | branch: kept";
			lines.push(`  ${item.entry.path} | ${action}${branch}`);
		}
	}

	if (skipped.length > 0) {
		lines.push("Skipped:");
		for (const item of skipped) lines.push(`  ${item.entry.path} | ${item.reason}; next: ${item.next}`);
	}

	if (!apply) lines.push("Run /worktree clean --apply to remove eligible worktrees.");
	return lines.join("\n");
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.access(targetPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export function formatCreatedWorktree(worktree: CreatedWorktree, platform: NodeJS.Platform | undefined, envLines: string[] = []): string {
	return [
		"Created worktree:",
		`Path: ${worktree.worktreePath}`,
		`Branch: ${worktree.branch}`,
		`Base: ${worktree.base}`,
		...envLines,
		`cd: ${formatCdCommand(worktree.worktreePath, platform)}`,
	].join("\n");
}

export function formatScratchSelection(result: ScratchWorktreeResult, platform: NodeJS.Platform | undefined, envLines: string[] = []): string {
	if (result.action === "created") return formatCreatedWorktree(result.worktree, platform, envLines);
	return [
		"Selected scratch worktree:",
		`Path: ${result.worktreePath}`,
		`Branch: ${result.branch}`,
		"Base: existing worktree",
		`cd: ${formatCdCommand(result.worktreePath, platform)}`,
	].join("\n");
}
