-- 店家資訊（匯款帳號、聯絡電話），主管理員可在後台「設定」修改
-- 已經執行過 schema.sql 的專案，在 SQL Editor 執行這份一次即可。

create table public.shop_settings (
  id int primary key default 1 check (id = 1),  -- 只會有一列
  bank_code text not null,
  bank_name text not null,
  account_number text not null,
  contact_phone text not null
);
insert into public.shop_settings (id, bank_code, bank_name, account_number, contact_phone)
values (1, '808', '玉山銀行', '0521979250523', '04-2407-0766');

alter table public.shop_settings enable row level security;
create policy shop_settings_public_read on public.shop_settings
  for select to anon, authenticated using (true);
create policy shop_settings_main_update on public.shop_settings
  for update to authenticated using (public.is_main_admin()) with check (public.is_main_admin());
revoke all on public.shop_settings from anon, authenticated;
grant select on public.shop_settings to anon, authenticated;
grant update (bank_code, bank_name, account_number, contact_phone) on public.shop_settings to authenticated;

alter publication supabase_realtime add table public.shop_settings;
