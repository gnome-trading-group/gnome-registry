-- A PRICE hold now records the crossed book (one security's bid above the other's ask) instead of two mids, which
-- held every thin market against its neighbours. Holds recorded with mids lose their prices: there is no bid or ask to
-- rebuild them from, and the controller only shows the new shape.
UPDATE sm.proposition_subject_merge_candidate
SET details = details - 'prices', date_modified = now()
WHERE details->'prices'->0 ? 'mid_a';
