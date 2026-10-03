import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

import { signalProcessTree } from "../shared/process-tree.mjs";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const MAX_COMMENT_LENGTH = 30_000;

export function normalizeWorkspacePath(rawPath) {
  if (typeof rawPath !== "string") return "";
  let p = rawPath.trim();
  if (!p) return "";
  if (process.platform !== "win32") {
    // Unescape shell escapes (e.g. \ , \~, \(, \), \[, \], etc.)
    if (p.includes("\\")) {
      p = p.replace(/\\(.)/g, "$1");
    }
    // Expand ~ to user homedir if at start
    if (p === "~" || p.startsWith("~/")) {
      const home = process.env.HOME || os.homedir();
      p = path.join(home, p.slice(1));
    }
  }
  return path.resolve(p);
}

/**
 * Resolve the CLI executable path for claude or agy.
 */
export function resolveAgentExecutable(platform, explicit = null) {
  if (explicit) return explicit;
  const envKey = platform === "claude"
    ? "TASKBOARD_CLAUDE_EXECUTABLE"
    : "TASKBOARD_AGY_EXECUTABLE";
  if (process.env[envKey]) return process.env[envKey];

  const home = process.env.HOME || os.homedir();
  const candidates = [
    path.join(home, ".local", "bin", platform),
    `/usr/local/bin/${platform}`,
    `/opt/homebrew/bin/${platform}`,
    platform,
  ];

  for (const candidate of candidates) {
    try {
      if (candidate.includes(path.sep)) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Try next candidate
    }
  }

  return platform;
}

/**
 * Strip standard ANSI escape codes from terminal output.
 */
export function stripAnsi(str) {
  if (typeof str !== "string") return "";
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
}

/**
 * Detect interactive prompts that wait for user confirmation or continuation.
 */
export function detectInteractivePrompt(rawText) {
  if (!rawText || typeof rawText !== "string") return null;
  const clean = stripAnsi(rawText).trim();
  if (!clean) return null;

  const tail = clean.slice(-400);

  // 1. Enter / Continue prompts
  if (
    /press\s+(?:any\s+key|enter|return|<enter>|\[enter\])\s+to\s+continue/i.test(tail) ||
    /hit\s+(?:enter|return)\s+to\s+continue/i.test(tail) ||
    /請?按\s*(?:enter|return|回車|任意鍵)\s*(?:鍵)?繼續/i.test(tail) ||
    /--\s*more\s*--/i.test(tail)
  ) {
    return {
      type: "continue",
      input: "\n",
      promptSnippet: tail.slice(-80),
    };
  }

  // 2. Approve / Yes-No prompts
  if (
    /(?:\[y\/n\]|\[y\/N\]|\[Y\/n\]|\(y\/n\)|\(y\/N\)|\(Y\/n\)|\(yes\/no\)|\[yes\/no\])\s*[:?]?\s*$/i.test(tail) ||
    /(?:proceed|continue|overwrite|are you sure|confirm|do you want to|install anyway)\b[^\n\r]*\?\s*$/i.test(tail) ||
    /(?:是否確定|要繼續嗎|確定執行|是否覆蓋)[^\n\r]*[?？]\s*$/i.test(tail) ||
    /Ok to proceed\?\s*(?:\(y\)|\[y\])?/i.test(tail) ||
    /Press y to (?:confirm|continue|proceed)/i.test(tail) ||
    /\[y\/n\/[a-z\/?]+\]\s*[:?]?\s*$/i.test(tail)
  ) {
    return {
      type: "approve",
      input: "y\n",
      promptSnippet: tail.slice(-80),
    };
  }

  return null;
}

export const KNOWN_AGY_MODELS = new Set([
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "gemini-3.7-flash-high",
  "gemini-3.7-flash-medium",
  "gemini-3.7-flash-low",
  "gemini-3.6-flash-high",
  "gemini-3.6-flash-medium",
  "gemini-3.6-flash-low",
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "claude-opus-5-5-low",
  "claude-opus-5-5-medium",
  "claude-opus-5-5-high",
  "claude-sonnet-5-5-low",
  "claude-sonnet-5-5-medium",
  "claude-sonnet-5-5-high",
  "gpt-oss-120b-medium",
]);

/**
 * Normalize model identifier for Google Antigravity (AGY) CLI.
 * AGY encodes reasoning effort directly into model slugs (e.g. claude-sonnet-5-5-medium).
 * AGY CLI does not support a separate --effort flag for Claude aliases like "sonnet".
 */
export function normalizeAgyModel(rawModel, rawEffort = "") {
  let m = typeof rawModel === "string" ? rawModel.trim() : "";
  let effort = typeof rawEffort === "string" ? rawEffort.trim().toLowerCase() : "";

  // If already an exact known AGY model slug, return as-is
  if (KNOWN_AGY_MODELS.has(m)) {
    return m;
  }

  // Extract embedded effort if present (e.g. model-medium)
  const effortMatch = m.match(/-(low|medium|high)$/i);
  if (effortMatch) {
    if (!effort) effort = effortMatch[1].toLowerCase();
    m = m.slice(0, effortMatch.index);
  }

  // Default effort to medium if not low/high
  if (effort !== "low" && effort !== "high") {
    effort = "medium";
  }

  // Map Opus
  if (/opus/i.test(m)) {
    return `claude-opus-5-5-${effort}`;
  }

  // Map Sonnet or Claude (including legacy "sonnet", "claude-sonnet-4-6", etc.)
  if (/sonnet|claude/i.test(m)) {
    return `claude-sonnet-5-5-${effort}`;
  }

  // Map Gemini Pro (pro only has low and high in AGY)
  if (/pro/i.test(m)) {
    return effort === "low" ? "gemini-3.1-pro-low" : "gemini-3.1-pro-high";
  }

  // Default to Gemini Flash with effort
  return `gemini-3.8-flash-${effort}`;
}

/**
 * Build CLI arguments for the target agent platform.
 */
export function buildAgentCliArgs({ platform, prompt, sessionId, config = {} }) {
  if (platform === "claude") {
    const args = [
      "-p",
      prompt,
      "--session-id",
      sessionId,
      "--dangerously-skip-permissions",
    ];
    let model = config.model || "sonnet";
    if (/^claude-3/i.test(model)) {
      if (/opus/i.test(model)) model = "opus";
      else if (/haiku/i.test(model)) model = "haiku";
      else model = "sonnet";
    } else if (/gemini|gpt/i.test(model) || !model) {
      model = "sonnet";
    }
    args.push("--model", model);
    return args;
  }

  if (platform === "agy") {
    const args = [
      "-p",
      prompt,
      "--conversation",
      sessionId,
      "--dangerously-skip-permissions",
    ];
    const normalizedModel = normalizeAgyModel(config.model, config.reasoningEffort);
    args.push("--model", normalizedModel);
    return args;
  }

  throw new Error(`Unsupported agent platform '${platform}'`);
}

/**
 * Build the execution prompt given to the AI Agent CLI.
 */
export function buildAgentTaskPrompt({ project, task, workspacePath }) {
  const parts = [
    `# Taskboard 任務指派：[${task.identifier || task.id}] ${task.title}`,
    "",
    "## 任務描述 (Task Description)",
    task.description?.trim() || "（無特定詳細描述）",
    "",
    "## 任務資訊",
    `- 專案名稱: ${project?.name || task.projectId}`,
    `- 優先級: ${task.priority || "none"}`,
    `- 標籤: ${(task.labels || []).join(", ") || "無"}`,
    `- 工作目錄: ${workspacePath}`,
    "",
    "## 執行指令與規範",
    "1. 你正在以無人值守（Headless）模式自主執行此看板任務。",
    "2. 請先檢視工作區內的程式碼結構、相關檔案與現有規範，並完成所有必要的修改與實作。",
    "3. 若專案包含測試、型別檢查或代碼驗證工具，請務必在完成前執行並確認通過。",
    "4. 不需要詢問使用者確認，請直接自主完成必要操作。",
    "5. 執行完成後，請於最終輸出中清楚整理：「改動檔案清單」、「主要實作內容」、「驗證結果」以及「任何後續注意事項」。",
  ];

  return parts.join("\n");
}

/**
 * Determine if a task is eligible for dispatch by this runner.
 */
export function evaluateTaskEligibility(task, projectConfig) {
  if (!task || task.status !== "todo" || task.archivedAt != null) {
    return { eligible: false, reason: "NOT_TODO_OR_ARCHIVED" };
  }

  // Blocker dependencies check: every blocker must be "done"
  const blockedBy = task.relations?.blockedBy ?? [];
  const hasIncompleteBlocker = blockedBy.some((dep) => dep.status !== "done");
  if (hasIncompleteBlocker) {
    return { eligible: false, reason: "BLOCKED_BY_DEPENDENCIES" };
  }

  // Label-based agent routing
  const labels = Array.isArray(task.labels) ? task.labels : [];
  for (const label of labels) {
    if (/^agent:codex$/i.test(label)) {
      return { eligible: false, reason: "ROUTED_TO_CODEX" };
    }
    if (/^agent:claude$/i.test(label)) {
      return { eligible: true, platform: "claude" };
    }
    if (/^agent:agy$/i.test(label)) {
      return { eligible: true, platform: "agy" };
    }
  }

  // Fallback to project default agent platform
  const defaultPlatform = projectConfig?.agentPlatform;
  if (defaultPlatform === "claude" || defaultPlatform === "agy") {
    return { eligible: true, platform: defaultPlatform };
  }

  return { eligible: false, reason: "PLATFORM_NOT_SUPPORTED" };
}

/**
 * Truncate long strings for API comments.
 */
function truncateOutput(content, max = MAX_COMMENT_LENGTH) {
  if (typeof content !== "string") return "";
  if (content.length <= max) return content;
  return `${content.slice(0, max)}\n\n... (輸出內容過長已截斷)`;
}

export class AgentRunner {
  constructor(options = {}) {
    this.readClientStorage = options.readClientStorage ?? (async () => ({}));
    this.apiBaseUrl = options.apiBaseUrl ?? "http://127.0.0.1:47823";
    this.fetch = options.fetch ?? globalThis.fetch;
    this.events = options.events ?? null;
    this.claudeExecutable = options.claudeExecutable ?? null;
    this.agyExecutable = options.agyExecutable ?? null;
    this.processEnv = options.processEnv ?? process.env;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.spawnProcess = options.spawnProcess ?? ((cmd, args, opts) => spawn(cmd, args, opts));
    this.isCustomSpawnProcess = Boolean(options.spawnProcess);
    this.checkAgentAuthFn = options.checkAgentAuth ?? null;

    this.activeRuns = new Map(); // taskId -> { child, promise, platform, sessionId, startedAt }
    this.projectRuns = new Set(); // projectId
    this.authCache = new Map(); // platform -> { authenticated: boolean, timestamp: number }
    this.closed = false;
    this.timer = null;
    this.eventListeners = [];
  }

  getResolvedApiBaseUrl() {
    const raw = typeof this.apiBaseUrl === "function" ? this.apiBaseUrl() : this.apiBaseUrl;
    return String(raw || "http://127.0.0.1:47823").replace(/\/$/, "");
  }

  start() {
    if (this.closed || this.timer) return;

    this.timer = setInterval(() => void this.checkAndDispatch(), this.pollIntervalMs);
    this.timer.unref?.();

    if (this.events) {
      const onStorageUpdated = ({ key }) => {
        if (key === "taskboard.projectAutomations.v1") {
          void this.checkAndDispatch();
        }
      };
      const onTaskEvent = () => {
        void this.checkAndDispatch();
      };

      this.events.on("client-storage.updated", onStorageUpdated);
      this.events.on("task.created", onTaskEvent);
      this.events.on("task.updated", onTaskEvent);
      this.events.on("task.moved", onTaskEvent);

      this.eventListeners.push(
        () => this.events.off("client-storage.updated", onStorageUpdated),
        () => this.events.off("task.created", onTaskEvent),
        () => this.events.off("task.updated", onTaskEvent),
        () => this.events.off("task.moved", onTaskEvent),
      );
    }

    void this.checkAndDispatch();
  }

  status() {
    return {
      activeRuns: [...this.activeRuns.entries()].map(([taskId, run]) => ({
        taskId,
        platform: run.platform,
        sessionId: run.sessionId,
        startedAt: run.startedAt,
        lastLine: run.lastLine || null,
        recentLines: run.recentLines || [],
        lastOutputAt: run.lastOutputAt || null,
      })),
      runningProjects: [...this.projectRuns],
      closed: this.closed,
    };
  }

  getExecutionEnv() {
    const env = { ...process.env, ...(this.processEnv || {}) };
    const home = env.HOME || os.homedir();
    const extraPaths = [
      path.join(home, ".local", "bin"),
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ];
    const existing = (env.PATH || "").split(path.delimiter).filter(Boolean);
    const combined = [...new Set([...extraPaths, ...existing])];
    env.PATH = combined.join(path.delimiter);
    return env;
  }

  async checkAgentAuth(platform, explicitPath = null) {
    if (this.checkAgentAuthFn) {
      return this.checkAgentAuthFn(platform, explicitPath);
    }
    if (this.isCustomSpawnProcess) {
      return true;
    }
    const executable = resolveAgentExecutable(
      platform,
      explicitPath ?? (platform === "claude" ? this.claudeExecutable : this.agyExecutable),
    );

    if (typeof executable === "string" && executable.startsWith("/mock/")) {
      return true;
    }

    try {
      accessSync(executable, constants.X_OK);
    } catch {
      return false;
    }

    if (!explicitPath) {
      const cached = this.authCache.get(platform);
      if (cached && Date.now() - cached.timestamp < 300_000) {
        return cached.authenticated;
      }
    }

    const execEnv = this.getExecutionEnv();

    let authenticated = false;
    if (platform === "claude") {
      let output = "";
      try {
        const { stdout } = await execFileAsync(executable, ["auth", "status"], {
          timeout: 8000,
          env: execEnv,
        });
        output = stdout;
      } catch (err) {
        output = err.stdout || "";
      }
      const match = output.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          const data = JSON.parse(match[0]);
          authenticated = Boolean(data.loggedIn);
        } catch {}
      }
    } else if (platform === "agy") {
      try {
        const { stdout, stderr } = await execFileAsync(executable, ["models"], {
          timeout: 20000,
          env: execEnv,
        });
        const combined = `${stdout} ${stderr}`;
        if (!/please sign in/i.test(combined) && !/authentication required/i.test(combined)) {
          authenticated = true;
        }
      } catch (err) {
        const combined = `${err.stdout || ""} ${err.stderr || ""} ${err.message || ""}`;
        if (!/please sign in/i.test(combined) && !/authentication required/i.test(combined)) {
          // If previously authenticated, do not revoke on transient network/timeout error
          const prev = this.authCache.get(platform);
          if (prev?.authenticated) {
            authenticated = true;
          }
        }
      }
    }

    if (!explicitPath) {
      this.authCache.set(platform, { authenticated, timestamp: Date.now() });
    }
    return authenticated;
  }

  async launchAuth(platform) {
    this.authCache.delete(platform);
    const isMac = process.platform === "darwin";
    const cmd = platform === "claude" ? "claude auth login" : "agy";

    if (isMac) {
      try {
        await execFileAsync("osascript", [
          "-e",
          `tell application "Terminal" to do script "${cmd}"`,
          "-e",
          'tell application "Terminal" to activate',
        ]);
        return { launched: true, method: "terminal", command: cmd };
      } catch (e) {
        console.error("[AgentRunner] Failed to launch Terminal via osascript:", e);
      }
    } else if (process.platform === "win32") {
      try {
        spawn("cmd.exe", ["/c", "start", "cmd.exe", "/k", cmd], { detached: true, stdio: "ignore" }).unref();
        return { launched: true, method: "terminal", command: cmd };
      } catch {}
    }

    return { launched: false, method: "manual", command: cmd };
  }

  async health() {
    const claudePath = resolveAgentExecutable("claude", this.claudeExecutable);
    const agyPath = resolveAgentExecutable("agy", this.agyExecutable);

    let claudeInstalled = false;
    try {
      accessSync(claudePath, constants.X_OK);
      claudeInstalled = true;
    } catch {}

    let agyInstalled = false;
    try {
      accessSync(agyPath, constants.X_OK);
      agyInstalled = true;
    } catch {}

    const [claudeAuth, agyAuth] = await Promise.all([
      claudeInstalled ? this.checkAgentAuth("claude", claudePath) : Promise.resolve(false),
      agyInstalled ? this.checkAgentAuth("agy", agyPath) : Promise.resolve(false),
    ]);

    return {
      status: "ready",
      claude: {
        installed: claudeInstalled,
        executable: claudePath,
        authenticated: claudeAuth,
      },
      agy: {
        installed: agyInstalled,
        executable: agyPath,
        authenticated: agyAuth,
      },
      activeRuns: this.status().activeRuns,
      runningProjects: this.status().runningProjects,
    };
  }

  sendInput(taskId, input) {
    const run = this.activeRuns.get(taskId);
    if (!run || !run.child || !run.child.stdin) {
      return false;
    }
    try {
      run.child.stdin.write(input);
      return true;
    } catch (e) {
      console.error(`[AgentRunner] Failed to send input to task ${taskId}:`, e);
      return false;
    }
  }

  abortTask(taskId) {
    const run = this.activeRuns.get(taskId);
    if (!run) return false;
    try {
      if (run.child?.pid) {
        signalProcessTree(run.child.pid, "SIGTERM");
      }
      return true;
    } catch (e) {
      console.error(`[AgentRunner] Failed to abort task ${taskId}:`, e);
      return false;
    }
  }

  async restart() {
    await this.close();
    this.closed = false;
    this.start();
    void this.checkAndDispatch();
    return { ...this.status(), restarted: true };
  }

  async checkAndDispatch() {
    if (this.closed) return;

    let entries = {};
    try {
      const apiBaseUrl = this.getResolvedApiBaseUrl();
      const res = await this.fetch(`${apiBaseUrl}/api/client-storage`, {
        headers: { accept: "application/json", "x-taskboard-client": "agent-runner" },
      });
      if (res.ok) {
        const payload = await res.json();
        entries = payload.entries || {};
      } else {
        entries = await this.readClientStorage();
      }
    } catch {
      entries = await this.readClientStorage().catch(() => ({}));
    }

    const rawAutomations = entries["taskboard.projectAutomations.v1"];
    if (!rawAutomations) return;

    let automations = {};
    try {
      automations = JSON.parse(rawAutomations);
    } catch {
      return;
    }

    const dispatches = [];
    for (const [projectId, config] of Object.entries(automations)) {
      if (this.closed) break;
      if (!config || config.status !== "ACTIVE") continue;

      const platform = config.agentPlatform ?? "codex";
      if (platform !== "claude" && platform !== "agy") continue;

      if (this.projectRuns.has(projectId)) continue;

      dispatches.push(this.dispatchProject(projectId, config));
    }
    await Promise.all(dispatches);
  }

  async dispatchProject(projectId, config) {
    if (this.projectRuns.has(projectId) || this.closed) return;
    this.projectRuns.add(projectId);
    const apiBaseUrl = this.getResolvedApiBaseUrl();

    try {
      // 1. Fetch project metadata
      const projectsRes = await this.fetch(`${apiBaseUrl}/api/projects`, {
        headers: { accept: "application/json", "x-taskboard-client": "agent-runner" },
      });
      if (!projectsRes.ok) return;
      const projectsPayload = await projectsRes.json();
      const project = (projectsPayload.projects || []).find((p) => p.id === projectId);
      if (!project) return;

      let workspacePath = normalizeWorkspacePath(
        project.workspacePath || config.workspacePath || process.cwd(),
      );

      // 2. Fetch todo tasks
      const tasksRes = await this.fetch(
        `${apiBaseUrl}/api/tasks?projectId=${encodeURIComponent(projectId)}&status=todo&archived=false`,
        {
          headers: { accept: "application/json", "x-taskboard-client": "agent-runner" },
        },
      );
      if (!tasksRes.ok) return;
      const tasksPayload = await tasksRes.json();
      const tasks = tasksPayload.tasks || [];

      // 3. Find first eligible task
      let targetTask = null;
      let targetPlatform = null;

      for (const candidate of tasks) {
        const evalResult = evaluateTaskEligibility(candidate, config);
        if (evalResult.eligible) {
          targetTask = candidate;
          targetPlatform = evalResult.platform;
          break;
        }
      }

      if (!targetTask || !targetPlatform) return;

      const isAuth = await this.checkAgentAuth(targetPlatform);
      if (!isAuth) {
        console.warn(`[AgentRunner] Agent '${targetPlatform}' is not authenticated. Triggering authentication...`);
        await this.launchAuth(targetPlatform);
        return;
      }

      // 4. Execute the task
      await this.executeTask({
        project,
        task: targetTask,
        config,
        platform: targetPlatform,
        workspacePath,
      });
    } catch (error) {
      console.error(`[AgentRunner] Error dispatching project '${projectId}':`, error);
    } finally {
      this.projectRuns.delete(projectId);
    }
  }

  async executeTask({ project, task, config, platform, workspacePath }) {
    if (this.activeRuns.has(task.id) || this.closed) return;
    const apiBaseUrl = this.getResolvedApiBaseUrl();

    const sessionId = randomUUID();

    // 1. Atomically claim task: move to in_progress with agentSession
    let currentVersion = task.version;
    try {
      const claimRes = await this.fetch(
        `${apiBaseUrl}/api/tasks/${encodeURIComponent(task.id)}/move`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-taskboard-client": "agent-runner",
          },
          body: JSON.stringify({
            status: "in_progress",
            version: currentVersion,
            agentSession: {
              platform,
              sessionId,
            },
          }),
        },
      );

      if (claimRes.status === 409) {
        // Version conflict or already claimed
        return;
      }

      if (!claimRes.ok) {
        const errorText = await claimRes.text().catch(() => "");
        console.error(`[AgentRunner] Failed to claim task ${task.id}: ${claimRes.status} ${errorText}`);
        return;
      }

      const claimPayload = await claimRes.json().catch(() => ({}));
      if (claimPayload.task?.version !== undefined) {
        currentVersion = claimPayload.task.version;
      }
    } catch (error) {
      console.error(`[AgentRunner] Network error claiming task ${task.id}:`, error);
      return;
    }

    // 2. Prepare CLI command & arguments
    const targetWorkspace = normalizeWorkspacePath(workspacePath);
    const executable = resolveAgentExecutable(
      platform,
      platform === "claude" ? this.claudeExecutable : this.agyExecutable,
    );
    const prompt = buildAgentTaskPrompt({ project, task, workspacePath: targetWorkspace });
    const args = buildAgentCliArgs({ platform, prompt, sessionId, config });

    const runState = {
      child: null,
      promise: null,
      platform,
      sessionId,
      startedAt: Date.now(),
      lastLine: null,
      lastOutputAt: null,
    };

    const autoApprove = config?.autoApprovePrompts !== false;
    let autoResponsesCount = 0;
    let rollingOutput = "";
    let lastAutoResponseAt = 0;
    let lastPromptSnippet = "";

    const checkAndAutoRespond = (chunkStr, childProcess) => {
      rollingOutput += chunkStr;
      if (rollingOutput.length > 3000) {
        rollingOutput = rollingOutput.slice(-3000);
      }

      if (!autoApprove) return;

      const detected = detectInteractivePrompt(rollingOutput);
      if (detected) {
        const now = Date.now();
        // Cooldown: at least 1200ms between auto-responses unless prompt snippet changed
        if (now - lastAutoResponseAt > 1200 || lastPromptSnippet !== detected.promptSnippet) {
          if (childProcess && childProcess.stdin && childProcess.stdin.writable) {
            try {
              childProcess.stdin.write(detected.input);
              lastAutoResponseAt = now;
              lastPromptSnippet = detected.promptSnippet;
              autoResponsesCount++;
              console.log(
                `[AgentRunner] Auto-responded (${detected.type}) to prompt: "${detected.promptSnippet.replace(/\s+/g, " ")}" for task ${task.id}`,
              );
            } catch (err) {
              console.error("[AgentRunner] Failed to auto-respond to child stdin:", err);
            }
          }
        }
      }
    };

    runState.promise = new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let errorOccurred = null;

      try {
        const child = this.spawnProcess(executable, args, {
          cwd: targetWorkspace,
          env: this.processEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });
        runState.child = child;

        child.stdout?.on("data", (chunk) => {
          const str = chunk.toString("utf8");
          stdout += str;
          runState.lastOutputAt = Date.now();
          const lines = stripAnsi(str).trim().split("\n").filter((l) => l.trim().length > 0);
          if (lines.length > 0) {
            runState.lastLine = lines[lines.length - 1].slice(0, 150);
            runState.recentLines = [...(runState.recentLines || []), ...lines.map((l) => l.trim().slice(0, 150))].slice(-2);
          }
          checkAndAutoRespond(str, child);
        });
        child.stderr?.on("data", (chunk) => {
          const str = chunk.toString("utf8");
          stderr += str;
          runState.lastOutputAt = Date.now();
          const lines = stripAnsi(str).trim().split("\n").filter((l) => l.trim().length > 0);
          if (lines.length > 0) {
            runState.lastLine = lines[lines.length - 1].slice(0, 150);
            runState.recentLines = [...(runState.recentLines || []), ...lines.map((l) => l.trim().slice(0, 150))].slice(-2);
          }
          checkAndAutoRespond(str, child);
        });
        child.on("error", (err) => {
          if (err && err.code === "ENOENT") {
            try {
              accessSync(targetWorkspace, constants.R_OK);
            } catch {
              err.message = `${err.message} (工作目錄不存在或無法存取: "${targetWorkspace}")`;
            }
          }
          errorOccurred = err;
        });
        child.on("close", (exitCode, signal) => {
          resolve({ exitCode, signal, stdout, stderr, error: errorOccurred });
        });
      } catch (err) {
        if (err && err.code === "ENOENT") {
          try {
            accessSync(targetWorkspace, constants.R_OK);
          } catch {
            err.message = `${err.message} (工作目錄不存在或無法存取: "${targetWorkspace}")`;
          }
        }
        resolve({ exitCode: 1, signal: null, stdout: "", stderr: "", error: err });
      }
    });

    this.activeRuns.set(task.id, runState);

    let executionResult;
    try {
      executionResult = await runState.promise;
    } finally {
      this.activeRuns.delete(task.id);
    }

    const { exitCode, stdout, stderr, error } = executionResult;
    const isSuccess = exitCode === 0 && !error;
    const resumeCommand = platform === "claude"
      ? `claude --resume ${sessionId}`
      : `agy --conversation ${sessionId}`;
    const agentTitle = platform === "claude" ? "Claude Code" : "Google Antigravity (AGY)";

    // 3. Post summary or error comment
    let commentBody;
    if (isSuccess) {
      commentBody = [
        `### 🤖 ${agentTitle} 執行完成報告`,
        "",
        `- **會話識別碼 (Session ID)**: \`${sessionId}\``,
        `- **終端接續命令**: \`${resumeCommand}\``,
        ...(autoResponsesCount > 0 ? [`- **自動授權應答 (Auto-Approve)**: 執行中自動回應了 ${autoResponsesCount} 次互動確認提示`] : []),
        "",
        "---",
        "",
        truncateOutput(stdout.trim() || "任務執行完成，無終端額外輸出。"),
      ].join("\n");
    } else {
      const rawDetails = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n\n");
      const details = error?.message
        ? `${error.message}\n\n${rawDetails}`
        : (rawDetails || "未知執行錯誤或異常退出");
      commentBody = [
        `### ⚠️ ${agentTitle} 執行失敗 (Exit Code: ${exitCode ?? "ERROR"})`,
        "",
        `- **會話識別碼 (Session ID)**: \`${sessionId}\``,
        `- **終端檢視命令**: \`${resumeCommand}\``,
        "",
        "**錯誤詳情**:",
        "```",
        truncateOutput(details, 10_000),
        "```",
      ].join("\n");
    }

    try {
      await this.fetch(
        `${apiBaseUrl}/api/tasks/${encodeURIComponent(task.id)}/comments`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-taskboard-client": "agent-runner",
          },
          body: JSON.stringify({
            body: commentBody,
            agentSession: {
              platform,
              sessionId,
            },
          }),
        },
      );
    } catch (commentError) {
      console.error(`[AgentRunner] Failed to post comment on task ${task.id}:`, commentError);
    }

    // 4. Update task status: move to in_review on success, or back to todo on failure
    const nextStatus = isSuccess ? "in_review" : "todo";
    try {
      // Fetch latest task version first to avoid 409
      const latestRes = await this.fetch(
        `${apiBaseUrl}/api/tasks/${encodeURIComponent(task.id)}`,
        {
          headers: { accept: "application/json", "x-taskboard-client": "agent-runner" },
        },
      );
      if (latestRes.ok) {
        const latestPayload = await latestRes.json();
        if (latestPayload.task?.version !== undefined) {
          currentVersion = latestPayload.task.version;
        }
      }

      await this.fetch(
        `${apiBaseUrl}/api/tasks/${encodeURIComponent(task.id)}/move`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-taskboard-client": "agent-runner",
          },
          body: JSON.stringify({
            status: nextStatus,
            version: currentVersion,
            agentSession: {
              platform,
              sessionId,
            },
          }),
        },
      );
    } catch (moveError) {
      console.error(`[AgentRunner] Failed to move task ${task.id} to ${nextStatus}:`, moveError);
    }
  }

  async close() {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    for (const unsubscribe of this.eventListeners) {
      try {
        unsubscribe();
      } catch {}
    }
    this.eventListeners = [];

    const runs = [...this.activeRuns.values()];
    for (const run of runs) {
      if (run.child) {
        signalProcessTree(run.child, "SIGTERM");
      }
    }

    await Promise.allSettled(runs.map((run) => run.promise));
    this.activeRuns.clear();
    this.projectRuns.clear();
  }
}

/**
 * Open a native OS folder selection dialog and return the selected path.
 * Supports macOS (osascript), Windows (PowerShell FolderBrowserDialog), and Linux (zenity/kdialog).
 */
export async function chooseSystemDirectory({ initialPath = "", prompt = "請選擇目錄" } = {}) {
  const normInitial = normalizeWorkspacePath(initialPath);
  const initialExists = Boolean(normInitial && existsSync(normInitial));

  if (process.platform === "darwin") {
    let script = `tell application "System Events"\nactivate\n`;
    if (initialExists) {
      const safePath = normInitial.replace(/"/g, '\\"');
      script += `set chosenFolder to choose folder with prompt "${prompt.replace(/"/g, '\\"')}" default location (POSIX file "${safePath}")\n`;
    } else {
      script += `set chosenFolder to choose folder with prompt "${prompt.replace(/"/g, '\\"')}"\n`;
    }
    script += `POSIX path of chosenFolder\nend tell`;

    try {
      const { stdout } = await execFileAsync("osascript", ["-e", script]);
      const chosen = stdout.trim();
      if (!chosen) {
        return { canceled: true, path: null };
      }
      return { canceled: false, path: chosen.replace(/\/$/, "") };
    } catch (err) {
      const message = String(err?.stderr || err?.message || "");
      if (message.includes("-128") || message.includes("User cancelled")) {
        return { canceled: true, path: null };
      }
      throw err;
    }
  } else if (process.platform === "win32") {
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "${(prompt || 'Select Folder').replace(/"/g, '`"')}"
${initialExists ? `$dialog.SelectedPath = "${normInitial.replace(/"/g, '`"')}"` : ''}
$dialog.ShowNewFolderButton = $true
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
} else {
  Write-Output "__CANCELED__"
}
`;
    try {
      const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript]);
      const chosen = stdout.trim();
      if (!chosen || chosen.includes("__CANCELED__")) {
        return { canceled: true, path: null };
      }
      return { canceled: false, path: chosen };
    } catch (err) {
      throw err;
    }
  } else {
    // Linux
    try {
      const args = ["--file-selection", "--directory", `--title=${prompt}`];
      if (initialExists) {
        args.push(`--filename=${normInitial}/`);
      }
      const { stdout } = await execFileAsync("zenity", args);
      const chosen = stdout.trim();
      if (!chosen) return { canceled: true, path: null };
      return { canceled: false, path: chosen.replace(/\/$/, "") };
    } catch (err) {
      if (err?.code === 1) {
        return { canceled: true, path: null };
      }
      try {
        const kArgs = ["--getexistingdirectory", initialExists ? normInitial : (process.env.HOME || "/")];
        const { stdout } = await execFileAsync("kdialog", kArgs);
        const chosen = stdout.trim();
        if (!chosen) return { canceled: true, path: null };
        return { canceled: false, path: chosen.replace(/\/$/, "") };
      } catch (kErr) {
        if (kErr?.code === 1) return { canceled: true, path: null };
        throw new Error("No supported dialog tool found (zenity or kdialog required on Linux)");
      }
    }
  }
}

