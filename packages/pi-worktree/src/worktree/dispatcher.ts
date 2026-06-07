import { formatEnvLinkSummary, prepareEnvLinkPolicy, applyEnvLinkPolicy, type EnvLinkPolicy } from "./env-policy.ts";
import {
	cleanupWorktrees,
	createWorktreeWithPath,
	formatCreatedWorktree,
	formatScratchSelection,
	listWorktrees,
	loadWorktrees,
	resolveWorktreeCdTarget,
	scratchWorktree,
} from "./git-operations.ts";
import { formatHelp, parseWorktreeArgs } from "./commands.ts";
import type { InteractiveCommandOptions, ParsedArgs, Runtime, WorktreeCommandResult } from "./types.ts";

export async function executeParsedWorktreeCommand(args: ParsedArgs, runtime: Runtime, options: InteractiveCommandOptions = {}): Promise<WorktreeCommandResult> {
	const mode = options.mode ?? "message";

	switch (args.command) {
		case "help":
			return { kind: "notify", message: formatHelp() };
		case "create": {
			const envPolicy = await prepareEnvLinkPolicy(runtime);
			const worktree = await createWorktreeWithPath(runtime, args);
			const envSummary = await applyEnvLinkPolicy(envPolicy, worktree);
			return { kind: "notify", message: formatCreatedWorktree(worktree, runtime.platform, formatEnvLinkSummary(envSummary)) };
		}
		case "ccd": {
			if (mode === "interactive") options.assertCanMoveSession?.();
			const envPolicy = await prepareEnvLinkPolicy(runtime);
			const worktree = await createWorktreeWithPath(runtime, args);
			const envSummary = await applyEnvLinkPolicy(envPolicy, worktree);
			const message = formatCreatedWorktree(worktree, runtime.platform, formatEnvLinkSummary(envSummary));
			if (mode === "interactive") return { kind: "move-session", targetCwd: worktree.worktreePath, commandName: "/worktree ccd", message };
			return { kind: "notify", message };
		}
		case "cd": {
			if (mode === "interactive") {
				const targetCwd = args.target
					? await resolveWorktreeCdTarget(runtime, args)
					: await selectInteractiveTarget(runtime, options);
				if (!targetCwd) return { kind: "noop" };
				options.assertCanMoveSession?.();
				return { kind: "move-session", targetCwd, commandName: "/worktree cd" };
			}
			return { kind: "notify", message: `Target: ${await resolveWorktreeCdTarget(runtime, args)}` };
		}
		case "scratch": {
			let envPolicy: EnvLinkPolicy | null = null;
			const result = await scratchWorktree(runtime, args.slot, async () => {
				envPolicy = await prepareEnvLinkPolicy(runtime);
			});
			const envLines = result.action === "created" && envPolicy ? formatEnvLinkSummary(await applyEnvLinkPolicy(envPolicy, result.worktree)) : [];
			return { kind: "notify", message: formatScratchSelection(result, runtime.platform, envLines) };
		}
		case "list": {
			const markdown = await listWorktrees(runtime);
			return mode === "interactive" ? { kind: "overlay", title: "/worktree list", markdown } : { kind: "notify", message: markdown };
		}
		case "cleanup": {
			const markdown = await cleanupWorktrees(runtime, args.apply);
			return mode === "interactive" ? { kind: "overlay", title: args.apply ? "/worktree clean --apply" : "/worktree clean", markdown } : { kind: "notify", message: markdown };
		}
		default: {
			const _exhaustive: never = args;
			return _exhaustive;
		}
	}
}

async function selectInteractiveTarget(runtime: Runtime, options: InteractiveCommandOptions): Promise<string | null> {
	if (!options.selectWorktreeTarget || !options.commandContext) throw new Error("Usage: /worktree cd [path|branch|folder-name]");
	return options.selectWorktreeTarget(options.commandContext, await loadWorktrees(runtime));
}

export async function runWorktreeCommand(rawArgs: string, runtime: Runtime): Promise<string> {
	const parsedArgs = parseWorktreeArgs(rawArgs);
	return worktreeCommandResultToText(await executeParsedWorktreeCommand(parsedArgs, runtime, { mode: "message" }));
}

export function worktreeCommandResultToText(result: WorktreeCommandResult): string {
	switch (result.kind) {
		case "noop":
			return "";
		case "notify":
			return result.message;
		case "overlay":
			return result.markdown;
		case "move-session":
			return result.message ?? `Target: ${result.targetCwd}`;
		default: {
			const _exhaustive: never = result;
			return _exhaustive;
		}
	}
}
