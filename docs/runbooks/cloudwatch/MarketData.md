---
type: MarketData
summary: A market-data pipeline Lambda failed.
first_steps:
  - Open the alarm to see which function.
  - Read its CloudWatch logs.
  - Check Market Data → Gaps / Transform Jobs in the controller.
---

## What it means

Alarms named `MarketData-…`: a fault in the Merger, Transformer job creator or processor, Gap Detector, Inventory Processor or Quality Check Lambda.

## Impact

Historical datasets fall behind or have gaps; live trading is unaffected.

## Diagnose

The function's logs; its queue's age and DLQ on /system → Queues.

## Resolve

Fix and redrive the failed messages from the DLQ.

## Escalate

No.

## Related

[Controller](Controller.md)
