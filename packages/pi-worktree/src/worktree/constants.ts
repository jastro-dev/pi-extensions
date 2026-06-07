import os from "node:os";
import path from "node:path";

export const GIT_TIMEOUT_MS = 30_000;
export const TRASH_TIMEOUT_MS = 5000;
export const HEADER_READ_MAX = 8192;
export const COPY_CHUNK_SIZE = 65_536;
export const DEFAULT_WORKTREE_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "extensions", "worktree.json");
