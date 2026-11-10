-- 冠軍羽球館預約系統：Supabase 資料庫結構
-- 在 Supabase 後台「SQL Editor」貼上整份執行一次即可，接著執行 002_shop_settings.sql。
--
-- 設計重點：
-- * 客人不用登入：預約、查詢都透過下面的函式，不能直接讀寫預約資料表。
-- * 場地狀況只公開「哪一格有人訂」（booking_slots），不公開姓名電話。
-- * 同一日期、時段、場地只能有一筆預約，由資料庫的主鍵擋住重複預約。
-- * 管理員用 Supabase 帳號（Email + 密碼）登入，角色記在 admins 表。

-- ============ 資料表 ============

create table public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('main', 'sub')),
  created_at timestamptz not null default now()
);

create table public.bookings (
  id bigint generated always as identity primary key,
  date date not null,
  times text[] not null,
  court text[] not null,
  name text not null,
  user_phone text not null,
  transfer_code text,
  is_confirmed boolean not null default false,
  is_bulk boolean not null default false,
  no_show boolean not null default false,
  created_at timestamptz not null default now()
);

-- 每筆預約佔用的每一格（日期 × 時段 × 場地），主鍵保證不會重複預約
create table public.booking_slots (
  booking_id bigint not null references public.bookings (id) on delete cascade,
  date date not null,
  time text not null,
  court text not null,
  primary key (date, time, court)
);
create index booking_slots_booking_id_idx on public.booking_slots (booking_id);

-- 主管理員手動調整的暢打保留場地；空陣列代表當天取消暢打（包場）
create table public.open_play_overrides (
  date date primary key,
  courts text[] not null default '{}'
);

-- ============ 角色判斷 ============

create function public.admin_role() returns text
language sql stable security definer set search_path = public
as $$ select role from public.admins where user_id = auth.uid() $$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public
as $$ select public.admin_role() is not null $$;

create function public.is_main_admin() returns boolean
language sql stable security definer set search_path = public
as $$ select coalesce(public.admin_role() = 'main', false) $$;

-- ============ 營業與暢打規則（與網頁上的規則一致） ============

create function public.open_play_times(d date) returns text[]
language sql immutable
as $$
  select case when extract(isodow from d) between 1 and 5
    then array['12:00', '13:00', '14:00', '15:00', '16:00']  -- 平日 12:00-17:00
    else array['18:00', '19:00', '20:00', '21:00']           -- 假日 18:00-22:00
  end
$$;

create function public.open_play_courts(d date) returns text[]
language sql stable security definer set search_path = public
as $$
  select coalesce(
    (select courts from public.open_play_overrides where date = d),
    case when extract(isodow from d) between 1 and 5 then array['2'] else array['2', '3', '4'] end
  )
$$;

create function public.taipei_now() returns timestamp
language sql stable
as $$ select now() at time zone 'Asia/Taipei' $$;

-- 檢查時段、場地格式與暢打保留，不合法就丟出錯誤代碼
create function public.check_slots(d date, p_times text[], p_courts text[]) returns void
language plpgsql stable security definer set search_path = public
as $$
declare
  t text;
  c text;
begin
  if coalesce(cardinality(p_times), 0) = 0 or coalesce(cardinality(p_courts), 0) = 0 then
    raise exception 'INVALID_SLOT';
  end if;
  if (select count(distinct x) from unnest(p_times) x) <> cardinality(p_times)
     or (select count(distinct x) from unnest(p_courts) x) <> cardinality(p_courts) then
    raise exception 'INVALID_SLOT';
  end if;
  foreach c in array p_courts loop
    if c not in ('1', '2', '3', '4') then raise exception 'INVALID_SLOT'; end if;
  end loop;
  foreach t in array p_times loop
    if t !~ '^([01][0-9]|2[0-3]):00$' then raise exception 'INVALID_SLOT'; end if;
    foreach c in array p_courts loop
      if t = any (public.open_play_times(d)) and c = any (public.open_play_courts(d)) then
        raise exception 'OPEN_PLAY';
      end if;
    end loop;
  end loop;
end
$$;

-- ============ 客人：預約與查詢 ============

create function public.create_booking(
  p_date date, p_times text[], p_courts text[], p_name text, p_phone text, p_code text
) returns jsonb
language plpgsql volatile security definer set search_path = public
as $$
declare
  today date := public.taipei_now()::date;
  now_hour int := extract(hour from public.taipei_now());
  open_hour int := case when extract(isodow from p_date) between 1 and 5 then 9 else 7 end;
  t text;
  c text;
  h int;
  b public.bookings;
begin
  p_name := btrim(coalesce(p_name, ''));
  if p_name = '' or char_length(p_name) > 30 then raise exception 'INVALID_NAME'; end if;
  if coalesce(p_phone, '') !~ '^09[0-9]{8}$' then raise exception 'INVALID_PHONE'; end if;
  if coalesce(p_code, '') !~ '^[0-9]{5}$' then raise exception 'INVALID_CODE'; end if;
  -- 臨打只開放今天起 7 天內
  if p_date is null or p_date < today or p_date > today + 7 then raise exception 'INVALID_DATE'; end if;

  perform public.check_slots(p_date, p_times, p_courts);
  foreach t in array p_times loop
    h := split_part(t, ':', 1)::int;
    if h < open_hour or h > 21 or (p_date = today and h <= now_hour) then
      raise exception 'INVALID_SLOT';
    end if;
  end loop;

  insert into public.bookings (date, times, court, name, user_phone, transfer_code)
  values (
    p_date,
    (select array_agg(x order by x) from unnest(p_times) x),
    (select array_agg(x order by x) from unnest(p_courts) x),
    p_name, p_phone, p_code
  )
  returning * into b;

  begin
    foreach t in array p_times loop
      foreach c in array p_courts loop
        insert into public.booking_slots (booking_id, date, time, court) values (b.id, p_date, t, c);
      end loop;
    end loop;
  exception when unique_violation then
    raise exception 'SLOT_TAKEN';
  end;

  return jsonb_build_object(
    'id', b.id, 'date', b.date, 'times', b.times, 'court', b.court, 'name', b.name,
    'user_phone', b.user_phone, 'transfer_code', b.transfer_code,
    'is_confirmed', b.is_confirmed, 'created_at', b.created_at
  );
end
$$;

-- 姓名、電話、後五碼三項都符合才回傳（不含爽約標記等店內資訊）
create function public.lookup_bookings(p_name text, p_phone text, p_code text)
returns table (
  id bigint, date date, times text[], court text[], name text,
  user_phone text, transfer_code text, is_confirmed boolean, created_at timestamptz
)
language sql stable security definer set search_path = public
as $$
  select b.id, b.date, b.times, b.court, b.name, b.user_phone, b.transfer_code, b.is_confirmed, b.created_at
  from public.bookings b
  where btrim(coalesce(p_name, '')) <> ''
    and btrim(b.name) = btrim(p_name)
    and b.user_phone = p_phone
    and b.transfer_code = p_code
  order by b.date desc, b.created_at desc
$$;

-- ============ 管理員 ============

-- 週期預約：一次建立多週，任一格衝突就整批不建立
create function public.create_bulk_bookings(p_name text, p_dates date[], p_times text[], p_courts text[])
returns int
language plpgsql volatile security definer set search_path = public
as $$
declare
  d date;
  t text;
  c text;
  b_id bigint;
  n int := 0;
begin
  if not public.is_main_admin() then raise exception 'NOT_ALLOWED'; end if;
  p_name := btrim(coalesce(p_name, ''));
  if p_name = '' then raise exception 'INVALID_NAME'; end if;
  if coalesce(cardinality(p_dates), 0) = 0 then raise exception 'INVALID_DATE'; end if;

  foreach d in array p_dates loop
    perform public.check_slots(d, p_times, p_courts);
    insert into public.bookings (date, times, court, name, user_phone, transfer_code, is_confirmed, is_bulk)
    values (
      d,
      (select array_agg(x order by x) from unnest(p_times) x),
      (select array_agg(x order by x) from unnest(p_courts) x),
      p_name, '內部建立', null, true, true
    )
    returning id into b_id;
    begin
      foreach t in array p_times loop
        foreach c in array p_courts loop
          insert into public.booking_slots (booking_id, date, time, court) values (b_id, d, t, c);
        end loop;
      end loop;
    exception when unique_violation then
      raise exception 'SLOT_TAKEN';
    end;
    n := n + 1;
  end loop;
  return n;
end
$$;

create function public.list_admins() returns table (email text, role text)
language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_main_admin() then raise exception 'NOT_ALLOWED'; end if;
  return query
    select u.email::text, a.role from public.admins a join auth.users u on u.id = a.user_id
    order by a.role, u.email;
end
$$;

-- 副管理員需先在 Supabase 後台 Authentication → Users 建立帳號，再由主管理員授權
create function public.grant_sub_admin(p_email text) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare
  uid uuid;
begin
  if not public.is_main_admin() then raise exception 'NOT_ALLOWED'; end if;
  select id into uid from auth.users where lower(email) = lower(btrim(p_email));
  if uid is null then raise exception 'USER_NOT_FOUND'; end if;
  if exists (select 1 from public.admins where user_id = uid) then raise exception 'ALREADY_ADMIN'; end if;
  insert into public.admins (user_id, role) values (uid, 'sub');
end
$$;

create function public.revoke_sub_admin(p_email text) returns void
language plpgsql volatile security definer set search_path = public
as $$
begin
  if not public.is_main_admin() then raise exception 'NOT_ALLOWED'; end if;
  delete from public.admins a using auth.users u
  where u.id = a.user_id and a.role = 'sub' and lower(u.email) = lower(btrim(p_email));
end
$$;

-- ============ 權限（Row Level Security） ============

alter table public.admins enable row level security;
alter table public.bookings enable row level security;
alter table public.booking_slots enable row level security;
alter table public.open_play_overrides enable row level security;

-- 管理員只能讀到自己的角色
create policy admins_read_own on public.admins
  for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete on public.admins from anon, authenticated;

-- 預約明細只有管理員看得到；兩種管理員都能勾選確認與爽約，只有主管理員能刪除
create policy bookings_admin_read on public.bookings
  for select to authenticated using (public.is_admin());
create policy bookings_admin_update on public.bookings
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy bookings_main_delete on public.bookings
  for delete to authenticated using (public.is_main_admin());
revoke all on public.bookings from anon;
revoke insert, update on public.bookings from authenticated;
grant update (is_confirmed, no_show) on public.bookings to authenticated;

-- 場地佔用格：所有人可讀（不含個資），只能透過函式寫入
create policy slots_public_read on public.booking_slots
  for select to anon, authenticated using (true);
revoke insert, update, delete on public.booking_slots from anon, authenticated;

-- 暢打設定：所有人可讀，只有主管理員能改
create policy open_play_public_read on public.open_play_overrides
  for select to anon, authenticated using (true);
create policy open_play_main_write on public.open_play_overrides
  for all to authenticated using (public.is_main_admin()) with check (public.is_main_admin());
revoke all on public.open_play_overrides from anon;
grant select on public.open_play_overrides to anon;

-- ============ 函式執行權限 ============

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.create_booking(date, text[], text[], text, text, text),
  public.lookup_bookings(text, text, text)
to anon, authenticated;
grant execute on function
  public.admin_role(),
  public.is_admin(),
  public.is_main_admin(),
  public.create_bulk_bookings(text, date[], text[], text[]),
  public.list_admins(),
  public.grant_sub_admin(text),
  public.revoke_sub_admin(text)
to authenticated;

-- ============ 即時同步 ============

alter publication supabase_realtime add table public.bookings, public.booking_slots, public.open_play_overrides;
