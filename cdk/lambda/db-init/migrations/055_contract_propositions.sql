-- What each prediction-market security asks, as the classifier extracts it, and the subjects those questions are
-- about. Relationships (EQUIVALENT, IMPLIES) are derived by comparing propositions that share a subject.

-- The thing a proposition measures or the contest it is about ("btc-usd", "us-senate-2026-control"). A duplicate is
-- merged into another subject through sm.proposition_subject_alias rather than deleted. A subject is due a fresh
-- derivation while date_modified is after derived_at: a proposition joined or left it, or it took part in a merge.
CREATE TABLE sm.proposition_subject (
    subject_id     serial    PRIMARY KEY,
    key            varchar   NOT NULL UNIQUE,
    description    text      NOT NULL DEFAULT '',
    embedding      vector(1024),
    derived_at     timestamp,
    date_created   timestamp NOT NULL DEFAULT now(),
    date_modified  timestamp NOT NULL DEFAULT now()
);

CREATE INDEX proposition_subject_embedding_hnsw_idx
    ON sm.proposition_subject USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- A merge: alias_subject_id is the same subject as canonical_subject_id. Aliases can chain (a subject merged into one
-- that is later merged elsewhere); a proposition's subject_id is always the end of its extracted subject's chain.
CREATE TABLE sm.proposition_subject_alias (
    alias_subject_id      integer   PRIMARY KEY REFERENCES sm.proposition_subject(subject_id) ON DELETE CASCADE,
    canonical_subject_id  integer   NOT NULL REFERENCES sm.proposition_subject(subject_id) ON DELETE CASCADE,
    actor                 varchar   NOT NULL,
    date_created          timestamp NOT NULL DEFAULT now(),
    CHECK (alias_subject_id <> canonical_subject_id)
);

CREATE INDEX idx_proposition_subject_alias_canonical ON sm.proposition_subject_alias (canonical_subject_id);

-- The venue's own description of a security as the classifier last fetched it: the resolution-relevant fields of the
-- market and its event (rules text, strikes, resolution sources, close and expiration times), as the venue named them.
-- Propositions are extracted from it, and test cases are rebuilt from it, so nothing the venue said is lost.
CREATE TABLE sm.contract_source (
    security_id    integer   PRIMARY KEY REFERENCES sm.security(security_id) ON DELETE CASCADE,
    exchange_id    integer   NOT NULL REFERENCES sm.exchange(exchange_id),
    source         jsonb     NOT NULL,
    source_hash    varchar   NOT NULL,
    date_created   timestamp NOT NULL DEFAULT now(),
    date_modified  timestamp NOT NULL DEFAULT now()
);

-- One proposition per security. extracted_subject_id is what extraction chose; subject_id is that subject after
-- merges, so an unmerge can put the proposition back. fields holds the classifier's typed record (kind, comparator,
-- thresholds, window, entity, scope, resolution source, unknowns); the registry only stores it.
CREATE TABLE sm.contract_proposition (
    security_id           integer   PRIMARY KEY REFERENCES sm.security(security_id) ON DELETE CASCADE,
    subject_id            integer   NOT NULL REFERENCES sm.proposition_subject(subject_id),
    extracted_subject_id  integer   NOT NULL REFERENCES sm.proposition_subject(subject_id),
    fields                jsonb     NOT NULL,
    method                varchar   NOT NULL CHECK (method IN ('VENUE', 'LLM')),
    extractor_version     varchar   NOT NULL,
    source_hash           varchar   NOT NULL,
    date_created          timestamp NOT NULL DEFAULT now(),
    date_modified         timestamp NOT NULL DEFAULT now()
);

CREATE INDEX idx_contract_proposition_subject ON sm.contract_proposition (subject_id);
CREATE INDEX idx_contract_proposition_extracted_subject ON sm.contract_proposition (extracted_subject_id);

-- A relationship either follows from two propositions or is not written, so it carries the rule and fields that
-- produced it and its caveats (flags such as RESOLUTION_SOURCE_DIFFERS) instead of a confidence.
ALTER TABLE sm.contract_relationship DROP COLUMN confidence;
ALTER TABLE sm.contract_relationship ADD COLUMN flags text[] NOT NULL DEFAULT '{}';
ALTER TABLE sm.contract_relationship ADD COLUMN evidence jsonb;
ALTER TABLE sm.contract_relationship ADD COLUMN derivation_version varchar;

-- The pair-wise LLM judge and the hedge-keyword rule are gone: their rows go, and only the derived types remain.
-- Manual rows are a person's and stay (all manual rows to date are EQUIVALENT).
DELETE FROM sm.contract_relationship WHERE method <> 'manual';
DELETE FROM sm.contract_relationship WHERE relationship_type NOT IN ('EQUIVALENT', 'IMPLIES');
ALTER TABLE sm.contract_relationship
    ADD CONSTRAINT contract_relationship_type_check CHECK (relationship_type IN ('EQUIVALENT', 'IMPLIES'));
DROP TABLE sm.hedge_keyword;
