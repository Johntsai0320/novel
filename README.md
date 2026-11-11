# 雲端書閣 (Cloud Book Sanctuary) — 私人 NAS 線上 EPUB / TXT 小說閱讀平台

專為個人與家庭打造的**私人 NAS 線上小說閱讀平台**，支援手機（iOS / Android PWA）與電腦瀏覽器直接線上閱讀放置於私人 NAS 上的 `.epub` 與 `.txt` 小說檔案。

---

## ✨ 核心功能特色

1. **免下載整本檔案於本機（章節級線上串流）**
   - 後端自動解析 NAS 上的 `.epub` 與 `.txt` 檔案，前端僅拉取「目錄結構」與「當前閱讀的單一章節文字」，即使在手機行動網路下閱讀數十 MB 的長篇小說也能秒開，**完全不佔用手機或電腦本機儲存空間**。
   - 自動偵測中文編碼（支援 `UTF-8`、`GB18030 / GBK / GB2312`、`Big5`、`UTF-16`），徹底解決簡體 `.txt` 小說亂碼問題。
2. **閱讀時自動簡體轉繁體（OpenCC 台灣正體與慣用詞轉換）**
   - 預設啟用 **「簡→繁 (台灣正體 + 台灣慣用詞彙)」**（例如：`软件` → `軟體`、`信息` → `資訊`），並提供一鍵切換 **「簡→繁 (標準)」** 或 **「顯示原文」**。
   - 書庫書名、分類子資料夾、章節目錄與內文皆自動轉換。
3. **跨裝置閱讀紀錄線上同步**
   - 自動同步每本書的 **目前閱讀章節、章節內捲動百分比、最後閱讀時間、個人書籤（含段落摘要）與排版主題設定**。
   - 支援自訂 **同步識別碼 (Sync Key / PIN)**（例如預設 `default` 或設定為 `1234`），在手機與電腦輸入相同識別碼即可即時接續閱讀進度。
   - 同步紀錄同時儲存於 NAS 伺服器 (`/data/sync_store.json`) 與 WebDAV 遠端書庫 (`.novel-reader-sync.json`)。
4. **雙架構部署與連線支援**
   - **模式一（NAS Docker / Node.js 直接掛載）**：直接掛載 NAS 小說資料夾 (`/novels`)，內建後端 API 與 WebDAV 代理。
   - **模式二（GitHub Pages 純前端 + WebDAV / 遠端 NAS API）**：透過 GitHub Actions 自動部署前端至 GitHub Pages，可於網頁右上角設定連回私人 NAS API 或 WebDAV 伺服器。
5. **進階閱讀體驗**
   - **子資料夾分類與搜尋**：自動掃描 NAS 子資料夾作為分類標籤，支援書名/分類即時關鍵字搜尋與格式篩選。
   - **智慧章節解析與書籤**：`.txt` 自動擷取「第X章/回/節/卷/楔子/番外」生成目錄；`.epub` 自動解析內建 OPF / NCX / NAV 目錄與插圖。
   - **4 款護眼閱讀主題與排版自訂**：內建「暖調宣紙」、「晨光純白」、「松石護眼」、「靜夜深墨（夜間深色模式）」，可自由調整字體（思源宋體 / 思源黑體 / 傳統楷體）、字級大小（14px–30px）、行距與版面寬度。

---

## 🚀 部署方式一：在 Synology / QNAP NAS 上透過 Docker 部署（最推薦）

1. 在 NAS 上透過 Git 下載本專案，或將本專案放至 NAS 資料夾：
   ```bash
   git clone https://github.com/Johntsai0320/novel.git
   cd novel
   ```
2. 修改 [`docker-compose.yml`](./docker-compose.yml) 中的 `volumes` 路徑，將左側替換為您 NAS 上實際存放小說的資料夾路徑：
   ```yaml
   volumes:
     - /volume1/books:/novels   # 改為您 NAS 上的小說資料夾路徑
     - ./data:/data             # 儲存跨裝置同步閱讀紀錄與設定
   ```
3. 啟動容器（或在群暉 Synology **Container Manager** / QNAP **Container Station** 中新增專案匯入 `docker-compose.yml`）：
   ```bash
   docker compose up -d --build
   ```
4. 打開手機或電腦瀏覽器連線至 `http://<您的NAS_IP>:3000` 即可開始閱讀！

---

## 🚀 部署方式二：在 NAS 或伺服器上以 Node.js 直接執行

```bash
git clone https://github.com/Johntsai0320/novel.git
cd novel
npm install
# 指定小說資料夾路徑並啟動（預設讀取 ./novels）
NOVELS_DIR=/path/to/your/nas/novels PORT=3000 npm start
```

---

## 🌐 部署方式三：GitHub Pages 線上前端 + 連回 NAS (WebDAV / API)

本儲存庫已內建 GitHub Actions ([`.github/workflows/deploy-pages.yml`](./.github/workflows/deploy-pages.yml))：
1. 進入 GitHub 儲存庫的 **Settings → Pages**，將 **Build and deployment > Source** 設為 **GitHub Actions**。
2. 開啟部署後的 GitHub Pages 網址，點擊右上角 **「⚙️ NAS 連線設定」**：
   - 可填入您的 **NAS 後端 API 網址**，或勾選 **「啟用 NAS WebDAV 遠端書庫掛載」** 輸入 NAS 的 WebDAV 網址與帳密。
   - 設定相同的 **「🔑 跨裝置閱讀同步識別碼」**（例如 `default` 或 `1234`），即可在手機與電腦間自動同步閱讀進度與書籤。
