package group.gnometrading.md;

import group.gnometrading.SecurityMaster;
import group.gnometrading.collections.IntHashMap;
import group.gnometrading.collections.IntMap;
import group.gnometrading.collections.IntToIntHashMap;
import group.gnometrading.collections.LongHashMap;
import group.gnometrading.collections.LongMap;
import group.gnometrading.sm.Listing;

/**
 * The streams one session or backtest reads, and the listings they carry. Market data names only its stream; orders
 * and execution reports name a listing by exchange and security. This resolves between them, built once from the
 * registry before trading starts so lookups on the hot path allocate nothing.
 */
public final class StreamDirectory {

    /** Returned when a stream carries no listing, or a listing has no stream here. */
    public static final int NONE = IntToIntHashMap.MISSING;

    private final IntToIntHashMap listingByStream = new IntToIntHashMap();
    private final IntToIntHashMap streamByListing = new IntToIntHashMap();
    private final IntMap<Stream> streams = new IntHashMap<>();
    private final IntMap<Listing> listings = new IntHashMap<>();
    private final LongMap<Listing> listingByExchangeSecurity = new LongHashMap<>();

    /** The directory of these listings' book streams plus these data-only streams. */
    public static StreamDirectory of(
            final SecurityMaster securityMaster, final int[] listingIds, final int[] dataStreamIds) {
        final StreamDirectory directory = new StreamDirectory();
        for (final int listingId : listingIds) {
            final Listing listing = securityMaster.getListing(listingId);
            if (listing == null) {
                throw new IllegalArgumentException("Unknown listing " + listingId);
            }
            final Stream stream = securityMaster.streamForListing(listingId);
            if (stream == null) {
                throw new IllegalArgumentException("Listing " + listingId + " has no book stream");
            }
            directory.add(stream, listing);
        }
        for (final int streamId : dataStreamIds) {
            final Stream stream = securityMaster.getStream(streamId);
            if (stream == null) {
                throw new IllegalArgumentException("Unknown stream " + streamId);
            }
            directory.add(stream, stream.listingId() == 0 ? null : securityMaster.getListing(stream.listingId()));
        }
        return directory;
    }

    /** Adds a stream, and the listing it carries if any. */
    public void add(final Stream stream, final Listing listing) {
        this.streams.put(stream.streamId(), stream);
        if (listing != null) {
            this.listingByStream.put(stream.streamId(), listing.listingId());
            this.streamByListing.put(listing.listingId(), stream.streamId());
            this.listings.put(listing.listingId(), listing);
            this.listingByExchangeSecurity.put(
                    key(listing.exchange().exchangeId(), listing.security().securityId()), listing);
        }
    }

    /** The listing a stream carries, or {@link #NONE}. */
    public int listingId(final int streamId) {
        return this.listingByStream.get(streamId);
    }

    /** The listing an order or execution report names, or {@link #NONE} if it isn't one of these listings. */
    public int listingId(final int exchangeId, final int securityId) {
        final Listing listing = this.listingByExchangeSecurity.get(key(exchangeId, securityId));
        return listing == null ? NONE : listing.listingId();
    }

    /** A listing's book stream, or {@link #NONE}. */
    public int streamId(final int listingId) {
        return this.streamByListing.get(listingId);
    }

    /** The stream, or null if it isn't one of these. */
    public Stream stream(final int streamId) {
        return this.streams.get(streamId);
    }

    /** The listing, or null if it isn't one of these. */
    public Listing listing(final int listingId) {
        return this.listings.get(listingId);
    }

    private static long key(final int exchangeId, final int securityId) {
        return ((long) exchangeId << Integer.SIZE) | Integer.toUnsignedLong(securityId);
    }
}
