# 冠軍羽球館預約系統

客人線上預約場地、查看一週場地狀況與查詢預約；店家在後台確認預約、管理暢打與週期預約。資料存在 Supabase。

- 客人預約網頁：`index.html`
- 店家後台：`admin.html`（客人網頁上沒有後台入口）

## 修改網站

程式原始碼在 `src/`，修改後執行：

```bash
npm install
npm run build
```

會重新產生網站實際使用的 `index.html`、`admin.html` 與 `assets/`，一起提交。React、Supabase 與圖示字型也會複製到 `assets/vendor/`，網站不依賴外部 CDN。

## 資料庫

在 Supabase 的 SQL Editor 依序執行一次：

1. `supabase/schema.sql`：資料表、預約規則與權限
2. `supabase/002_shop_settings.sql`：匯款帳號與聯絡電話（後台「設定」可修改）
3. `supabase/003_admin_single_booking.sql`：後台「新增預約 → 單次」（例如電話預約）
4. `supabase/004_sub_admin_accounts.sql`：後台「設定 → 副管理員」直接建立帳號、改密碼
5. `supabase/005_system_health.sql`：每週自動檢查用，回報 Supabase 改版是否影響建立副管理員
6. `supabase/006_rate_limits.sql`：防止濫用，同一個 IP 每小時最多成功預約 15 次、查詢 30 次
