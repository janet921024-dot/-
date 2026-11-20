-- 每週自動檢查用：回報「後台直接建立副管理員」（004_sub_admin_accounts.sql）依賴的 Supabase 帳號資料表是否還相容。
-- 不需要登入即可呼叫，只回傳欄位是否相容，不含任何個人資料。
-- 在 SQL Editor 執行這份一次即可。

create function public.system_health() returns jsonb
language sql stable security definer set search_path = public
as $$
  with used(tbl, col) as (
    -- create_sub_admin 寫入的欄位
    values
      ('users', 'instance_id'), ('users', 'id'), ('users', 'aud'), ('users', 'role'), ('users', 'email'),
      ('users', 'encrypted_password'), ('users', 'email_confirmed_at'), ('users', 'raw_app_meta_data'),
      ('users', 'raw_user_meta_data'), ('users', 'created_at'), ('users', 'updated_at'),
      ('users', 'confirmation_token'), ('users', 'recovery_token'), ('users', 'email_change_token_new'),
      ('users', 'email_change'),
      ('identities', 'id'), ('identities', 'user_id'), ('identities', 'provider_id'), ('identities', 'identity_data'),
      ('identities', 'provider'), ('identities', 'last_sign_in_at'), ('identities', 'created_at'), ('identities', 'updated_at')
  ),
  cols as (
    select table_name::text as tbl, column_name::text as col,
           is_nullable = 'NO' and column_default is null and is_generated = 'NEVER' and is_identity = 'NO' as required
    from information_schema.columns
    where table_schema = 'auth' and table_name in ('users', 'identities')
  )
  select jsonb_build_object(
    -- 我們會寫入、但 Supabase 已經沒有的欄位（有的話建立副管理員會失敗）
    'missing_columns', coalesce((select jsonb_agg(u.tbl || '.' || u.col order by u.tbl, u.col)
                                 from used u where not exists (select 1 from cols c where c.tbl = u.tbl and c.col = u.col)), '[]'::jsonb),
    -- Supabase 新增的必填欄位、我們沒有填（有的話建立副管理員會失敗）
    'unfilled_required_columns', coalesce((select jsonb_agg(c.tbl || '.' || c.col order by c.tbl, c.col)
                                           from cols c where c.required and not exists (select 1 from used u where u.tbl = c.tbl and u.col = c.col)), '[]'::jsonb),
    'sub_admin_functions_installed', (select count(*) = 2 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                      where n.nspname = 'public' and p.proname in ('create_sub_admin', 'set_sub_admin_password')),
    'checked_at', now()
  )
$$;

revoke execute on function public.system_health() from public;
grant execute on function public.system_health() to anon, authenticated;
