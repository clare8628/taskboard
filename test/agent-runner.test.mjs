import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  AgentRunner,
  buildAgentCliArgs,
  buildAgentTaskPrompt,
  chooseSystemDirectory,
  detectInteractivePrompt,
  evaluateTaskEligibility,
  normalizeWorkspacePath,
  resolveAgentExecutable,
  stripAnsi,
  validateAgentModel,
} from "../server/agent-runner.mjs";

test("resolveAgentExecutable returns explicit path or env override", () => {
  assert.equal(resolveAgentExecutable("claude", "/custom/bin/claude"), "/custom/bin/claude");
  assert.equal(resolveAgentExecutable("agy", "/custom/bin/agy"), "/custom/bin/agy");

  const originalEnv = process.env.TASKBOARD_CLAUDE_EXECUTABLE;
  try {
    process.env.TASKBOARD_CLAUDE_EXECUTABLE = "/env/bin/claude";
    assert.equal(resolveAgentExecutable("claude"), "/env/bin/claude");
  } finally {
    if (originalEnv === undefined) delete process.env.TASKBOARD_CLAUDE_EXECUTABLE;
    else process.env.TASKBOARD_CLAUDE_EXECUTABLE = originalEnv;
  }
});

test("buildAgentCliArgs constructs correct flags for claude and agy", () => {
  const claudeArgs = buildAgentCliArgs({
    platform: "claude",
    prompt: "Test prompt",
    sessionId: "sess-123",
    config: { model: "claude-sonnet-4-6" },
  });
  assert.deepEqual(claudeArgs, [
    "-p",
    "Test prompt",
    "--session-id",
    "sess-123",
    "--dangerously-skip-permissions",
    "--model",
    "sonnet",
  ]);

  // Cross-model protection: passing a Gemini model to Claude Code automatically falls back to sonnet
  const claudeCrossModelArgs = buildAgentCliArgs({
    platform: "claude",
    prompt: "Cross model prompt",
    sessionId: "sess-cross",
    config: { model: "gemini-3.8-flash-high" },
  });
  assert.deepEqual(claudeCrossModelArgs, [
    "-p",
    "Cross model prompt",
    "--session-id",
    "sess-cross",
    "--dangerously-skip-permissions",
    "--model",
    "sonnet",
  ]);

  const agyArgs = buildAgentCliArgs({
    platform: "agy",
    prompt: "Agy prompt",
    sessionId: "agy-456",
    config: { model: "gemini-3.8-flash-high" },
  });
  assert.deepEqual(agyArgs, [
    "-p",
    "Agy prompt",
    "--conversation",
    "agy-456",
    "--dangerously-skip-permissions",
    "--model",
    "gemini-3.8-flash-high",
  ]);

  const agyLegacyArgs = buildAgentCliArgs({
    platform: "agy",
    prompt: "Legacy prompt",
    sessionId: "agy-789",
    config: { model: "gemini-2.5-pro", reasoningEffort: "medium" },
  });
  assert.deepEqual(agyLegacyArgs, [
    "-p",
    "Legacy prompt",
    "--conversation",
    "agy-789",
    "--dangerously-skip-permissions",
    "--model",
    "gemini-3.1-pro-high",
  ]);

  const agyCrossModelArgs = buildAgentCliArgs({
    platform: "agy",
    prompt: "Cross model prompt",
    sessionId: "agy-999",
    config: { model: "sonnet", reasoningEffort: "medium" },
  });
  assert.deepEqual(agyCrossModelArgs, [
    "-p",
    "Cross model prompt",
    "--conversation",
    "agy-999",
    "--dangerously-skip-permissions",
    "--model",
    "claude-sonnet-5-5-medium",
  ]);

  const agyClaudeLegacyArgs = buildAgentCliArgs({
    platform: "agy",
    prompt: "Claude legacy prompt",
    sessionId: "agy-111",
    config: { model: "claude-sonnet-4-6", reasoningEffort: "high" },
  });
  assert.deepEqual(agyClaudeLegacyArgs, [
    "-p",
    "Claude legacy prompt",
    "--conversation",
    "agy-111",
    "--dangerously-skip-permissions",
    "--model",
    "claude-sonnet-5-5-high",
  ]);

  assert.throws(() => buildAgentCliArgs({ platform: "unknown", prompt: "", sessionId: "" }));
});

test("normalizeWorkspacePath correctly unescapes shell escaped paths on posix", () => {
  if (process.platform !== "win32") {
    const raw = "/Users/test/Library/Mobile\\ Documents/com\\~apple\\~CloudDocs/My\\ Folder";
    const cleaned = normalizeWorkspacePath(raw);
    assert.equal(cleaned, "/Users/test/Library/Mobile Documents/com~apple~CloudDocs/My Folder");

    assert.equal(normalizeWorkspacePath(""), "");
    assert.equal(normalizeWorkspacePath("   "), "");
  }
});

test("buildAgentTaskPrompt includes task identifier, title, description, and workspace", () => {
  const prompt = buildAgentTaskPrompt({
    project: { name: "My Project" },
    task: {
      id: "task-1",
      identifier: "TASK-1",
      title: "Implement multi-agent runner",
      description: "Must handle claude and agy CLI execution.",
      priority: "high",
      labels: ["backend", "agent:claude"],
    },
    workspacePath: "/work/my-project",
  });

  assert.match(prompt, /\[TASK-1\] Implement multi-agent runner/);
  assert.match(prompt, /Must handle claude and agy CLI execution/);
  assert.match(prompt, /專案名稱: My Project/);
  assert.match(prompt, /工作目錄: \/work\/my-project/);
});

test("evaluateTaskEligibility handles task status, blockers, and agent labels", () => {
  const baseTask = {
    id: "task-1",
    status: "todo",
    archivedAt: null,
    labels: [],
    relations: { blockedBy: [] },
  };

  // 1. Not todo or archived
  assert.equal(evaluateTaskEligibility({ ...baseTask, status: "in_progress" }, { agentPlatform: "claude" }).eligible, false);
  assert.equal(evaluateTaskEligibility({ ...baseTask, archivedAt: "2026-10-01" }, { agentPlatform: "claude" }).eligible, false);

  // 2. Blocked by incomplete task
  const blockedTask = {
    ...baseTask,
    relations: {
      blockedBy: [{ id: "blocker-1", status: "in_progress" }],
    },
  };
  assert.equal(evaluateTaskEligibility(blockedTask, { agentPlatform: "claude" }).eligible, false);

  // 3. Blocker is done -> eligible
  const unblockedTask = {
    ...baseTask,
    relations: {
      blockedBy: [{ id: "blocker-1", status: "done" }],
    },
  };
  assert.deepEqual(evaluateTaskEligibility(unblockedTask, { agentPlatform: "claude" }), {
    eligible: true,
    platform: "claude",
  });

  // 4. Label routing overrides project default
  const claudeTagged = { ...baseTask, labels: ["bug", "agent:claude"] };
  assert.deepEqual(evaluateTaskEligibility(claudeTagged, { agentPlatform: "agy" }), {
    eligible: true,
    platform: "claude",
  });

  const agyTagged = { ...baseTask, labels: ["feature", "agent:agy"] };
  assert.deepEqual(evaluateTaskEligibility(agyTagged, { agentPlatform: "claude" }), {
    eligible: true,
    platform: "agy",
  });

  // 5. Codex tag skips dispatcher
  const codexTagged = { ...baseTask, labels: ["agent:codex"] };
  assert.equal(evaluateTaskEligibility(codexTagged, { agentPlatform: "claude" }).eligible, false);

  // 6. Unsupported platform
  assert.equal(evaluateTaskEligibility(baseTask, { agentPlatform: "codex" }).eligible, false);
});

class MockChildProcess extends EventEmitter {
  constructor(exitCode = 0, stdout = "", stderr = "") {
    super();
    this.pid = 99999;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.exitCode = exitCode;
    this.stdoutContent = stdout;
    this.stderrContent = stderr;
    this.killedSignal = null;
  }

  kill(signal) {
    this.killedSignal = signal;
    this.emit("close", null, signal);
    return true;
  }

  simulateRun() {
    queueMicrotask(() => {
      if (this.stdoutContent) this.stdout.emit("data", Buffer.from(this.stdoutContent));
      if (this.stderrContent) this.stderr.emit("data", Buffer.from(this.stderrContent));
      this.emit("close", this.exitCode, null);
    });
  }
}

test("AgentRunner full cycle: claim, spawn claude CLI, post summary, move to in_review", async () => {
  const apiCalls = [];
  let taskVersion = 1;

  const mockFetch = async (url, init = {}) => {
    const urlStr = String(url);
    apiCalls.push({ url: urlStr, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });

    if (urlStr.endsWith("/api/projects")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          projects: [{ id: "proj-1", name: "Alpha", workspacePath: "/work/alpha" }],
        }),
      };
    }

    if (urlStr.includes("/api/tasks?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tasks: [
            {
              id: "task-101",
              identifier: "PROJ-101",
              projectId: "proj-1",
              title: "Build Feature X",
              description: "Implement Feature X",
              status: "todo",
              version: taskVersion,
              relations: { blockedBy: [] },
              labels: [],
            },
          ],
        }),
      };
    }

    if (urlStr.endsWith("/move")) {
      taskVersion += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          task: { id: "task-101", version: taskVersion, status: init.body ? JSON.parse(init.body).status : "in_progress" },
        }),
      };
    }

    if (urlStr.endsWith("/comments")) {
      return {
        ok: true,
        status: 201,
        json: async () => ({ comment: { id: "comm-1" } }),
      };
    }

    if (urlStr.endsWith("/api/tasks/task-101")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ task: { id: "task-101", version: taskVersion } }),
      };
    }

    return { ok: false, status: 404, text: async () => "Not Found" };
  };

  let spawnedArgs = null;
  const runner = new AgentRunner({
    readClientStorage: async () => ({
      "taskboard.projectAutomations.v1": JSON.stringify({
        "proj-1": {
          status: "ACTIVE",
          agentPlatform: "claude",
          model: "claude-sonnet-4-6",
        },
      }),
    }),
    apiBaseUrl: "http://127.0.0.1:47823",
    fetch: mockFetch,
    claudeExecutable: "/mock/bin/claude",
    spawnProcess: (cmd, args) => {
      spawnedArgs = { cmd, args };
      const child = new MockChildProcess(0, "All tests passed and code implemented cleanly.");
      child.simulateRun();
      return child;
    },
  });

  await runner.checkAndDispatch();

  // Verify CLI invocation
  assert.equal(spawnedArgs?.cmd, "/mock/bin/claude");
  assert.equal(spawnedArgs?.args[0], "-p");
  assert.equal(spawnedArgs?.args[2], "--session-id");
  assert.equal(spawnedArgs?.args[5], "--model");
  assert.equal(spawnedArgs?.args[6], "sonnet");

  // Verify API claim
  const claimCall = apiCalls.find((c) => c.url.includes("/tasks/task-101/move") && c.body?.status === "in_progress");
  assert.ok(claimCall, "Task should be moved to in_progress");
  assert.equal(claimCall.body.agentSession.platform, "claude");
  assert.ok(claimCall.body.agentSession.sessionId);

  // Verify comment added
  const commentCall = apiCalls.find((c) => c.url.includes("/tasks/task-101/comments"));
  assert.ok(commentCall, "Comment should be added");
  assert.match(commentCall.body.body, /Claude Code 執行完成報告/);
  assert.match(commentCall.body.body, /All tests passed/);

  // Verify moved to in_review
  const reviewCall = apiCalls.find((c) => c.url.includes("/tasks/task-101/move") && c.body?.status === "in_review");
  assert.ok(reviewCall, "Task should be moved to in_review");

  await runner.close();
});

test("AgentRunner handles failure: posts error comment and reverts task to todo", async () => {
  const apiCalls = [];
  let taskVersion = 1;

  const mockFetch = async (url, init = {}) => {
    const urlStr = String(url);
    apiCalls.push({ url: urlStr, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });

    if (urlStr.endsWith("/api/projects")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          projects: [{ id: "proj-agy", name: "Beta", workspacePath: "/work/beta" }],
        }),
      };
    }

    if (urlStr.includes("/api/tasks?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tasks: [
            {
              id: "task-202",
              identifier: "PROJ-202",
              projectId: "proj-agy",
              title: "Build Feature Y",
              status: "todo",
              version: taskVersion,
              relations: { blockedBy: [] },
              labels: [],
            },
          ],
        }),
      };
    }

    if (urlStr.endsWith("/move")) {
      taskVersion += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          task: { id: "task-202", version: taskVersion, status: init.body ? JSON.parse(init.body).status : "in_progress" },
        }),
      };
    }

    if (urlStr.endsWith("/comments")) {
      return { ok: true, status: 201, json: async () => ({ comment: { id: "comm-2" } }) };
    }

    if (urlStr.endsWith("/api/tasks/task-202")) {
      return { ok: true, status: 200, json: async () => ({ task: { id: "task-202", version: taskVersion } }) };
    }

    return { ok: false, status: 404, text: async () => "Not Found" };
  };

  const runner = new AgentRunner({
    readClientStorage: async () => ({
      "taskboard.projectAutomations.v1": JSON.stringify({
        "proj-agy": {
          status: "ACTIVE",
          agentPlatform: "agy",
          model: "gemini-2.5-pro",
          reasoningEffort: "medium",
        },
      }),
    }),
    apiBaseUrl: "http://127.0.0.1:47823",
    fetch: mockFetch,
    agyExecutable: "/mock/bin/agy",
    spawnProcess: () => {
      const child = new MockChildProcess(1, "", "Syntax error in build.ts line 14");
      child.simulateRun();
      return child;
    },
  });

  await runner.checkAndDispatch();

  // Verify comment with failure
  const commentCall = apiCalls.find((c) => c.url.includes("/tasks/task-202/comments"));
  assert.ok(commentCall, "Comment should be added");
  assert.match(commentCall.body.body, /Google Antigravity \(AGY\) 執行失敗/);
  assert.match(commentCall.body.body, /Syntax error in build.ts/);

  // Verify task moved back to todo
  const revertCall = apiCalls.find((c) => c.url.includes("/tasks/task-202/move") && c.body?.status === "todo");
  assert.ok(revertCall, "Task should be moved back to todo upon failure");

  await runner.close();
});

test("AgentRunner status reflects active runs and close terminates spawned child", async () => {
  let childRef = null;
  const runner = new AgentRunner({
    readClientStorage: async () => ({
      "taskboard.projectAutomations.v1": JSON.stringify({
        "proj-long": { status: "ACTIVE", agentPlatform: "claude" },
      }),
    }),
    apiBaseUrl: "http://127.0.0.1:47823",
    fetch: async (url, init = {}) => {
      const s = String(url);
      if (s.endsWith("/api/projects")) {
        return { ok: true, json: async () => ({ projects: [{ id: "proj-long", workspacePath: "/work/long" }] }) };
      }
      if (s.includes("/api/tasks?")) {
        return {
          ok: true,
          json: async () => ({
            tasks: [{ id: "task-long", identifier: "LONG-1", projectId: "proj-long", status: "todo", version: 1 }],
          }),
        };
      }
      if (s.endsWith("/move")) {
        return { ok: true, json: async () => ({ task: { id: "task-long", version: 2 } }) };
      }
      return { ok: true, json: async () => ({}) };
    },
    spawnProcess: () => {
      childRef = new MockChildProcess(0);
      // do not simulate immediate run to keep it active
      return childRef;
    },
  });

  const dispatchPromise = runner.dispatchProject("proj-long", { status: "ACTIVE", agentPlatform: "claude" });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const status = runner.status();
  assert.equal(status.activeRuns.length, 1);
  assert.equal(status.activeRuns[0].taskId, "task-long");
  assert.equal(status.activeRuns[0].platform, "claude");

  // Closing runner should terminate child
  await runner.close();
  assert.equal(childRef.killedSignal, "SIGTERM");
  assert.equal(runner.status().closed, true);

  await dispatchPromise.catch(() => {});
});

test("AgentRunner health reports executable status and active runs", async () => {
  const runner = new AgentRunner({
    apiBaseUrl: "http://127.0.0.1:47823",
  });

  const health = await runner.health();
  assert.ok("status" in health);
  assert.ok("claude" in health);
  assert.ok("agy" in health);
  assert.ok(Array.isArray(health.activeRuns));
  assert.equal(typeof health.claude.installed, "boolean");
  assert.equal(typeof health.claude.authenticated, "boolean");
  await runner.close();
});

test("AgentRunner restart terminates active runs and restarts cleanly", async () => {
  let childRef = null;
  const runner = new AgentRunner({
    readClientStorage: async () => ({}),
    apiBaseUrl: "http://127.0.0.1:47823",
    spawnProcess: () => {
      childRef = new MockChildProcess(0);
      return childRef;
    },
  });

  runner.activeRuns.set("test-task", {
    child: { kill: (sig) => { childRef = sig; } },
    platform: "claude",
    sessionId: "sess-1",
    startedAt: Date.now(),
  });

  assert.equal(runner.status().activeRuns.length, 1);
  const result = await runner.restart();
  assert.equal(result.restarted, true);
  assert.equal(childRef, "SIGTERM");
  assert.equal(runner.status().activeRuns.length, 0);

  await runner.close();
});

test("AgentRunner triggers launchAuth and avoids claiming when agent is unauthenticated", async () => {
  let launchAuthCalled = null;
  let taskClaimed = false;

  const runner = new AgentRunner({
    readClientStorage: async () => ({
      "taskboard.projectAutomations.v1": JSON.stringify({
        "proj-unauth": { status: "ACTIVE", agentPlatform: "agy" },
      }),
    }),
    apiBaseUrl: "http://127.0.0.1:47823",
    fetch: async (url, init = {}) => {
      const s = String(url);
      if (s.endsWith("/api/projects")) {
        return { ok: true, json: async () => ({ projects: [{ id: "proj-unauth", workspacePath: "/work/unauth" }] }) };
      }
      if (s.includes("/api/tasks?")) {
        return {
          ok: true,
          json: async () => ({
            tasks: [{ id: "task-unauth", identifier: "UNAUTH-1", projectId: "proj-unauth", status: "todo", version: 1 }],
          }),
        };
      }
      if (s.endsWith("/move")) {
        taskClaimed = true;
        return { ok: true, json: async () => ({ task: { id: "task-unauth", version: 2 } }) };
      }
      return { ok: true, json: async () => ({}) };
    },
    checkAgentAuth: async () => false,
  });

  runner.launchAuth = async (platform) => {
    launchAuthCalled = platform;
    return { launched: true, method: "test" };
  };

  await runner.dispatchProject("proj-unauth", { status: "ACTIVE", agentPlatform: "agy" });

  assert.equal(launchAuthCalled, "agy");
  assert.equal(taskClaimed, false);
  assert.equal(runner.status().activeRuns.length, 0);

  await runner.close();
});

test("stripAnsi removes color and control sequences", () => {
  const colored = "\u001b[32mSuccess\u001b[39m and \u001b[1mBold\u001b[22m";
  assert.equal(stripAnsi(colored), "Success and Bold");
  assert.equal(stripAnsi(""), "");
  assert.equal(stripAnsi(null), "");
});

test("detectInteractivePrompt identifies yes/no and continue prompts", () => {
  const y1 = detectInteractivePrompt("Do you want to proceed? [y/N]");
  assert.equal(y1?.type, "approve");
  assert.equal(y1?.input, "y\n");

  const y2 = detectInteractivePrompt("Overwrite /path/file.js? (y/n)");
  assert.equal(y2?.type, "approve");
  assert.equal(y2?.input, "y\n");

  const y3 = detectInteractivePrompt("Ok to proceed? (y)");
  assert.equal(y3?.type, "approve");

  const y4 = detectInteractivePrompt("是否確定要覆蓋此檔案？ [y/N]");
  assert.equal(y4?.type, "approve");

  const c1 = detectInteractivePrompt("Press Enter to continue...");
  assert.equal(c1?.type, "continue");
  assert.equal(c1?.input, "\n");

  const c2 = detectInteractivePrompt("請按 Enter 鍵繼續...");
  assert.equal(c2?.type, "continue");

  const normal = detectInteractivePrompt("Compiled successfully in 120ms.\nAll 15 tests passed.");
  assert.equal(normal, null);
});

test("AgentRunner auto-responds to interactive prompts when autoApprovePrompts is enabled", async () => {
  const mockChild = new EventEmitter();
  let stdinReceived = "";
  mockChild.stdin = {
    writable: true,
    write: (data) => {
      stdinReceived += data;
      return true;
    },
  };
  mockChild.stdout = new EventEmitter();
  mockChild.stderr = new EventEmitter();

  let commentsPosted = [];

  const runner = new AgentRunner({
    readClientStorage: async () => ({
      "taskboard.projectAutomations.v1": JSON.stringify({
        "proj-auto": { status: "ACTIVE", agentPlatform: "claude", autoApprovePrompts: true },
      }),
    }),
    apiBaseUrl: "http://127.0.0.1:47823",
    spawnProcess: () => mockChild,
    fetch: async (url, init = {}) => {
      const s = String(url);
      if (s.endsWith("/api/projects")) {
        return { ok: true, json: async () => ({ projects: [{ id: "proj-auto", workspacePath: "/work/auto" }] }) };
      }
      if (s.includes("/api/tasks?")) {
        return {
          ok: true,
          json: async () => ({
            tasks: [{ id: "task-auto-1", identifier: "AUTO-1", projectId: "proj-auto", status: "todo", version: 1 }],
          }),
        };
      }
      if (s.endsWith("/move")) {
        return { ok: true, json: async () => ({ task: { id: "task-auto-1", version: 2 } }) };
      }
      if (s.includes("/comments")) {
        commentsPosted.push(JSON.parse(init.body || "{}"));
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    },
    checkAgentAuth: async () => true,
  });

  const dispatchPromise = runner.dispatchProject("proj-auto", {
    status: "ACTIVE",
    agentPlatform: "claude",
    autoApprovePrompts: true,
  });

  // Wait a tick for spawn
  await new Promise((r) => setTimeout(r, 50));

  // Simulate prompt output
  mockChild.stdout.emit("data", Buffer.from("Need to install vite. Ok to proceed? (y) "));

  // Process completes
  await new Promise((r) => setTimeout(r, 50));
  mockChild.emit("close", 0, null);

  await dispatchPromise;

  assert.equal(stdinReceived, "y\n");
  assert.equal(commentsPosted.length > 0, true);
  assert.match(commentsPosted[0].body, /自動授權應答/);

  await runner.close();
});

test("AgentRunner abortTask terminates child process and tracks lastLine", async () => {
  const mockChild = new EventEmitter();
  mockChild.pid = 99999;
  mockChild.stdin = { writable: true, write: () => true };
  mockChild.stdout = new EventEmitter();
  mockChild.stderr = new EventEmitter();

  let signalSent = null;

  const runner = new AgentRunner({
    apiBaseUrl: "http://127.0.0.1:47823",
    spawnProcess: () => mockChild,
    fetch: async (url) => {
      const s = String(url);
      if (s.endsWith("/api/projects")) {
        return { ok: true, json: async () => ({ projects: [{ id: "proj-abort", workspacePath: "/work/abort" }] }) };
      }
      if (s.includes("/api/tasks?")) {
        return {
          ok: true,
          json: async () => ({
            tasks: [{ id: "task-abort-1", identifier: "ABORT-1", projectId: "proj-abort", status: "todo", version: 1 }],
          }),
        };
      }
      if (s.endsWith("/move")) {
        return { ok: true, json: async () => ({ task: { id: "task-abort-1", version: 2 } }) };
      }
      return { ok: true, json: async () => ({}) };
    },
    checkAgentAuth: async () => true,
  });

  const dispatchPromise = runner.dispatchProject("proj-abort", {
    status: "ACTIVE",
    agentPlatform: "claude",
  });

  await new Promise((r) => setTimeout(r, 50));

  mockChild.stdout.emit("data", Buffer.from("Running 92 unit tests...\n"));

  const runs = runner.status().activeRuns;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].lastLine, "Running 92 unit tests...");

  const aborted = runner.abortTask("task-abort-1");
  assert.equal(aborted, true);

  mockChild.emit("close", 1, "SIGTERM");
  await dispatchPromise;

  assert.equal(runner.status().activeRuns.length, 0);

  await runner.close();
});

test("chooseSystemDirectory is an exported async function", () => {
  assert.equal(typeof chooseSystemDirectory, "function");
});

test("validateAgentModel validates and normalizes models for claude and agy", () => {
  // Claude valid models
  assert.deepEqual(validateAgentModel("claude", "sonnet"), { valid: true, model: "sonnet" });
  assert.deepEqual(validateAgentModel("claude", "opus"), { valid: true, model: "opus" });
  assert.deepEqual(validateAgentModel("claude", "haiku"), { valid: true, model: "haiku" });
  assert.deepEqual(validateAgentModel("claude", "claude-3-7-sonnet-latest"), { valid: true, model: "claude-3-7-sonnet-latest" });
  assert.deepEqual(validateAgentModel("claude", "claude-sonnet-4-6"), { valid: true, model: "sonnet" });
  assert.deepEqual(validateAgentModel("claude", ""), { valid: true, model: "sonnet" });

  // Claude invalid / cross-provider models fallback to sonnet
  assert.deepEqual(validateAgentModel("claude", "gemini-3.8-flash-high"), {
    valid: false,
    model: "sonnet",
    original: "gemini-3.8-flash-high",
  });
  assert.deepEqual(validateAgentModel("claude", "gpt-4o"), {
    valid: false,
    model: "sonnet",
    original: "gpt-4o",
  });
  assert.deepEqual(validateAgentModel("claude", "unknown-random-model"), {
    valid: false,
    model: "sonnet",
    original: "unknown-random-model",
  });

  // AGY valid models
  assert.deepEqual(validateAgentModel("agy", "gemini-3.8-flash-high"), { valid: true, model: "gemini-3.8-flash-high" });
  assert.deepEqual(validateAgentModel("agy", "gemini-3.8-flash-medium"), { valid: true, model: "gemini-3.8-flash-medium" });
  assert.deepEqual(validateAgentModel("agy", "claude-sonnet-5-5-medium"), { valid: true, model: "claude-sonnet-5-5-medium" });
  assert.deepEqual(validateAgentModel("agy", "sonnet", "medium"), { valid: true, model: "claude-sonnet-5-5-medium" });

  // AGY invalid models fallback to gemini-3.8-flash-medium
  assert.deepEqual(validateAgentModel("agy", "totally-unknown-model-xyz"), {
    valid: false,
    model: "gemini-3.8-flash-medium",
    original: "totally-unknown-model-xyz",
  });
});



