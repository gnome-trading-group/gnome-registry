-- One entity or measure spelled two ways on one subject (`phi` and `philadelphia`, `rushing_tds` and
-- `rushing_touchdowns`): the classifier's derivation reads `key` as `canonical_key`. Readings are never rewritten, so a
-- re-read can't undo an alias. A merge's aliases go with it on unmerge (merge_log_id); a reconcile's stay with the
-- subject. Flags are carried onto every relationship that rests on the alias (PARTY_NOMINEE: a party joined to its
-- nominee, which settle apart if the party replaces its candidate).
CREATE TABLE sm.subject_key_alias (
    subject_id     INTEGER     NOT NULL REFERENCES sm.proposition_subject (subject_id) ON DELETE CASCADE,
    kind           TEXT        NOT NULL CHECK (kind IN ('ENTITY', 'MEASURE')),
    key            TEXT        NOT NULL,
    canonical_key  TEXT        NOT NULL,
    flags          TEXT[]      NOT NULL DEFAULT '{}',
    origin         TEXT        NOT NULL CHECK (origin IN ('MERGE', 'RECONCILE', 'MANUAL')),
    merge_log_id   INTEGER     REFERENCES sm.proposition_subject_merge_log (merge_log_id) ON DELETE SET NULL,
    reason         TEXT,
    actor          TEXT        NOT NULL,
    date_created   TIMESTAMPTZ NOT NULL DEFAULT now(),
    date_modified  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (subject_id, kind, key),
    CHECK (key <> canonical_key),
    CHECK (origin <> 'MERGE' OR merge_log_id IS NOT NULL)
);

CREATE INDEX subject_key_alias_merge_log_idx ON sm.subject_key_alias (merge_log_id) WHERE merge_log_id IS NOT NULL;
