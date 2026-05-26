-- Create FINN chat history table expected by /api/chat.
-- This migration is intentionally additive/idempotent to support existing environments.

create extension if not exists pgcrypto;

create table if not exists public.finn_agent_messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid null,
  agent text not null default 'finn_executive_operator',
  session_id text not null,
  agent_id text not null default 'finn-executive-operator',
  role text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  constraint finn_agent_messages_role_check check (role in ('user', 'assistant'))
);

-- Ensure expected columns exist even if table was previously created with a smaller schema.
alter table public.finn_agent_messages
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists user_id uuid null,
  add column if not exists agent text not null default 'finn_executive_operator',
  add column if not exists session_id text,
  add column if not exists agent_id text not null default 'finn-executive-operator',
  add column if not exists role text,
  add column if not exists content text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.finn_agent_messages
  alter column session_id set not null,
  alter column role set not null,
  alter column content set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'finn_agent_messages_role_check'
      and conrelid = 'public.finn_agent_messages'::regclass
  ) then
    alter table public.finn_agent_messages
      add constraint finn_agent_messages_role_check
      check (role in ('user', 'assistant'));
  end if;
end $$;

create index if not exists idx_finn_agent_messages_created_at
  on public.finn_agent_messages (created_at);

create index if not exists idx_finn_agent_messages_agent
  on public.finn_agent_messages (agent);

create index if not exists idx_finn_agent_messages_user_id
  on public.finn_agent_messages (user_id);

-- Query path used by /api/chat:
-- .eq("session_id", sessionId).eq("agent_id", agentId).order("created_at")
create index if not exists idx_finn_agent_messages_session_agent_created
  on public.finn_agent_messages (session_id, agent_id, created_at);

alter table public.finn_agent_messages enable row level security;

-- Restrictive client policies: no anon/auth direct table access.
-- Server-side service_role still works because it bypasses RLS in Supabase.
drop policy if exists "deny_anon_all_finn_agent_messages" on public.finn_agent_messages;
create policy "deny_anon_all_finn_agent_messages"
  on public.finn_agent_messages
  for all
  to anon
  using (false)
  with check (false);

drop policy if exists "deny_authenticated_all_finn_agent_messages" on public.finn_agent_messages;
create policy "deny_authenticated_all_finn_agent_messages"
  on public.finn_agent_messages
  for all
  to authenticated
  using (false)
  with check (false);

-- Ask PostgREST to refresh schema cache after migration.
notify pgrst, 'reload schema';
