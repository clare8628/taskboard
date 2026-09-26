import { createContext, useContext, type ReactNode } from "react";
import type { TaskPriority, TaskStatus } from "./types";
import { toTraditionalChinese } from "./s2t";

export type TaskboardLanguage = "zh-TW" | "zh" | "en";

interface TaskboardI18n {
  language: TaskboardLanguage;
  locale: "zh-TW" | "zh-CN" | "en";
  text: (chinese: string, english: string, traditional?: string) => string;
}

const I18N: Record<TaskboardLanguage, TaskboardI18n> = {
  "zh-TW": {
    language: "zh-TW",
    locale: "zh-TW",
    text: (chinese, _english, traditional) => traditional ?? toTraditionalChinese(chinese),
  },
  zh: {
    language: "zh",
    locale: "zh-CN",
    text: (chinese) => chinese,
  },
  en: {
    language: "en",
    locale: "en",
    text: (_chinese, english) => english,
  },
};

const STATUS_LABELS: Record<TaskboardLanguage, Record<TaskStatus, string>> = {
  "zh-TW": {
    backlog: "待立項 (Backlog)",
    todo: "等待認領 (Todo)",
    in_progress: "處理中 (In Progress)",
    in_review: "等你確認 (In Review)",
    blocked: "遇到阻礙 (Blocked)",
    done: "完成 (Done)",
    canceled: "取消 (Canceled)",
  },
  zh: {
    backlog: "待立项",
    todo: "等待认领",
    in_progress: "处理中",
    in_review: "等你确认",
    blocked: "遇到阻碍",
    done: "完成",
    canceled: "取消",
  },
  en: {
    backlog: "Backlog",
    todo: "To do",
    in_progress: "In progress",
    in_review: "In review",
    blocked: "Blocked",
    done: "Done",
    canceled: "Canceled",
  },
};

const PRIORITY_LABELS: Record<TaskboardLanguage, Record<TaskPriority, string>> = {
  "zh-TW": {
    none: "無 (None)",
    urgent: "緊急 (Urgent)",
    high: "高 (High)",
    medium: "中 (Medium)",
    low: "低 (Low)",
  },
  zh: {
    none: "无优先级",
    urgent: "紧急",
    high: "高",
    medium: "中",
    low: "低",
  },
  en: {
    none: "No priority",
    urgent: "Urgent",
    high: "High",
    medium: "Medium",
    low: "Low",
  },
};

const TaskboardLanguageContext = createContext<TaskboardLanguage>("en");

export function resolveTaskboardLanguage(value: string | null | undefined): TaskboardLanguage {
  const normalized = value?.trim().replaceAll("_", "-").toLowerCase() ?? "";
  if (
    normalized === "zh-tw" ||
    normalized === "zh-hk" ||
    normalized === "zh-mo" ||
    normalized === "zh-hant" ||
    normalized.startsWith("zh-hant-") ||
    normalized.startsWith("zh-tw-") ||
    normalized.startsWith("zh-hk-") ||
    normalized.startsWith("zh-mo-")
  ) {
    return "zh-TW";
  }
  if (normalized === "zh" || normalized.startsWith("zh-")) {
    return "zh";
  }
  if (normalized === "en" || normalized.startsWith("en-")) {
    return "en";
  }
  return "en";
}

export function getTaskboardI18n(language: TaskboardLanguage): TaskboardI18n {
  return I18N[language] ?? I18N["zh-TW"];
}

export function taskStatusLabel(language: TaskboardLanguage, status: TaskStatus): string {
  return (STATUS_LABELS[language] ?? STATUS_LABELS["zh-TW"])[status];
}

export function taskPriorityLabel(language: TaskboardLanguage, priority: TaskPriority): string {
  return (PRIORITY_LABELS[language] ?? PRIORITY_LABELS["zh-TW"])[priority];
}

export function TaskboardLanguageProvider({
  language,
  children,
}: {
  language: TaskboardLanguage;
  children: ReactNode;
}) {
  return (
    <TaskboardLanguageContext.Provider value={language}>
      {children}
    </TaskboardLanguageContext.Provider>
  );
}

export function useTaskboardI18n(): TaskboardI18n {
  return I18N[useContext(TaskboardLanguageContext)] ?? I18N["zh-TW"];
}
