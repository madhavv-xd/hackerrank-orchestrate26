You are reading a screenshot of an internal Northstar Shop admin console during a personal-data deletion audit.

Extract every record the screen shows. A record is identified by a printed resource id (tokens such as
`account_123`, `search_45`, `support_6`, `analytics_7`, `export_8`, `backup_9`, `data_flow_10`,
`audit_record_11`, `tombstone_12`, `marketing_13`) or, when no such id is printed, by the handle the screen
uses for it (a stored file name such as `delivery_confirmation_19.pdf`, or a reference key such as `user_17`).

For each record return exactly what is visible on the screen, without inferring anything:
- `reference`: the resource id or handle exactly as printed.
- `email`, `phone`, `name`: direct identifiers shown for that record, or null.
- `user_id`: a stable internal reference (`user_<n>`) shown for that record, or null.
- `status`: the record's visible state in the console's own words (e.g. "Ready", "Active", "Healthy",
  "Continuous sync", "Retained reference", "Valid"), or null.
- `detail`: one short line of other facts printed next to the record (dates, expiry, restore settings), or null.

Rules: copy values verbatim; never guess a value that is not printed; do not decide whether deletion is
complete; include rows from tables, header blocks and side panels. Return JSON matching the schema.
