# Runbook: source failing

**Signal:** dashboard exception `source_failing`, metric `ingest_attempts_total{result="rejected"}` > 20 % for a source over 1 hour, or `sources_failing_total` rising.

1. Open the source's delivery log (API-016, Sources screen). Read the `reason` codes - no payloads are stored.
   - `SIGNATURE_INVALID` / `SECRET_INVALID`: the form tool uses an old or mistyped secret. Rotate (API-017) and re-enter it; the old secret keeps working for 24 h.
   - `TIMESTAMP_OUT_OF_WINDOW`: the sender's clock is off by more than 300 s.
   - `CONTACT_REQUIRED` / `VALIDATION_FAILED`: field mapping changed in the form tool. Update `field_mapping`.
   - No attempts at all (silence alert): the form tool stopped sending. Check the tool's webhook settings.
2. Send a test enquiry through the real form. A single accepted event returns the source to `verified`.
3. Never mark a source Connected by hand. Only a valid event does that.
