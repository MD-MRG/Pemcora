-- ─────────────────────────────────────────────────────────────────────────────
-- 0013 — landlords read the reports sent to them without the sender's ids
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Build plan D4a. Until now the account a report was saved to read its row in
-- report_deliveries directly, and with it the sending team's ids: its team, its
-- site, the visit, who sent it, and the account that signed it off. None of it
-- is any use to a landlord, and it isn't theirs to have.
--
--   report_deliveries   read directly by the team that sent it, and no one else.
--   received_reports()  what the account a report was saved to reads instead:
--                       every column it needs, none of the sender's ids, and
--                       the snapshot without the sender's team or the account
--                       that signed it off (as report_preview() gives it). A
--                       function rather than a view: a view that leaves RLS
--                       behind is what Supabase's advisor warns about, and this
--                       has to, to read rows the landlord no longer can.
--   site_links          read by the team that sent the reports, and no one else.
--                       It holds the sender's site and team too. Whether a
--                       report's site files itself comes with received_reports()
--                       (files_itself), and stop_auto_filing() ends it, named by
--                       a report, so the landlord never needs the ids.
--   reports bucket      the saved account still reads a report's PDF. The
--                       bucket's rule looked the delivery up as the landlord,
--                       which they can't any more, so it asks
--                       can_read_received_report(), which can.
--
-- Known: a report's PDF is stored as <sending team>/<name>.pdf, and the bucket
-- needs that name to make a link, so received_reports() returns it. The team's
-- id is in it. It opens nothing: every read is still checked by membership.
--
-- 0007 sets the policies this replaces. Re-running 0007 by itself puts them
-- back, so re-run 0013 after it.
--
-- Safe to re-run. Applied by M.D. in the Supabase SQL editor, after 0012.

-- ── Deliveries and links: the sender's own ─────────────────────────────────

drop policy if exists report_deliveries_select on public.report_deliveries;
create policy report_deliveries_select on public.report_deliveries
  for select to authenticated
  using (public.is_team_member(provider_team_id));

drop policy if exists site_links_select on public.site_links;
create policy site_links_select on public.site_links
  for select to authenticated
  using (public.is_team_member(provider_team_id));

-- Ended through stop_auto_filing() now, which checks the same thing.
drop policy if exists site_links_delete on public.site_links;
revoke delete on table public.site_links from authenticated;

-- ── What the saved account reads ───────────────────────────────────────────

drop function if exists public.received_reports();
create or replace function public.received_reports()
returns table (
  id                    uuid,
  token                 uuid,
  workflow_id           text,
  workflow              text,
  completed_on          date,
  outcome               text,
  site                  jsonb,
  snapshot              jsonb,
  has_file              boolean,
  file_path             text,
  recipient_email       text,
  recipient_team_id     uuid,
  recipient_location_id uuid,
  sent_at               timestamptz,
  opened_at             timestamptz,
  claimed_at            timestamptz,
  filed_at              timestamptz,
  files_itself          boolean
)
language sql stable security definer set search_path = public as $$
  select d.id, d.token, d.workflow_id, w.label, d.completed_on, d.outcome, d.site,
         d.snapshot #- '{provider,team_id}' #- '{signoff,signed_by}',
         d.file_path is not null, d.file_path, d.recipient_email,
         d.recipient_team_id, d.recipient_location_id,
         d.sent_at, d.opened_at, d.claimed_at, d.filed_at,
         exists (select 1 from public.site_links l
                  where l.provider_location_id = d.provider_location_id
                    and l.recipient_team_id = d.recipient_team_id)
    from public.report_deliveries d
    join public.workflows w on w.id = d.workflow_id
   where d.recipient_team_id in (select m.team_id from public.team_members m where m.user_id = auth.uid());
$$;

/**
 * Stop the site a report came from filing its next reports into this account
 * by themselves. The report itself stays where it is filed.
 */
create or replace function public.stop_auto_filing(p_delivery_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_row public.report_deliveries;
begin
  select * into v_row from public.report_deliveries where id = p_delivery_id;
  if v_row.id is null or v_row.recipient_team_id is null
     or not public.is_team_member(v_row.recipient_team_id) then
    raise exception 'That report is not in your account';
  end if;
  delete from public.site_links
   where provider_location_id = v_row.provider_location_id
     and recipient_team_id    = v_row.recipient_team_id;
end;
$$;

-- ── The PDF, for the account it was saved to ───────────────────────────────

-- Only ever says whether the person asking may read this one file.
create or replace function public.can_read_received_report(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.report_deliveries d
     where d.file_path = p_name
       and d.recipient_team_id is not null
       and public.is_team_member(d.recipient_team_id));
$$;

drop policy if exists pemcora_reports_select on storage.objects;
create policy pemcora_reports_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'reports'
    and (public.is_team_member(public.path_team(name)) or public.can_read_received_report(name))
  );

revoke execute on function public.received_reports()               from public, anon;
revoke execute on function public.stop_auto_filing(uuid)           from public, anon;
revoke execute on function public.can_read_received_report(text)   from public, anon;
grant  execute on function public.received_reports()               to authenticated;
grant  execute on function public.stop_auto_filing(uuid)           to authenticated;
grant  execute on function public.can_read_received_report(text)   to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — deliveries_senders_only, links_senders_only, pdf_rule_updated
-- and functions_closed_to_anon all true.
-- ─────────────────────────────────────────────────────────────────────────────

select
  (select qual from pg_policies where schemaname = 'public' and tablename = 'report_deliveries'
      and policyname = 'report_deliveries_select') not like '%recipient%'      as deliveries_senders_only,
  (select qual from pg_policies where schemaname = 'public' and tablename = 'site_links'
      and policyname = 'site_links_select') not like '%recipient%'             as links_senders_only,
  (select qual from pg_policies where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'pemcora_reports_select') like '%can_read_received_report%' as pdf_rule_updated,
  not has_function_privilege('anon', 'public.received_reports()', 'execute')
    and not has_function_privilege('anon', 'public.stop_auto_filing(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.can_read_received_report(text)', 'execute')
                                                                                as functions_closed_to_anon;
