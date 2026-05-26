-- FINN chat history table for server-side AI agent conversations.
-- Apply in Supabase SQL editor (or migration workflow) before using /api/chat.

create extension if not exists pgcrypto;

create table if not exists public.finn_agent_messages (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  agent_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_finn_agent_messages_session_agent_created
  on public.finn_agent_messages (session_id, agent_id, created_at);

alter table public.finn_agent_messages enable row level security;

-- No anon/auth policies by default.
-- Writes and reads are intended through server-side service role key only.
