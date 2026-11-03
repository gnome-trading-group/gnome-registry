-- Nearest-subject lookups (the classifier's extraction candidates and merge pass, the controller's similar subjects)
-- order by cosine distance to one subject's embedding; without an index each one scans every subject.
CREATE INDEX idx_proposition_subject_embedding_hnsw
    ON sm.proposition_subject USING hnsw (embedding vector_cosine_ops);
