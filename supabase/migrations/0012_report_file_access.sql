-- ─────────────────────────────────────────────────────────────────────────────
-- 0012 — report-file can read the five columns it decides by
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Build plan D3b. The report-file Edge Function gives a five-minute link to a
-- sent report's PDF from the report link's token alone. It reads the delivery
-- with the platform's service-role key: one row, by token, and only these
-- columns (supabase/functions/report-file/access.js).
--
-- On the live project service_role holds no privilege on any table in public
-- (found 9 November, once report-file was deployed: every lookup was refused).
-- Rather than give it the whole table, this gives it exactly what the function
-- reads. Everything else on report_deliveries, the recipient's address and the
-- report itself among them, stays closed to it, here and on any project where
-- it had more: the table-wide privileges are taken away first, so the result is
-- the same wherever this runs.
--
-- Safe to re-run. Applied by M.D. in the Supabase SQL editor, after 0011.

revoke all on table public.report_deliveries from service_role;
grant select (token, file_path, link_expires_at, claimed_at, recipient_team_id)
  on table public.report_deliveries to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — reads_what_it_decides_by true, everything_else_closed true.
-- ─────────────────────────────────────────────────────────────────────────────

select
  has_column_privilege('service_role', 'public.report_deliveries', 'token', 'select')
    and has_column_privilege('service_role', 'public.report_deliveries', 'file_path', 'select')
    and has_column_privilege('service_role', 'public.report_deliveries', 'link_expires_at', 'select')
    and has_column_privilege('service_role', 'public.report_deliveries', 'claimed_at', 'select')
    and has_column_privilege('service_role', 'public.report_deliveries', 'recipient_team_id', 'select')
                                                                             as reads_what_it_decides_by,
  not has_column_privilege('service_role', 'public.report_deliveries', 'recipient_email', 'select')
    and not has_column_privilege('service_role', 'public.report_deliveries', 'snapshot', 'select')
    and not has_table_privilege('service_role', 'public.report_deliveries', 'insert, update, delete')
                                                                             as everything_else_closed;
