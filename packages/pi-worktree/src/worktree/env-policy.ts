import { promises as fs } from "node:fs";
import path from "node:path";

import { DEFAULT_WORKTREE_CONFIG_PATH } from "./constants.ts";
import type { CreatedWorktree, EnvLinkSummary, Runtime, WorktreeConfig } from "./types.ts";

export type EnvLinkPolicy = {
	config: WorktreeConfig;
};

export async function prepareEnvLinkPolicy(runtime: Runtime): Promise<EnvLinkPolicy> {
	return { config: await readWorktreeConfig(runtime.worktreeConfigPath) };
}

export async function applyEnvLinkPolicy(policy: EnvLinkPolicy, worktree: CreatedWorktree): Promise<EnvLinkSummary> {
	return linkEnvFiles(worktree.primaryPath, worktree.worktreePath, policy.config);
}

export function formatEnvLinkSummary(summary: EnvLinkSummary): string[] {
	const lines: string[] = [];
	if (summary.linked.length > 0) lines.push(`Env links: ${summary.linked.join(", ")}`);
	if (summary.skipped.length > 0) lines.push(`Env links skipped: ${summary.skipped.join(", ")}`);
	if (summary.failed.length > 0) lines.push(`Env links failed: ${summary.failed.join(", ")}`);
	return lines;
}

async function readWorktreeConfig(configPath = DEFAULT_WORKTREE_CONFIG_PATH): Promise<WorktreeConfig> {
	let raw: string;
	try {
		raw = await fs.readFile(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { autoSymlinkEnvFiles: true };
		throw new Error(`Could not read worktree config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid worktree config JSON at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid worktree config at ${configPath}: expected an object`);
	}

	const value = (parsed as { autoSymlinkEnvFiles?: unknown }).autoSymlinkEnvFiles;
	if (value === undefined) return { autoSymlinkEnvFiles: true };
	if (typeof value === "boolean") return { autoSymlinkEnvFiles: value };
	if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0 && !item.includes("/") && !item.includes("\\"))) {
		return { autoSymlinkEnvFiles: value };
	}

	throw new Error(`Invalid worktree config at ${configPath}: autoSymlinkEnvFiles must be true, false, or an array of top-level file names`);
}

async function listEnvFileNames(primaryPath: string, setting: boolean | string[]): Promise<string[]> {
	if (setting === false) return [];
	if (Array.isArray(setting)) {
		const names: string[] = [];
		for (const name of setting) {
			try {
				const stats = await fs.lstat(path.join(primaryPath, name));
				if (stats.isFile() || stats.isSymbolicLink()) names.push(name);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		return names;
	}

	const entries = await fs.readdir(primaryPath, { withFileTypes: true });
	return entries
		.filter((entry) => (entry.name === ".env" || entry.name.startsWith(".env.")) && (entry.isFile() || entry.isSymbolicLink()))
		.map((entry) => entry.name)
		.sort();
}

async function linkEnvFiles(primaryPath: string, worktreePath: string, config: WorktreeConfig): Promise<EnvLinkSummary> {
	const summary: EnvLinkSummary = { linked: [], skipped: [], failed: [] };
	const names = await listEnvFileNames(primaryPath, config.autoSymlinkEnvFiles);
	for (const name of names) {
		const targetPath = path.join(worktreePath, name);
		try {
			await fs.lstat(targetPath);
			summary.skipped.push(`${name} exists`);
			continue;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}

		const sourcePath = path.join(primaryPath, name);
		const relativeTarget = path.relative(worktreePath, sourcePath) || sourcePath;
		await fs.symlink(relativeTarget, targetPath);
		summary.linked.push(name);
	}

	return summary;
}
