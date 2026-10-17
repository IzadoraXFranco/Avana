-- Avana's cloud database (2026-10-16). No local SQLite data is read by this migration.
-- All client mutations go through avana_api; domain tables are read-only to clients.
create schema if not exists avana_private;
revoke all on schema avana_private from public, anon, authenticated;

create table if not exists public.avana_workspaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id),
  name text not null default 'Pessoal',
  revision bigint not null default 0 check (revision >= 0),
  "createdAt" timestamptz(3) not null default now()
);
create table if not exists public.avana_settings (
  "workspaceId" uuid primary key references public.avana_workspaces(id),
  name text not null default 'Você', timezone text not null default 'America/Sao_Paulo',
  theme text not null default 'system' check (theme in ('light','dark','system'))
);
create table if not exists public.avana_projects (
  id uuid primary key default gen_random_uuid(), "workspaceId" uuid not null references public.avana_workspaces(id),
  name text not null, description text not null default '', color text not null default '#9470d8', icon text not null default 'folder',
  favorite boolean not null default false, "archivedAt" timestamptz(3), "deletedAt" timestamptz(3),
  "requireEvidence" boolean not null default false, "createdAt" timestamptz(3) not null default now(),
  unique (id,"workspaceId")
);
create table if not exists public.avana_tasks (
  id uuid primary key default gen_random_uuid(), "workspaceId" uuid not null references public.avana_workspaces(id),
  "projectId" uuid not null, title text not null, description text not null default '',
  section text check (section in ('backlog','hold','today')), "completionId" uuid,
  position double precision not null check (position > 0 and position < 'Infinity'::float8),
  "executionOrder" integer check ("executionOrder" between 1 and 99999),
  assignee text not null default '', priority text not null default '' check (priority in ('','low','medium','high')),
  "plannedDate" date, "dueDate" date, "dueTime" time(0), "dueTimezone" text not null default 'America/Sao_Paulo',
  "createdAt" timestamptz(3) not null default now(), "updatedAt" timestamptz(3) not null default now(), "deletedAt" timestamptz(3),
  version integer not null default 1 check (version >= 1), unique (id,"workspaceId"),
  foreign key ("projectId","workspaceId") references public.avana_projects(id,"workspaceId"),
  check ((section is not null and "completionId" is null) or (section is null and "completionId" is not null)),
  check ("dueTime" is null or "dueDate" is not null)
);
create table if not exists public.avana_completions (
  id uuid primary key default gen_random_uuid(), "workspaceId" uuid not null references public.avana_workspaces(id), "taskId" uuid not null,
  "completedAt" timestamptz(3) not null, author text not null, event_order bigint generated always as identity,
  unique (id,"taskId","workspaceId"),
  foreign key ("taskId","workspaceId") references public.avana_tasks(id,"workspaceId") deferrable initially deferred
);
do $$ begin
  if not exists (select 1 from pg_catalog.pg_constraint where conname='avana_task_completion_fk' and conrelid='public.avana_tasks'::regclass) then
    alter table public.avana_tasks add constraint avana_task_completion_fk foreign key ("completionId",id,"workspaceId")
      references public.avana_completions(id,"taskId","workspaceId") deferrable initially deferred;
  end if;
end $$;
create table if not exists public.avana_subtasks (
  id uuid primary key default gen_random_uuid(), "workspaceId" uuid not null references public.avana_workspaces(id), "taskId" uuid not null,
  title text not null, "completedAt" timestamptz(3), assignee text not null default '', "dueDate" date,
  position double precision not null check (position > 0 and position < 'Infinity'::float8),
  foreign key ("taskId","workspaceId") references public.avana_tasks(id,"workspaceId")
);
create table if not exists public.avana_comments (
  id uuid primary key default gen_random_uuid(), "workspaceId" uuid not null references public.avana_workspaces(id), "taskId" uuid not null,
  body text not null, kind text not null check (kind in ('comment','evidence')), "completionId" uuid,
  "createdAt" timestamptz(3) not null, author text not null, event_order bigint generated always as identity,
  foreign key ("taskId","workspaceId") references public.avana_tasks(id,"workspaceId"),
  foreign key ("completionId","taskId","workspaceId") references public.avana_completions(id,"taskId","workspaceId")
);
create table if not exists public.avana_activity (
  id uuid primary key default gen_random_uuid(), "workspaceId" uuid not null references public.avana_workspaces(id), "taskId" uuid not null,
  type text not null, summary text not null, before jsonb not null default 'null', after jsonb not null default 'null',
  "createdAt" timestamptz(3) not null, author text not null,
  event_order bigint generated always as identity,
  foreign key ("taskId","workspaceId") references public.avana_tasks(id,"workspaceId")
);
create table if not exists public.avana_holds (
  id uuid primary key default gen_random_uuid(), "workspaceId" uuid not null references public.avana_workspaces(id), "taskId" uuid not null,
  reason text not null default '', "waitingFor" text not null default '', "nextAction" text not null default '',
  "startedAt" timestamptz(3) not null, "endedAt" timestamptz(3), event_order bigint generated always as identity,
  foreign key ("taskId","workspaceId") references public.avana_tasks(id,"workspaceId")
);
create table if not exists public.avana_follow_ups (
  id uuid primary key default gen_random_uuid(), "workspaceId" uuid not null references public.avana_workspaces(id), "taskId" uuid not null,
  date date not null, status text not null check (status in ('pending','done','cancelled')), note text not null default '',
  "createdAt" timestamptz(3) not null, "closedAt" timestamptz(3), event_order bigint generated always as identity,
  check ((status='pending' and "closedAt" is null) or (status<>'pending' and "closedAt" is not null)),
  foreign key ("taskId","workspaceId") references public.avana_tasks(id,"workspaceId")
);
create table if not exists public.avana_requests (
  "workspaceId" uuid not null references public.avana_workspaces(id), request_id text not null,
  request_hash text not null, result jsonb not null, "createdAt" timestamptz(3) not null default now(),
  primary key ("workspaceId",request_id)
);
create table if not exists public.avana_backups (
  id uuid primary key default gen_random_uuid(), "workspaceId" uuid not null references public.avana_workspaces(id),
  kind text not null, data jsonb not null, "createdAt" timestamptz(3) not null default now()
);
create table if not exists public.avana_imports (
  id uuid primary key default gen_random_uuid(), "workspaceId" uuid not null references public.avana_workspaces(id),
  source_id text not null, source_hash text not null, receipt jsonb not null,
  "createdAt" timestamptz(3) not null default now(), unique ("workspaceId",source_id)
);
-- Operational tombstones survive trash expiry and snapshot replacement. They are
-- intentionally not domain export data: old clients belong to this workspace.
create table if not exists public.avana_task_versions (
  "workspaceId" uuid not null references public.avana_workspaces(id),
  "taskId" uuid not null, max_version integer not null check (max_version >= 1),
  primary key ("workspaceId","taskId")
);
insert into public.avana_task_versions("workspaceId","taskId",max_version)
  select "workspaceId",id,version from public.avana_tasks
  on conflict("workspaceId","taskId") do update
    set max_version=greatest(public.avana_task_versions.max_version,excluded.max_version);

create or replace function avana_private.track_task_version() returns trigger
language plpgsql set search_path='' as $$
declare record_workspace uuid; record_task uuid; record_version integer;
begin
  if TG_OP='DELETE' then
    record_workspace:=old."workspaceId"; record_task:=old.id; record_version:=old.version;
  else
    record_workspace:=new."workspaceId"; record_task:=new.id; record_version:=new.version;
  end if;
  insert into public.avana_task_versions("workspaceId","taskId",max_version)
    values(record_workspace,record_task,record_version)
    on conflict("workspaceId","taskId") do update
      set max_version=greatest(public.avana_task_versions.max_version,excluded.max_version);
  return null;
end $$;
drop trigger if exists avana_track_task_version on public.avana_tasks;
create trigger avana_track_task_version after insert or update or delete on public.avana_tasks
  for each row execute function avana_private.track_task_version();

create unique index if not exists avana_one_open_hold on public.avana_holds("taskId") where "endedAt" is null;
create unique index if not exists avana_one_pending_followup on public.avana_follow_ups("taskId") where status='pending';
create index if not exists avana_task_project_section on public.avana_tasks("workspaceId","projectId",section,position);
create index if not exists avana_subtask_task on public.avana_subtasks("workspaceId","taskId",position);
create index if not exists avana_comment_task on public.avana_comments("workspaceId","taskId","createdAt");
create index if not exists avana_activity_task on public.avana_activity("workspaceId","taskId","createdAt",event_order);
create index if not exists avana_completion_task on public.avana_completions("workspaceId","taskId");
create index if not exists avana_hold_task on public.avana_holds("workspaceId","taskId");
create index if not exists avana_followup_task on public.avana_follow_ups("workspaceId","taskId");

alter table public.avana_workspaces enable row level security;
drop policy if exists avana_workspace_owner on public.avana_workspaces;
create policy avana_workspace_owner on public.avana_workspaces for select to authenticated using (owner_id=(select auth.uid()));
revoke all on public.avana_workspaces from public, anon, authenticated;
grant select on public.avana_workspaces to authenticated;
do $$ declare t text; begin
  foreach t in array array['settings','projects','tasks','completions','subtasks','comments','activity','holds','follow_ups','requests','backups','imports','task_versions'] loop
    execute format('alter table public.avana_%I enable row level security',t);
    execute format('drop policy if exists avana_owner_read on public.avana_%I',t);
    execute format('create policy avana_owner_read on public.avana_%I for select to authenticated using (exists (select 1 from public.avana_workspaces w where w.id="workspaceId" and w.owner_id=(select auth.uid())))',t);
    execute format('revoke all on public.avana_%I from public, anon, authenticated',t);
    execute format('grant select on public.avana_%I to authenticated',t);
  end loop;
end $$;

create or replace function avana_private.fail(message text, status integer default 400, code text default 'VALIDATION_ERROR') returns void
language plpgsql set search_path='' as $$ begin
  raise exception using errcode='P0001', message=jsonb_build_object('error',message,'status',status,'code',code)::text;
end $$;
create or replace function avana_private.text_field(data jsonb,key text,max_length integer default 10000,required boolean default false,fallback text default '') returns text
language plpgsql set search_path='' as $$ declare value text; begin
  if not data ? key then value:=fallback;
  elsif jsonb_typeof(data->key)<>'string' then perform avana_private.fail('Campo inválido: '||key); else value:=data->>key; end if;
  if value is null or length(value)>max_length or (required and btrim(value)='') then perform avana_private.fail('Campo inválido: '||key); end if;
  return value;
end $$;
create or replace function avana_private.check_keys(data jsonb,allowed text[]) returns void
language plpgsql set search_path='' as $$ declare key text; begin
  if data is null or jsonb_typeof(data)<>'object' then perform avana_private.fail('Dados inválidos.'); end if;
  for key in select jsonb_object_keys(data) loop if not key=any(allowed) then perform avana_private.fail('Campo não permitido: '||key); end if; end loop;
end $$;
create or replace function avana_private.date_value(value jsonb) returns date
language plpgsql set search_path='' as $$ declare result date; begin
  if value='null'::jsonb or value='""'::jsonb then return null; end if;
  if value is null or jsonb_typeof(value)<>'string' or (value#>>'{}') !~ '^\d{4}-\d{2}-\d{2}$' then perform avana_private.fail('Data inválida.'); end if;
  begin result:=(value#>>'{}')::date; exception when others then perform avana_private.fail('Data inválida.'); end;
  return result;
end $$;
create or replace function avana_private.uuid_value(value text) returns uuid
language plpgsql set search_path='' as $$ begin
  if value is null then perform avana_private.fail('Identificador inválido.'); end if;
  begin return value::uuid; exception when invalid_text_representation then perform avana_private.fail('Identificador inválido.'); end;
end $$;
create or replace function avana_private.sequence_value(value jsonb) returns integer
language plpgsql set search_path='' as $$ declare n numeric; begin
  if value='null'::jsonb then return null; end if;
  if value is null or jsonb_typeof(value)<>'number' then perform avana_private.fail('A sequência deve ser um inteiro entre 1 e 99999.'); end if;
  n:=(value#>>'{}')::numeric;
  if n<>trunc(n) or n<1 or n>99999 then perform avana_private.fail('A sequência deve ser um inteiro entre 1 e 99999.'); end if;
  return n::integer;
end $$;
create or replace function avana_private.json_row(value jsonb,strip_workspace boolean default true) returns jsonb
language plpgsql stable set search_path='' as $$ declare key text; item jsonb; result jsonb:=value-'event_order'; begin
  if strip_workspace then result:=result-'workspaceId'; end if;
  for key,item in select * from jsonb_each(result) loop
    if key ~ 'At$' and item<>'null'::jsonb then result:=jsonb_set(result,array[key],to_jsonb(to_char((item#>>'{}')::timestamptz at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))); end if;
    if key='dueTime' and item<>'null'::jsonb then result:=jsonb_set(result,array[key],to_jsonb(left(item#>>'{}',5))); end if;
  end loop;
  return result;
end $$;
create or replace function avana_private.settings(wid uuid) returns jsonb
language sql stable set search_path='' as $$ select avana_private.json_row(to_jsonb(s)) from public.avana_settings s where s."workspaceId"=wid $$;
create or replace function avana_private.today(wid uuid) returns date
language sql stable set search_path='' as $$ select (now() at time zone s.timezone)::date from public.avana_settings s where s."workspaceId"=wid $$;
create or replace function avana_private.task(wid uuid,tid uuid) returns jsonb
language plpgsql stable set search_path='' as $$ declare result jsonb; begin
  select avana_private.json_row(to_jsonb(t)) || jsonb_build_object(
    'completedAt',(select to_char(c."completedAt" at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from public.avana_completions c where c.id=t."completionId" and c."workspaceId"=wid),
    'subtaskCount',(select count(*) from public.avana_subtasks s where s."taskId"=tid and s."workspaceId"=wid),
    'subtaskDone',(select count(*) from public.avana_subtasks s where s."taskId"=tid and s."workspaceId"=wid and s."completedAt" is not null),
    'commentCount',(select count(*) from public.avana_comments c where c."taskId"=tid and c."workspaceId"=wid),
    'followUpDate',(select f.date from public.avana_follow_ups f where f."taskId"=tid and f."workspaceId"=wid and f.status='pending'),
    'holdReason',coalesce(h.reason,''),'waitingFor',coalesce(h."waitingFor",''),'nextAction',coalesce(h."nextAction",''),
    'holdSince',to_char(h."startedAt" at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) into result
  from public.avana_tasks t left join public.avana_holds h on h."taskId"=t.id and h."workspaceId"=wid and h."endedAt" is null
  where t.id=tid and t."workspaceId"=wid;
  if result is null then perform avana_private.fail('Tarefa não encontrada.',404,'NOT_FOUND'); end if;
  return result;
end $$;
create or replace function avana_private.detail(wid uuid,tid uuid) returns jsonb
language sql stable set search_path='' as $$ select jsonb_build_object(
  'task',avana_private.task(wid,tid),
  'subtasks',coalesce((select jsonb_agg(avana_private.json_row(to_jsonb(s)) order by s.position,s.id) from public.avana_subtasks s where s."workspaceId"=wid and s."taskId"=tid),'[]'::jsonb),
  'comments',coalesce((select jsonb_agg(avana_private.json_row(to_jsonb(c)) order by c."createdAt",c.event_order) from public.avana_comments c where c."workspaceId"=wid and c."taskId"=tid),'[]'::jsonb),
  'activity',coalesce((select jsonb_agg(avana_private.json_row(to_jsonb(a)) order by a."createdAt" desc,a.event_order desc) from public.avana_activity a where a."workspaceId"=wid and a."taskId"=tid),'[]'::jsonb),
  'holds',coalesce((select jsonb_agg(avana_private.json_row(to_jsonb(h)) order by h."startedAt",h.event_order) from public.avana_holds h where h."workspaceId"=wid and h."taskId"=tid),'[]'::jsonb),
  'followUps',coalesce((select jsonb_agg(avana_private.json_row(to_jsonb(f)) order by f."createdAt",f.event_order) from public.avana_follow_ups f where f."workspaceId"=wid and f."taskId"=tid),'[]'::jsonb),
  'completions',coalesce((select jsonb_agg(avana_private.json_row(to_jsonb(c)) order by c."completedAt",c.event_order) from public.avana_completions c where c."workspaceId"=wid and c."taskId"=tid),'[]'::jsonb)
) $$;
create or replace function avana_private.bootstrap(wid uuid) returns jsonb
language sql stable set search_path='' as $$ select jsonb_build_object(
  'workspaceId',w.id,'revision',w.revision,'settings',avana_private.settings(wid),'today',avana_private.today(wid),
  'serverTime',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'projects',coalesce((select jsonb_agg(avana_private.json_row(to_jsonb(p)) order by p."createdAt",p.id) from public.avana_projects p where p."workspaceId"=wid),'[]'::jsonb),
  'tasks',coalesce((select jsonb_agg(avana_private.task(wid,t.id) order by t.position,t."createdAt",t.id) from public.avana_tasks t where t."workspaceId"=wid),'[]'::jsonb))
from public.avana_workspaces w where w.id=wid $$;
create or replace function avana_private.ensure_active(wid uuid,pid uuid) returns void
language plpgsql stable set search_path='' as $$ declare p public.avana_projects%rowtype; begin
  select * into p from public.avana_projects where id=pid and "workspaceId"=wid;
  if not found then perform avana_private.fail('Projeto não encontrado.',404,'NOT_FOUND'); end if;
  if p."deletedAt" is not null then perform avana_private.fail('Restaure o projeto antes de editar.',409,'PROJECT_DELETED'); end if;
  if p."archivedAt" is not null then perform avana_private.fail('Restaure o projeto arquivado antes de editar.',409,'PROJECT_ARCHIVED'); end if;
end $$;
create or replace function avana_private.next_position(wid uuid,pid uuid,section_name text) returns double precision
language sql stable set search_path='' as $$ select coalesce(max(position),0)+1024 from public.avana_tasks where "workspaceId"=wid and "projectId"=pid and section is not distinct from section_name and "deletedAt" is null $$;
create or replace function avana_private.followup(wid uuid,tid uuid,next_date date,instant timestamptz,note text default 'Reagendado') returns void
language plpgsql set search_path='' as $$ declare current_date_value date; begin
  select date into current_date_value from public.avana_follow_ups where "workspaceId"=wid and "taskId"=tid and status='pending';
  if current_date_value is not distinct from next_date then return; end if;
  update public.avana_follow_ups set status='cancelled',"closedAt"=instant,note=followup.note where "workspaceId"=wid and "taskId"=tid and status='pending';
  if next_date is not null then insert into public.avana_follow_ups("workspaceId","taskId",date,status,note,"createdAt") values(wid,tid,next_date,'pending','',instant); end if;
end $$;
create or replace function avana_private.audit_delta(wid uuid,tid uuid,action text,summary text,previous jsonb,current_value jsonb,instant timestamptz) returns void
language plpgsql set search_path='' as $$ declare b jsonb:='{}'; a jsonb:='{}'; key text; value jsonb; old_rows jsonb; new_rows jsonb; begin
  for key,value in select * from jsonb_each(previous->'task') loop
    if value is distinct from current_value->'task'->key then b:=b||jsonb_build_object(key,value); a:=a||jsonb_build_object(key,current_value->'task'->key); end if;
  end loop;
  foreach key in array array['subtasks','comments','holds','followUps'] loop
    select coalesce(jsonb_agg(x),'[]') into old_rows from jsonb_array_elements(previous->key) x where not exists(select 1 from jsonb_array_elements(current_value->key) y where x=y);
    select coalesce(jsonb_agg(x),'[]') into new_rows from jsonb_array_elements(current_value->key) x where not exists(select 1 from jsonb_array_elements(previous->key) y where x=y);
    if old_rows<>'[]'::jsonb or new_rows<>'[]'::jsonb then b:=b||jsonb_build_object(key,old_rows); a:=a||jsonb_build_object(key,new_rows); end if;
  end loop;
  insert into public.avana_activity("workspaceId","taskId",type,summary,before,after,"createdAt",author)
    values(wid,tid,action,summary,b,a,instant,(avana_private.settings(wid)->>'name'));
end $$;

create or replace function avana_private.task_command(wid uuid,tid uuid,data jsonb) returns jsonb
language plpgsql set search_path='' as $$
<<task_cmd>> declare
  t public.avana_tasks%rowtype; p public.avana_projects%rowtype; s public.avana_subtasks%rowtype;
  action text:=data->>'action'; fields jsonb; previous jsonb; instant timestamptz(3):=clock_timestamp();
  next_section text; summary text; cid uuid; sid uuid; before_id uuid; item_id uuid; ids uuid[]; ordered_ids uuid[];
  old_section text; old_completion uuid; note text; link text; comment_kind text; rank integer; value text;
  changed boolean:=true; follow_id uuid;
begin
  select * into t from public.avana_tasks where id=tid and "workspaceId"=wid;
  if not found then perform avana_private.fail('Tarefa não encontrada.',404,'NOT_FOUND'); end if;
  if jsonb_typeof(data->'version') is distinct from 'number' or (data->>'version') !~ '^[1-9][0-9]*$' then perform avana_private.fail('Versão inválida.'); end if;
  if t.version::text<>data->>'version' then perform avana_private.fail('Esta tarefa foi alterada. Atualize os dados; seu texto foi preservado.',409,'VERSION_CONFLICT'); end if;
  perform avana_private.ensure_active(wid,t."projectId");
  select * into p from public.avana_projects where id=t."projectId" and "workspaceId"=wid;
  if t."deletedAt" is not null and action not in ('delete','restore') then perform avana_private.fail('Restaure a tarefa antes de editar.',409,'TASK_DELETED'); end if;
  previous:=avana_private.detail(wid,tid);
  case action
  when 'edit' then
    fields:=data->'fields';
    perform avana_private.check_keys(fields,array['title','description','assignee','priority','plannedDate','dueDate','dueTime','projectId','executionOrder']);
    if fields ? 'title' then t.title:=btrim(avana_private.text_field(fields,'title',1000,true)); end if;
    if fields ? 'description' then t.description:=avana_private.text_field(fields,'description',100000); end if;
    if fields ? 'assignee' then t.assignee:=avana_private.text_field(fields,'assignee',1000); end if;
    if fields ? 'priority' then
      value:=avana_private.text_field(fields,'priority',20);
      if value not in ('','low','medium','high') then perform avana_private.fail('Prioridade inválida.'); end if;
      t.priority:=value;
    end if;
    if fields ? 'executionOrder' then t."executionOrder":=avana_private.sequence_value(fields->'executionOrder'); end if;
    if fields ? 'plannedDate' then t."plannedDate":=avana_private.date_value(fields->'plannedDate'); end if;
    if fields ? 'dueDate' then t."dueDate":=avana_private.date_value(fields->'dueDate'); end if;
    if fields ? 'dueTime' then
      if fields->'dueTime'='null'::jsonb or fields->>'dueTime'='' then t."dueTime":=null;
      elsif jsonb_typeof(fields->'dueTime')='string' and fields->>'dueTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then t."dueTime":=(fields->>'dueTime')::time;
      else perform avana_private.fail('Horário inválido.'); end if;
    end if;
    if t."dueDate" is null then t."dueTime":=null; end if;
    if fields ?| array['dueDate','dueTime'] then t."dueTimezone":=avana_private.settings(wid)->>'timezone'; end if;
    if fields ? 'projectId' and fields->>'projectId'<>t."projectId"::text then
      t."projectId":=avana_private.uuid_value(fields->>'projectId'); perform avana_private.ensure_active(wid,t."projectId");
      if t.section is not null and t.section<>'hold' then t.section:='backlog'; end if;
      t.position:=avana_private.next_position(wid,t."projectId",t.section);
    end if;
    summary:='Campos atualizados';
  when 'move','plan','reopen','hold' then
    if action='reopen' and t."completionId" is null then changed:=false;
    else
      next_section:=case when action='plan' then 'today' when action='hold' then 'hold' when action='reopen' then coalesce(data->>'section','today') else data->>'section' end;
      if next_section is null or next_section not in ('backlog','hold','today') then perform avana_private.fail('Seção inválida.'); end if;
      if action='hold' and t.section is distinct from 'hold' then perform avana_private.fail('O bloqueio só pode ser editado em Hold.'); end if;
      old_section:=t.section; old_completion:=t."completionId";
      if t.section='hold' and next_section<>'hold' then update public.avana_holds set "endedAt"=instant where "workspaceId"=wid and "taskId"=tid and "endedAt" is null; end if;
      if next_section='hold' then
        if t.section is distinct from 'hold' then
          insert into public.avana_holds("workspaceId","taskId",reason,"waitingFor","nextAction","startedAt")
          values(wid,tid,avana_private.text_field(data,'reason',10000),avana_private.text_field(data,'waitingFor',1000),avana_private.text_field(data,'nextAction',10000),instant);
        else
          update public.avana_holds h set
            reason=case when data ? 'reason' then avana_private.text_field(data,'reason',10000) else h.reason end,
            "waitingFor"=case when data ? 'waitingFor' then avana_private.text_field(data,'waitingFor',1000) else h."waitingFor" end,
            "nextAction"=case when data ? 'nextAction' then avana_private.text_field(data,'nextAction',10000) else h."nextAction" end
          where h."workspaceId"=wid and h."taskId"=tid and h."endedAt" is null;
        end if;
        if data ? 'followUpDate' then perform avana_private.followup(wid,tid,avana_private.date_value(data->'followUpDate'),instant); end if;
      end if;
      if t.section is distinct from next_section or t."completionId" is not null then t.position:=avana_private.next_position(wid,t."projectId",next_section); end if;
      t.section:=next_section; t."completionId":=null;
      if next_section='today' then t."plannedDate":=avana_private.today(wid); end if;
      summary:=case when old_completion is not null then 'Tarefa reaberta' when action='hold' then 'Bloqueio atualizado' when action='plan' then 'Planejada para hoje' else 'Seção alterada' end;
    end if;
  when 'complete' then
    if t."completionId" is not null then changed:=false;
    else
      if exists(select 1 from public.avana_subtasks where "workspaceId"=wid and "taskId"=tid and "completedAt" is null) and data->'confirmPending' is distinct from 'true'::jsonb then
        perform avana_private.fail('Há subtarefas pendentes. Confirme para concluir apenas a tarefa principal.',422,'PENDING_SUBTASKS');
      end if;
      note:=btrim(avana_private.text_field(data,'note',100000)); link:=btrim(avana_private.text_field(data,'link',4000));
      if link<>'' and link !~* '^https?://[^/[:space:]]+([/?#][^[:space:]]*)?$' then perform avana_private.fail('Use um link HTTP ou HTTPS válido.'); end if;
      if p."requireEvidence" and note='' and link='' and not exists(select 1 from public.avana_comments where "workspaceId"=wid and "taskId"=tid and kind='evidence' and "completionId" is null and btrim(body)<>'') then
        perform avana_private.fail('Este projeto exige uma nota ou link de evidência para esta conclusão.',422,'EVIDENCE_REQUIRED');
      end if;
      cid:=gen_random_uuid();
      insert into public.avana_completions(id,"workspaceId","taskId","completedAt",author) values(cid,wid,tid,instant,avana_private.settings(wid)->>'name');
      update public.avana_comments set "completionId"=cid where "workspaceId"=wid and "taskId"=tid and kind='evidence' and "completionId" is null;
      if note<>'' or link<>'' then
        insert into public.avana_comments("workspaceId","taskId",body,kind,"completionId","createdAt",author)
        values(wid,tid,concat_ws(E'\n',nullif(note,''),nullif(link,'')),'evidence',cid,instant,avana_private.settings(wid)->>'name');
      end if;
      update public.avana_holds set "endedAt"=instant where "workspaceId"=wid and "taskId"=tid and "endedAt" is null;
      update public.avana_follow_ups set status='cancelled',"closedAt"=instant,note='Tarefa concluída' where "workspaceId"=wid and "taskId"=tid and status='pending';
      t.section:=null; t."completionId":=cid; summary:='Tarefa concluída';
    end if;
  when 'followup' then
    if t."completionId" is not null then perform avana_private.fail('Reabra a tarefa antes de agendar um acompanhamento.'); end if;
    perform avana_private.followup(wid,tid,avana_private.date_value(data->'date'),instant,case when data->'date'='null'::jsonb then 'Acompanhamento cancelado' else 'Reagendado' end);
    summary:='Follow-up atualizado';
  when 'followupDone' then
    select id into follow_id from public.avana_follow_ups where "workspaceId"=wid and "taskId"=tid and status='pending';
    if follow_id is null then perform avana_private.fail('Não há follow-up pendente.'); end if;
    note:=avana_private.text_field(data,'note',10000);
    update public.avana_follow_ups set status='done',"closedAt"=instant,note=task_cmd.note where id=follow_id and "workspaceId"=wid;
    perform avana_private.followup(wid,tid,avana_private.date_value(data->'nextDate'),instant);
    summary:='Acompanhamento realizado';
  when 'comment' then
    comment_kind:=coalesce(data->>'kind','comment'); if comment_kind not in ('comment','evidence') then perform avana_private.fail('Tipo de comentário inválido.'); end if;
    insert into public.avana_comments("workspaceId","taskId",body,kind,"completionId","createdAt",author)
    values(wid,tid,btrim(avana_private.text_field(data,'body',100000,true)),comment_kind,case when comment_kind='evidence' then t."completionId" else null end,instant,avana_private.settings(wid)->>'name');
    summary:=case when comment_kind='evidence' then 'Evidência adicionada' else 'Comentário adicionado' end;
  when 'subtaskAdd' then
    insert into public.avana_subtasks("workspaceId","taskId",title,position)
    values(wid,tid,btrim(avana_private.text_field(data,'title',1000,true)),(select coalesce(max(position),0)+1024 from public.avana_subtasks where "workspaceId"=wid and "taskId"=tid));
    summary:='Subtarefa adicionada';
  when 'subtaskEdit','subtaskDelete','subtaskReorder' then
    sid:=avana_private.uuid_value(data->>'subtaskId');
    select * into s from public.avana_subtasks where id=sid and "workspaceId"=wid and "taskId"=tid;
    if not found then perform avana_private.fail('Subtarefa não encontrada.',404,'NOT_FOUND'); end if;
    if action='subtaskDelete' then delete from public.avana_subtasks where id=sid and "workspaceId"=wid; summary:='Subtarefa excluída';
    elsif action='subtaskEdit' then
      fields:=data->'fields'; perform avana_private.check_keys(fields,array['title','completed','assignee','dueDate']);
      if fields ? 'title' then s.title:=btrim(avana_private.text_field(fields,'title',1000,true)); end if;
      if fields ? 'assignee' then s.assignee:=avana_private.text_field(fields,'assignee',1000); end if;
      if fields ? 'dueDate' then s."dueDate":=avana_private.date_value(fields->'dueDate'); end if;
      if fields ? 'completed' then
        if jsonb_typeof(fields->'completed')<>'boolean' then perform avana_private.fail('Conclusão inválida.'); end if;
        s."completedAt":=case when (fields->>'completed')::boolean then coalesce(s."completedAt",instant) else null end;
      end if;
      update public.avana_subtasks set title=s.title,assignee=s.assignee,"dueDate"=s."dueDate","completedAt"=s."completedAt" where id=sid and "workspaceId"=wid;
      summary:='Subtarefa atualizada';
    else
      if not data ? 'beforeId' then perform avana_private.fail('Destino de ordenação inválido.'); end if;
      before_id:=case when data->'beforeId'='null'::jsonb then null else avana_private.uuid_value(data->>'beforeId') end;
      select array_agg(id order by position,id) into ids from public.avana_subtasks where "workspaceId"=wid and "taskId"=tid;
      if before_id is not null and not before_id=any(ids) then perform avana_private.fail('Destino de ordenação inválido.'); end if;
      if before_id=sid then changed:=false;
      else
        ordered_ids:='{}'; foreach item_id in array ids loop if item_id=before_id then ordered_ids:=array_append(ordered_ids,sid); end if; if item_id<>sid then ordered_ids:=array_append(ordered_ids,item_id); end if; end loop;
        if before_id is null then ordered_ids:=array_append(ordered_ids,sid); end if;
        rank:=0; foreach item_id in array ordered_ids loop rank:=rank+1; update public.avana_subtasks set position=rank*1024 where id=item_id and "workspaceId"=wid; end loop;
      end if;
      summary:='Subtarefas reordenadas';
    end if;
  when 'reorder' then
    if t.section is null then perform avana_private.fail('A ordenação manual está disponível nas seções ativas.'); end if;
    if not data ? 'beforeId' then perform avana_private.fail('Destino de ordenação inválido.'); end if;
    before_id:=case when data->'beforeId'='null'::jsonb then null else avana_private.uuid_value(data->>'beforeId') end;
    select array_agg(id order by position,id) into ids from public.avana_tasks where "workspaceId"=wid and "projectId"=t."projectId" and section=t.section and "deletedAt" is null;
    if before_id is not null and not before_id=any(ids) then perform avana_private.fail('A tarefa de destino deve estar no mesmo projeto e seção.'); end if;
    if before_id=tid then changed:=false;
    else
      ordered_ids:='{}'; foreach item_id in array ids loop if item_id=before_id then ordered_ids:=array_append(ordered_ids,tid); end if; if item_id<>tid then ordered_ids:=array_append(ordered_ids,item_id); end if; end loop;
      if before_id is null then ordered_ids:=array_append(ordered_ids,tid); end if;
      rank:=0; foreach item_id in array ordered_ids loop
        rank:=rank+1;
        if item_id=tid then t.position:=rank*1024;
        else update public.avana_tasks set position=rank*1024,version=version+1,"updatedAt"=instant where id=item_id and "workspaceId"=wid and position<>rank*1024; end if;
      end loop;
    end if;
    summary:='Ordem alterada';
  when 'delete' then t."deletedAt":=coalesce(t."deletedAt",instant); summary:='Tarefa movida para a lixeira';
  when 'restore' then t."deletedAt":=null; summary:='Tarefa restaurada da lixeira';
  else perform avana_private.fail('Ação desconhecida.');
  end case;
  if changed then
    update public.avana_tasks set "projectId"=t."projectId",title=t.title,description=t.description,section=t.section,"completionId"=t."completionId",position=t.position,
      "executionOrder"=t."executionOrder",assignee=t.assignee,priority=t.priority,"plannedDate"=t."plannedDate","dueDate"=t."dueDate","dueTime"=t."dueTime","dueTimezone"=t."dueTimezone",
      "deletedAt"=t."deletedAt","updatedAt"=instant,version=t.version+1 where id=tid and "workspaceId"=wid;
    perform avana_private.audit_delta(wid,tid,action,summary,previous,avana_private.detail(wid,tid),instant);
  end if;
  return avana_private.detail(wid,tid);
end $$;

create or replace function avana_private.export_data(wid uuid) returns jsonb
language plpgsql stable set search_path='' as $$
declare result jsonb; rows jsonb; source text; target text; w public.avana_workspaces%rowtype; settings jsonb;
begin
  select * into w from public.avana_workspaces where id=wid;
  settings:=avana_private.settings(wid);
  result:=jsonb_build_object(
    'workspaces',jsonb_build_array(jsonb_build_object('id',w.id,'name',w.name,'createdAt',to_char(w."createdAt" at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
    'users',jsonb_build_array(jsonb_build_object('id',w.owner_id,'name',settings->>'name')),
    'memberships',jsonb_build_array(jsonb_build_object('workspaceId',wid,'userId',w.owner_id,'role','owner')),
    'settings',jsonb_build_array(settings||jsonb_build_object('workspaceId',wid,'backupDirectory',null)),
    'commands','[]'::jsonb,'requests','[]'::jsonb);
  for source,target in select * from (values ('projects','projects'),('tasks','tasks'),('completions','completions'),('subtasks','subtasks'),('comments','comments'),('activity','activity'),('holds','holds'),('followUps','follow_ups')) x(a,b) loop
    if source='projects' then
      select coalesce(jsonb_agg(avana_private.json_row(to_jsonb(p),false)||jsonb_build_object('favorite',case when p.favorite then 1 else 0 end,'requireEvidence',case when p."requireEvidence" then 1 else 0 end) order by p.id),'[]'::jsonb)
        into rows from public.avana_projects p where p."workspaceId"=wid;
    elsif source='activity' then
      select coalesce(jsonb_agg(avana_private.json_row(to_jsonb(a))||jsonb_build_object('before',a.before::text,'after',a.after::text) order by a.event_order),'[]'::jsonb)
        into rows from public.avana_activity a where a."workspaceId"=wid;
    else
      execute format('select coalesce(jsonb_agg(avana_private.json_row(to_jsonb(x),$2) order by x.%I),''[]''::jsonb) from public.avana_%I x where x."workspaceId"=$1',case when source in ('comments','completions','holds','followUps') then 'event_order' else 'id' end,target)
        into rows using wid,source not in ('projects','tasks');
    end if;
    result:=result||jsonb_build_object(source,rows);
  end loop;
  return jsonb_build_object('format','avana','version',1,'exportedAt',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'data',result);
end $$;

drop function if exists avana_private.import_rows(uuid,jsonb,boolean);
create or replace function avana_private.import_rows(wid uuid,payload jsonb,apply_settings boolean,is_restore boolean default false) returns jsonb
language plpgsql set search_path='' as $$
declare
  data jsonb; source text; target text; row_value jsonb; normalized jsonb; existing jsonb; existing_workspace uuid;
  allowed text[]; names text; old_workspace text; owner_settings jsonb; counts jsonb:='{}'; key text; row_id uuid;
begin
  if jsonb_typeof(payload) is distinct from 'object' or payload->>'format' is distinct from 'avana' or payload->'version' is distinct from '1'::jsonb or jsonb_typeof(payload->'data') is distinct from 'object' then
    perform avana_private.fail('Formato ou versão de exportação incompatível.');
  end if;
  data:=payload->'data';
  foreach key in array array['workspaces','users','memberships','settings','projects','tasks','completions','subtasks','comments','activity','holds','followUps','commands','requests'] loop
    if jsonb_typeof(data->key) is distinct from 'array' then perform avana_private.fail('Tabela inválida: '||key); end if;
    if jsonb_array_length(data->key)>200000 then perform avana_private.fail('Tabela muito grande: '||key); end if;
  end loop;
  if jsonb_array_length(data->'workspaces')<>1 or jsonb_array_length(data->'users')<>1 or jsonb_array_length(data->'memberships')<>1 or jsonb_array_length(data->'settings')<>1 then
    perform avana_private.fail('O arquivo deve conter um workspace e um proprietário.');
  end if;
  old_workspace:=data->'workspaces'->0->>'id';
  perform avana_private.uuid_value(old_workspace);
  perform avana_private.uuid_value(data->'users'->0->>'id');
  if old_workspace is null or data->'settings'->0->>'workspaceId' is distinct from old_workspace
     or data->'memberships'->0->>'workspaceId' is distinct from old_workspace
     or data->'memberships'->0->>'userId' is distinct from data->'users'->0->>'id'
     or data->'memberships'->0->>'role' is distinct from 'owner' then perform avana_private.fail('Identidade do arquivo inconsistente.'); end if;
  set constraints all deferred;
  for source,target in select * from (values ('projects','projects'),('tasks','tasks'),('completions','completions'),('subtasks','subtasks'),('comments','comments'),('activity','activity'),('holds','holds'),('followUps','follow_ups')) x(a,b) loop
    counts:=counts||jsonb_build_object(source,jsonb_array_length(data->source));
    select array_agg(a.attname::text order by a.attnum),string_agg(format('%I',a.attname),',' order by a.attnum)
      into allowed,names from pg_catalog.pg_attribute a
      where a.attrelid=('public.avana_'||target)::regclass and a.attnum>0 and not a.attisdropped and a.attname<>'event_order';
    for row_value in select value from jsonb_array_elements(data->source) loop
      perform avana_private.check_keys(row_value,allowed);
      for key in select a.attname::text from pg_catalog.pg_attribute a where a.attrelid=('public.avana_'||target)::regclass and a.attnum>0 and not a.attisdropped and a.atttypid='text'::regtype loop
        if row_value ? key and row_value->key <> 'null'::jsonb and jsonb_typeof(row_value->key) is distinct from 'string' then perform avana_private.fail('Campo textual inválido no arquivo: '||key); end if;
      end loop;
      if source in ('tasks','subtasks') and jsonb_typeof(row_value->'position') is distinct from 'number' then perform avana_private.fail('Ordenação inválida no arquivo.'); end if;
      if source='tasks' and jsonb_typeof(row_value->'version') is distinct from 'number' then perform avana_private.fail('Versão inválida no arquivo.'); end if;
      row_id:=avana_private.uuid_value(row_value->>'id');
      if source in ('projects','tasks') and row_value->>'workspaceId' is distinct from old_workspace then perform avana_private.fail('Registro pertence a outro workspace no arquivo.'); end if;
      row_value:=row_value||jsonb_build_object('workspaceId',wid);
      foreach key in array array['plannedDate','dueDate','date'] loop
        if row_value ? key then perform avana_private.date_value(row_value->key); end if;
      end loop;
      if row_value ? 'dueTime' and row_value->'dueTime'<>'null'::jsonb and
         (jsonb_typeof(row_value->'dueTime')<>'string' or row_value->>'dueTime' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
        perform avana_private.fail('Horário inválido no arquivo.');
      end if;
      if source='projects' then
        foreach key in array array['favorite','requireEvidence'] loop
          if row_value->key='0'::jsonb then row_value:=jsonb_set(row_value,array[key],'false'::jsonb);
          elsif row_value->key='1'::jsonb then row_value:=jsonb_set(row_value,array[key],'true'::jsonb);
          elsif jsonb_typeof(row_value->key)<>'boolean' then perform avana_private.fail('Preferência de projeto inválida.'); end if;
        end loop;
        perform avana_private.text_field(row_value,'name',200,true);
        if row_value->>'color' !~ '^#[a-fA-F0-9]{6}$' then perform avana_private.fail('Cor de projeto inválida.'); end if;
      elsif source='tasks' then
        if not row_value ? 'executionOrder' then row_value:=row_value||jsonb_build_object('executionOrder',null); end if;
        perform avana_private.sequence_value(row_value->'executionOrder');
        if row_value->>'priority'='urgent' then row_value:=jsonb_set(row_value,'{priority}','"high"'); end if;
        perform avana_private.text_field(row_value,'title',1000,true);
        if not exists(select 1 from pg_catalog.pg_timezone_names where name=row_value->>'dueTimezone') then perform avana_private.fail('Fuso de prazo inválido.'); end if;
      elsif source='subtasks' then perform avana_private.text_field(row_value,'title',1000,true);
      elsif source='comments' then perform avana_private.text_field(row_value,'body',100000,true);
      elsif source='activity' then
        foreach key in array array['before','after'] loop
          if jsonb_typeof(row_value->key)='string' then row_value:=jsonb_set(row_value,array[key],(row_value->>key)::jsonb); end if;
        end loop;
      end if;
      execute format('select avana_private.json_row(to_jsonb(jsonb_populate_record(null::public.avana_%I,$1)),false)',target) into normalized using row_value;
      execute format('select x."workspaceId",avana_private.json_row(to_jsonb(x),false) from public.avana_%I x where x.id=$1',target)
        into existing_workspace,existing using row_id;
      if existing is not null then
        if existing_workspace<>wid or existing<>normalized then perform avana_private.fail('Há um identificador existente com dados diferentes. A importação não substitui dados.',409,'IMPORT_CONFLICT'); end if;
      else
        if source='tasks' and not is_restore and exists(select 1 from public.avana_task_versions v where v."workspaceId"=wid and v."taskId"=row_id) then
          perform avana_private.fail('Esta tarefa já foi removida deste espaço. Use a restauração explícita para recuperar o arquivo sem reutilizar uma versão antiga.',409,'IMPORT_CONFLICT');
        end if;
        if source='activity' then
          insert into public.avana_activity(id,"workspaceId","taskId",type,summary,before,after,"createdAt",author)
          select x.id,x."workspaceId",x."taskId",x.type,x.summary,coalesce(x.before,'null'::jsonb),coalesce(x.after,'null'::jsonb),x."createdAt",x.author
          from jsonb_populate_record(null::public.avana_activity,row_value) x;
        else
          execute format('insert into public.avana_%I (%s) select %s from jsonb_populate_record(null::public.avana_%I,$1)',target,names,names,target) using row_value;
        end if;
      end if;
    end loop;
  end loop;
  if exists(select 1 from public.avana_tasks t where t."workspaceId"=wid and
      ((t.section='hold' and not exists(select 1 from public.avana_holds h where h."taskId"=t.id and h."workspaceId"=wid and h."endedAt" is null))
       or (t.section is distinct from 'hold' and exists(select 1 from public.avana_holds h where h."taskId"=t.id and h."workspaceId"=wid and h."endedAt" is null))
       or (t."completionId" is not null and exists(select 1 from public.avana_follow_ups f where f."taskId"=t.id and f."workspaceId"=wid and f.status='pending')))) then
    perform avana_private.fail('Bloqueios ou acompanhamentos inconsistentes no arquivo.');
  end if;
  if apply_settings then
    owner_settings:=data->'settings'->0;
    perform avana_private.text_field(owner_settings,'name',200,true);
    if owner_settings->>'theme' not in ('light','dark','system') or not exists(select 1 from pg_catalog.pg_timezone_names where name=owner_settings->>'timezone') then perform avana_private.fail('Configurações inválidas.'); end if;
    update public.avana_settings set name=owner_settings->>'name',theme=owner_settings->>'theme',timezone=owner_settings->>'timezone' where "workspaceId"=wid;
  end if;
  set constraints all immediate;
  return counts;
end $$;

create or replace function avana_private.advance_restored_versions(wid uuid,instant timestamptz) returns void
language plpgsql set search_path='' as $$
declare task_record record; next_version integer;
begin
  for task_record in
    select t.id,t.version,t."updatedAt",v.max_version from public.avana_tasks t
    join public.avana_task_versions v on v."workspaceId"=t."workspaceId" and v."taskId"=t.id
    where t."workspaceId"=wid
  loop
    if task_record.max_version=2147483647 then
      perform avana_private.fail('O limite de versões desta tarefa foi atingido. A restauração não foi aplicada.',409,'VERSION_LIMIT');
    end if;
    next_version:=greatest(task_record.version,task_record.max_version)+1;
    update public.avana_tasks set version=next_version,"updatedAt"=instant
      where "workspaceId"=wid and id=task_record.id;
    insert into public.avana_activity("workspaceId","taskId",type,summary,before,after,"createdAt",author)
      values(wid,task_record.id,'restoreSnapshot','Tarefa restaurada de uma exportação',
        avana_private.json_row(jsonb_build_object('version',task_record.version,'updatedAt',task_record."updatedAt")),
        avana_private.json_row(jsonb_build_object('version',next_version,'updatedAt',instant)),
        instant,avana_private.settings(wid)->>'name');
  end loop;
end $$;

create or replace function avana_private.clear_domain(wid uuid) returns void
language plpgsql set search_path='' as $$ begin
  update public.avana_tasks set "completionId"=null,section='backlog' where "workspaceId"=wid;
  delete from public.avana_comments where "workspaceId"=wid;
  delete from public.avana_activity where "workspaceId"=wid;
  delete from public.avana_holds where "workspaceId"=wid;
  delete from public.avana_follow_ups where "workspaceId"=wid;
  delete from public.avana_subtasks where "workspaceId"=wid;
  delete from public.avana_completions where "workspaceId"=wid;
  delete from public.avana_tasks where "workspaceId"=wid;
  delete from public.avana_projects where "workspaceId"=wid;
  delete from public.avana_requests where "workspaceId"=wid;
  delete from public.avana_imports where "workspaceId"=wid;
end $$;

create or replace function avana_private.resolve_result(wid uuid,result jsonb) returns jsonb
language plpgsql stable set search_path='' as $$ declare value jsonb; begin
  if result->>'$ref'='task' then return avana_private.detail(wid,(result->>'id')::uuid);
  elsif result->>'$ref'='project' then
    select avana_private.json_row(to_jsonb(p)) into value from public.avana_projects p where p.id=(result->>'id')::uuid and p."workspaceId"=wid;
    if value is null then perform avana_private.fail('Projeto não encontrado.',404,'NOT_FOUND'); end if;
    return value;
  elsif result->>'$ref'='settings' then return avana_private.settings(wid);
  end if;
  return result;
end $$;

create or replace function avana_private.maintenance(wid uuid) returns void
language plpgsql set search_path='' as $$
declare zone text; expired_tasks uuid[]; expired_projects uuid[];
begin
  select timezone into zone from public.avana_settings where "workspaceId"=wid;
  if not exists(select 1 from public.avana_backups b where b."workspaceId"=wid and b.kind='daily' and (b."createdAt" at time zone zone)::date=(now() at time zone zone)::date) then
    insert into public.avana_backups("workspaceId",kind,data) values(wid,'daily',avana_private.export_data(wid));
  end if;
  select coalesce(array_agg(id),'{}'::uuid[]) into expired_projects from public.avana_projects where "workspaceId"=wid and "deletedAt"<=now()-interval '30 days';
  select coalesce(array_agg(id),'{}'::uuid[]) into expired_tasks from public.avana_tasks where "workspaceId"=wid and ("deletedAt"<=now()-interval '30 days' or "projectId"=any(expired_projects));
  if cardinality(expired_tasks)>0 or cardinality(expired_projects)>0 then
    update public.avana_tasks set "completionId"=null,section='backlog' where "workspaceId"=wid and id=any(expired_tasks);
    delete from public.avana_comments where "workspaceId"=wid and "taskId"=any(expired_tasks);
    delete from public.avana_activity where "workspaceId"=wid and "taskId"=any(expired_tasks);
    delete from public.avana_holds where "workspaceId"=wid and "taskId"=any(expired_tasks);
    delete from public.avana_follow_ups where "workspaceId"=wid and "taskId"=any(expired_tasks);
    delete from public.avana_subtasks where "workspaceId"=wid and "taskId"=any(expired_tasks);
    delete from public.avana_completions where "workspaceId"=wid and "taskId"=any(expired_tasks);
    delete from public.avana_tasks where "workspaceId"=wid and id=any(expired_tasks);
    delete from public.avana_projects where "workspaceId"=wid and id=any(expired_projects);
    update public.avana_workspaces set revision=revision+1 where id=wid;
  end if;
  delete from public.avana_backups where "workspaceId"=wid and kind='daily' and "createdAt"<now()-interval '30 days';
end $$;

-- Remove the earlier development signature so PostgREST sees one unambiguous RPC.
drop function if exists public.avana_api(text,text,jsonb,text);
create or replace function public.avana_api(p_method text,p_path text,p_body jsonb default '{}',p_request_id text default null,p_expected_user_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
<<api>> declare
  uid uuid:=auth.uid(); wid uuid; fresh uuid; rev bigint; method text:=upper(p_method); parts text[];
  body jsonb:=coalesce(p_body,'{}'::jsonb); result jsonb; reference jsonb; receipt jsonb; counts jsonb; source_id text; source_hash text;
  request_key text; request_hash text; previous_request public.avana_requests%rowtype;
  pid uuid; tid uuid; item_id uuid; bid uuid; row_project public.avana_projects%rowtype;
  instant timestamptz(3):=clock_timestamp(); section_name text; name_value text; description_value text; color_value text; icon_value text;
  boolean_value boolean; changed boolean:=false; settings_applied boolean; settings jsonb; field text;
begin
  if uid is null then perform avana_private.fail('Entre na sua conta para continuar.',401,'UNAUTHENTICATED'); end if;
  if p_expected_user_id is not null and p_expected_user_id<>uid then
    perform avana_private.fail('A conta mudou. Abra o espaço novamente antes de continuar.',401,'SESSION_CHANGED');
  end if;
  if jsonb_typeof(body)<>'object' then perform avana_private.fail('Dados inválidos.'); end if;
  if p_path is null or p_path !~ '^/api/[a-zA-Z0-9/_-]+$' then perform avana_private.fail('Rota não encontrada.',404,'NOT_FOUND'); end if;
  insert into public.avana_workspaces(owner_id) values(uid) on conflict(owner_id) do nothing returning id into fresh;
  select id,revision into wid,rev from public.avana_workspaces where owner_id=uid for update;
  if fresh is not null then
    insert into public.avana_settings("workspaceId") values(wid);
    insert into public.avana_projects("workspaceId",name,icon,favorite) values(wid,'Meu trabalho','briefcase',true);
  end if;
  -- Verification/export reads must not expire imported records before cutover completes.
  if p_path='/api/bootstrap' or (method<>'GET' and p_path not in ('/api/import','/api/restore')) then
    perform avana_private.maintenance(wid);
  end if;
  select revision into rev from public.avana_workspaces where id=wid;
  -- The owner row lock serializes all changes to one workspace, across all devices.
  -- The auth check occurs before reading any idempotency result or import receipt.
  parts:=string_to_array(trim(both '/' from p_path),'/');
  if method not in ('GET','POST','PATCH') then perform avana_private.fail('Método não permitido.',405,'METHOD_NOT_ALLOWED'); end if;
  if method<>'GET' then
    if parts[2]='tasks' and parts[4]='command' then
      request_key:='command:'||avana_private.text_field(body,'commandId',200,true);
    elsif p_request_id is not null then
      if length(p_request_id)>200 or btrim(p_request_id)='' then perform avana_private.fail('Chave de idempotência inválida.'); end if;
      request_key:='request:'||p_request_id;
    elsif not coalesce((p_path='/api/import' and jsonb_typeof(body->'sourceId')='string' and length(btrim(body->>'sourceId'))>0),false) then
      perform avana_private.fail('Informe uma chave de idempotência para esta alteração.',400,'IDEMPOTENCY_REQUIRED');
    end if;
    request_hash:=md5(jsonb_build_object('method',method,'path',p_path,'body',body)::text);
    if request_key is not null then
      select * into previous_request from public.avana_requests where "workspaceId"=wid and request_id=request_key;
      if found then
        if previous_request.request_hash<>request_hash then perform avana_private.fail('Esta ação já foi usada com outros dados.',409,'IDEMPOTENCY_CONFLICT'); end if;
        return avana_private.resolve_result(wid,previous_request.result);
      end if;
    end if;
  end if;
  if method='GET' and p_path='/api/health' then return jsonb_build_object('ok',true,'app','avana');
  elsif method='GET' and p_path='/api/bootstrap' then return avana_private.bootstrap(wid);
  elsif method='GET' and p_path='/api/export' then return avana_private.export_data(wid);
  elsif method='GET' and parts[2]='tasks' and array_length(parts,1)=3 then return avana_private.detail(wid,avana_private.uuid_value(parts[3]));
  elsif method='GET' and parts[2]='imports' and array_length(parts,1)=3 then
    select i.receipt into receipt from public.avana_imports i where i."workspaceId"=wid and i.source_id=parts[3];
    if receipt is null then perform avana_private.fail('Importação não encontrada.',404,'NOT_FOUND'); end if;
    return receipt;
  elsif method='POST' and p_path='/api/projects' then
    perform avana_private.check_keys(body,array['name','description','color','icon','requireEvidence']);
    name_value:=btrim(avana_private.text_field(body,'name',200,true)); description_value:=avana_private.text_field(body,'description',100000);
    color_value:=avana_private.text_field(body,'color',40,true,'#9470d8'); icon_value:=avana_private.text_field(body,'icon',80,true,'folder');
    if color_value !~ '^#[a-fA-F0-9]{6}$' then perform avana_private.fail('Cor inválida.'); end if;
    if body ? 'requireEvidence' and jsonb_typeof(body->'requireEvidence')<>'boolean' then perform avana_private.fail('Preferência de evidência inválida.'); end if;
    insert into public.avana_projects("workspaceId",name,description,color,icon,"requireEvidence","createdAt")
      values(wid,name_value,description_value,color_value,icon_value,coalesce((body->>'requireEvidence')::boolean,false),instant) returning id into pid;
    reference:=jsonb_build_object('$ref','project','id',pid); result:=avana_private.resolve_result(wid,reference); changed:=true;
  elsif method='PATCH' and parts[2]='projects' and array_length(parts,1)=3 then
    pid:=avana_private.uuid_value(parts[3]);
    select * into row_project from public.avana_projects where id=pid and "workspaceId"=wid;
    if not found then perform avana_private.fail('Projeto não encontrado.',404,'NOT_FOUND'); end if;
    if row_project."deletedAt" is not null and body->'deleted' is distinct from 'false'::jsonb then perform avana_private.fail('Restaure o projeto antes de editar.',409,'PROJECT_DELETED'); end if;
    perform avana_private.check_keys(body,array['name','description','color','icon','favorite','archived','deleted','requireEvidence']);
    if body ? 'name' then row_project.name:=btrim(avana_private.text_field(body,'name',200,true)); end if;
    if body ? 'description' then row_project.description:=avana_private.text_field(body,'description',100000); end if;
    if body ? 'color' then row_project.color:=avana_private.text_field(body,'color',40,true); end if;
    if body ? 'icon' then row_project.icon:=avana_private.text_field(body,'icon',80,true); end if;
    if row_project.color !~ '^#[a-fA-F0-9]{6}$' then perform avana_private.fail('Cor inválida.'); end if;
    foreach field in array array['favorite','archived','deleted','requireEvidence'] loop if body ? field and jsonb_typeof(body->field)<>'boolean' then perform avana_private.fail('Preferência de projeto inválida: '||field); end if; end loop;
    if body ? 'favorite' then row_project.favorite:=(body->>'favorite')::boolean; end if;
    if body ? 'requireEvidence' then row_project."requireEvidence":=(body->>'requireEvidence')::boolean; end if;
    if body ? 'archived' then row_project."archivedAt":=case when (body->>'archived')::boolean then coalesce(row_project."archivedAt",instant) else null end; end if;
    if body ? 'deleted' then row_project."deletedAt":=case when (body->>'deleted')::boolean then coalesce(row_project."deletedAt",instant) else null end; end if;
    update public.avana_projects set name=row_project.name,description=row_project.description,color=row_project.color,icon=row_project.icon,favorite=row_project.favorite,
      "requireEvidence"=row_project."requireEvidence","archivedAt"=row_project."archivedAt","deletedAt"=row_project."deletedAt" where id=pid and "workspaceId"=wid;
    reference:=jsonb_build_object('$ref','project','id',pid); result:=avana_private.resolve_result(wid,reference); changed:=true;
  elsif method='PATCH' and p_path='/api/settings' then
    perform avana_private.check_keys(body,array['name','timezone','theme','backupDirectory']); settings:=avana_private.settings(wid);
    if body ? 'name' then settings:=jsonb_set(settings,'{name}',to_jsonb(btrim(avana_private.text_field(body,'name',200,true)))); end if;
    if body ? 'timezone' then
      name_value:=avana_private.text_field(body,'timezone',100,true);
      if not exists(select 1 from pg_catalog.pg_timezone_names where name=name_value) then perform avana_private.fail('Fuso horário inválido.'); end if;
      settings:=jsonb_set(settings,'{timezone}',to_jsonb(name_value));
    end if;
    if body ? 'theme' then
      name_value:=avana_private.text_field(body,'theme',20,true); if name_value not in ('light','dark','system') then perform avana_private.fail('Tema inválido.'); end if;
      settings:=jsonb_set(settings,'{theme}',to_jsonb(name_value));
    end if;
    if body ? 'backupDirectory' and body->'backupDirectory' not in ('null'::jsonb,'""'::jsonb) then perform avana_private.fail('A pasta de backup é uma preferência local do dispositivo.'); end if;
    update public.avana_settings set name=settings->>'name',timezone=settings->>'timezone',theme=settings->>'theme' where "workspaceId"=wid;
    reference:=jsonb_build_object('$ref','settings'); result:=avana_private.settings(wid); changed:=true;
  elsif method='POST' and p_path='/api/tasks' then
    perform avana_private.check_keys(body,array['title','projectId','section']);
    name_value:=btrim(avana_private.text_field(body,'title',1000,true));
    if body ? 'projectId' then pid:=avana_private.uuid_value(body->>'projectId');
    else select id into pid from public.avana_projects where "workspaceId"=wid and "archivedAt" is null and "deletedAt" is null order by "createdAt",id limit 1; end if;
    if pid is null then perform avana_private.fail('Crie ou restaure um projeto antes de adicionar tarefas.'); end if;
    perform avana_private.ensure_active(wid,pid);
    section_name:=coalesce(body->>'section','backlog'); if section_name not in ('backlog','hold','today') then perform avana_private.fail('Seção inválida.'); end if;
    insert into public.avana_tasks("workspaceId","projectId",title,section,position,assignee,"plannedDate","dueTimezone","createdAt","updatedAt")
      values(wid,pid,name_value,section_name,avana_private.next_position(wid,pid,section_name),avana_private.settings(wid)->>'name',case when section_name='today' then avana_private.today(wid) else null end,avana_private.settings(wid)->>'timezone',instant,instant) returning id into tid;
    if section_name='hold' then insert into public.avana_holds("workspaceId","taskId","startedAt") values(wid,tid,instant); end if;
    insert into public.avana_activity("workspaceId","taskId",type,summary,before,after,"createdAt",author) values(wid,tid,'created','Tarefa criada','null',jsonb_build_object('title',name_value,'section',section_name),instant,avana_private.settings(wid)->>'name');
    reference:=jsonb_build_object('$ref','task','id',tid); result:=avana_private.detail(wid,tid); changed:=true;
  elsif method='POST' and parts[2]='tasks' and parts[4]='command' and array_length(parts,1)=4 then
    tid:=avana_private.uuid_value(parts[3]); result:=avana_private.task_command(wid,tid,body); reference:=jsonb_build_object('$ref','task','id',tid); changed:=true;
  elsif method='POST' and p_path='/api/backup' then
    insert into public.avana_backups("workspaceId",kind,data,"createdAt") values(wid,'manual',avana_private.export_data(wid),instant) returning id into bid;
    result:=jsonb_build_object('ok',true,'id',bid,'createdAt',to_char(instant at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')); changed:=true;
  elsif method='POST' and p_path='/api/import' then
    source_hash:=md5((body->'data')::text); source_id:=coalesce(nullif(body->>'sourceId',''),'export-'||source_hash);
    if source_hash is null or source_id !~ '^[A-Za-z0-9_-]{1,200}$' then perform avana_private.fail('Origem da importação inválida.'); end if;
    select i.receipt into receipt from public.avana_imports i where i."workspaceId"=wid and i.source_id=api.source_id;
    if receipt is not null then
      if receipt->>'hash'<>source_hash then perform avana_private.fail('Esta origem já foi importada com outro conteúdo.',409,'IMPORT_SOURCE_CONFLICT'); end if;
      return receipt;
    end if;
    select i.receipt into receipt from public.avana_imports i where i."workspaceId"=wid and i.source_hash=api.source_hash order by i."createdAt",i.id limit 1;
    if receipt is not null then receipt:=receipt||jsonb_build_object('sourceId',source_id);
    else
      settings_applied:=rev=0;
      if settings_applied and jsonb_typeof(body->'data'->'data'->'projects')='array' and jsonb_array_length(body->'data'->'data'->'projects')>0 then
        delete from public.avana_projects p where p."workspaceId"=wid and not exists(select 1 from public.avana_tasks t where t."projectId"=p.id and t."workspaceId"=wid);
      end if;
      counts:=avana_private.import_rows(wid,body->'data',settings_applied);
      receipt:=jsonb_build_object('sourceId',source_id,'hash',source_hash,'workspaceId',wid,'counts',counts,'settingsApplied',settings_applied);
    end if;
    insert into public.avana_imports("workspaceId",source_id,source_hash,receipt,"createdAt") values(wid,source_id,source_hash,receipt,instant);
    result:=receipt; changed:=true;
  elsif method='POST' and p_path='/api/restore' then
    insert into public.avana_backups("workspaceId",kind,data,"createdAt") values(wid,'before-restore',avana_private.export_data(wid),instant);
    perform avana_private.clear_domain(wid);
    counts:=avana_private.import_rows(wid,body->'data',true,true);
    perform avana_private.advance_restored_versions(wid,instant);
    result:=jsonb_build_object('ok',true); changed:=true;
  else perform avana_private.fail('Rota não encontrada.',404,'NOT_FOUND');
  end if;
  if changed then
    update public.avana_workspaces set revision=revision+1 where id=wid and owner_id=uid;
    delete from public.avana_backups where "workspaceId"=wid and kind='daily' and "createdAt"<now()-interval '30 days';
    if request_key is not null then insert into public.avana_requests("workspaceId",request_id,request_hash,result,"createdAt") values(wid,request_key,request_hash,coalesce(reference,result),instant); end if;
  end if;
  return result;
exception
  when sqlstate 'P0001' then raise;
  when foreign_key_violation or unique_violation or check_violation or not_null_violation or invalid_text_representation or datetime_field_overflow then
    perform avana_private.fail('Dados inválidos ou vínculos inconsistentes. Nenhuma alteração foi aplicada.',400,'VALIDATION_ERROR');
end $$;

revoke all on all functions in schema avana_private from public, anon, authenticated;
revoke all on function public.avana_api(text,text,jsonb,text,uuid) from public, anon;
grant execute on function public.avana_api(text,text,jsonb,text,uuid) to authenticated;
do $$ begin
  if exists(select 1 from pg_catalog.pg_publication where pubname='supabase_realtime')
     and not exists(select 1 from pg_catalog.pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='avana_workspaces') then
    alter publication supabase_realtime add table public.avana_workspaces;
  end if;
end $$;
