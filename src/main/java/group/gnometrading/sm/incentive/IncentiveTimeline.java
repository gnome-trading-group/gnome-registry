package group.gnometrading.sm.incentive;

import java.util.List;

/**
 * A listing's incentive programs over time, as the registry knew them: each program as its versions in effective
 * order. At a time t a program has the version with the latest start at or before t, and pays when t falls in that
 * version's period, so a later cancellation (a version whose period ends before it starts) stops it from then on.
 * Built once at setup; the lookups never allocate.
 */
public final class IncentiveTimeline {

    public static final IncentiveTimeline EMPTY = new IncentiveTimeline(List.of());

    private final IncentiveProgram[][] programs;

    /** Each element is one program's versions, in effective order. */
    public IncentiveTimeline(final List<IncentiveProgram[]> programs) {
        this.programs = new IncentiveProgram[programs.size()][];
        for (int i = 0; i < this.programs.length; i++) {
            final IncentiveProgram[] versions = programs.get(i).clone();
            if (versions.length == 0) {
                throw new IllegalArgumentException("A program needs at least one version");
            }
            for (int v = 1; v < versions.length; v++) {
                if (versions[v].effectiveFromNanos() < versions[v - 1].effectiveFromNanos()
                        || !versions[v].venueProgramId().equals(versions[0].venueProgramId())) {
                    throw new IllegalArgumentException(
                            "A program's versions must be one program's, in effective order");
                }
            }
            this.programs[i] = versions;
        }
    }

    public int size() {
        return this.programs.length;
    }

    /** The version of program {@code index} in effect at {@code nanos}, or null before its first version. */
    public IncentiveProgram versionAt(final int index, final long nanos) {
        final IncentiveProgram[] versions = this.programs[index];
        IncentiveProgram found = null;
        for (final IncentiveProgram version : versions) {
            if (version.effectiveFromNanos() > nanos) {
                break;
            }
            found = version;
        }
        return found;
    }

    /** Program {@code index} as it pays at {@code nanos}, or null when it isn't paying then. */
    public IncentiveProgram inForce(final int index, final long nanos) {
        final IncentiveProgram version = versionAt(index, nanos);
        return version != null && version.covers(nanos) ? version : null;
    }
}
