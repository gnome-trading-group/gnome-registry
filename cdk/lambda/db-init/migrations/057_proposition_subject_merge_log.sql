-- Every merge and unmerge of proposition subjects, in order. sm.proposition_subject_alias holds only the merges in
-- effect (an unmerge deletes its row), so this is the only record of who merged what and later undid it.
CREATE TABLE sm.proposition_subject_merge_log (
    merge_log_id          serial    PRIMARY KEY,
    alias_subject_id      integer   NOT NULL REFERENCES sm.proposition_subject(subject_id) ON DELETE CASCADE,
    canonical_subject_id  integer   NOT NULL REFERENCES sm.proposition_subject(subject_id) ON DELETE CASCADE,
    action                varchar   NOT NULL CHECK (action IN ('MERGE', 'UNMERGE')),
    actor                 varchar   NOT NULL,
    propositions_moved    integer   NOT NULL,
    date_created          timestamp NOT NULL DEFAULT now()
);

CREATE INDEX idx_proposition_subject_merge_log_alias ON sm.proposition_subject_merge_log (alias_subject_id);
CREATE INDEX idx_proposition_subject_merge_log_canonical ON sm.proposition_subject_merge_log (canonical_subject_id);

-- Merges made before the log existed; how many propositions they moved was not kept.
INSERT INTO sm.proposition_subject_merge_log
    (alias_subject_id, canonical_subject_id, action, actor, propositions_moved, date_created)
SELECT alias_subject_id, canonical_subject_id, 'MERGE', actor, 0, date_created
FROM sm.proposition_subject_alias;
