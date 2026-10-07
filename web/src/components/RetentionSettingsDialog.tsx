import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { taskStatusLabel, useTaskboardI18n } from "../i18n";
import {
  ApiError,
  getRetentionOverview,
  runRetentionNow,
  updateRetentionSettings,
} from "../api";
import type { RetentionOverview, RetentionSettings } from "../api";
import type { TaskStatus } from "../types";
import { LinearIcon } from "./LinearIcon";

const DAY_PRESETS = [30, 60, 90, 180, 365];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.7 1.5h2.6l.4 1.8c.4.2.8.4 1.1.6l1.8-.6 1.3 2.2-1.4 1.3a4.6 4.6 0 0 1 0 1.3l1.4 1.3-1.3 2.2-1.8-.6c-.3.2-.7.5-1.1.6l-.4 1.9H6.7l-.4-1.9c-.4-.1-.8-.4-1.1-.6l-1.8.6-1.3-2.2 1.4-1.3a4.6 4.6 0 0 1 0-1.3L2.1 5.5l1.3-2.2 1.8.6c.3-.2.7-.4 1.1-.6l.4-1.8Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function RetentionSettingsButton() {
  const { language, locale, text } = useTaskboardI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [overview, setOverview] = useState<RetentionOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [daysDraft, setDaysDraft] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getRetentionOverview();
      setOverview(data);
      setDaysDraft(String(data.settings.retentionDays));
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? text("此功能仅在 Cloudflare 云端模式下可用。", "This feature is only available in Cloudflare cloud mode.")
          : err instanceof Error ? err.message : String(err),
      );
    } finally {
      setLoading(false);
    }
  }, [text]);

  useEffect(() => {
    if (!open) return;
    void load();
    closeRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, load]);

  function close() {
    setOpen(false);
    setNotice(null);
    triggerRef.current?.focus();
  }

  async function save(patch: Partial<RetentionSettings>) {
    setSaving(true);
    setError(null);
    try {
      const data = await updateRetentionSettings(patch);
      setOverview(data);
      setDaysDraft(String(data.settings.retentionDays));
      setNotice(text("设置已保存", "Settings saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function commitDays(raw: string) {
    if (!overview) return;
    const days = Number(raw);
    const { minDays, maxDays } = overview.limits;
    if (!Number.isInteger(days) || days < minDays || days > maxDays) {
      setError(text(`保留天数需介于 ${minDays}–${maxDays} 天`, `Retention must be ${minDays}–${maxDays} days`));
      setDaysDraft(String(overview.settings.retentionDays));
      return;
    }
    if (days !== overview.settings.retentionDays) void save({ retentionDays: days });
  }

  async function runNow() {
    if (!overview) return;
    const count = overview.totals.overdue;
    const confirmed = window.confirm(text(
      `将立即永久删除 ${count} 张已超过保留期限的卡片（含留言与上传的图片/附件），此操作无法复原。确定继续？`,
      `This will permanently delete ${count} expired cards (including comments and uploaded files). This cannot be undone. Continue?`,
    ));
    if (!confirmed) return;
    setSaving(true);
    setError(null);
    try {
      const data = await runRetentionNow();
      setOverview(data);
      const result = data.result;
      setNotice(result
        ? text(
            `已删除 ${result.deletedTasks} 张卡片、${result.deletedAttachments} 个附件，释放 ${formatBytes(result.freedBytes)}`,
            `Deleted ${result.deletedTasks} cards and ${result.deletedAttachments} files, freed ${formatBytes(result.freedBytes)}`,
          )
        : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const dateFormatter = new Intl.DateTimeFormat(locale, { year: "numeric", month: "2-digit", day: "2-digit" });
  const dateTimeFormatter = new Intl.DateTimeFormat(locale, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const nowMs = Date.now();

  function statusText(candidate: RetentionOverview["candidates"][number]) {
    const base = taskStatusLabel(language, candidate.status as TaskStatus);
    return candidate.archived ? `${base} · ${text("已归档", "Archived")}` : base;
  }

  const settings = overview?.settings;
  const toggles: Array<[keyof RetentionSettings, string]> = [
    ["includeDone", text("已完成的卡片", "Done cards")],
    ["includeCanceled", text("已取消的卡片", "Canceled cards")],
    ["includeArchived", text("已归档的卡片", "Archived cards")],
  ];

  const dialog = open ? createPortal(
    <div
      className="display-settings-backdrop no-drag"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className="display-settings-dialog retention-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="retention-settings-title"
      >
        <header className="display-settings-header">
          <h2 id="retention-settings-title">{text("数据保留与自动清理", "Data retention & auto cleanup")}</h2>
          <button
            ref={closeRef}
            id="retention-settings-close"
            className="icon-button display-settings-close"
            type="button"
            aria-label={text("关闭", "Close")}
            onClick={close}
          >
            <LinearIcon name="close" />
          </button>
        </header>

        <div className="retention-body">
          {loading && !overview && <p className="retention-muted">{text("载入中…", "Loading…")}</p>}
          {error && <p className="retention-error" role="alert">{error}</p>}
          {notice && <p className="retention-notice" role="status">{notice}</p>}

          {settings && overview && (
            <>
              <section className="retention-section">
                <div className="project-automation-switch">
                  <span>
                    <strong>{text("启用定期自动清理", "Enable scheduled cleanup")}</strong>
                    <small className="retention-muted">{overview.schedule}</small>
                  </span>
                  <button
                    id="retention-enabled-switch"
                    type="button"
                    className={"board-setting-switch" + (settings.enabled ? " is-on" : "")}
                    role="switch"
                    aria-checked={settings.enabled}
                    disabled={saving}
                    onClick={() => void save({ enabled: !settings.enabled })}
                  >
                    <span aria-hidden="true" />
                  </button>
                </div>

                <div className="retention-days">
                  <label htmlFor="retention-days-input">{text("保留期限", "Keep data for")}</label>
                  <div className="retention-days-controls">
                    {DAY_PRESETS.map((days) => (
                      <button
                        key={days}
                        id={`retention-preset-${days}`}
                        type="button"
                        className={"retention-chip" + (settings.retentionDays === days ? " is-active" : "")}
                        disabled={saving}
                        onClick={() => void save({ retentionDays: days })}
                      >
                        {days % 30 === 0 && days < 365
                          ? text(`${days / 30} 个月`, `${days / 30} mo`)
                          : days === 365 ? text("1 年", "1 yr") : `${days}d`}
                      </button>
                    ))}
                    <span className="retention-custom">
                      <input
                        id="retention-days-input"
                        type="number"
                        min={overview.limits.minDays}
                        max={overview.limits.maxDays}
                        value={daysDraft}
                        disabled={saving}
                        onChange={(event) => setDaysDraft(event.target.value)}
                        onBlur={(event) => commitDays(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") commitDays((event.target as HTMLInputElement).value);
                        }}
                      />
                      {text("天", "days")}
                    </span>
                  </div>
                  <small className="retention-muted">
                    {text(
                      "以卡片「最后更新时间」起算；期间内若卡片有任何修改，倒数会重新计算。",
                      "Counted from each card's last update; any edit resets the countdown.",
                    )}
                  </small>
                </div>

                <fieldset className="retention-scope">
                  <legend>{text("清理范围（含留言、上传的图片与附件）", "Scope (incl. comments, uploaded images & files)")}</legend>
                  {toggles.map(([key, label]) => (
                    <label key={key} className="retention-check">
                      <input
                        id={`retention-${key}`}
                        type="checkbox"
                        checked={Boolean(settings[key])}
                        disabled={saving}
                        onChange={() => void save({ [key]: !settings[key] } as Partial<RetentionSettings>)}
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              </section>

              <section className="retention-section">
                <div className="retention-stats">
                  <div><strong>{overview.totals.tasks}</strong><span>{text("纳入清理范围", "In scope")}</span></div>
                  <div className={overview.totals.overdue ? "is-warning" : ""}>
                    <strong>{overview.totals.overdue}</strong><span>{text("已到期待删除", "Due now")}</span>
                  </div>
                  <div><strong>{overview.totals.attachments}</strong><span>{text("附件数", "Files")}</span></div>
                  <div><strong>{formatBytes(overview.totals.bytes)}</strong><span>{text("附件容量", "File size")}</span></div>
                </div>
                <p className="retention-muted">
                  {overview.lastRun
                    ? text(
                        `上次执行：${dateTimeFormatter.format(new Date(overview.lastRun.startedAt))}（${overview.lastRun.trigger === "manual" ? "手动" : "排程"}）${overview.lastRun.skipped ? "，已略过" : `，删除 ${overview.lastRun.deletedTasks} 张卡片、释放 ${formatBytes(overview.lastRun.freedBytes)}`}`,
                        `Last run: ${dateTimeFormatter.format(new Date(overview.lastRun.startedAt))} (${overview.lastRun.trigger})${overview.lastRun.skipped ? ", skipped" : `, deleted ${overview.lastRun.deletedTasks} cards, freed ${formatBytes(overview.lastRun.freedBytes)}`}`,
                      )
                    : text("尚未执行过清理。", "Cleanup has not run yet.")}
                </p>
              </section>

              <section className="retention-section">
                <h3>{text("即将被删除的卡片", "Cards scheduled for deletion")}</h3>
                {overview.candidates.length === 0 ? (
                  <p className="retention-muted">{text("目前没有符合清理范围的卡片。", "No cards are in scope.")}</p>
                ) : (
                  <div className="retention-table-wrap">
                    <table className="retention-table">
                      <thead>
                        <tr>
                          <th>{text("预计删除日", "Delete on")}</th>
                          <th>{text("卡片", "Card")}</th>
                          <th>{text("状态", "Status")}</th>
                          <th>{text("最后更新", "Updated")}</th>
                          <th>{text("附件", "Files")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overview.candidates.map((candidate) => {
                          const deleteMs = Date.parse(candidate.deleteAt);
                          const daysLeft = Math.ceil((deleteMs - nowMs) / 86400000);
                          return (
                            <tr key={candidate.id} className={daysLeft <= 0 ? "is-due" : daysLeft <= 7 ? "is-soon" : ""}>
                              <td>
                                {dateFormatter.format(new Date(deleteMs))}
                                <small>
                                  {daysLeft <= 0
                                    ? text("下次排程删除", "Next run")
                                    : text(`剩 ${daysLeft} 天`, `${daysLeft}d left`)}
                                </small>
                              </td>
                              <td>
                                <a href={`?issue=${encodeURIComponent(candidate.identifier)}`}>{candidate.identifier}</a>
                                <span className="retention-title">{candidate.title}</span>
                                {candidate.projectName && <small>{candidate.projectName}</small>}
                              </td>
                              <td>{statusText(candidate)}</td>
                              <td>{dateFormatter.format(new Date(candidate.updatedAt))}</td>
                              <td>
                                {candidate.attachmentCount
                                  ? `${candidate.attachmentCount} · ${formatBytes(candidate.attachmentBytes)}`
                                  : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {overview.totals.tasks > overview.candidates.length && (
                      <p className="retention-muted">
                        {text(
                          `仅显示最早的 ${overview.candidates.length} 张（共 ${overview.totals.tasks} 张）`,
                          `Showing earliest ${overview.candidates.length} of ${overview.totals.tasks}`,
                        )}
                      </p>
                    )}
                  </div>
                )}
              </section>
            </>
          )}
        </div>

        <footer className="display-settings-footer retention-footer">
          <small className="retention-muted">
            {text("删除后无法复原，若需保留请将卡片改为其他状态或修改内容。", "Deletion is permanent. Change a card's status or edit it to keep it.")}
          </small>
          <button
            id="retention-run-now"
            className="button danger"
            type="button"
            disabled={saving || !overview || overview.totals.overdue === 0}
            onClick={() => void runNow()}
          >
            {text("立即清理到期卡片", "Clean up due cards now")}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        id="retention-settings-trigger"
        className={"task-filter-trigger board-card-display-trigger retention-trigger" + (open ? " is-open" : "")}
        type="button"
        aria-label={text("数据保留设置", "Data retention settings")}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={text("数据保留与自动清理", "Data retention & auto cleanup")}
        onClick={() => setOpen(true)}
      >
        <GearIcon />
      </button>
      {dialog}
    </>
  );
}
