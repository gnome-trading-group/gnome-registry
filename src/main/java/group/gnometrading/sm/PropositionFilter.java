package group.gnometrading.sm;

import java.util.List;

/**
 * Contracts by what they ask, from their proposition's fields; empty lists and {@code null} mean no filter. A contract
 * not yet read, or whose field the extractor left unknown, matches no filter on that field.
 *
 * @param kinds of any of these kinds ({@code WINNER}, {@code SCORE}, {@code THRESHOLD}, ...)
 * @param scopes at any of these scopes ({@code match}, {@code map:1}, {@code regulation}, ...)
 */
public record PropositionFilter(List<String> kinds, List<String> scopes) {}
