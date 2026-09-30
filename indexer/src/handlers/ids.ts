// Entity ids and ordering keys shared by the handlers.

export const eventId = (chainId: number, txHash: string, logIndex: number) => `${chainId}-${txHash}-${logIndex}`;

// Strictly increasing across the chain: a block never holds a million logs.
export const seqOf = (blockNumber: number, logIndex: number) => BigInt(blockNumber) * 1_000_000n + BigInt(logIndex);
