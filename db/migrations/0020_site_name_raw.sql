-- Manual site fallback (S-03): an entry may name an object that is not in the
-- sites dictionary. The entry is never blocked; the server tries to match the
-- normalized raw name on sync and leaves not_found for manual resolution.
ALTER TABLE journal_entries
    ADD COLUMN site_name_raw varchar(120),
    ADD COLUMN site_binding_status binding_status_enum NOT NULL DEFAULT 'not_required';

UPDATE journal_entries
   SET site_binding_status = 'linked'
 WHERE site_id IS NOT NULL;

ALTER TABLE journal_entries
    ADD CONSTRAINT journal_entries_site_linked_check
        CHECK (site_binding_status <> 'linked' OR site_id IS NOT NULL),
    ADD CONSTRAINT journal_entries_site_raw_length_check
        CHECK (site_name_raw IS NULL OR char_length(btrim(site_name_raw)) BETWEEN 2 AND 120);

CREATE INDEX journal_entries_site_raw_idx
    ON journal_entries (site_binding_status, site_name_raw)
    WHERE site_name_raw IS NOT NULL;

-- "Ignore" is a manual admin decision for an unresolved raw name; it does not
-- create or delete a Site and can be reversed in a later iteration.
CREATE TABLE site_raw_ignores (
    normalized_name text PRIMARY KEY,
    display_name varchar(120) NOT NULL,
    ignored_by uuid NOT NULL REFERENCES users (id),
    ignored_at timestamptz NOT NULL DEFAULT now()
);
