-- 防止濫用：同一個網路位址（IP）在一小時內最多預約成功 15 次、查詢 30 次。
-- 一般客人遠遠用不到這麼多，但能擋住用程式大量假預約佔滿場地、或猜匯款後五碼的情況。
-- 已經執行過前面幾份 SQL 的專案，在 SQL Editor 執行這份一次即可。

create table public.rate_limit_log (
  key text not null,
  action text not null,
  created_at timestamptz not null default now()
);
create index rate_limit_log_lookup_idx on public.rate_limit_log (action, key, created_at);
create index rate_limit_log_created_idx on public.rate_limit_log (created_at);
alter table public.rate_limit_log enable row level security;
revoke all on public.rate_limit_log from anon, authenticated;

-- 呼叫者的 IP（Supabase 會帶在 x-forwarded-for 的第一個位置）
create function public.client_ip() returns text
language sql stable
as $$
  select nullif(btrim(coalesce(
    split_part(nullif(current_setting('request.headers', true), '')::json->>'x-forwarded-for', ',', 1),
    nullif(current_setting('request.headers', true), '')::json->>'cf-connecting-ip',
    ''
  )), '')
$$;

create function public.enforce_rate_limit(p_action text, p_max int, p_window interval) returns void
language plpgsql volatile security definer set search_path = public
as $$
declare
  ip text := public.client_ip();
begin
  -- 取不到來源位址時不限制，避免誤擋所有客人
  if ip is null then return; end if;
  if (select count(*) from public.rate_limit_log
      where action = p_action and key = ip and created_at > now() - p_window) >= p_max then
    raise exception 'RATE_LIMITED';
  end if;
  insert into public.rate_limit_log (key, action) values (ip, p_action);
  -- 只保留一天內的紀錄，資料表不會越長越大
  delete from public.rate_limit_log where created_at < now() - interval '1 day';
end
$$;

-- 客人預約：加上次數限制（其餘規則與 schema.sql 相同）。
-- 預約失敗（例如被別人訂走）不會留下紀錄，所以只計算成功的預約。
create or replace function public.create_booking(
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
  if p_date is null or p_date < today or p_date > today + 7 then raise exception 'INVALID_DATE'; end if;

  perform public.check_slots(p_date, p_times, p_courts);
  foreach t in array p_times loop
    h := split_part(t, ':', 1)::int;
    if h < open_hour or h > 21 or (p_date = today and h <= now_hour) then
      raise exception 'INVALID_SLOT';
    end if;
  end loop;

  perform public.enforce_rate_limit('booking', 15, interval '1 hour');

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

-- 查詢預約：每次查詢都計算次數（避免猜匯款後五碼）
create or replace function public.lookup_bookings(p_name text, p_phone text, p_code text)
returns table (
  id bigint, date date, times text[], court text[], name text,
  user_phone text, transfer_code text, is_confirmed boolean, created_at timestamptz
)
language plpgsql volatile security definer set search_path = public
as $$
begin
  perform public.enforce_rate_limit('lookup', 30, interval '1 hour');
  return query
    select b.id, b.date, b.times, b.court, b.name, b.user_phone, b.transfer_code, b.is_confirmed, b.created_at
    from public.bookings b
    where btrim(coalesce(p_name, '')) <> ''
      and btrim(b.name) = btrim(p_name)
      and b.user_phone = p_phone
      and b.transfer_code = p_code
    order by b.date desc, b.created_at desc;
end
$$;

-- 確認限制有作用：回報這次請求是否取得來源位址。
-- 不回傳位址本身，只回傳打亂後的前 8 碼，用來比對兩次請求是否來自同一個地方。
create or replace function public.rate_limit_probe() returns jsonb
language sql stable security definer set search_path = public, extensions
as $$
  select jsonb_build_object(
    'ip_detected', public.client_ip() is not null,
    'ip_fingerprint', left(encode(digest(coalesce(public.client_ip(), ''), 'sha256'), 'hex'), 8),
    'forwarded_hops', coalesce(array_length(string_to_array(nullif(current_setting('request.headers', true), '')::json->>'x-forwarded-for', ','), 1), 0)
  )
$$;

revoke execute on function public.client_ip(), public.enforce_rate_limit(text, int, interval) from public, anon, authenticated;
revoke execute on function public.rate_limit_probe() from public;
grant execute on function public.rate_limit_probe() to anon, authenticated;
