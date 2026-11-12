package group.gnometrading.sm.incentive;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import group.gnometrading.schemas.Statics;
import group.gnometrading.sm.fee.FeeTimelineJson;
import java.io.IOException;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.List;

/** Reads the registry's listing programs ({@code GET /incentive-programs?listingIds=}) into {@link IncentiveTimeline}s. */
public final class IncentiveTimelineJson {

    private static final ObjectMapper MAPPER =
            new ObjectMapper().configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
    private static final BigDecimal PRICE_SCALE = BigDecimal.valueOf(Statics.PRICE_SCALING_FACTOR);

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record ListingPrograms(int listingId, List<Program> programs) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record Program(String venueProgramId, List<Version> versions) {}

    @JsonIgnoreProperties(ignoreUnknown = true)
    private record Version(
            String venueProgramId,
            String program,
            String venueMarket,
            String periodStart,
            String periodEnd,
            String reward,
            String rewardPer,
            JsonNode definition,
            Boolean paidOut,
            String effectiveFrom) {}

    private IncentiveTimelineJson() {}

    /** The programs of {@code listingId} in a response, or none if the response doesn't name it. */
    public static IncentiveTimeline parse(final byte[] json, final int listingId) throws IOException {
        for (final ListingPrograms listing : MAPPER.readValue(json, ListingPrograms[].class)) {
            if (listing.listingId() == listingId) {
                final List<IncentiveProgram[]> programs =
                        new ArrayList<>(listing.programs().size());
                for (final Program program : listing.programs()) {
                    programs.add(program.versions().stream()
                            .map(IncentiveTimelineJson::toProgram)
                            .toArray(IncentiveProgram[]::new));
                }
                return new IncentiveTimeline(programs);
            }
        }
        return IncentiveTimeline.EMPTY;
    }

    private static IncentiveProgram toProgram(final Version version) {
        return new IncentiveProgram(
                version.venueProgramId(),
                IncentiveProgram.IncentiveKind.valueOf(version.program()),
                version.venueMarket(),
                FeeTimelineJson.epochNanos(version.periodStart()),
                version.periodEnd() == null
                        ? IncentiveProgram.OPEN_ENDED
                        : FeeTimelineJson.epochNanos(version.periodEnd()),
                new BigDecimal(version.reward())
                        .multiply(PRICE_SCALE)
                        .setScale(0, RoundingMode.DOWN)
                        .longValueExact(),
                IncentiveProgram.RewardPer.valueOf(version.rewardPer()),
                version.definition(),
                version.paidOut(),
                FeeTimelineJson.epochNanos(version.effectiveFrom()));
    }
}
