import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  onOpen: () => void;
  onChange: (options: AutomationOptions) => void;
}

export const CLAUDE_AUTOMATION_MODELS: AiChatModel[] = [
  {
    slug: "claude-3-7-sonnet",
    displayName: "Claude 3.7 Sonnet (Thinking)",
    description: "Hybrid reasoning and coding model by Anthropic",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "max"],
    serviceTiers: [],
  },
  {
    slug: "claude-3-5-sonnet",
    displayName: "Claude 3.5 Sonnet",
    description: "High-capability coding and analysis model",
    defaultReasoningEffort: "",
    supportedReasoningEfforts: [],
    serviceTiers: [],
  },
  {
    slug: "claude-3-5-haiku",
    displayName: "Claude 3.5 Haiku",
    description: "Fast, cost-efficient model",
    defaultReasoningEffort: "",
    supportedReasoningEfforts: [],
    serviceTiers: [],
  },
];

export const AGY_AUTOMATION_MODELS: AiChatModel[] = [
  {
    slug: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    description: "Advanced reasoning and coding model by Google",
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high", "max"],
    serviceTiers: [],
  },
  {
    slug: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    description: "Fast multimodal reasoning model",
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low", "medium", "high"],
    serviceTiers: [],
  },
  {
    slug: "gemini-3.8-flash",
    displayName: "Gemini 3.8 Flash (High)",
    description: "Ultra-fast response model",
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low", "medium", "high"],
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
  };
}

export function ProjectAutomationMenu({
  automation,
  models,
  pending,
  error,
  unavailableReason,
  onOpen,
  onChange,
}: ProjectAutomationMenuProps) {
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
            ? text("运行中", "Running")
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

  const activeLabel = draft.agentPlatform === "claude"
    ? text("Claude 认领中", "Claude claiming")
    : draft.agentPlatform === "agy"
      ? text("AGY 认领中", "AGY claiming")
      : text("自动认领中", "Auto-claiming");

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
          onClick={() => submitChange({
            ...draft,
            enabledByUser: !draft.enabledByUser,
          })}
        >
          <span aria-hidden="true" />
        </button>
      </div>

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
            onOpen();
          }
          setOpen((current) => !current);
        }}
      >
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
