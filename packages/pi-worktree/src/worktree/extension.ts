import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { parseWorktreeArgs } from "./commands.ts";
import { executeParsedWorktreeCommand } from "./dispatcher.ts";
import { presentWorktreeCommandResult, selectWorktreeFromMenu } from "./presentation.ts";
import { requirePersistentSessionFile, toMoveSessionContext } from "./session.ts";
import type { MoveSessionContext } from "./types.ts";

export default function worktreeExtension(pi: ExtensionAPI): void {
	pi.registerCommand("worktree", {
		description: "Create, enter, list, and safely clean git worktrees",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			try {
				const parsedArgs = parseWorktreeArgs(args);
				const runtime = {
					cwd: ctx.cwd,
					exec: pi.exec.bind(pi),
					platform: process.platform,
				};
				let moveCtx: MoveSessionContext | null = null;
				const getMoveCtx = () => {
					moveCtx ??= toMoveSessionContext(ctx);
					return moveCtx;
				};
				const result = await executeParsedWorktreeCommand(parsedArgs, runtime, {
					mode: "interactive",
					commandContext: ctx,
					selectWorktreeTarget: selectWorktreeFromMenu,
					assertCanMoveSession: () => {
						requirePersistentSessionFile(getMoveCtx());
					},
				});
				await presentWorktreeCommandResult(pi, ctx, getMoveCtx, result);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
