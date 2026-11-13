-- 後台「新增預約 → 單次」：主管理員替客人建立某一天的預約（例如電話預約）
-- 已經執行過 schema.sql 的專案，在 SQL Editor 執行這份一次即可。
-- 與客人自己預約不同：不限 7 天內、不需匯款後五碼，建立後直接是「已確認」。

create function public.create_admin_booking(
  p_name text, p_phone text, p_date date, p_times text[], p_courts text[]
) returns bigint
language plpgsql volatile security definer set search_path = public
as $$
declare
  t text;
  c text;
  b_id bigint;
begin
  if not public.is_main_admin() then raise exception 'NOT_ALLOWED'; end if;
  p_name := btrim(coalesce(p_name, ''));
  if p_name = '' or char_length(p_name) > 30 then raise exception 'INVALID_NAME'; end if;
  -- 電話可不填；有填的話允許手機或市話（數字與 -）
  p_phone := nullif(btrim(coalesce(p_phone, '')), '');
  if p_phone is not null and p_phone !~ '^[0-9-]{8,15}$' then raise exception 'INVALID_PHONE'; end if;
  if p_date is null or p_date < public.taipei_now()::date then raise exception 'INVALID_DATE'; end if;

  perform public.check_slots(p_date, p_times, p_courts);

  insert into public.bookings (date, times, court, name, user_phone, transfer_code, is_confirmed, is_bulk)
  values (
    p_date,
    (select array_agg(x order by x) from unnest(p_times) x),
    (select array_agg(x order by x) from unnest(p_courts) x),
    p_name, coalesce(p_phone, '內部建立'), null, true, false
  )
  returning id into b_id;

  begin
    foreach t in array p_times loop
      foreach c in array p_courts loop
        insert into public.booking_slots (booking_id, date, time, court) values (b_id, p_date, t, c);
      end loop;
    end loop;
  exception when unique_violation then
    raise exception 'SLOT_TAKEN';
  end;

  return b_id;
end
$$;

revoke execute on function public.create_admin_booking(text, text, date, text[], text[]) from public, anon, authenticated;
grant execute on function public.create_admin_booking(text, text, date, text[], text[]) to authenticated;
