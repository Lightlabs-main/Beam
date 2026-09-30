import { indexer } from "envio";

// Entity ids and ordering: seq is strictly increasing across the chain (a block never holds a million logs).
const eventId = (chainId: number, txHash: string, logIndex: number) => `${chainId}-${txHash}-${logIndex}`;
const seqOf = (blockNumber: number, logIndex: number) => BigInt(blockNumber) * 1_000_000n + BigInt(logIndex);

indexer.onEvent({ contract: "BeamClaims", event: "ChatterGiftSent" }, async ({ event, context }) => {
  const p = event.params;
  const giftId = eventId(event.chainId, event.transaction.hash, event.logIndex);
  context.Gift.set({
    id: giftId,
    seq: seqOf(event.block.number, event.logIndex),
    kind: "Chatter",
    from: p.from,
    to: undefined,
    amount: BigInt(p.amount),
    displayName: p.displayName,
    message: p.message,
    actionCode: Number(p.actionCode),
    dropId: p.dropId,
    recipientLabel: p.recipientLabel,
    slots: 1,
    expiry: BigInt(p.expiry),
    ts: BigInt(p.ts),
    blockNumber: event.block.number,
    logIndex: event.logIndex,
    txHash: event.transaction.hash,
  });
  context.Drop.set({
    id: p.dropId,
    kind: "Chatter",
    sender: p.from,
    amount: BigInt(p.amount),
    slots: 1,
    claimed: 0,
    claimedAmount: 0n,
    refunded: 0n,
    closed: false,
    expiry: BigInt(p.expiry),
    giftId,
  });
});

indexer.onEvent({ contract: "BeamClaims", event: "BombSent" }, async ({ event, context }) => {
  const p = event.params;
  const giftId = eventId(event.chainId, event.transaction.hash, event.logIndex);
  context.Gift.set({
    id: giftId,
    seq: seqOf(event.block.number, event.logIndex),
    kind: "Bomb",
    from: p.from,
    to: undefined,
    amount: BigInt(p.pool),
    displayName: p.displayName,
    message: p.message,
    actionCode: Number(p.actionCode),
    dropId: p.bombId,
    recipientLabel: undefined,
    slots: Number(p.slots),
    expiry: BigInt(p.expiry),
    ts: BigInt(p.ts),
    blockNumber: event.block.number,
    logIndex: event.logIndex,
    txHash: event.transaction.hash,
  });
  context.Drop.set({
    id: p.bombId,
    kind: "Bomb",
    sender: p.from,
    amount: BigInt(p.pool),
    slots: Number(p.slots),
    claimed: 0,
    claimedAmount: 0n,
    refunded: 0n,
    closed: false,
    expiry: BigInt(p.expiry),
    giftId,
  });
});

indexer.onEvent({ contract: "BeamClaims", event: "Claimed" }, async ({ event, context }) => {
  const p = event.params;
  const drop = await context.Drop.getOrThrow(p.dropId, `Claimed for unknown drop ${p.dropId}`);
  const claimed = drop.claimed + 1;
  context.Drop.set({
    ...drop,
    claimed,
    claimedAmount: drop.claimedAmount + BigInt(p.amount),
    closed: drop.closed || claimed === drop.slots,
  });
  context.Claim.set({
    id: eventId(event.chainId, event.transaction.hash, event.logIndex),
    seq: seqOf(event.block.number, event.logIndex),
    dropId: p.dropId,
    slot: Number(p.slot),
    recipient: p.recipient,
    amount: BigInt(p.amount),
    ts: BigInt(p.ts),
    txHash: event.transaction.hash,
  });
});

indexer.onEvent({ contract: "BeamClaims", event: "Reclaimed" }, async ({ event, context }) => {
  const p = event.params;
  const drop = await context.Drop.getOrThrow(p.dropId, `Reclaimed for unknown drop ${p.dropId}`);
  context.Drop.set({ ...drop, refunded: drop.refunded + BigInt(p.amount), closed: true });
  context.Reclaim.set({
    id: eventId(event.chainId, event.transaction.hash, event.logIndex),
    dropId: p.dropId,
    sender: p.sender,
    amount: BigInt(p.amount),
    expired: p.expired,
    ts: BigInt(p.ts),
    txHash: event.transaction.hash,
  });
});
