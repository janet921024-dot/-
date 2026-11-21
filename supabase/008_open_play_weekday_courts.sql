-- 平日預設保留給暢打的場地：從第 2 場改成第 2、3 場（假日維持第 2、3、4 場）。
-- 後台「暢打管理」手動設定過的日期不受影響，仍以手動設定為準。
-- 已經執行過 schema.sql 的專案，在 SQL Editor 執行這份一次即可。

create or replace function public.open_play_courts(d date) returns text[]
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select courts from public.open_play_overrides where date = d),
    case when extract(isodow from d) between 1 and 5 then array['2', '3'] else array['2', '3', '4'] end
  )
$$;
