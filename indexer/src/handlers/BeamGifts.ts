import { indexer } from "envio";

// Entity ids and ordering: seq is strictly increasing across the chain (a block never holds a million logs).
const eventId = (chainId: number, txHash: string, logIndex: number) => `${chainId}-${txHash}-${logIndex}`;
const seqOf = (blockNumber: number, logIndex: number) => BigInt(blockNumber) * 1_000_000n + BigInt(logIndex);

indexer.onEvent({ contract: "BeamGifts", event: "GiftSent" }, async ({ event, context }) => {
  const p = event.params;
  context.Gift.set({
    id: eventId(event.chainId, event.transaction.hash, event.logIndex),
    seq: seqOf(event.block.number, event.logIndex),
    kind: "Direct",
    from: p.from,
    channel: p.to,
    to: p.to,
    amount: BigInt(p.amount),
    displayName: p.displayName,
    message: p.message,
    actionCode: Number(p.actionCode),
    dropId: undefined,
    recipientLabel: undefined,
    slots: undefined,
    expiry: undefined,
    ts: BigInt(p.ts),
    blockNumber: event.block.number,
    logIndex: event.logIndex,
    txHash: event.transaction.hash,
  });
});

// BeamGifts.giftWithSplit emits GiftSent immediately followed by GiftSplit, so the gift this
// split belongs to is the log just before it in the same transaction.
indexer.onEvent({ contract: "BeamGifts", event: "GiftSplit" }, async ({ event, context }) => {
  const p = event.params;
  const giftId = eventId(event.chainId, event.transaction.hash, event.logIndex - 1);
  const gift = await context.Gift.getOrThrow(giftId, `GiftSplit without preceding GiftSent: ${giftId}`);
  context.Gift.set({ ...gift, kind: "Split" });

  p.recipients.forEach((recipient, i) => {
    context.SplitPayout.set({
      id: `${giftId}-${i}`,
      giftId,
      from: p.from,
      recipient,
      amount: BigInt(p.amounts[i]),
      position: i,
      ts: BigInt(p.ts),
      txHash: event.transaction.hash,
    });
  });
});
