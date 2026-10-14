package group.gnometrading;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import group.gnometrading.account.SessionAccounts;
import group.gnometrading.account.VenueAccount;
import group.gnometrading.strings.ViewString;
import java.nio.ByteBuffer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class SessionAccountsTest {

    @Mock
    private RegistryConnection registryConnection;

    private static final String ACCOUNTS = "[{\"account_id\": 4, \"exchange_id\": 2, \"label\": \"sleepy-otter-42\","
            + " \"trading_secret_name\": \"gnome/accounts/sleepy-otter-42/trading\","
            + " \"venue_ref\": {\"funderAddress\": \"0xabc\", \"signatureType\": 3}},"
            + " {\"account_id\": 1, \"exchange_id\": 1, \"label\": \"turbo-walrus-07\","
            + " \"trading_secret_name\": \"gnome/exchange-credentials/kalshi\", \"venue_ref\": {}}]";

    @Test
    void testEachExchangeResolvesToItsBoundAccount() {
        when(registryConnection.get(new ViewString("/api/strategy-sessions/accounts?sessionId=abc")))
                .thenReturn(ByteBuffer.wrap(ACCOUNTS.getBytes()));
        SessionAccounts accounts = SessionAccounts.fetch(registryConnection, "abc");

        assertEquals(
                new VenueAccount(4, 2, "sleepy-otter-42", "gnome/accounts/sleepy-otter-42/trading", "0xabc"),
                accounts.forExchange(2));
        assertNull(accounts.forExchange(1).funderAddress());
        assertEquals(2, accounts.all().size());
    }

    @Test
    void testAnExchangeWithNoBoundAccountCannotTrade() {
        when(registryConnection.get(any())).thenReturn(ByteBuffer.wrap("[]".getBytes()));
        SessionAccounts accounts = SessionAccounts.fetch(registryConnection, "abc");
        assertThrows(IllegalStateException.class, () -> accounts.forExchange(2));
    }
}
