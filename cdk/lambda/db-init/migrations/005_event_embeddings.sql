CREATE TABLE IF NOT EXISTS sm.event_embedding (
    event_id INTEGER PRIMARY KEY REFERENCES sm.event(event_id) ON DELETE CASCADE,
    embedding vector(1024) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_embedding_hnsw_idx
    ON sm.event_embedding USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
