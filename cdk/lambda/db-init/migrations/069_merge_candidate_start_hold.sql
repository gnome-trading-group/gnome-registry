-- A merge of two game subjects whose contracts start hours apart is held for a person (START): one pair of teams can
-- play twice in a day, and derivation only tells the two matches apart when one venue lists both.
ALTER TABLE sm.proposition_subject_merge_candidate DROP CONSTRAINT proposition_subject_merge_candidate_hold_check;
ALTER TABLE sm.proposition_subject_merge_candidate
    ADD CONSTRAINT proposition_subject_merge_candidate_hold_check CHECK (hold IN ('PRICE', 'COLLISION', 'START'));
