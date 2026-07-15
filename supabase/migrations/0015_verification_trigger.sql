-- Crith AI V2 — claim_verifications trigger column
--
-- Distinguishes auto-verifications (combined fact-check call) from
-- user-clicked manual re-checks (/api/verify-claim).

alter table claim_verifications
  add column if not exists trigger text not null default 'manual'
  check (trigger in ('auto', 'manual'));
