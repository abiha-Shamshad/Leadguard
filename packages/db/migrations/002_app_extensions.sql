-- LeadGuard Release 1 - additive (expand-only) extensions to 001_core_schema.sql.
-- 001 is kept byte-identical to the verified schema. Everything here is needed by the API/worker implementation
-- and was not expressible with the 001 columns alone. Run as the same admin role as 001 (it switches to lg_owner).
SET ROLE lg_owner;
SET search_path = lg, public;

-- Round-robin needs "oldest last_assigned_at" (Section 11.2).
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS last_assigned_at timestamptz;

-- Lead bookkeeping used by API-024/025/029 and the dashboard.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS possible_duplicates uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS cycle_started_at timestamptz;   -- reset on reopen; follow-up attempts counted from here

-- Timeline sub-types for system activities (due_set, timer_cancelled, due_recomputed, repeat_enquiry, ...).
ALTER TABLE lead_activities ADD COLUMN IF NOT EXISTS subtype text CHECK (length(subtype) <= 40);

-- Timers remember how their due time was computed so business-hours / time-zone changes can recompute them.
ALTER TABLE lead_timers ADD COLUMN IF NOT EXISTS base_at timestamptz;
ALTER TABLE lead_timers ADD COLUMN IF NOT EXISTS business_minutes integer;
ALTER TABLE lead_timers ADD COLUMN IF NOT EXISTS hours_version integer;

-- Source lifecycle details.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS silence_window_minutes integer NOT NULL DEFAULT 4320; -- 72 business hours

-- Unknown fields beyond the attribute limits are dropped and counted in the attempt record (Section 10).
ALTER TABLE delivery_attempts ADD COLUMN IF NOT EXISTS dropped_fields integer NOT NULL DEFAULT 0;
ALTER TABLE delivery_attempts ADD COLUMN IF NOT EXISTS auth_mode text;

-- Invitations: who invited (audit/UI).
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS invited_by uuid;

-- Subscription trial start (API-043 trial.started_at) and cancellation reason.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_started_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancel_reason text;

-- Export request options and failure reason.
ALTER TABLE exports ADD COLUMN IF NOT EXISTS include text[] NOT NULL DEFAULT '{leads,activities,alerts}';
ALTER TABLE exports ADD COLUMN IF NOT EXISTS failure_reason text;
ALTER TABLE exports ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

-- Support grants: who revoked.
ALTER TABLE support_access_grants ADD COLUMN IF NOT EXISTS revoked_by uuid;

-- Alert deliveries: kind of message (alert or invitation) is implied by alerts; nothing to add.

-- Search: trigram indexes when pg_trgm is available (trusted extension on PostgreSQL 13+).
DO $$ BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA lg;
  EXCEPTION WHEN insufficient_privilege OR undefined_file THEN
    RAISE NOTICE 'pg_trgm not available; search falls back to sequential ILIKE within the organization';
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_leads_name_trgm ON lg.leads USING gin (name gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_leads_email_trgm ON lg.leads USING gin (email_norm gin_trgm_ops)';
    EXECUTE 'CREATE INDEX IF NOT EXISTS ix_leads_phone_trgm ON lg.leads USING gin (phone_e164 gin_trgm_ops)';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_leads_created ON leads (org_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS ix_alerts_lead ON alerts (org_id, lead_id);
CREATE INDEX IF NOT EXISTS ix_deliveries_recipient ON alert_deliveries (org_id, recipient_id);
CREATE INDEX IF NOT EXISTS ix_deliveries_provider_msg ON alert_deliveries (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_source_events_lead ON source_events (org_id, lead_id);
CREATE INDEX IF NOT EXISTS ix_audit_grant ON audit_events (support_grant_id) WHERE support_grant_id IS NOT NULL;

-- New columns on existing tables inherit the table-level grants from 001. Re-assert the column-level ones
-- that 001 restricted, so lg_app keeps exactly its 001 privileges.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA lg TO lg_app;
REVOKE UPDATE ON audit_events, lead_activities, delivery_attempts, source_events FROM lg_app;
REVOKE INSERT, UPDATE ON users FROM lg_app;
GRANT SELECT ON ALL TABLES IN SCHEMA lg TO lg_lookup;

-- ------------------------------------------------------------------ additional lookups (SECURITY DEFINER, lg_lookup)
-- Same pattern as 001 Section 15.2: return only the minimum columns, executable only by the named runtime role.

-- Support staff identities come from a separate Clerk instance (DEC-009); users.kind must be support_staff.
CREATE OR REPLACE FUNCTION lg.upsert_support_user(p_id uuid, p_clerk_user_id text, p_email text, p_name text)
RETURNS uuid LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = lg, pg_temp AS
$$ INSERT INTO lg.users (id, clerk_user_id, email, name, kind) VALUES (p_id, p_clerk_user_id, lower(p_email), p_name, 'support_staff')
   ON CONFLICT (clerk_user_id) DO UPDATE SET email = excluded.email, name = excluded.name
   RETURNING CASE WHEN kind = 'support_staff' THEN id ELSE NULL END $$;

-- Which org a grant belongs to, active or not, so denied support requests can be audited (SEC-07).
CREATE OR REPLACE FUNCTION lg.support_grant_org(p_grant_id uuid)
RETURNS TABLE (org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lg, pg_temp AS
$$ SELECT org_id FROM lg.support_access_grants WHERE id = p_grant_id $$;

-- Organization names for the caller's own memberships (API-002 organizations list).
CREATE OR REPLACE FUNCTION lg.user_organizations(p_user_id uuid)
RETURNS TABLE (org_id uuid, name text, time_zone text, role text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lg, pg_temp AS
$$ SELECT o.id, o.name, o.time_zone, m.role, m.status FROM lg.memberships m JOIN lg.organizations o ON o.id = m.org_id
   WHERE m.user_id = p_user_id ORDER BY m.created_at $$;

-- Notification delivery webhooks identify the delivery only by provider message ID (API-047).
CREATE OR REPLACE FUNCTION lg.resolve_delivery_message(p_provider_message_id text)
RETURNS TABLE (org_id uuid, delivery_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lg, pg_temp AS
$$ SELECT org_id, id FROM lg.alert_deliveries WHERE provider_message_id = p_provider_message_id $$;

-- Readiness metrics without tenant data (API-001).
CREATE OR REPLACE FUNCTION lg.health_stats()
RETURNS TABLE (outbox_lag_seconds integer, oldest_pending_timer_seconds integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lg, pg_temp AS
$$ SELECT
     coalesce((SELECT extract(epoch FROM now() - min(created_at))::int FROM lg.outbox_events WHERE published_at IS NULL), 0),
     coalesce((SELECT greatest(0, extract(epoch FROM now() - min(due_at)))::int FROM lg.lead_timers WHERE state = 'pending' AND due_at <= now()), 0) $$;

-- Sweeper recovery (Section 17): work that has no live queue job. Returns IDs and org only.
CREATE OR REPLACE FUNCTION lg.scan_stale_work()
RETURNS TABLE (kind text, id uuid, org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lg, pg_temp AS
$$ SELECT 'delivery_pending', d.id, d.org_id FROM lg.alert_deliveries d
     WHERE d.state = 'pending' AND d.channel <> 'in_app' AND d.updated_at < now() - interval '2 minutes'
   UNION ALL
   SELECT 'delivery_sending', d.id, d.org_id FROM lg.alert_deliveries d
     WHERE d.state = 'sending' AND d.updated_at < now() - interval '2 minutes'
   UNION ALL
   SELECT 'export_queued', e.id, e.org_id FROM lg.exports e
     WHERE e.status IN ('queued','building') AND e.created_at < now() - interval '10 minutes'
   UNION ALL
   SELECT 'export_expired', e.id, e.org_id FROM lg.exports e
     WHERE e.status = 'ready' AND e.expires_at < now()
   UNION ALL
   SELECT 'window_expired', w.id, w.org_id FROM lg.verification_windows w
     WHERE w.result = 'open' AND w.expires_at < now()
   LIMIT 500 $$;

-- Periodic per-organization jobs (billing-reconcile, daily metrics, source health). IDs only.
CREATE OR REPLACE FUNCTION lg.scan_orgs()
RETURNS TABLE (org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lg, pg_temp AS
$$ SELECT id FROM lg.organizations ORDER BY id $$;

CREATE OR REPLACE FUNCTION lg.scan_sources()
RETURNS TABLE (source_id uuid, org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lg, pg_temp AS
$$ SELECT id, org_id FROM lg.sources WHERE status IN ('verified','failing') $$;

-- Outbox publishing (Section 17). Under FORCE RLS, `UPDATE ... SET published_at` by lg_scanner fails with
-- "new row violates row-level security policy": the updated row no longer satisfies the scanner's SELECT
-- policy (published_at IS NULL). 001 is kept unchanged, so marking rows published goes through this narrow
-- definer function instead (IDs in, nothing out). Found by the API/worker integration tests.
CREATE OR REPLACE FUNCTION lg.mark_outbox_published(p_ids uuid[])
RETURNS integer LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = lg, pg_temp AS
$$ WITH u AS (UPDATE lg.outbox_events SET published_at = now() WHERE id = ANY(p_ids) AND published_at IS NULL RETURNING 1)
   SELECT count(*)::int FROM u $$;
GRANT UPDATE (published_at) ON outbox_events TO lg_lookup;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['upsert_support_user(uuid,text,text,text)','support_grant_org(uuid)','user_organizations(uuid)',
    'resolve_delivery_message(text)','health_stats()']
  LOOP
    EXECUTE format('ALTER FUNCTION lg.%s OWNER TO lg_lookup', f);
    EXECUTE format('REVOKE ALL ON FUNCTION lg.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION lg.%s TO lg_app', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['scan_stale_work()','scan_orgs()','scan_sources()','mark_outbox_published(uuid[])']
  LOOP
    EXECUTE format('ALTER FUNCTION lg.%s OWNER TO lg_lookup', f);
    EXECUTE format('REVOKE ALL ON FUNCTION lg.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION lg.%s TO lg_scanner', f);
  END LOOP;
END $$;
GRANT INSERT ON users TO lg_lookup;
GRANT UPDATE (email, name) ON users TO lg_lookup;

RESET ROLE;
