[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

# Codex Taskboard

一個本地優先（Local-first）的任務與議題看板，可在瀏覽器中運行，也可透過獨立 CDP 啟動器或注入腳本嵌入 Codex。同一套 HTTP API 同時支援 React UI 與隨附 Codex Skill 所使用的 `taskctl` CLI。

![Codex Taskboard 產品截圖](docs/assets/codex-taskboard.png)

## 系統需求

- Node.js 22.5 或更高版本
- 建置 macOS App 與 DMG：Xcode Command Line Tools、Rust 1.88 或更高版本，以及 `aarch64-apple-darwin` 與 `x86_64-apple-darwin` target。`npm install` 會安裝本專案所使用的 Tauri CLI。
- 建置 Windows NSIS：Microsoft Store 版 Codex App、Rust 1.88 或更高版本，以及包含 C++ 工作負載與 Windows SDK 的 Visual Studio Build Tools。

## 本地運行

```bash
npm install
npm run build
npm start
```

開啟 [http://127.0.0.1:47823](http://127.0.0.1:47823)。SQLite 資料庫儲存於 `.data/taskboard.sqlite`。

如需在前端即時重載（Hot Reload）模式下開發：

```bash
npm run dev
```

Vite UI 將運行在 [http://127.0.0.1:5173](http://127.0.0.1:5173)，並將 API 請求代理至本地服務。

## 使用 CLI

在專案中執行：

```bash
npm run taskctl -- project create \
  --id my-project \
  --name "My project" \
  --workspace-path /absolute/path/to/repository

npm run taskctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

請執行 `npm link`，以便在 shell PATH 中直接使用 `taskctl` 指令。設定 `CODEX_TASKBOARD_URL` 可讓 CLI 指向其他本地或區域網路（LAN）服務。雲端部署透過**本機配套服務（loopback companion）**使用 `taskctl cloud login` 進行設定。

## 安裝 Codex Skill

將 `skills/manage-taskboard` 複製或建立符號連結至 Codex Skill 目錄，然後啟動一個新的 Codex 任務：

```bash
ln -s /absolute/path/to/codex-taskboard/skills/manage-taskboard \
  ~/.agents/skills/manage-taskboard
```

桌面 App 會使該目錄與內建 Skill 保持同步。該 Skill 會引導 Codex 檢視議題、將其移至 `in_progress`、使用樂觀版本控制、驗證成果，然後移至 `in_review`；只有在使用者明確確認驗收或要求將議題標記為完成後，才會將狀態變更為 `done`。

## 嵌入 Codex

### 手動：使用專用 CDP 連接埠

保持現有 Codex 視窗開啟。在 Taskboard 儲存庫中，使用專用 CDP 連接埠啟動第二個 Codex 實例：

```bash
open -n -a /Applications/ChatGPT.app --args \
  --remote-debugging-port=9231 \
  --remote-allow-origins=http://127.0.0.1:9231
```

新 Codex 視窗出現後，在另一個終端機中執行注入器：

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

使用嵌入式看板時，請保持注入器終端機持續運行。原 Codex 視窗不會改變，新視窗則會顯示 Taskboard 側邊欄入口。若連接埠 `9231` 已被占用，請在兩個指令中改用其他連接埠。

### 推薦：以單一指令啟動獨立 Taskboard 視窗

保持現有 Codex 視窗開啟，然後執行：

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

該指令會在需要時自動啟動本地 Taskboard 服務。它會重用已開啟且具備可用 CDP 渲染器的 Codex；若一般 Codex 沒有 CDP，則會在該實例的原生瀏覽面板中開啟 Taskboard；若未開啟 Codex，它會使用獨立設定檔與僅限 loopback 存取的連接埠 `9231` 啟動官方 macOS Codex App。在有可用 CDP 時，它會在 Plugins 後方注入原生外觀的 Taskboard 入口，並持續監控服務與替換後的渲染器。使用嵌入式看板時請保持該指令運行。啟動器不會修改 `ChatGPT.app` 或其 `app.asar`。

源碼啟動器會將帶有身份資訊的服務位址寫入 `.data/launcher-runtime.json`。透過 `npm link` 安裝的 `taskctl` 預設會讀取此檔案。因此，一般 shell 與從看板開啟的 Codex 任務無需設定額外環境變數，即可共享同一個 Taskboard 服務。

### macOS App：無需終端機即可開啟與注入

如需進行 Tauri 開發，請執行：

```bash
npm run app:dev
```

如需建置本機 App 與 DMG，請先安裝兩個 Rust target，然後執行建置：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run app:build
```

從 Finder 開啟 `src-tauri/target/universal-apple-darwin/release/bundle/macos/Codex Taskboard.app`。DMG 檔案位於 `src-tauri/target/universal-apple-darwin/release/bundle/dmg/`。若只需安裝穩定版本，請至 [GitHub Releases](https://github.com/chuspeeism/dashi-taskboard/releases/latest) 下載當前 DMG。

該 App 包含獨立的 Node 執行環境、Taskboard 服務、編譯後的前端 Web UI、Skill、CLI 包裝器與注入腳本。它會啟動服務，重用已開啟且具備可用 CDP 渲染器的 Codex；若一般 Codex 沒有 CDP，則會在該實例的原生瀏覽面板中開啟 Taskboard；若未開啟 Codex，則會啟動官方 Codex App。在有可用 CDP 時，它會等待渲染器就緒並注入側邊欄入口，隨後在不開啟終端機視窗的情況下開啟看板。該 App 可複製到本專案目錄之外獨立運行；目標 Mac 僅需安裝官方 Codex App，不需要本儲存庫、系統 Node 環境或獨立的 Codex CLI 安裝。Taskboard 資料儲存於 `~/Library/Application Support/Codex Taskboard`，啟動器日誌寫入 `~/Library/Logs/Codex Taskboard/codex-taskboard-launcher.log`。

本地建置使用 ad-hoc 程式碼簽署以供直接驗證。公開發佈的 macOS 下載版本仍需經過 Developer ID 簽名與 Apple 公證（Notarization）。

### Linux App：Ubuntu 24.04 x64 套件

Linux 桌面版第一版僅支援 Ubuntu 24.04 LTS x64。請先安裝官方 ChatGPT 桌面版 `.deb`，並確認執行 `chatgpt` 可以正常開啟。接著從 [GitHub Releases](https://github.com/chuspeeism/dashi-taskboard/releases/latest) 下載 Codex Taskboard `.deb` 或 `.AppImage`。請將下方指令中的 `<file>` 替換為實際下載檔名。

安裝 `.deb` 套件：

```bash
sudo apt install ./<file>.deb
```

或直接執行 AppImage：

```bash
chmod +x ./<file>.AppImage
./<file>.AppImage
```

如需在 Ubuntu 24.04 x64 上建置這兩種套件，請執行：

```bash
npm ci
npm run app:build:linux:x64
```

第一版不支援 ARM64、Fedora、RPM 套件或其他 Linux 發行版。

### Windows App：系統匣啟動器與內建 Taskboard

請先從 Microsoft Store 安裝官方 Codex App。在 Windows x64 上執行以下指令建置當前使用者層級的 NSIS 安裝套件：

```powershell
npm ci
npm run app:build:windows
```

安裝套件位於 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`。其中包含系統匣（Tray）啟動器、內建 Node、本地服務、編譯後的 Web UI、Skill、`taskctl.cmd` 與注入腳本。Taskboard 資料儲存於 `%APPDATA%\Codex Taskboard`，日誌儲存於 `%LOCALAPPDATA%\Codex Taskboard\Logs`，Skill 則會自動複製到 `%USERPROFILE%\.agents\skills\manage-taskboard`。

Windows CI 產出物目前有意保持未簽名狀態，亦不支援自動更新。分發前請閱讀[程式碼簽名政策](docs/code-signing-policy.md)。保留資料的行為請參閱 [Windows 解除安裝說明](docs/windows-uninstall.md)。

Codex 26.715.52143 的渲染器 CSP 會阻止載入任意 HTTP iframe。因此，啟動器會啟用 CDP CSP 繞過，重新載入該渲染器一次，安裝文檔啟動腳本，並等待 Taskboard OOPIF 實際完成載入。同一台機器上的其他行程存取 CDP 時不需要身份驗證，因此啟動器執行環境僅應執行受信任的本地程式碼。

若要注入已透過其他方式使用 CDP 啟動的 Codex 實例，請執行：

```bash
npm run codex:inject -- --port 9229 --open
```

該指令亦會保持常駐，因此服務退出後，已注入的頁籤可重新啟動 Taskboard。使用 `Ctrl-C` 即可停止該指令。

該腳本會在 Codex 側邊欄新增 Taskboard 入口，並在 Codex 的整個主工作區渲染 iframe（包含上下文標題列區域），使 Taskboard 自身的頁首不會留下空白邊條。此完整的矩形頁首位於 Electron 可拖動層之上，並標記為 `no-drag`；由於 Taskboard 處於使用狀態時會隱藏原生上下文操作，其自身操作可使用標準邊距，不會產生多餘的右側空隙。原生側邊欄保持掛載，先前的頁面選取狀態與上下文頁首會暫時隱藏；切換至其他 Codex 頁面時將自動復原。

「在對話中開啟」會在可用時自動選取對應的原生 Codex 專案，並開啟一個未發送的原生 composer，其中包含 `e-taskboard` 指令與議題的真實識別碼。已安裝的 Skill 會根據該指令隱式選取，因此 composer 不會額外新增 `$manage-taskboard` 提及。只有在工作階段實際處理該議題後，才會記錄該工作階段的歸屬關係：`taskctl` 讀取 Codex 的 `CODEX_THREAD_ID`，並在議題或評論變更上記錄該 ID。記錄的 ID 可透過 Codex 的原生路由橋接直接點擊跳轉。每個議題可綁定一個 Git 分支或一個 worktree；選項會由所選 Codex 專案的儲存庫自動掃描，無需手動輸入。此整合完全運用 Codex 現有的專案、composer 與路由標記，不修改 React、不替換 `fetch`、不載入私有 chunk，亦不直接編輯 Codex 資料檔案。

若需使用自訂 UI 來源，請在使用者腳本執行前設定 `window.__CODEX_TASKBOARD_URL__`。

## 環境變數設定

| 變數名稱                     | 預設值                     | 用途說明                                                   |
| ---------------------------- | -------------------------- | ---------------------------------------------------------- |
| `CODEX_TASKBOARD_HOST`     | `0.0.0.0`                | HTTP 綁定位址；設為`127.0.0.1` 可停用區域網路（LAN）存取 |
| `CODEX_TASKBOARD_PORT`     | `47823`                  | 本地 HTTP 連接埠                                           |
| `CODEX_TASKBOARD_DATA_DIR` | `.data`                  | SQLite 資料儲存目錄                                        |
| `CODEX_TASKBOARD_URL`      | `http://127.0.0.1:47823` | CLI API 來源位址                                           |

`npm start` 會輸出本地 URL 與可用的區域網路 URL。同一受信任區域網路中的協作者可開啟其中一個區域網路 URL，共享同一個 Taskboard 服務。任務、評論與附件的異動會透過伺服器發送事件（SSE）即時廣播至所有開啟的客戶端；客戶端重新連線後會執行完整重新整理，確保不遺漏斷線期間的任何變更。使用 `taskctl` 的協作者可透過 `CODEX_TASKBOARD_URL=http://<host-ip>:47823` 指向共享服務。

區域網路模式不具備帳號身份驗證機制：受信任本地網路中任何能存取該 URL 的人皆可讀寫 Taskboard。公網與雲端部署應設定受驗證保護的部署邊界。

## 透過 Cloudflare 共享

對於兩位受信任的協作者，Taskboard 可部署至 Cloudflare 運行，使用 Worker Static Assets 與 API 路由，以 D1 作為權威業務資料庫，並使用私有 R2 bucket 儲存附件。該部署採用具備共享密碼的 HTTPS Basic 驗證，並在全域修訂版本（Revision）變更時自動重新整理已開啟的看板。

每台裝置各自保留本機的專案檢出路徑映射，並持續透過**本地配套服務（local companion / loopback proxy）**提供 Codex、Git/worktree、Skill 與 MCP 能力。雲端模式絕不會退回使用本地 SQLite 資料庫，亦不會同步寫入本地資料庫。

請參閱[雲端協作說明文件](docs/cloud-collaboration.md)，了解擁有者部署、現有 GitHub 安裝設定、密碼輪替、本地路徑映射與一次性本地資料遷移流程。

## 專案驗證

```bash
npm run check
```

該指令會依序執行 TypeScript 型別檢查、生產環境前端建置、元件單元測試，以及伺服器/CLI/注入測試套件。

## 議題 Markdown 支援

議題描述與評論完整支援 GFM（GitHub Flavored Markdown），包含表格與任務檢查清單。`mermaid` 圍欄程式碼區塊會在檢視器載入後渲染為唯讀圖表；若渲染失敗仍可檢視原始圖表語法。Markdown HTML 註解（例如 `<!-- trace-analysis:v1 ... -->`）不會顯示於渲染後的內文中，且不啟用原生 HTML 解析以確保安全性。
