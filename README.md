# 冠軍羽球館預約系統

客人線上預約場地、查看一週場地狀況與查詢預約；店家在後台確認預約、管理暢打與週期預約。資料存在 Supabase。

## 修改網站

程式原始碼在 `src/`，修改後執行：

```bash
npm install
npm run build
```

會重新產生網站實際使用的 `index.html` 與 `assets/`，三者一起提交。

## 資料庫

在 Supabase 的 SQL Editor 依序執行一次：

1. `supabase/schema.sql`：資料表、預約規則與權限
2. `supabase/002_shop_settings.sql`：匯款帳號與聯絡電話（後台「設定」可修改）
