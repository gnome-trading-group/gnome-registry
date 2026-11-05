package group.gnometrading;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import group.gnometrading.account.GatewayAccounts;
import group.gnometrading.account.VenueAccount;
import group.gnometrading.strings.ViewString;
import java.nio.ByteBuffer;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class GatewayAccountsTest {

    @Mock
    private RegistryConnection registryConnection;

    @Test
    void testEveryAccountTheGatewayHoldsIsRead() {
        when(registryConnection.get(new ViewString("/api/venue-accounts/gateway?gatewayKey=live:polymarket_intl:main")))
                .thenReturn(ByteBuffer.wrap(("[{\"account_id\": 4, \"exchange_id\": 2, \"exchange_code\":"
                                + " \"POLYMARKET_INTL\", \"label\": \"sleepy-otter-42\", \"status\": \"ACTIVE\","
                                + " \"trading_secret_name\": \"gnome/accounts/sleepy-otter-42/trading\","
                                + " \"venue_ref\": {\"funderAddress\": \"0xabc\"}},"
                                + " {\"account_id\": 6, \"exchange_id\": 2, \"exchange_code\": \"POLYMARKET_INTL\","
                                + " \"label\": \"quiet-falcon-01\", \"status\": \"DRAINING\","
                                + " \"trading_secret_name\": \"gnome/accounts/quiet-falcon-01/trading\","
                                + " \"venue_ref\": null}]")
                        .getBytes()));

        assertEquals(
                List.of(
                        new VenueAccount(4, 2, "sleepy-otter-42", "gnome/accounts/sleepy-otter-42/trading", "0xabc"),
                        new VenueAccount(6, 2, "quiet-falcon-01", "gnome/accounts/quiet-falcon-01/trading", null)),
                GatewayAccounts.fetch(registryConnection, "live:polymarket_intl:main"));
    }
}
