alter table public.notes
  add column if not exists title text not null default '',
  add column if not exists subject text not null default '',
  add column if not exists tags text[] not null default '{}',
  add column if not exists error_message text;
