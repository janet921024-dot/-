-- 後台「設定 → 副管理員」：主管理員直接建立副管理員帳號（Email + 密碼）、幫副管理員改密碼
-- 已經執行過前面幾份 SQL 的專案，在 SQL Editor 執行這份一次即可。
--
-- 注意：Supabase 沒有提供從資料庫建立登入帳號的正式方式，這裡直接寫入 auth.users / auth.identities，
-- 寫法與 Supabase 後台「Add user」建立的帳號相同。若日後 Supabase 改版造成失效，
-- 仍可改回在 Supabase 後台 Authentication → Users → Add user 建立帳號，再於後台輸入 Email 授權。

create function public.create_sub_admin(p_email text, p_password text) returns void
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  uid uuid;
  mail text := lower(btrim(coalesce(p_email, '')));
begin
  if not public.is_main_admin() then raise exception 'NOT_ALLOWED'; end if;
  if mail !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'INVALID_EMAIL'; end if;
  if char_length(coalesce(p_password, '')) < 8 then raise exception 'WEAK_PASSWORD'; end if;

  select id into uid from auth.users where lower(email) = mail;
  if uid is not null then
    if exists (select 1 from public.admins where user_id = uid) then raise exception 'ALREADY_ADMIN'; end if;
    -- 帳號已存在（例如之前在 Supabase 後台建過）但不是管理員：設定密碼後授權
    update auth.users
      set encrypted_password = crypt(p_password, gen_salt('bf')),
          email_confirmed_at = coalesce(email_confirmed_at, now()),
          updated_at = now()
      where id = uid;
  else
    uid := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', mail,
      crypt(p_password, gen_salt('bf')), now(),
      '{"provider": "email", "providers": ["email"]}', '{}', now(), now(),
      '', '', '', ''
    );
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (
      gen_random_uuid(), uid, uid::text,
      jsonb_build_object('sub', uid::text, 'email', mail, 'email_verified', true),
      'email', now(), now(), now()
    );
  end if;

  insert into public.admins (user_id, role) values (uid, 'sub');
end
$$;

-- 只能改副管理員的密碼；主管理員改自己的密碼請用「修改我的密碼」
create function public.set_sub_admin_password(p_email text, p_password text) returns void
language plpgsql volatile security definer set search_path = public, extensions
as $$
declare
  uid uuid;
begin
  if not public.is_main_admin() then raise exception 'NOT_ALLOWED'; end if;
  if char_length(coalesce(p_password, '')) < 8 then raise exception 'WEAK_PASSWORD'; end if;
  select a.user_id into uid
    from public.admins a join auth.users u on u.id = a.user_id
    where a.role = 'sub' and lower(u.email) = lower(btrim(coalesce(p_email, '')));
  if uid is null then raise exception 'USER_NOT_FOUND'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now() where id = uid;
end
$$;

revoke execute on function public.create_sub_admin(text, text), public.set_sub_admin_password(text, text) from public, anon, authenticated;
grant execute on function public.create_sub_admin(text, text), public.set_sub_admin_password(text, text) to authenticated;
