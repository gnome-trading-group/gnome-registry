-- Subject pairs the classifier's merge pass judged the same but would not merge on its own: merged, two venues'
-- prices for a new equivalence disagree, or two outcomes of one event would read alike. A person merges or dismisses
-- each from the controller; a decided pair is never queued again.
CREATE TABLE sm.proposition_subject_merge_candidate (
    candidate_id          serial    PRIMARY KEY,
    alias_subject_id      integer   NOT NULL REFERENCES sm.proposition_subject(subject_id) ON DELETE CASCADE,
    canonical_subject_id  integer   NOT NULL REFERENCES sm.proposition_subject(subject_id) ON DELETE CASCADE,
    hold                  varchar   NOT NULL CHECK (hold IN ('PRICE', 'COLLISION')),
    reason                text      NOT NULL,
    -- Cross-venue relationships the merge would add.
    gain                  integer   NOT NULL,
    -- What held it: the disagreeing prices or the colliding outcomes, and the judge's entity and measure maps.
    details               jsonb     NOT NULL DEFAULT '{}',
    status                varchar   NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'MERGED', 'DISMISSED')),
    decided_by            varchar,
    decided_at            timestamp,
    date_created          timestamp NOT NULL DEFAULT now(),
    date_modified         timestamp NOT NULL DEFAULT now(),
    CHECK (alias_subject_id <> canonical_subject_id)
);

-- One row per pair whichever way round the classifier names it.
CREATE UNIQUE INDEX idx_proposition_subject_merge_candidate_pair
    ON sm.proposition_subject_merge_candidate (LEAST(alias_subject_id, canonical_subject_id),
                                               GREATEST(alias_subject_id, canonical_subject_id));
CREATE INDEX idx_proposition_subject_merge_candidate_status ON sm.proposition_subject_merge_candidate (status);
