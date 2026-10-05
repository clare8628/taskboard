import { spawnSync } from "node:child_process";

export function signalProcessTree(child, signal) {
  const pid = typeof child === "number" ? child : child?.pid;

  if (Number.isInteger(pid)) {
    if (process.platform === "win32") {
      const result = spawnSync(
        "taskkill.exe",
        ["/PID", String(pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      if (result.error || result.status !== 0) {
        try {
          if (typeof child?.kill === "function") child.kill(signal);
          else process.kill(pid, signal);
        } catch {}
      }
      return;
    }

    try {
      process.kill(-pid, signal);
      return;
    } catch {}
  }

  try {
    if (typeof child?.kill === "function") {
      child.kill(signal);
    } else if (Number.isInteger(pid)) {
      process.kill(pid, signal);
    }
  } catch {}
}
