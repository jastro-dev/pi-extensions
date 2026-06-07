import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
	buildWorktreeCdItems,
	chooseGeneratedNames,
	classifyCleanupEntries,
	clearParentSession,
	createDestinationSessionFile,
	formatCdCommand,
	localBranchName,
	parseGitHubWorkItemUrl,
	parseIssueUrl,
	parseWorktreeArgs,
	parseWorktreePorcelain,
	runWorktreeCommand,
	selectWorktreeCdTarget,
	slugifyTask,
	sortWorktreeCdEntries,
	default as worktreeExtension,
} from "../src/index.ts";

const execFileAsync = promisify(execFile);

test("slugifies task names safely", () => {
	assert.equal(slugifyTask("Fix flaky CI!!!"), "fix-flaky-ci");
	assert.equal(slugifyTask("  Add OAuth/Login flow  "), "add-oauth-login-flow");
	assert.equal(slugifyTask("---"), "task");
});

test("parses GitHub issue URLs", () => {
	assert.deepEqual(parseIssueUrl("https://github.com/acme/widgets/issues/123"), {
		owner: "acme",
		repo: "widgets",
		number: 123,
		url: "https://github.com/acme/widgets/issues/123",
	});
	assert.equal(parseIssueUrl("https://github.com/acme/widgets/pull/123"), null);
	assert.equal(parseIssueUrl("not a url"), null);
	assert.deepEqual(parseGitHubWorkItemUrl("https://github.com/acme/widgets/pull/123"), {
		kind: "pull",
		owner: "acme",
		repo: "widgets",
		number: 123,
		url: "https://github.com/acme/widgets/pull/123",
	});
});

test("parses command arguments and quoted flag values", () => {
	assert.deepEqual(parseWorktreeArgs("create fix bug --base main --branch worktree/fix --path 'C:/tmp/my wt'"), {
		command: "create",
		task: "fix bug",
		base: "main",
		branch: "worktree/fix",
		path: "C:/tmp/my wt",
	});
	assert.deepEqual(parseWorktreeArgs("ccd fix bug --base main --branch worktree/fix --path 'C:/tmp/my wt'"), {
		command: "ccd",
		task: "fix bug",
		base: "main",
		branch: "worktree/fix",
		path: "C:/tmp/my wt",
	});
	assert.deepEqual(parseWorktreeArgs("scratch 2"), { command: "scratch", slot: 2 });
	assert.deepEqual(parseWorktreeArgs("cd"), { command: "cd" });
	assert.throws(() => parseWorktreeArgs("cd --last"), /Usage: \/worktree cd \[path\|branch\|folder-name\]/);
	assert.deepEqual(parseWorktreeArgs("cd worktree/fix"), { command: "cd", target: "worktree/fix" });
	assert.deepEqual(parseWorktreeArgs("clean --apply"), { command: "cleanup", apply: true });
	assert.deepEqual(parseWorktreeArgs("cleanup --apply"), { command: "cleanup", apply: true });
	assert.throws(() => parseWorktreeArgs("create task --unknown"), /Unknown option/);
});

test("preserves backslashes in Windows-style paths", () => {
	assert.deepEqual(parseWorktreeArgs("create fix windows --path C:\\repo\\repo-wt-fix"), {
		command: "create",
		task: "fix windows",
		path: "C:\\repo\\repo-wt-fix",
	});
});

test("chooses numeric suffixes for generated branch or path collisions", () => {
	const selected = chooseGeneratedNames({
		repoName: "repo",
		parentDir: "/tmp",
		slug: "fix-bug",
		existingBranches: new Set(["worktree/fix-bug"]),
		existingPaths: new Set([path.resolve("/tmp/repo-wt-fix-bug-2")]),
		platform: "linux",
	});

	assert.equal(selected.branch, "worktree/fix-bug-3");
	assert.equal(selected.worktreePath, path.join("/tmp", "repo-wt-fix-bug-3"));
});

test("honors explicit generated-name overrides", () => {
	const selected = chooseGeneratedNames({
		repoName: "repo",
		parentDir: "/tmp",
		slug: "fix-bug",
		branchOverride: "feature/custom",
		pathOverride: "/tmp/custom path",
		existingBranches: new Set(["feature/custom"]),
		existingPaths: new Set([path.resolve("/tmp/custom path")]),
		platform: "linux",
	});

	assert.equal(selected.branch, "feature/custom");
	assert.equal(selected.worktreePath, path.resolve("/tmp/custom path"));
});

test("resolves relative explicit paths against the runtime base", () => {
	const selected = chooseGeneratedNames({
		repoName: "repo",
		parentDir: "/tmp",
		slug: "fix-bug",
		pathOverride: "../custom-wt",
		pathBase: "/tmp/repo/subdir",
		existingBranches: new Set(),
		existingPaths: new Set(),
		platform: "linux",
	});

	assert.equal(selected.worktreePath, path.resolve("/tmp/repo/subdir", "../custom-wt"));
});

test("parses git worktree porcelain including detached and locked states", () => {
	const entries = parseWorktreePorcelain([
		"worktree /repo",
		"HEAD abc123",
		"branch refs/heads/main",
		"",
		"worktree /repo-wt-task",
		"HEAD def456",
		"branch refs/heads/worktree/task",
		"locked maintenance",
		"",
		"worktree /repo-wt-detached",
		"HEAD fedcba",
		"detached",
		"",
		"worktree /repo-wt-prunable",
		"HEAD 111111",
		"branch refs/heads/worktree/prunable",
		"prunable gitdir file points to non-existent location",
	].join("\n"));

	assert.equal(entries.length, 4);
	assert.equal(entries[0].path, "/repo");
	assert.equal(entries[1].locked, "maintenance");
	assert.equal(entries[2].detached, true);
	assert.equal(entries[3].prunable, "gitdir file points to non-existent location");
});

test("classifies cleanup eligibility strictly", () => {
	const classifications = classifyCleanupEntries([
		{ path: "/repo", branch: "refs/heads/main", dirty: false, merged: true },
		{ path: "/repo-wt-merged", branch: "refs/heads/worktree/merged", dirty: false, merged: true },
		{ path: "/repo-wt-dirty", branch: "refs/heads/worktree/dirty", dirty: true, merged: true },
		{ path: "/repo-wt-remote", branch: "refs/remotes/origin/topic", dirty: false, merged: null },
		{ path: "/repo-wt-detached", detached: true, dirty: false, merged: null },
		{ path: "/repo-wt-missing", dirty: false, merged: null },
		{ path: "/repo-wt-locked", branch: "refs/heads/worktree/locked", dirty: false, merged: true, locked: true },
		{ path: "/repo-wt-prunable", branch: "refs/heads/worktree/prunable", dirty: true, merged: false, prunable: true },
	], new Set(["main", "worktree/merged", "worktree/dirty"]));

	assert.equal(classifications[0].action, "eligible");
	assert.equal(classifications[1].action, "skip");
	assert.match(classifications[1].action === "skip" ? classifications[1].reason : "", /dirty/);
	assert.equal(classifications[2].action, "skip");
	assert.match(classifications[2].action === "skip" ? classifications[2].reason : "", /not a local/);
	assert.equal(classifications[3].action, "skip");
	assert.match(classifications[3].action === "skip" ? classifications[3].reason : "", /detached/);
	assert.equal(classifications[4].action, "skip");
	assert.match(classifications[4].action === "skip" ? classifications[4].reason : "", /missing branch/);
	assert.equal(classifications[5].action, "skip");
	assert.match(classifications[5].action === "skip" ? classifications[5].reason : "", /locked/);
	assert.equal(classifications[6].action, "eligible");
	assert.equal(classifications[6].action === "eligible" ? classifications[6].pruneStale : false, true);
});

test("formats shell-specific cd commands", () => {
	assert.equal(formatCdCommand("C:/tmp/my repo", "win32"), "Set-Location 'C:/tmp/my repo'");
	assert.equal(formatCdCommand("/tmp/it's-here", "linux"), "cd '/tmp/it''s-here'");
});

test("extracts only local refs/heads branch names", () => {
	assert.equal(localBranchName("refs/heads/worktree/task"), "worktree/task");
	assert.equal(localBranchName("refs/remotes/origin/task"), null);
	assert.equal(localBranchName(undefined), null);
});

test("selects worktree cd targets by branch, folder, and path", () => {
	const entries = [
		{ path: "/repo", branch: "refs/heads/main" },
		{ path: "/repo-wt-api", branch: "refs/heads/worktree/api" },
		{ path: "/repo-wt-ui", branch: "refs/heads/worktree/ui" },
	];

	assert.equal(selectWorktreeCdTarget(entries, "/repo", "worktree/api", "linux"), "/repo-wt-api");
	assert.equal(selectWorktreeCdTarget(entries, "/repo", "repo-wt-ui", "linux"), "/repo-wt-ui");
	assert.equal(selectWorktreeCdTarget(entries, "/repo/subdir", "../../repo-wt-api", "linux"), "/repo-wt-api");
});

test("builds selectable worktree cd items and skips prunable entries", () => {
	const { items, pathByValue } = buildWorktreeCdItems([
		{ path: "/repo", branch: "refs/heads/main" },
		{ path: "/repo-wt-api", branch: "refs/heads/worktree/api", recentAtMs: 1000 },
		{ path: "/repo-wt-ui", branch: "refs/heads/worktree/ui", recentAtMs: 2000 },
		{ path: "/repo-wt-missing", branch: "refs/heads/worktree/missing", recentAtMs: 3000, prunable: true },
	]);

	assert.equal(items.length, 3);
	assert.match(items[0].description ?? "", /^primary\s+\/repo$/);
	assert.match(items[1].description ?? "", /^linked\s+\/repo-wt-ui$/);
	assert.match(items[2].description ?? "", /^linked\s+\/repo-wt-api$/);
	assert.equal(pathByValue.get("/repo-wt-api"), "/repo-wt-api");
});

test("sorts worktree cd entries with primary first then newest linked worktrees", () => {
	const sorted = sortWorktreeCdEntries([
		{ path: "/repo", branch: "refs/heads/main" },
		{ path: "/repo-wt-old", branch: "refs/heads/worktree/old", recentAtMs: 1000 },
		{ path: "/repo-wt-new", branch: "refs/heads/worktree/new", recentAtMs: 3000 },
		{ path: "/repo-wt-mid", branch: "refs/heads/worktree/mid", recentAtMs: 2000 },
	]);

	assert.deepEqual(sorted.map((entry) => entry.path), ["/repo", "/repo-wt-new", "/repo-wt-mid", "/repo-wt-old"]);
});

test("clears parentSession from a forked session header", async () => {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-session-test-"));
	const sessionFile = path.join(tempRoot, "session.jsonl");
	await fs.writeFile(sessionFile, `${JSON.stringify({ cwd: "/repo", parentSession: "old-session", keep: true })}\n{"type":"entry"}\n`);

	clearParentSession(sessionFile);

	const contents = await fs.readFile(sessionFile, "utf8");
	const [headerLine, entryLine] = contents.split("\n");
	assert.deepEqual(JSON.parse(headerLine), { cwd: "/repo", keep: true });
	assert.equal(entryLine, '{"type":"entry"}');
});

test("creates fresh destination session when source session is empty", async () => {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-empty-source-test-"));
	const freshSessionFile = path.join(tempRoot, "target.jsonl");
	const manager = {
		forkFrom() {
			throw new Error("Cannot fork: source session file is empty or invalid: source.jsonl");
		},
		create(targetCwd: string) {
			return {
				getSessionFile: () => freshSessionFile,
				getHeader: () => ({ type: "session", version: 1, id: "new-session", timestamp: "now", cwd: targetCwd }),
			};
		},
		open() {
			throw new Error("unused");
		},
	};

	const result = createDestinationSessionFile(manager, "source.jsonl", "/repo-wt-target");

	assert.deepEqual(result, { sessionFile: freshSessionFile, forked: false });
	const contents = await fs.readFile(freshSessionFile, "utf8");
	assert.deepEqual(JSON.parse(contents.trim()), { type: "session", version: 1, id: "new-session", timestamp: "now", cwd: "/repo-wt-target" });
});

test("registers the /worktree command", () => {
	let registeredName = "";
	let registeredDescription = "";
	worktreeExtension({
		registerCommand(name: string, options: { description?: string }) {
			registeredName = name;
			registeredDescription = options.description ?? "";
		},
	} as any);

	assert.equal(registeredName, "worktree");
	assert.match(registeredDescription, /worktrees/);
});

test("ccd requires a persistent session before creating a worktree", async () => {
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const notifications: Array<{ message: string; level?: string }> = [];
	worktreeExtension({
		registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			handler = options.handler;
		},
		exec() {
			throw new Error("exec should not run before session preflight");
		},
	} as any);

	await handler?.("ccd fix bug", {
		cwd: "/repo",
		waitForIdle: async () => {},
		sessionManager: {
			getSessionFile: () => null,
			getLeafId: () => null,
		},
		ui: {
			notify(message: string, level?: string) {
				notifications.push({ message, level });
			},
		},
		switchSession() {
			throw new Error("switchSession should not run before session preflight");
		},
	});

	assert.deepEqual(notifications, [{ message: "No persistent session file (maybe started with --no-session)", level: "error" }]);
});

test("renders /worktree help text", async () => {
	const help = await runWorktreeCommand("", {
		cwd: "/repo",
		exec: async () => ({ code: 1, stdout: "", stderr: "unexpected exec" }),
		platform: "linux",
	});
	assert.match(help, /\/worktree create/);
	assert.match(help, /\/worktree ccd/);
	assert.match(help, /\/worktree clean \[--apply\]/);
});

test("fails clearly when issue title lookup fails", async () => {
	const exec = async (command: string, args: string[]) => {
		if (command === "git" && args.join(" ") === "worktree list --porcelain") {
			return { code: 0, stdout: "worktree /repo\nHEAD abc\nbranch refs/heads/main\n", stderr: "" };
		}
		if (command === "git" && args[0] === "branch") {
			return { code: 0, stdout: "main\n", stderr: "" };
		}
		if (command === "git" && args.join(" ") === "rev-parse --verify HEAD") {
			return { code: 0, stdout: "abc\n", stderr: "" };
		}
		if (command === "gh") {
			return { code: 1, stdout: "", stderr: "gh auth required" };
		}
		return { code: 1, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}` };
	};

	await assert.rejects(
		runWorktreeCommand("create https://github.com/acme/widgets/issues/42", { cwd: "/repo", exec, platform: "linux" }),
		/Could not fetch GitHub issue title.*gh auth required/,
	);
});

test("creates issue-url branch names from fetched titles and short directory names", async () => {
	let addArgs: string[] | undefined;
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-issue-name-test-"));
	const configPath = path.join(tempRoot, "worktree.json");
	await fs.writeFile(configPath, JSON.stringify({ autoSymlinkEnvFiles: false }));
	const exec = async (command: string, args: string[]) => {
		if (command === "git" && args.join(" ") === "worktree list --porcelain") {
			return { code: 0, stdout: "worktree /repo\nHEAD abc\nbranch refs/heads/main\n", stderr: "" };
		}
		if (command === "git" && args[0] === "branch") {
			return { code: 0, stdout: "main\n", stderr: "" };
		}
		if (command === "git" && args.join(" ") === "rev-parse --verify HEAD") {
			return { code: 0, stdout: "abc\n", stderr: "" };
		}
		if (command === "gh") {
			return { code: 0, stdout: "Fix login bug\n", stderr: "" };
		}
		if (command === "git" && args[0] === "worktree" && args[1] === "add") {
			addArgs = args;
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 1, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}` };
	};

	const output = await runWorktreeCommand("create https://github.com/acme/widgets/issues/42", { cwd: "/repo", exec, platform: "linux", worktreeConfigPath: configPath });
	assert.match(output, /Branch: worktree\/issue-42-fix-login-bug/);
	assert.ok(addArgs);
	assert.equal(addArgs[3], "worktree/issue-42-fix-login-bug");
	assert.match(addArgs[4], /repo-wt-issue-42$/);
});

test("symlinks top-level env files after creating a worktree", async () => {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-env-test-"));
	const repo = path.join(tempRoot, "repo");
	const worktreePath = path.join(tempRoot, "repo-wt-env-links");
	await fs.mkdir(repo);
	await fs.writeFile(path.join(repo, ".env"), "BASE=1\n");
	await fs.writeFile(path.join(repo, ".env.local"), "LOCAL=1\n");
	await fs.mkdir(path.join(repo, ".env.dir"));

	const exec = async (command: string, args: string[]) => {
		if (command === "git" && args.join(" ") === "worktree list --porcelain") {
			return { code: 0, stdout: `worktree ${repo}\nHEAD abc\nbranch refs/heads/main\n`, stderr: "" };
		}
		if (command === "git" && args[0] === "branch") return { code: 0, stdout: "main\n", stderr: "" };
		if (command === "git" && args.join(" ") === "rev-parse --verify HEAD") return { code: 0, stdout: "abc\n", stderr: "" };
		if (command === "git" && args[0] === "worktree" && args[1] === "add") {
			await fs.mkdir(worktreePath);
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 1, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}` };
	};

	const output = await runWorktreeCommand("create env links --path ../repo-wt-env-links", {
		cwd: repo,
		exec,
		platform: "linux",
		worktreeConfigPath: path.join(tempRoot, "missing-config.json"),
	});

	assert.match(output, /Env links: \.env, \.env\.local/);
	assert.equal((await fs.lstat(path.join(worktreePath, ".env"))).isSymbolicLink(), true);
	assert.equal(await fs.readlink(path.join(worktreePath, ".env")), path.relative(worktreePath, path.join(repo, ".env")));
	assert.equal(await exists(path.join(worktreePath, ".env.dir")), false);
});

test("honors configured env file list and never overwrites existing targets", async () => {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-env-config-test-"));
	const repo = path.join(tempRoot, "repo");
	const worktreePath = path.join(tempRoot, "repo-wt-env-config");
	const configPath = path.join(tempRoot, "worktree.json");
	await fs.mkdir(repo);
	await fs.writeFile(path.join(repo, ".env"), "BASE=1\n");
	await fs.writeFile(path.join(repo, ".env.local"), "LOCAL=1\n");
	await fs.writeFile(configPath, JSON.stringify({ autoSymlinkEnvFiles: [".env.local"] }));

	const exec = async (command: string, args: string[]) => {
		if (command === "git" && args.join(" ") === "worktree list --porcelain") {
			return { code: 0, stdout: `worktree ${repo}\nHEAD abc\nbranch refs/heads/main\n`, stderr: "" };
		}
		if (command === "git" && args[0] === "branch") return { code: 0, stdout: "main\n", stderr: "" };
		if (command === "git" && args.join(" ") === "rev-parse --verify HEAD") return { code: 0, stdout: "abc\n", stderr: "" };
		if (command === "git" && args[0] === "worktree" && args[1] === "add") {
			await fs.mkdir(worktreePath);
			await fs.writeFile(path.join(worktreePath, ".env.local"), "KEEP=1\n");
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 1, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}` };
	};

	const output = await runWorktreeCommand("create env config --path ../repo-wt-env-config", {
		cwd: repo,
		exec,
		platform: "linux",
		worktreeConfigPath: configPath,
	});

	assert.doesNotMatch(output, /Env links: \.env/);
	assert.match(output, /Env links skipped: \.env\.local exists/);
	assert.equal(await fs.readFile(path.join(worktreePath, ".env.local"), "utf8"), "KEEP=1\n");
	assert.equal(await exists(path.join(worktreePath, ".env")), false);
});

test("invalid worktree config fails before git worktree add", async () => {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-bad-config-test-"));
	const configPath = path.join(tempRoot, "worktree.json");
	await fs.writeFile(configPath, JSON.stringify({ autoSymlinkEnvFiles: ["nested/.env"] }));
	let added = false;
	const exec = async (command: string, args: string[]) => {
		if (command === "git" && args.join(" ") === "worktree list --porcelain") {
			return { code: 0, stdout: "worktree /repo\nHEAD abc\nbranch refs/heads/main\n", stderr: "" };
		}
		if (command === "git" && args[0] === "branch") return { code: 0, stdout: "main\n", stderr: "" };
		if (command === "git" && args.join(" ") === "rev-parse --verify HEAD") return { code: 0, stdout: "abc\n", stderr: "" };
		if (command === "git" && args[0] === "worktree" && args[1] === "add") {
			added = true;
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 1, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}` };
	};

	await assert.rejects(
		runWorktreeCommand("create bad config", { cwd: "/repo", exec, platform: "linux", worktreeConfigPath: configPath }),
		/autoSymlinkEnvFiles must be true, false, or an array of top-level file names/,
	);
	assert.equal(added, false);
});

test("creates pull-request-url branch names from fetched titles and short directory names", async () => {
	let ghArgs: string[] | undefined;
	let addArgs: string[] | undefined;
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-pr-name-test-"));
	const configPath = path.join(tempRoot, "worktree.json");
	await fs.writeFile(configPath, JSON.stringify({ autoSymlinkEnvFiles: false }));
	const exec = async (command: string, args: string[]) => {
		if (command === "git" && args.join(" ") === "worktree list --porcelain") {
			return { code: 0, stdout: "worktree /repo\nHEAD abc\nbranch refs/heads/main\n", stderr: "" };
		}
		if (command === "git" && args[0] === "branch") {
			return { code: 0, stdout: "main\n", stderr: "" };
		}
		if (command === "git" && args.join(" ") === "rev-parse --verify HEAD") {
			return { code: 0, stdout: "abc\n", stderr: "" };
		}
		if (command === "gh") {
			ghArgs = args;
			return { code: 0, stdout: "Fix PowerShell session move\n", stderr: "" };
		}
		if (command === "git" && args[0] === "worktree" && args[1] === "add") {
			addArgs = args;
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 1, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}` };
	};

	const output = await runWorktreeCommand("create https://github.com/acme/widgets/pull/49", { cwd: "/repo", exec, platform: "linux", worktreeConfigPath: configPath });
	assert.deepEqual(ghArgs, ["pr", "view", "https://github.com/acme/widgets/pull/49", "--json", "title", "--jq", ".title"]);
	assert.match(output, /Branch: worktree\/pr-49-fix-powershell-session-move/);
	assert.ok(addArgs);
	assert.equal(addArgs[3], "worktree/pr-49-fix-powershell-session-move");
	assert.match(addArgs[4], /repo-wt-pr-49$/);
});

test("cleanup refuses to run from a linked worktree", async () => {
	const exec = async (command: string, args: string[]) => {
		if (command === "git" && args.join(" ") === "worktree list --porcelain") {
			return {
				code: 0,
				stdout: [
					"worktree /repo",
					"HEAD abc",
					"branch refs/heads/main",
					"",
					"worktree /repo-wt-task",
					"HEAD def",
					"branch refs/heads/worktree/task",
				].join("\n"),
				stderr: "",
			};
		}
		if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
			return { code: 0, stdout: "/repo-wt-task\n", stderr: "" };
		}
		return { code: 1, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}` };
	};

	await assert.rejects(
		runWorktreeCommand("clean", { cwd: "/repo-wt-task", exec, platform: "linux" }),
		/Refusing cleanup from a linked worktree/,
	);
});

test("anchors cleanup merge checks to the default remote branch", async () => {
	const branchCommands: string[][] = [];
	const exec = async (command: string, args: string[], options?: { cwd?: string }) => {
		if (command === "git" && args.join(" ") === "worktree list --porcelain") {
			return {
				code: 0,
				stdout: [
					"worktree /repo",
					"HEAD abc",
					"branch refs/heads/main",
					"",
					"worktree /repo-wt-task",
					"HEAD def",
					"branch refs/heads/worktree/task",
				].join("\n"),
				stderr: "",
			};
		}
		if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
			return { code: 0, stdout: "/repo\n", stderr: "" };
		}
		if (command === "git" && args.join(" ") === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
			return { code: 0, stdout: "origin/main\n", stderr: "" };
		}
		if (command === "git" && args[0] === "branch") {
			branchCommands.push(args);
			return { code: 0, stdout: "main\nworktree/task\n", stderr: "" };
		}
		if (command === "git" && args.join(" ") === "status --porcelain") {
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 1, stdout: "", stderr: `unexpected command in ${options?.cwd}: ${command} ${args.join(" ")}` };
	};

	await runWorktreeCommand("clean", { cwd: "/repo", exec, platform: "linux" });
	assert.deepEqual(branchCommands[0], ["branch", "--format=%(refname:short)", "--merged", "origin/main"]);
});

test("cleanup prunes stale worktree metadata", async () => {
	const commands: string[] = [];
	const exec = async (command: string, args: string[], options?: { cwd?: string }) => {
		commands.push(`${options?.cwd ?? ""}:${command} ${args.join(" ")}`);
		if (command === "git" && args.join(" ") === "worktree list --porcelain") {
			return {
				code: 0,
				stdout: [
					"worktree /repo",
					"HEAD abc",
					"branch refs/heads/main",
					"",
					"worktree /repo-wt-missing",
					"HEAD def",
					"branch refs/heads/worktree/missing",
					"prunable gitdir file points to non-existent location",
				].join("\n"),
				stderr: "",
			};
		}
		if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
			return { code: 0, stdout: "/repo\n", stderr: "" };
		}
		if (command === "git" && args.join(" ") === "symbolic-ref --quiet --short refs/remotes/origin/HEAD") {
			return { code: 1, stdout: "", stderr: "" };
		}
		if (command === "git" && args.join(" ") === "rev-parse --verify HEAD") {
			return { code: 0, stdout: "abc\n", stderr: "" };
		}
		if (command === "git" && args[0] === "branch") {
			return { code: 0, stdout: "main\n", stderr: "" };
		}
		if (command === "git" && args.join(" ") === "worktree prune") {
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 1, stdout: "", stderr: `unexpected command: ${command} ${args.join(" ")}` };
	};

	const dryRun = await runWorktreeCommand("clean", { cwd: "/repo", exec, platform: "linux" });
	assert.match(dryRun, /repo-wt-missing.*prune stale metadata/);
	assert.equal(commands.includes("/repo-wt-missing:git status --porcelain"), false);

	const applied = await runWorktreeCommand("clean --apply", { cwd: "/repo", exec, platform: "linux" });
	assert.match(applied, /Applied cleanup actions:/);
	assert.doesNotMatch(applied, /Eligible removals:/);
	assert.ok(commands.includes("/repo:git worktree prune"));
	assert.equal(commands.includes("/repo:git worktree remove /repo-wt-missing"), false);
});

test("smoke: create, scratch, list, dry-run cleanup, apply cleanup, and dirty skip", async () => {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worktree-test-"));
	const repo = path.join(tempRoot, "repo");
	await fs.mkdir(repo);

	const run = async (cwd: string, args: string[]) => {
		const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
		return { code: 0, stdout: result.stdout, stderr: result.stderr };
	};

	const exec = async (command: string, args: string[], options?: { cwd?: string }) => {
		try {
			const result = await execFileAsync(command, args, { cwd: options?.cwd, encoding: "utf8" });
			return { code: 0, stdout: result.stdout, stderr: result.stderr };
		} catch (error: any) {
			return {
				code: typeof error?.code === "number" ? error.code : 1,
				stdout: String(error?.stdout ?? ""),
				stderr: String(error?.stderr ?? error?.message ?? ""),
			};
		}
	};

	await run(repo, ["init", "-b", "main"]);
	await run(repo, ["config", "user.email", "worktree-test@example.invalid"]);
	await run(repo, ["config", "user.name", "Worktree Test"]);
	await fs.writeFile(path.join(repo, "README.md"), "# repo\n");
	await run(repo, ["add", "README.md"]);
	await run(repo, ["commit", "-m", "initial"]);

	const runtime = { cwd: repo, exec, platform: process.platform };
	await fs.mkdir(path.join(tempRoot, "repo-wt-fs-clash"));
	const fsCollision = await runWorktreeCommand("create fs clash", runtime);
	assert.match(fsCollision, /Branch: worktree\/fs-clash-2/);
	assert.ok(await exists(path.join(tempRoot, "repo-wt-fs-clash-2")));

	const created = await runWorktreeCommand("create build feature", runtime);
	assert.match(created, /Created worktree/);
	assert.match(created, /Branch: worktree\/build-feature/);
	assert.ok(await exists(path.join(tempRoot, "repo-wt-build-feature")));
	const duplicate = await runWorktreeCommand("create build feature", runtime);
	assert.match(duplicate, /Branch: worktree\/build-feature-2/);
	assert.ok(await exists(path.join(tempRoot, "repo-wt-build-feature-2")));
	const createdAndCd = await runWorktreeCommand("ccd switch feature", runtime);
	assert.match(createdAndCd, /Branch: worktree\/switch-feature/);
	assert.ok(await exists(path.join(tempRoot, "repo-wt-switch-feature")));
	const manualPath = path.join(tempRoot, "manual-safe-worktree");
	await run(repo, ["worktree", "add", "-b", "manual-safe", manualPath, "HEAD"]);

	const scratchOne = await runWorktreeCommand("scratch", runtime);
	assert.match(scratchOne, /repo-wt-1/);
	await fs.writeFile(path.join(tempRoot, "repo-wt-1", "dirty.txt"), "dirty\n");

	const scratchTwo = await runWorktreeCommand("scratch", runtime);
	assert.match(scratchTwo, /repo-wt-2/);

	const list = await runWorktreeCommand("list", runtime);
	assert.match(list, /repo-wt-1/);
	assert.match(list, /\| linked \| worktree\/scratch-1 \| yes \|/);
	assert.match(list, /repo-wt-2/);
	assert.match(list, /\| linked \| worktree\/scratch-2 \| no \|/);

	const dryRun = await runWorktreeCommand("clean", runtime);
	assert.match(dryRun, /Cleanup dry-run/);
	assert.match(dryRun, /Run \/worktree clean --apply/);
	assert.match(dryRun, /manual-safe-worktree/);
	assert.match(dryRun, /repo-wt-1.*dirty worktree/);

	const applied = await runWorktreeCommand("clean --apply", runtime);
	assert.match(applied, /Cleanup applied/);
	assert.match(applied, /Applied cleanup actions:/);
	assert.doesNotMatch(applied, /Eligible removals:/);
	assert.equal(await exists(manualPath), false);
	assert.equal(await exists(path.join(tempRoot, "repo-wt-fs-clash-2")), false);
	assert.equal(await exists(path.join(tempRoot, "repo-wt-build-feature")), false);
	assert.equal(await exists(path.join(tempRoot, "repo-wt-build-feature-2")), false);
	assert.equal(await exists(path.join(tempRoot, "repo-wt-switch-feature")), false);
	assert.equal(await exists(path.join(tempRoot, "repo-wt-2")), false);
	assert.equal(await exists(path.join(tempRoot, "repo-wt-1")), true);
});

async function exists(targetPath: string): Promise<boolean> {
	try {
		await fs.access(targetPath);
		return true;
	} catch {
		return false;
	}
}
