-- Event embeddings were only read by the classifier's old relationship judge; relationships now come from
-- propositions, whose subjects carry their own embeddings (sm.proposition_subject).
DROP TABLE sm.event_embedding;
