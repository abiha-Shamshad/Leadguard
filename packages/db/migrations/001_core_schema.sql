-- LeadGuard Release 1 core schema (canonical, executable)
-- Target: PostgreSQL 17 (verified on PostgreSQL 16 in the audit sandbox; no 17-only features used)
-- Run as a superuser or the cloud admin role ONCE per environment, then as lg_owner for migrations.

-- ------------------------------------------------------------------ roles
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lg_owner')   THEN CREATE ROLE lg_owner LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lg_app')     THEN CREATE ROLE lg_app LOGIN NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lg_scanner') THEN CREATE ROLE lg_scanner LOGIN NOBYPASSRLS; END IF;
  -- Owns SECURITY DEFINER lookup functions only. Cannot log in.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lg_lookup')  THEN CREATE ROLE lg_lookup NOLOGIN BYPASSRLS; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS lg AUTHORIZATION lg_owner;
GRANT USAGE ON SCHEMA lg TO lg_app, lg_scanner, lg_lookup;
GRANT CREATE ON SCHEMA lg TO lg_lookup;   -- required so lg_lookup can own the lookup functions
GRANT lg_lookup TO lg_owner;              -- lets lg_owner transfer function ownership

-- Everything below runs as the migration owner, so tables are owned by lg_owner (FORCE RLS applies to it).
SET ROLE lg_owner;
SET search_path = lg;

-- Context helpers: always set with set_config(..., true) so values are transaction-local.
CREATE OR REPLACE FUNCTION lg.current_org() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;

-- ------------------------------------------------------------------ tables
CREATE TABLE organizations (
  id          uuid PRIMARY KEY,
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  time_zone   text NOT NULL,
  country     char(2) NOT NULL DEFAULT 'US',
  version     integer NOT NULL DEFAULT 1,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (                       -- global (not tenant-owned); LeadGuard copy of Clerk identity
  id             uuid PRIMARY KEY,
  clerk_user_id  text NOT NULL UNIQUE,
  email          text NOT NULL,
  name           text,
  kind           text NOT NULL DEFAULT 'customer' CHECK (kind IN ('customer','support_staff')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  org_id     uuid NOT NULL REFERENCES organizations(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  role       text NOT NULL CHECK (role IN ('owner','manager','member')),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deactivated')),
  version    integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE business_hours (
  org_id     uuid NOT NULL REFERENCES organizations(id),
  version    integer NOT NULL,
  days       jsonb NOT NULL,                 -- [{"weekday":"mon","open":"08:00","close":"18:00"}], validated by Zod
  holidays   date[] NOT NULL DEFAULT '{}',
  is_current boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, version)
);
CREATE UNIQUE INDEX ux_business_hours_current ON business_hours (org_id) WHERE is_current;

CREATE TABLE invitations (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id),
  email_norm  text NOT NULL,
  role        text NOT NULL CHECK (role IN ('owner','manager','member')),
  token_hash  bytea NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired','revoked')),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX ux_invitation_pending ON invitations (org_id, email_norm) WHERE status = 'pending';

CREATE TABLE sources (
  id               uuid PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES organizations(id),
  type             text NOT NULL CHECK (type IN ('web_form_webhook','web_form_embed','call_webhook')),
  name             text NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','testing','verified','failing','disabled')),
  source_key       text NOT NULL UNIQUE,         -- public routing key, not a secret
  auth_mode        text NOT NULL CHECK (auth_mode IN ('hmac_v1','secret_header','embed')),
  secret_enc       bytea,                        -- encrypted current secret (null for embed)
  prev_secret_enc  bytea,
  prev_secret_valid_until timestamptz,
  allowed_origins  text[] NOT NULL DEFAULT '{}',
  field_mapping    jsonb NOT NULL DEFAULT '{}',
  provider_key     text,                         -- call adapter id; null for forms
  verified_at      timestamptz,
  last_event_at    timestamptz,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);

CREATE TABLE verification_windows (
  id         uuid PRIMARY KEY,
  org_id     uuid NOT NULL,
  source_id  uuid NOT NULL,
  opened_at  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  result     text NOT NULL DEFAULT 'open' CHECK (result IN ('open','passed','expired')),
  steps      jsonb NOT NULL DEFAULT '[]',
  FOREIGN KEY (org_id, source_id) REFERENCES sources (org_id, id)
);
CREATE UNIQUE INDEX ux_window_open ON verification_windows (source_id) WHERE result = 'open';

-- Canonical business event: one row per (source, dedupe_key)
CREATE TABLE source_events (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL,
  source_id    uuid NOT NULL,
  dedupe_key   text NOT NULL CHECK (length(dedupe_key) <= 200),
  kind         text NOT NULL CHECK (kind IN ('form_submission','call')),
  occurred_at  timestamptz NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('lead_created','lead_linked','activity_logged')),
  lead_id      uuid,
  is_test      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, source_id) REFERENCES sources (org_id, id),
  UNIQUE (source_id, dedupe_key),
  UNIQUE (org_id, id)
);

-- Every HTTP delivery attempt, including duplicates and rejections (repeatable rows)
CREATE TABLE delivery_attempts (
  id               uuid PRIMARY KEY,
  org_id           uuid NOT NULL,
  source_id        uuid NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  result           text NOT NULL CHECK (result IN ('accepted','duplicate','rejected','failed')),
  reason_code      text,
  source_event_id  uuid,
  body_sha256      bytea NOT NULL,
  FOREIGN KEY (org_id, source_id) REFERENCES sources (org_id, id)
);
CREATE INDEX ix_attempts_source ON delivery_attempts (org_id, source_id, received_at DESC);

CREATE TABLE leads (
  id               uuid PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES organizations(id),
  source_id        uuid,
  name             text CHECK (length(name) <= 200),
  email_norm       text CHECK (length(email_norm) <= 254),
  phone_e164       text CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  phone_raw        text CHECK (length(phone_raw) <= 40),
  message          text CHECK (length(message) <= 4000),
  attributes       jsonb NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new','attempted','contacted','qualified','won','lost','spam','merged')),
  close_reason     text,
  merged_into      uuid,
  owner_id         uuid,
  next_action      text CHECK (length(next_action) <= 200),
  due_at           timestamptz,
  policy_version   integer,
  hours_version    integer,
  first_action_at  timestamptz,
  is_test          boolean NOT NULL DEFAULT false,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (email_norm IS NOT NULL OR phone_e164 IS NOT NULL OR phone_raw IS NOT NULL),
  CHECK ((status = 'merged') = (merged_into IS NOT NULL)),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, source_id) REFERENCES sources (org_id, id),
  FOREIGN KEY (org_id, owner_id)  REFERENCES memberships (org_id, user_id),
  FOREIGN KEY (org_id, merged_into) REFERENCES leads (org_id, id)
);
CREATE INDEX ix_leads_inbox ON leads (org_id, status, due_at) WHERE status IN ('new','attempted');
CREATE INDEX ix_leads_owner ON leads (org_id, owner_id, due_at) WHERE status IN ('new','attempted');
CREATE INDEX ix_leads_match_phone ON leads (org_id, phone_e164) WHERE status IN ('new','attempted','contacted','qualified');
CREATE INDEX ix_leads_match_email ON leads (org_id, email_norm) WHERE status IN ('new','attempted','contacted','qualified');

CREATE TABLE lead_activities (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL,
  lead_id      uuid NOT NULL,
  type         text NOT NULL CHECK (type IN ('call','text','email','visit','note','event_received','assigned','status_changed','rescheduled','merged','system')),
  outcome      text CHECK (outcome IN ('reached','no_answer','voicemail','wrong_number','booked','not_interested')),
  evidence     text NOT NULL DEFAULT 'self_reported' CHECK (evidence IN ('self_reported','provider_confirmed','system')),
  note         text CHECK (length(note) <= 2000),
  actor_id     uuid,
  occurred_at  timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, lead_id) REFERENCES leads (org_id, id)
);
CREATE INDEX ix_activities_lead ON lead_activities (org_id, lead_id, occurred_at);

CREATE TABLE follow_up_policies (
  org_id     uuid NOT NULL REFERENCES organizations(id),
  version    integer NOT NULL,
  policy     jsonb NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, version)
);
CREATE UNIQUE INDEX ux_policy_current ON follow_up_policies (org_id) WHERE is_current;

-- Authoritative timers. One row per occurrence; cycle increases on each new occurrence of the same kind.
CREATE TABLE lead_timers (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  lead_id         uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('first_response_due','follow_up_due','escalation','unassigned_escalation')),
  cycle           integer NOT NULL,
  due_at          timestamptz NOT NULL,
  policy_version  integer NOT NULL,
  state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','fired','cancelled')),
  claimed_until   timestamptz,
  cancel_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id, kind, cycle),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, lead_id) REFERENCES leads (org_id, id)
);
CREATE UNIQUE INDEX ux_timer_one_pending ON lead_timers (lead_id, kind) WHERE state IN ('pending','claimed');
CREATE INDEX ix_timers_due ON lead_timers (due_at) WHERE state = 'pending';

-- Logical alert decision: at most one per timer occurrence
CREATE TABLE alerts (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  lead_id         uuid NOT NULL,
  timer_id        uuid NOT NULL UNIQUE,
  kind            text NOT NULL CHECK (kind IN ('reminder','escalation','unassigned')),
  policy_version  integer NOT NULL,
  state           text NOT NULL DEFAULT 'open' CHECK (state IN ('open','cancelled','closed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, lead_id)  REFERENCES leads (org_id, id),
  FOREIGN KEY (org_id, timer_id) REFERENCES lead_timers (org_id, id)
);

-- Per recipient and channel delivery state
CREATE TABLE alert_deliveries (
  id                   uuid PRIMARY KEY,
  org_id               uuid NOT NULL,
  alert_id             uuid NOT NULL,
  recipient_id         uuid NOT NULL,
  channel              text NOT NULL CHECK (channel IN ('in_app','email','sms')),
  state                text NOT NULL DEFAULT 'pending'
                       CHECK (state IN ('pending','sending','accepted','delivered','failed','unknown','cancelled')),
  provider_message_id  text,
  attempts             integer NOT NULL DEFAULT 0,
  last_error_code      text,
  acknowledged_at      timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (alert_id, recipient_id, channel),
  FOREIGN KEY (org_id, alert_id) REFERENCES alerts (org_id, id)
);

CREATE TABLE notification_preferences (
  org_id   uuid NOT NULL,
  user_id  uuid NOT NULL,
  prefs    jsonb NOT NULL,
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id)
);

CREATE TABLE subscriptions (
  org_id                uuid PRIMARY KEY REFERENCES organizations(id),
  state                 text NOT NULL CHECK (state IN ('setup_pending','trialing','pilot_invoice','active','past_due','read_only')),
  plan_id               text NOT NULL,
  trial_ends_at         timestamptz,
  current_period_end    timestamptz,
  cancel_at_period_end  boolean NOT NULL DEFAULT false,
  past_due_since        timestamptz,
  provider              text,
  provider_customer_id  text,
  version               integer NOT NULL DEFAULT 1,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_customer_id)
);

CREATE TABLE billing_events (
  id                 uuid PRIMARY KEY,
  org_id             uuid,
  provider           text NOT NULL,
  provider_event_id  text NOT NULL,
  type               text NOT NULL,
  applied            boolean NOT NULL DEFAULT false,
  received_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE exports (
  id           uuid PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id),
  requested_by uuid NOT NULL,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','building','ready','failed','expired')),
  file_key     text,
  rows         jsonb,
  expires_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_export_running ON exports (org_id) WHERE status IN ('queued','building');

CREATE TABLE support_access_grants (
  id          uuid PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id),
  scope       text NOT NULL CHECK (scope IN ('read_only','read_write')),
  reason      text NOT NULL,
  granted_by  uuid NOT NULL,
  starts_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  CHECK (expires_at <= starts_at + interval '72 hours')
);

-- Daily snapshot written at each org's closing time (pilot metric "overdue at close of business")
CREATE TABLE daily_metrics (
  org_id         uuid NOT NULL REFERENCES organizations(id),
  local_date     date NOT NULL,
  overdue_open   integer NOT NULL,
  unassigned_open integer NOT NULL,
  captured_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, local_date)
);

CREATE TABLE audit_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        uuid NOT NULL,
  actor_type    text NOT NULL CHECK (actor_type IN ('user','support','system','source','provider')),
  actor_id      text,
  action        text NOT NULL,
  record_type   text,
  record_id     uuid,
  changed_fields text[],
  support_grant_id uuid,
  request_id    text,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_events (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  routing_key   text NOT NULL,
  payload       jsonb NOT NULL,          -- IDs and states only
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX ix_outbox_unpublished ON outbox_events (created_at) WHERE published_at IS NULL;

CREATE TABLE idempotency_keys (
  org_id         uuid NOT NULL,
  actor_id       uuid NOT NULL,
  route          text NOT NULL,
  key            text NOT NULL CHECK (length(key) BETWEEN 8 AND 100),
  request_hash   bytea NOT NULL,
  state          text NOT NULL CHECK (state IN ('in_progress','completed')),
  response_code  integer,
  response_body  jsonb,                  -- secrets are never stored here (see API rule R-IDEM-3)
  expires_at     timestamptz NOT NULL,
  PRIMARY KEY (org_id, actor_id, route, key)
);

-- ------------------------------------------------------------------ RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','memberships','business_hours','invitations','sources','verification_windows',
    'source_events','delivery_attempts','leads','lead_activities','follow_up_policies','lead_timers','alerts',
    'alert_deliveries','notification_preferences','subscriptions','exports','support_access_grants','audit_events','daily_metrics',
    'outbox_events','idempotency_keys']
  LOOP
    EXECUTE format('ALTER TABLE lg.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE lg.%I FORCE ROW LEVEL SECURITY', t);
    IF t = 'organizations' THEN
      EXECUTE 'CREATE POLICY org_isolation ON lg.organizations TO lg_app USING (id = lg.current_org()) WITH CHECK (id = lg.current_org())';
    ELSE
      EXECUTE format('CREATE POLICY org_isolation ON lg.%I TO lg_app USING (org_id = lg.current_org()) WITH CHECK (org_id = lg.current_org())', t);
    END IF;
  END LOOP;
END $$;

-- Scanner: may see only pending/claimed timer metadata and unpublished outbox rows across orgs.
CREATE POLICY timer_scan ON lead_timers FOR SELECT TO lg_scanner USING (state IN ('pending','claimed'));
CREATE POLICY timer_claim ON lead_timers FOR UPDATE TO lg_scanner USING (state IN ('pending','claimed')) WITH CHECK (state IN ('pending','claimed'));
CREATE POLICY outbox_scan ON outbox_events FOR SELECT TO lg_scanner USING (published_at IS NULL);
CREATE POLICY outbox_mark ON outbox_events FOR UPDATE TO lg_scanner USING (published_at IS NULL) WITH CHECK (true);

-- ------------------------------------------------------------------ grants
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA lg TO lg_app;
GRANT DELETE ON idempotency_keys TO lg_app;
REVOKE UPDATE ON audit_events, lead_activities, delivery_attempts, source_events FROM lg_app;
-- users is global: rows are visible only for the current user or members of the current org.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY user_visibility ON users FOR SELECT TO lg_app USING (
  id = nullif(current_setting('app.user_id', true), '')::uuid
  OR EXISTS (SELECT 1 FROM lg.memberships m WHERE m.user_id = users.id));
REVOKE INSERT, UPDATE ON users FROM lg_app;
GRANT SELECT (id, org_id, kind, due_at, state, claimed_until) ON lead_timers TO lg_scanner;
GRANT UPDATE (state, claimed_until) ON lead_timers TO lg_scanner;
GRANT SELECT (id, org_id, routing_key, payload, created_at, published_at) ON outbox_events TO lg_scanner;
GRANT UPDATE (published_at) ON outbox_events TO lg_scanner;

-- ------------------------------------------------------------------ bootstrap lookups (before org context exists)
-- Each returns the minimum columns needed to set org context; owned by lg_lookup (BYPASSRLS, NOLOGIN).
CREATE FUNCTION lg.resolve_source(p_source_key text)
RETURNS TABLE (source_id uuid, org_id uuid, type text, status text, auth_mode text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lg, pg_temp AS
$$ SELECT id, org_id, type, status, auth_mode FROM lg.sources WHERE source_key = p_source_key $$;

CREATE FUNCTION lg.user_memberships(p_user_id uuid)
RETURNS TABLE (org_id uuid, role text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lg, pg_temp AS
$$ SELECT org_id, role, status FROM lg.memberships WHERE user_id = p_user_id $$;

CREATE FUNCTION lg.resolve_invitation(p_token_hash bytea)
RETURNS TABLE (invitation_id uuid, org_id uuid, email_norm text, role text, status text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lg, pg_temp AS
$$ SELECT id, org_id, email_norm, role, status, expires_at FROM lg.invitations WHERE token_hash = p_token_hash $$;

CREATE FUNCTION lg.resolve_billing_customer(p_provider text, p_customer_id text)
RETURNS TABLE (org_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lg, pg_temp AS
$$ SELECT org_id FROM lg.subscriptions WHERE provider = p_provider AND provider_customer_id = p_customer_id $$;

CREATE FUNCTION lg.active_support_grant(p_grant_id uuid)
RETURNS TABLE (org_id uuid, scope text, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = lg, pg_temp AS
$$ SELECT org_id, scope, expires_at FROM lg.support_access_grants
   WHERE id = p_grant_id AND revoked_at IS NULL AND now() BETWEEN starts_at AND expires_at $$;

CREATE FUNCTION lg.upsert_user(p_id uuid, p_clerk_user_id text, p_email text, p_name text)
RETURNS uuid LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = lg, pg_temp AS
$$ INSERT INTO lg.users (id, clerk_user_id, email, name) VALUES (p_id, p_clerk_user_id, lower(p_email), p_name)
   ON CONFLICT (clerk_user_id) DO UPDATE SET email = excluded.email, name = excluded.name
   RETURNING id $$;

-- Organization creation happens before any membership exists (setup bootstrap).
CREATE FUNCTION lg.bootstrap_organization(p_org_id uuid, p_name text, p_tz text, p_country text, p_user_id uuid)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = lg, pg_temp AS
$$
BEGIN
  IF (SELECT count(*) FROM lg.memberships WHERE user_id = p_user_id AND role = 'owner') >= 3 THEN
    RAISE EXCEPTION 'ORG_LIMIT_REACHED' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO lg.organizations (id, name, time_zone, country, created_by) VALUES (p_org_id, p_name, p_tz, p_country, p_user_id);
  INSERT INTO lg.memberships (org_id, user_id, role) VALUES (p_org_id, p_user_id, 'owner');
  INSERT INTO lg.subscriptions (org_id, state, plan_id) VALUES (p_org_id, 'setup_pending', 'team');
  RETURN p_org_id;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['upsert_user(uuid,text,text,text)','resolve_source(text)','user_memberships(uuid)','resolve_invitation(bytea)',
    'resolve_billing_customer(text,text)','active_support_grant(uuid)','bootstrap_organization(uuid,text,text,text,uuid)']
  LOOP
    EXECUTE format('ALTER FUNCTION lg.%s OWNER TO lg_lookup', f);
    EXECUTE format('REVOKE ALL ON FUNCTION lg.%s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION lg.%s TO lg_app', f);
  END LOOP;
END $$;
GRANT SELECT ON ALL TABLES IN SCHEMA lg TO lg_lookup;
GRANT INSERT ON organizations, memberships, subscriptions, users TO lg_lookup;
GRANT UPDATE (email, name) ON users TO lg_lookup;
