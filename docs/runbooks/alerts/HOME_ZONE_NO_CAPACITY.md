---
type: HOME_ZONE_NO_CAPACITY
summary: An order gateway or a production market-data shard hasn't been placed in its exchange's home availability zone 5 minutes after it was started, because no host of any of its instance types could be launched there.
first_steps:
  - Read the alert key (`HOME_ZONE_NO_CAPACITY:<live|paper>:<exchange>:<instance>` for a gateway, `HOME_ZONE_NO_CAPACITY:<shard id>` for a shard) and the labels `region`, `zoneId` and `capacityProvider`.
  - Check the zone's Auto Scaling group activity (EC2 console, the group named for the zone) for `InsufficientInstanceCapacity`.
  - If the zone stays short, move the venue: controller, Exchanges, set its home zone to the region's other zone.
---

## What it means

Each exchange can have a home zone (`sm.exchange.home_zone_id`, a zone ID such as `use2-az2`): the zone measured nearest the venue. Its order gateways (live and paper) start only there, on that zone's host group (`order-gateway-hosts-<zoneId>`, `order-gateway-paper-hosts-<zoneId>`), and so do the production shards carrying its streams (`collection-ondemand-<region>-<zoneId>`). Each group tries several instance types in order (live gateways c7a.large, c7i.large, m7a.large, m7i.large; paper c7a.medium, m7a.medium, c7i.large; shards r7a.medium, m7a.large, m7i.large). This alert means none of them could be launched in that zone for 5 minutes. There is no automatic move to another zone: the start keeps trying in the home zone.

Research shards (Spot) have no zone and never raise this.

## Impact

- A live gateway: sessions that trade the venue can't link, so no new orders reach it; the session launch that wanted it waits or fails. A gateway that is already running is not affected (its host exists): this only happens on a start.
- A paper gateway: paper sessions on the venue can't link (WARNING too, as one open alert while it lasts; paper alerts never page).
- A production shard: the streams it would carry stay on the shards they are on (a move to the new shard waits) or stay unplaced (`LEASED_STREAM_UNPLACED`), so a live session may miss market data.

## Diagnose

- The group's scaling activities: an `InsufficientInstanceCapacity` message names the type and zone. A message about the placement group means the zone lacks hardware with the Nitro clock for those types.
- The ECS service's events (`order-gateways` cluster for gateways, `CollectionCluster-<region>` for shards): "unable to place a task" with no host.
- Whether the region's other zone has capacity (launch a test instance of the same type there, or check its group).
- [AWS Health Dashboard](https://health.aws.amazon.com/health/status) for an event in the region or zone.

## Resolve

- Short shortage: usually nothing; the start succeeds when capacity returns (often minutes).
- Lasting shortage or a zone event: move the venue. Controller, Exchanges, set the home zone to the other zone of the region (or `PATCH /exchanges?exchangeId=<id>` with `{"homeZoneId": "<zone ID>"}`). Then:
  - starting gateways start there; a paper gateway, or a live gateway with no working orders and no linked sessions, restarts there at once; a live gateway with working orders keeps running where it is and moves at its next fresh start (never with orders);
  - production shards move to the new zone make-before-break, so readers see no gap;
  - new sessions follow the gateway.
- Move it back the same way once the home zone is healthy: the measured home zone is the faster one for the venue.

## Escalate

Not by itself (WARNING). If a live gateway can't start in either zone, it is `GATEWAY_START_STUCK` (ERROR) that matters: follow that runbook.

## Related

[GATEWAY_START_STUCK](GATEWAY_START_STUCK.md), [LEASED_STREAM_UNPLACED](LEASED_STREAM_UNPLACED.md), [COLLECTOR_SHARD_DOWN](COLLECTOR_SHARD_DOWN.md)
