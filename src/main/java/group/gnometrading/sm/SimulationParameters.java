package group.gnometrading.sm;

/**
 * How an exchange behaves in simulation, as recorded in the registry: {@code definition} is its JSON (network, order
 * and market data latency, queue model, self-trade prevention), which gnome-simulation reads into its own config.
 * {@code recordedAt} is when this version was recorded; a run pins a time and reads the version in force then.
 */
public record SimulationParameters(long simulationParametersId, int exchangeId, String recordedAt, String definition) {}
