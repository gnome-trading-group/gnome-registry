package group.gnometrading.sm;

public record EventContract(int eventContractId, int eventId, int securityId, String outcomeLabel) {}
