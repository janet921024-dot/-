-- 客人名單分類：管理員可以把客人標記為「教練」，客人名單會分成 臨打 / 週期 / 教練。
-- 臨打、週期依預約類型自動分類，只有「教練」需要記錄在這裡。
-- 已經執行過前面幾份 SQL 的專案，在 SQL Editor 執行這份一次即可。

create table public.customer_categories (
  -- 與後台客人名單相同的識別方式：手機號碼，或 name:姓名、bulk:週期預約名稱
  customer_key text primary key check (char_length(customer_key) between 1 and 100),
  category text not null check (category in ('coach')),
  updated_at timestamptz not null default now()
);

alter table public.customer_categories enable row level security;
-- 主管理員與副管理員都可以查看與標記；客人完全看不到
create policy customer_categories_admin_read on public.customer_categories
  for select to authenticated using (public.is_admin());
create policy customer_categories_admin_write on public.customer_categories
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.customer_categories from anon;
grant select, insert, update, delete on public.customer_categories to authenticated;

alter publication supabase_realtime add table public.customer_categories;
