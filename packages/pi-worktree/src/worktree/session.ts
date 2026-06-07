import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { closeSync, openSync, readSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";

import { COPY_CHUNK_SIZE, HEADER_READ_MAX, TRASH_TIMEOUT_MS } from "./constants.ts";
import type { MoveSessionContext, SessionManagerStatic } from "./types.ts";

function getBranchSelectionWarning(
	sessionManager: SessionManagerStatic,
	sourceSessionFile: string,
	currentLeafId: string | null,
	commandName: string,
	actionName: string,
): string | null {
	try {
		const persistedSession = sessionManager.open(sourceSessionFile);
		const hasPersistedEntries = persistedSession.getEntries().length > 0;
		if (!hasPersistedEntries) return null;

		const persistedLeafId = persistedSession.getLeafId() as string | null;
		if (currentLeafId === null) {
			return `${commandName} will not preserve the current /tree root selection. It reopens at the session file's default branch tip. Consider /fork first or continue from the branch tip before ${actionName}.`;
		}

		if (currentLeafId !== persistedLeafId) {
			return `${commandName} will not preserve the current /tree selection. It reopens at the session file's default branch tip. Consider /fork first or continue from the branch tip before ${actionName}.`;
		}
	} catch {
		return null;
	}

	return null;
}

export function clearParentSession(sessionFile: string): void {
	const fd = openSync(sessionFile, "r");
	const headerBuffer = Buffer.alloc(HEADER_READ_MAX);
	const bytesRead = readSync(fd, headerBuffer, 0, HEADER_READ_MAX, 0);
	const headerChunk = headerBuffer.toString("utf-8", 0, bytesRead);
	const newlineIndex = headerChunk.indexOf("\n");

	if (newlineIndex === -1) {
		closeSync(fd);
		return;
	}

	const header = JSON.parse(headerChunk.slice(0, newlineIndex));
	if (!header.parentSession) {
		closeSync(fd);
		return;
	}

	delete header.parentSession;
	const newHeaderLine = `${JSON.stringify(header)}\n`;
	const originalHeaderBytes = Buffer.byteLength(headerChunk.slice(0, newlineIndex + 1), "utf-8");
	const temporaryPath = `${sessionFile}.worktree-cd-tmp`;
	let writeFd: number | undefined;

	try {
		writeFd = openSync(temporaryPath, "w");
		const newHeaderBuffer = Buffer.from(newHeaderLine, "utf-8");
		writeSync(writeFd, newHeaderBuffer, 0, newHeaderBuffer.length);

		const copyBuffer = Buffer.alloc(COPY_CHUNK_SIZE);
		let position = originalHeaderBytes;
		for (;;) {
			const readCount = readSync(fd, copyBuffer, 0, COPY_CHUNK_SIZE, position);
			if (readCount === 0) break;
			writeSync(writeFd, copyBuffer, 0, readCount);
			position += readCount;
		}

		closeSync(writeFd);
		writeFd = undefined;
		closeSync(fd);
		renameSync(temporaryPath, sessionFile);
	} catch (error) {
		if (writeFd !== undefined) {
			try {
				closeSync(writeFd);
			} catch {
				// ignore cleanup close errors
			}
		}

		closeSync(fd);
		try {
			unlinkSync(temporaryPath);
		} catch {
			// ignore cleanup unlink errors
		}
		throw error;
	}
}

function isEmptySourceSessionError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("source session file is empty or invalid") || message.includes("source session has no header");
}

function ensureSessionHeaderFile(session: { getSessionFile(): string | null | undefined; getHeader(): unknown }): string {
	const sessionFile = session.getSessionFile();
	if (!sessionFile) throw new Error("Internal error: session manager produced no session file");

	try {
		if (statSync(sessionFile).size > 0) return sessionFile;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	const header = session.getHeader();
	if (!header) throw new Error("Internal error: session manager produced no session header");
	writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
	return sessionFile;
}

export function createDestinationSessionFile(sessionManager: SessionManagerStatic, sourceSessionFile: string, targetCwd: string): { sessionFile: string; forked: boolean } {
	try {
		return { sessionFile: ensureSessionHeaderFile(sessionManager.forkFrom(sourceSessionFile, targetCwd)), forked: true };
	} catch (error) {
		if (!isEmptySourceSessionError(error)) throw error;
		return { sessionFile: ensureSessionHeaderFile(sessionManager.create(targetCwd)), forked: false };
	}
}

async function trashFileBestEffort(pi: ExtensionAPI, filePath: string): Promise<void> {
	try {
		const { code } = await pi.exec("trash", [filePath], { timeout: TRASH_TIMEOUT_MS });
		if (code === 0) return;
	} catch {
		return;
	}
}

export function requirePersistentSessionFile(ctx: MoveSessionContext): string {
	const sourceSessionFile = ctx.sessionManager.getSessionFile();
	if (!sourceSessionFile) throw new Error("No persistent session file (maybe started with --no-session)");
	return sourceSessionFile;
}

export function toMoveSessionContext(ctx: ExtensionCommandContext): MoveSessionContext {
	const value: unknown = ctx;
	if (!isMoveSessionContext(value)) {
		throw new Error("Internal error: /worktree session move requires a command context with sessionManager and switchSession");
	}
	return value;
}

function isMoveSessionContext(value: unknown): value is MoveSessionContext {
	if (!value || typeof value !== "object") return false;
	const candidate = value as {
		cwd?: unknown;
		sessionManager?: { getSessionFile?: unknown; getLeafId?: unknown };
		ui?: { notify?: unknown };
		switchSession?: unknown;
	};
	return (
		typeof candidate.cwd === "string"
		&& typeof candidate.sessionManager?.getSessionFile === "function"
		&& typeof candidate.sessionManager.getLeafId === "function"
		&& typeof candidate.ui?.notify === "function"
		&& typeof candidate.switchSession === "function"
	);
}

export async function moveSessionToWorktree(pi: ExtensionAPI, ctx: MoveSessionContext, targetCwd: string, commandName = "/worktree cd"): Promise<void> {
	let targetCwdStat;
	try {
		targetCwdStat = statSync(targetCwd);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		throw new Error(code === "ENOENT" ? `Path does not exist: ${targetCwd}` : `Cannot access path: ${targetCwd}`);
	}

	if (!targetCwdStat.isDirectory()) throw new Error(`Not a directory: ${targetCwd}`);

	const sourceSessionFile = requirePersistentSessionFile(ctx);
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	const branchSelectionWarning = getBranchSelectionWarning(
		SessionManager,
		sourceSessionFile,
		ctx.sessionManager.getLeafId() as string | null,
		commandName,
		"moving",
	);
	if (branchSelectionWarning) ctx.ui.notify(branchSelectionWarning, "warning");

	const destination = createDestinationSessionFile(SessionManager, sourceSessionFile, targetCwd);
	const destSessionFile = destination.sessionFile;

	if (destination.forked) {
		try {
			clearParentSession(destSessionFile);
		} catch (error) {
			ctx.ui.notify(`Warning: could not clear parent session reference: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	await ctx.switchSession(destSessionFile, {
		withSession: async (newCtx) => {
			void trashFileBestEffort(pi, sourceSessionFile);
			newCtx.ui.notify(`Moved session to ${targetCwd}`, "info");
		},
	});
}
