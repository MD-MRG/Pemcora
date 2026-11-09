-- ─────────────────────────────────────────────────────────────────────────────
-- 0014 — certificates: the photo folder takes PDFs too
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Build plan D4d. A landlord's hand-entered check (a gas check, say) can keep
-- its certificate, on Pro (decision D6), in the team's own folder of the
-- evidence bucket, named in compliance_items.evidence_path. 0007 already lets a
-- member write there, Pro once limits are on (can_add_evidence()), and keeps an
-- evidence_path inside the team's own folder.
--
-- On the live project the bucket takes only JPEG, PNG and WebP, as label photos
-- need. A certificate mostly arrives as a PDF (M.D., 9 November), so this adds
-- application/pdf. The size limit stays at 10 MB.
--
-- Supabase's storage.buckets has these columns; the local test stub doesn't,
-- hence the check, as 0007 does for the reports bucket.
--
-- Safe to re-run. Applied by M.D. in the Supabase SQL editor, after 0013.

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets'
                and column_name = 'allowed_mime_types') then
    update storage.buckets
       set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
           file_size_limit    = 10485760
     where id = 'evidence';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — takes_pdf and takes_photos true, limit_bytes 10485760.
-- (On a database without these columns all three are empty.)
-- ─────────────────────────────────────────────────────────────────────────────

select
  (to_jsonb(b) -> 'allowed_mime_types') ? 'application/pdf'                    as takes_pdf,
  (to_jsonb(b) -> 'allowed_mime_types') ?& array['image/jpeg', 'image/png', 'image/webp'] as takes_photos,
  (to_jsonb(b) ->> 'file_size_limit')::bigint                                   as limit_bytes
  from storage.buckets b
 where b.id = 'evidence';
