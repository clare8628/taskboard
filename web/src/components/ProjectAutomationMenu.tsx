import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LinearIcon } from "./LinearIcon";
import { ProjectIcon, RecurrenceIcon } from "./SemanticIcons";
import { TaskPropertyPicker } from "./TaskPropertyPicker";
import { TaskboardIcon } from "./TaskboardIcon";
import { useTaskboardI18n } from "../i18n";
import { listenForMenuViewportChange, listenForOutsidePointerDown } from "../menuEvents";
import type { AiChatModel, AutomationProvider } from "../types";

export type AutomationStatus = "ACTIVE" | "PAUSED";
export type AutomationQuotaState = "available" | "blocked" | "unknown" | "unavailable";
export type IntervalMinutes = 5 | 10 | 15 | 30 | 60;

export interface AutomationOptions {
  agentPlatform: AutomationProvider;
  enabledByUser: boolean;
  quotaAware: boolean;
  intervalMinutes: IntervalMinutes;
  model: string;
  reasoningEffort: string;
  autoApprovePrompts?: boolean;
}

export interface AutomationState extends AutomationOptions {
  status: AutomationStatus;
  idleReason?: "checking-todos" | "waiting-todos";
  quota?: {
    state: AutomationQuotaState;
    checkedAt: number;
    resetsAt?: number;
    reason?: "api-key";
  };
}

export interface ProjectAutomationMenuProps {
  automation?: Partial<AutomationState>;
  models: AiChatModel[];
  pending: boolean;
  error: string | null;
  unavailableReason: string | null;
  /** Local companion URL (e.g. http://127.0.0.1:47823) – required in cloud mode */
  companionUrl?: string;
  onOpen: () => void;
  onChange: (options: AutomationOptions) => void;
  onClaimNow?: () => Promise<void>;
}

export interface AgentHealthInfo {
  status: "ready" | "offline" | "error";
  claude: { installed: boolean; executable?: string; authenticated: boolean };
  agy: { installed: boolean; executable?: string; authenticated: boolean };
  activeRuns: Array<{ taskId: string; platform: string; lastLine?: string | null; lastOutputAt?: number | null; startedAt?: number }>;
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return `${pad(h)}:${pad(remM)}:${pad(s)}`;
  }
  return `${pad(m)}:${pad(s)}`;
}

export const CLAUDE_AUTOMATION_MODELS: AiChatModel[] = [
  {
    slug: "sonnet",
    displayName: "Claude Sonnet (Default)",
    description: "State-of-the-art coding and hybrid reasoning model by Anthropic",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "max"],
    serviceTiers: [],
  },
  {
    slug: "opus",
    displayName: "Claude Opus",
    description: "Most capable model for deep reasoning and complex architecture",
    defaultReasoningEffort: "",
    supportedReasoningEfforts: [],
    serviceTiers: [],
  },
  {
    slug: "haiku",
    displayName: "Claude Haiku",
    description: "Fast, cost-efficient model",
    defaultReasoningEffort: "",
    supportedReasoningEfforts: [],
    serviceTiers: [],
  },
];

export const AGY_AUTOMATION_MODELS: AiChatModel[] = [
  {
    slug: "gemini-3.8-flash-high",
    displayName: "Gemini 3.8 Flash (High)",
    description: "Ultra-fast response model with high reasoning effort",
    defaultReasoningEffort: "",
    supportedReasoningEfforts: [],
    serviceTiers: [],
  },
  {
    slug: "gemini-3.8-flash-medium",
    displayName: "Gemini 3.8 Flash (Medium)",
    description: "Fast response model with balanced effort",
    defaultReasoningEffort: "",
    supportedReasoningEfforts: [],
    serviceTiers: [],
  },
  {
    slug: "gemini-3.1-pro-high",
    displayName: "Gemini 3.1 Pro (High)",
    description: "Advanced reasoning and coding model by Google",
    defaultReasoningEffort: "",
    supportedReasoningEfforts: [],
    serviceTiers: [],
  },
  {
    slug: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6 (Thinking)",
    description: "Anthropic model available in AGY",
    defaultReasoningEffort: "",
    supportedReasoningEfforts: [],
    serviceTiers: [],
  },
];

export const CODEX_FALLBACK_MODELS: AiChatModel[] = [
  {
    slug: "gpt-4o",
    displayName: "GPT-4o",
    description: "Omni model by OpenAI",
    defaultReasoningEffort: "",
    supportedReasoningEfforts: [],
    serviceTiers: [],
  },
  {
    slug: "o1",
    displayName: "o1",
    description: "Reasoning model by OpenAI",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"],
    serviceTiers: [],
  },
  {
    slug: "o3-mini",
    displayName: "o3-mini",
    description: "Fast reasoning model by OpenAI",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"],
    serviceTiers: [],
  },
];

export function getProviderModels(provider: AutomationProvider, codexModels: AiChatModel[]): AiChatModel[] {
  if (provider === "claude") return CLAUDE_AUTOMATION_MODELS;
  if (provider === "agy") return AGY_AUTOMATION_MODELS;
  return codexModels.length > 0 ? codexModels : CODEX_FALLBACK_MODELS;
}

const EFFORT_LABELS: Record<string, readonly [string, string]> = {
  low: ["轻度", "Low"],
  medium: ["中", "Medium"],
  high: ["高", "High"],
  xhigh: ["极高 (xhigh)", "Extra high (xhigh)"],
  max: ["最高", "Maximum"],
  ultra: ["极高 (ultra)", "Ultra"],
};

function automationOptions(
  models: AiChatModel[],
  automation?: Partial<AutomationState>,
): AutomationOptions {
  const agentPlatform: AutomationProvider = automation?.agentPlatform ?? "codex";
  const providerModels = getProviderModels(agentPlatform, models);
  const model = providerModels.find((candidate) => candidate.slug === automation?.model) ?? providerModels[0];
  const reasoningEffort = model?.supportedReasoningEfforts.includes(automation?.reasoningEffort ?? "")
    ? automation?.reasoningEffort
    : model?.defaultReasoningEffort;
  return {
    agentPlatform,
    enabledByUser: automation?.enabledByUser ?? false,
    quotaAware: agentPlatform === "codex" ? (automation?.quotaAware ?? false) : false,
    intervalMinutes: automation?.intervalMinutes ?? 5,
    model: model?.slug ?? "",
    reasoningEffort: reasoningEffort ?? "",
    autoApprovePrompts: automation?.autoApprovePrompts ?? true,
  };
}

export function ProjectAutomationMenu({
  automation,
  models,
  pending,
  error,
  unavailableReason,
  companionUrl,
  onOpen,
  onChange,
  onClaimNow,
}: ProjectAutomationMenuProps) {
  /** Resolve the base URL to use for companion endpoints.
   * If the web app is on a cloud URL (workers.dev, pages.dev), requests to
   * /api/local/* will get a 404 from the cloud worker. Instead, always talk
   * directly to the local companion when we have its URL. */
  const resolveCompanionUrl = useCallback((path: string): string => {
    if (companionUrl) {
      return new URL(path.replace(/^\//, ""), companionUrl.replace(/\/$/, "") + "/").href;
    }
    return new URL(path.replace(/^\//, ""), document.baseURI).href;
  }, [companionUrl]);
  const { locale, text } = useTaskboardI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasPendingRef = useRef(pending);
  const [open, setOpen] = useState(false);
  const [pickerMenu, setPickerMenu] = useState<"provider" | "interval" | "model" | "reasoning" | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const [draft, setDraft] = useState<AutomationOptions>(() => automationOptions(models, automation));
  const status = automation?.status ?? "PAUSED";
  const quota = automation?.quota;

  const [claimingNow, setClaimingNow] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState<number>(() => (draft.intervalMinutes ?? 5) * 60);
  const [health, setHealth] = useState<AgentHealthInfo | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartMessage, setRestartMessage] = useState<string | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch(resolveCompanionUrl("api/local/agent-runner/health"), {
        headers: { accept: "application/json", "x-taskboard-client": "web-ui" },
      });
      if (res.ok) {
        const data = await res.json() as AgentHealthInfo;
        setHealth(data);
      } else {
        setHealth({
          status: "offline",
          claude: { installed: false, authenticated: false },
          agy: { installed: false, authenticated: false },
          activeRuns: [],
        });
      }
    } catch {
      setHealth({
        status: "offline",
        claude: { installed: false, authenticated: false },
        agy: { installed: false, authenticated: false },
        activeRuns: [],
      });
    }
  }, [resolveCompanionUrl]);

  useEffect(() => {
    void fetchHealth();
    const interval = setInterval(fetchHealth, 10_000);
    return () => clearInterval(interval);
  }, [fetchHealth]);

  const handleRestart = async () => {
    if (restarting) return;
    setRestarting(true);
    setRestartMessage(text("正在重启本地伴侣服务…", "Restarting local companion…"));
    try {
      const res = await fetch(resolveCompanionUrl("api/local/agent-runner/restart"), {
        method: "POST",
        headers: { "x-taskboard-client": "web-ui" },
      });
      if (res.ok) {
        await fetchHealth();
        setRestartMessage(text("本地伴侣服务已重启就绪", "Local companion restarted"));
        setTimeout(() => setRestartMessage(null), 3000);
        if (onClaimNow) {
          await onClaimNow();
        }
      } else {
        setRestartMessage(text("重启失败，服务端返回异常", "Restart failed; server error"));
        setTimeout(() => setRestartMessage(null), 4000);
      }
    } catch {
      setRestartMessage(text("无法连线本地伴侣服务，请确认 Codex Taskboard 桌面应用已启动", "Cannot connect to local companion; please ensure Codex Taskboard is running"));
      setTimeout(() => setRestartMessage(null), 5000);
    } finally {
      setRestarting(false);
    }
  };

  const [authenticating, setAuthenticating] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);

  const handleAuthenticate = useCallback(async (platform: AutomationProvider) => {
    if (platform !== "claude" && platform !== "agy") return;
    setAuthenticating(true);
    setAuthMessage(text("正在启动终端认证登录…", "Launching terminal authentication…"));
    try {
      const res = await fetch(resolveCompanionUrl("api/local/agent-runner/auth"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-taskboard-client": "web-ui",
        },
        body: JSON.stringify({ platform }),
      });
      if (res.ok) {
        setAuthMessage(text("已开启终端视窗，请在终端完成登入，系统将自动同步状态…", "Terminal opened. Complete login in terminal; status will sync automatically…"));
      } else {
        setAuthMessage(text("启动失败，请手动在终端执行登录命令", "Launch failed; please run login command in terminal"));
      }
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        await fetchHealth();
      }
    } catch {
      setAuthMessage(text("连接本地伴侣服务失败", "Failed to connect to local companion"));
    } finally {
      setAuthenticating(false);
    }
  }, [fetchHealth, resolveCompanionUrl, text]);

  const isExecuting = Boolean(health?.activeRuns && health.activeRuns.length > 0);

  useEffect(() => {
    setSecondsRemaining((draft.intervalMinutes ?? 5) * 60);
  }, [draft.intervalMinutes, status]);

  useEffect(() => {
    if (status !== "ACTIVE" || !draft.enabledByUser) return;
    const timer = setInterval(() => {
      setSecondsRemaining((prev) => (prev <= 1 ? (draft.intervalMinutes ?? 5) * 60 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [draft.enabledByUser, draft.intervalMinutes, status]);

  const handleClaimNow = async () => {
    if (claimingNow) return;
    setClaimingNow(true);
    try {
      if (onClaimNow) {
        await onClaimNow();
      }
      setSecondsRemaining((draft.intervalMinutes ?? 5) * 60);
    } finally {
      setClaimingNow(false);
    }
  };

  const countdownText = formatCountdown(secondsRemaining);

  const idleLabel = automation?.enabledByUser && automation.idleReason === "checking-todos"
    ? text("正在判断待办", "Checking todos")
    : automation?.enabledByUser && automation.idleReason === "waiting-todos"
      ? text("等待任务条件", "Waiting for task conditions")
      : null;
  const stateLabel = idleLabel ?? (!automation?.enabledByUser
    ? text("已暂停", "Paused")
    : automation.quotaAware && quota?.state === "blocked"
      ? text("额度暂停", "Paused by quota")
      : automation.quotaAware && quota?.state === "unavailable"
        ? text("额度不可用", "Quota unavailable")
        : automation.quotaAware && (!quota || quota.state === "unknown")
          ? text("额度未知", "Quota unknown")
          : status === "ACTIVE"
            ? `${text("运行中", "Running")} (${countdownText})`
            : text("已暂停", "Paused"));

  const activeModels = getProviderModels(draft.agentPlatform, models);
  const selectedModel = activeModels.find((model) => model.slug === draft.model) ?? activeModels[0];
  const isCodexUnavailable = draft.agentPlatform === "codex" && Boolean(unavailableReason);
  const disabled = pending || !selectedModel || isCodexUnavailable;

  useEffect(() => {
    if (!open) return;
    setDraft(automationOptions(models, automation));
  }, [automation, models, open]);

  useEffect(() => {
    if (!open) setPickerMenu(null);
  }, [open]);

  useEffect(() => {
    if (wasPendingRef.current && !pending) {
      setDraft(automationOptions(models, automation));
    }
    wasPendingRef.current = pending;
  }, [automation, pending]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8));
    const top = trigger.bottom + 8 + menu.height <= window.innerHeight
      ? trigger.bottom + 8
      : Math.max(8, trigger.top - menu.height - 8);
    setPosition({ left, top, ready: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const stopOutside = listenForOutsidePointerDown([triggerRef, menuRef], close);
    const stopViewport = listenForMenuViewportChange(menuRef, close);
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !pickerMenu) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      stopOutside();
      stopViewport();
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [open, pickerMenu]);

  const submitChange = (next: AutomationOptions) => {
    if (pending) return;
    const nextIsCodexUnavailable = next.agentPlatform === "codex" && Boolean(unavailableReason);
    if (nextIsCodexUnavailable && next.agentPlatform === draft.agentPlatform) return;
    setDraft(next);
    onChange(next);
  };

  const activeLabel = isExecuting
    ? `${draft.agentPlatform === "claude" ? "Claude" : draft.agentPlatform === "agy" ? "AGY" : "Agent"} ${text("执行中…", "Running…")}`
    : draft.agentPlatform === "claude"
      ? `Claude ${countdownText}`
      : draft.agentPlatform === "agy"
        ? `AGY ${countdownText}`
        : `${text("自动认领", "Auto-claim")} ${countdownText}`;

  const buttonLabel = idleLabel ?? (status === "ACTIVE" ? activeLabel : text("自动化", "Automation"));

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="project-automation-menu no-drag"
      role="dialog"
      aria-label={text("自动认领待办设置", "Auto-claim settings")}
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      <div className="project-automation-menu-heading">
        <strong>{text("自动认领待办", "Auto-claim tasks")}</strong>
        <span className={status === "ACTIVE" ? "is-active" : "is-paused"}>
          {stateLabel}
        </span>
      </div>

      <div className="project-automation-health-card">
        <div className="project-automation-health-header">
          <div className="project-automation-health-title">
            <span
              className={`project-automation-status-dot ${
                health?.status === "offline"
                  ? "is-offline"
                  : isExecuting
                    ? "is-busy"
                    : (draft.agentPlatform === "claude" && health?.claude.installed && !health.claude.authenticated) ||
                      (draft.agentPlatform === "agy" && health?.agy.installed && !health.agy.authenticated)
                      ? "is-warning"
                      : "is-ready"
              }`}
              aria-hidden="true"
            />
            <span>
              {health?.status === "offline"
                ? text("本地伴侣服务未连线", "Local companion offline")
                : isExecuting
                  ? text("Agent 正在执行任务…", "Agent is running task…")
                  : draft.agentPlatform === "claude"
                    ? health?.claude.installed
                      ? health?.claude.authenticated
                        ? text("Claude Code 就绪 (已认证)", "Claude Code ready (authenticated)")
                        : text("Claude Code 尚未认证登录", "Claude Code not authenticated")
                      : text("未检测到 claude CLI", "claude CLI not found")
                    : draft.agentPlatform === "agy"
                      ? health?.agy.installed
                        ? health?.agy.authenticated
                          ? text("AGY 就绪 (已认证)", "AGY ready (authenticated)")
                          : text("AGY 尚未认证登录", "AGY not authenticated")
                        : text("未检测到 agy CLI", "agy CLI not found")
                      : text("本地伴侣运行正常", "Local companion healthy")}
            </span>
          </div>
          <button
            type="button"
            className="project-automation-restart-btn"
            disabled={restarting}
            onClick={() => void handleRestart()}
            title={text("重启本地 Agent 调度器", "Restart local agent")}
          >
            {restarting ? text("重启中…", "Restarting…") : text("重启", "Restart")}
          </button>
        </div>
        {restartMessage && (
          <div style={{ padding: "0 12px 8px", fontSize: 11, color: "var(--color-text-secondary, #6b7280)" }}>
            {restartMessage}
          </div>
        )}
        {!isExecuting && (
          (draft.agentPlatform === "claude" && health?.claude.installed && !health.claude.authenticated) ||
          (draft.agentPlatform === "agy" && health?.agy.installed && !health.agy.authenticated)
        ) && (
          <div style={{ padding: "0 12px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 12, color: "#f59e0b", display: "flex", alignItems: "center", gap: 4 }}>
              <span>⚠️</span>
              <span>{text("该 Agent 尚未登录认证，自动化调度将无法执行。", "Agent is not logged in. Automation cannot run.")}</span>
            </div>
            <button
              type="button"
              className="primary-button"
              style={{ padding: "5px 10px", fontSize: 12, height: "auto" }}
              disabled={authenticating}
              onClick={() => void handleAuthenticate(draft.agentPlatform)}
            >
              {authenticating ? text("正在启动认证…", "Launching…") : text("立即启动终端认证登录", "Launch Terminal Login")}
            </button>
            {authMessage && (
              <div style={{ fontSize: 11, color: "var(--color-text-secondary, #6b7280)" }}>
                {authMessage}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="project-automation-field">
        <span>{text("执行代理", "Agent provider")}</span>
        <TaskPropertyPicker
          value={draft.agentPlatform}
          options={[
            {
              value: "claude",
              label: "Claude Code (CLI)",
              icon: <LinearIcon name="terminal" />,
            },
            {
              value: "agy",
              label: "Google Antigravity (AGY)",
              icon: <LinearIcon name="terminal" />,
            },
            {
              value: "codex",
              label: "Codex (ChatGPT Desktop)",
              icon: <ProjectIcon color="currentColor" size={14} />,
            },
          ]}
          open={pickerMenu === "provider"}
          disabled={pending}
          className="project-automation-picker"
          triggerClassName="project-automation-picker-trigger"
          ariaLabel={text("执行代理", "Agent provider")}
          onOpenChange={(open) => setPickerMenu(open ? "provider" : null)}
          onChange={(value) => {
            const nextPlatform = value as AutomationProvider;
            const nextModels = getProviderModels(nextPlatform, models);
            const nextModel = nextModels[0];
            submitChange({
              ...draft,
              agentPlatform: nextPlatform,
              model: nextModel?.slug ?? "",
              reasoningEffort: nextModel?.defaultReasoningEffort ?? "",
              quotaAware: nextPlatform === "codex" ? draft.quotaAware : false,
            });
            if (nextPlatform === "claude" && health?.claude.installed && !health.claude.authenticated) {
              void handleAuthenticate("claude");
            } else if (nextPlatform === "agy" && health?.agy.installed && !health.agy.authenticated) {
              void handleAuthenticate("agy");
            }
          }}
        />
      </div>

      <div className="project-automation-switch">
        <span>{text("自动认领开关", "Auto-claim")}</span>
        <button
          type="button"
          className={`board-setting-switch${draft.enabledByUser ? " is-on" : ""}`}
          role="switch"
          aria-checked={draft.enabledByUser}
          disabled={disabled}
          onClick={() => {
            const nextEnabled = !draft.enabledByUser;
            submitChange({
              ...draft,
              enabledByUser: nextEnabled,
            });
            if (nextEnabled) {
              if (draft.agentPlatform === "claude" && health?.claude.installed && !health.claude.authenticated) {
                void handleAuthenticate("claude");
              } else if (draft.agentPlatform === "agy" && health?.agy.installed && !health.agy.authenticated) {
                void handleAuthenticate("agy");
              }
            }
          }}
        >
          <span aria-hidden="true" />
        </button>
      </div>

      {status === "ACTIVE" && (
        <div className="project-automation-countdown-banner">
          <div className="project-automation-countdown-info">
            <span className="project-automation-countdown-title">
              {text("下次认领倒数", "Next claim in")}
            </span>
            <span className="project-automation-countdown-clock">
              {countdownText}
            </span>
          </div>
          <button
            type="button"
            className="project-automation-claim-now-btn"
            disabled={claimingNow}
            onClick={() => void handleClaimNow()}
            title={text("立即检查待办并执行认领", "Check todos and claim now")}
          >
            {claimingNow ? text("检查中…", "Checking…") : text("立即认领", "Claim now")}
          </button>
        </div>
      )}

      {draft.agentPlatform === "codex" ? (
        <>
          <div className="project-automation-switch">
            <span>{text("根据额度启用/关闭", "Use quota limits")}</span>
            <button
              type="button"
              className={`board-setting-switch${draft.quotaAware ? " is-on" : ""}`}
              role="switch"
              aria-checked={draft.quotaAware}
              disabled={disabled}
              onClick={() => submitChange({
                ...draft,
                quotaAware: !draft.quotaAware,
              })}
            >
              <span aria-hidden="true" />
            </button>
          </div>
          {draft.quotaAware && (
            <div className={`project-automation-quota is-${quota?.state ?? "unknown"}`}>
              {quota?.state === "available" && text("当前额度可用", "Quota is available")}
              {quota?.state === "blocked" && (
                quota.resetsAt
                  ? text(
                    `额度已用尽，预计 ${formatResetTime(quota.resetsAt, locale)} 恢复`,
                    `Quota is exhausted. Expected reset: ${formatResetTime(quota.resetsAt, locale)}.`,
                  )
                  : text("额度已用尽，自动认领已暂停", "Quota is exhausted. Auto-claim is paused.")
              )}
              {quota?.state === "unavailable" && (
                quota.reason === "api-key"
                  ? text(
                    "API Key 模式不支持读取 Codex App 额度",
                    "API key mode cannot read the Codex app quota.",
                  )
                  : text("当前账户无法读取额度", "This account cannot read quota information.")
              )}
              {(!quota || quota.state === "unknown") && text(
                "额度状态未知，自动认领已暂停",
                "Quota status is unknown. Auto-claim is paused.",
              )}
            </div>
          )}
        </>
      ) : draft.agentPlatform === "claude" ? (
        <p className="project-automation-note" style={{ margin: "4px 0 8px" }}>
          {text(
            "Claude Code 終端機模式：自動調用本地 claude CLI 認領與執行任務，使用終端機授權與金鑰。",
            "Claude Code CLI mode: automatically invokes local claude CLI using terminal credentials.",
          )}
        </p>
      ) : (
        <p className="project-automation-note" style={{ margin: "4px 0 8px" }}>
          {text(
            "Google Antigravity (AGY) 模式：自動調用本地 agy CLI 認領與執行任務，使用 Google 帳戶憑證。",
            "Google Antigravity mode: automatically invokes local agy CLI using Google account authentication.",
          )}
        </p>
      )}

      {(draft.agentPlatform === "claude" || draft.agentPlatform === "agy") && (
        <div className="project-automation-switch" style={{ alignItems: "flex-start", marginTop: "4px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
            <span>{text("自動核准終端提示", "Auto-approve CLI prompts")}</span>
            <span style={{ fontSize: "11px", color: "var(--taskboard-muted, #888)", lineHeight: "1.3" }}>
              {text("自動應答 (y/n) 與繼續等待提示，無人值守自主執行", "Auto-respond to (y/n) and continue prompts")}
            </span>
          </div>
          <button
            type="button"
            className={`board-setting-switch${draft.autoApprovePrompts !== false ? " is-on" : ""}`}
            role="switch"
            aria-checked={draft.autoApprovePrompts !== false}
            disabled={disabled}
            onClick={() => submitChange({
              ...draft,
              autoApprovePrompts: draft.autoApprovePrompts === false,
            })}
          >
            <span aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="project-automation-field">
        <span>{text("间隔", "Interval")}</span>
        <TaskPropertyPicker
          value={String(draft.intervalMinutes)}
          options={[5, 10, 15, 30, 60].map((minutes) => ({
            value: String(minutes),
            label: text(`${minutes} 分钟`, `${minutes} min`),
            icon: <RecurrenceIcon color="currentColor" size={14} />,
          }))}
          open={pickerMenu === "interval"}
          disabled={disabled}
          className="project-automation-picker"
          triggerClassName="project-automation-picker-trigger"
          ariaLabel={text("间隔", "Interval")}
          onOpenChange={(open) => setPickerMenu(open ? "interval" : null)}
          onChange={(value) => submitChange({
            ...draft,
            intervalMinutes: Number(value) as IntervalMinutes,
          })}
        />
      </div>

      {selectedModel && (
        <>
          <div className="project-automation-field">
            <span>{text("模型", "Model")}</span>
            <TaskPropertyPicker
              value={draft.model}
              options={activeModels.map((model) => ({
                value: model.slug,
                label: model.displayName,
                icon: <ProjectIcon color="currentColor" size={14} />,
              }))}
              open={pickerMenu === "model"}
              disabled={disabled}
              className="project-automation-picker"
              triggerClassName="project-automation-picker-trigger"
              ariaLabel={text("模型", "Model")}
              onOpenChange={(open) => setPickerMenu(open ? "model" : null)}
              onChange={(value) => {
                const model = activeModels.find((candidate) => candidate.slug === value);
                if (!model) return;
                submitChange({
                  ...draft,
                  model: value,
                  reasoningEffort: model.supportedReasoningEfforts.includes(draft.reasoningEffort)
                    ? draft.reasoningEffort
                    : model.defaultReasoningEffort,
                });
              }}
            />
          </div>
          {selectedModel.supportedReasoningEfforts.length > 0 && (
            <div className="project-automation-field">
              <span>{text("推理强度", "Reasoning effort")}</span>
              <TaskPropertyPicker
                value={draft.reasoningEffort}
                options={selectedModel.supportedReasoningEfforts.map((effort) => ({
                  value: effort,
                  label: EFFORT_LABELS[effort] ? text(...EFFORT_LABELS[effort]) : effort,
                  icon: <LinearIcon name="displayOptions" />,
                }))}
                open={pickerMenu === "reasoning"}
                disabled={disabled}
                className="project-automation-picker"
                triggerClassName="project-automation-picker-trigger"
                ariaLabel={text("推理强度", "Reasoning effort")}
                onOpenChange={(open) => setPickerMenu(open ? "reasoning" : null)}
                onChange={(value) => submitChange({
                  ...draft,
                  reasoningEffort: value,
                })}
              />
            </div>
          )}
        </>
      )}

      {idleLabel && (
        <p className="project-automation-note" role="status">
          {automation?.idleReason === "waiting-todos"
            ? text(
              "当前待办任务都需要等待，已暂停本轮自动认领。新增可执行任务，或更新任务说明、最新评论后，将自动重新判断。",
              "Current tasks need to wait, so auto-claim is paused for now. New actionable tasks or changes to task descriptions or latest comments will trigger a new check.",
            )
            : text(
              "正在确认待办任务是否可以开始，确认前暂停自动认领。",
              "Checking whether tasks can start. Auto-claim is paused until the check is complete.",
            )}
        </p>
      )}
      {isCodexUnavailable && unavailableReason && <p className="project-automation-note">{unavailableReason}</p>}
      {error && (!isCodexUnavailable || error !== unavailableReason) && (
        <p className="project-automation-error" role="alert">{error}</p>
      )}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`project-automation-trigger no-drag ${status === "ACTIVE" ? "is-active" : "is-paused"}`}
        aria-label={buttonLabel}
        aria-busy={pending}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={buttonLabel}
        onClick={() => {
          if (!open) {
            setPosition((current) => ({ ...current, ready: false }));
            void fetchHealth();
            onOpen();
          }
          setOpen((current) => !current);
        }}
      >
        <span
          className={`project-automation-button-dot ${
            health?.status === "offline"
              ? "is-offline"
              : isExecuting
                ? "is-busy"
                : "is-ready"
          }`}
          aria-hidden="true"
        />
        <TaskboardIcon name={status === "ACTIVE" ? "automationPause" : "automationPlay"} />
        <span>{buttonLabel}</span>
      </button>
      {menu}
    </>
  );
}

function formatResetTime(value: number, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value * 1_000));
}
