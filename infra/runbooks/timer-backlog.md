# Runbook: timer backlog

**Signal:** `oldest_pending_timer_seconds` > 300 (API-001 body), `timer_fire_delay_p95` > 60 s.

1. `GET /internal/v1/health`: `postgres` must be `ok`. `redis: unavailable` alone does not stop timers - the sweeper claims due timers every 30 s straight from PostgreSQL.
2. Check worker containers are running and logging `sweep`. Restarting a worker is safe: claims expire after 2 minutes and are re-claimed; alerts are unique per timer occurrence (no duplicates).
3. Large backlog: add a worker container (scale trigger: fire delay p95 > 60 s). Claims use `FOR UPDATE SKIP LOCKED`, so workers never fire the same timer.
4. Timers never fire at all: verify the scanner policy and column grants exist (DB-09) - run `pnpm test:db` against a restored copy.
