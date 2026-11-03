-- 059 added an HNSW index on sm.proposition_subject.embedding that 055 had already created
-- (proposition_subject_embedding_hnsw_idx); two identical indexes only double the writes and the storage.
DROP INDEX IF EXISTS sm.idx_proposition_subject_embedding_hnsw;
