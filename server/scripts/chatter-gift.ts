// Gift-a-chatter end to end on the live chain: the viewer signs a one-slot drop for a chatter
// on a creator's channel, the relayer creates it, then a brand-new account with no MON claims it
// through the relayer. Testnet wallets only (VIEWER_*, RELAYER_*, CREATOR_ADDRESS from ../../.env).
//
//   pnpm --filter @beam/server exec tsx scripts/chatter-gift.ts
import { readFileSync } from "node:fs";
import { beamClaimsAbi, deployment, parseNetwork, parseUsdc, receiveWithAuthorizationTypes, usdcDomain } from "@beam/shared";
import { type Address, type Hex, createPublicClient, createWalletClient, hexToSignature, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const env = Object.fromEntries(
  readFileSync(new URL("../../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const d = deployment(parseNetwork(process.env.BEAM_NETWORK ?? "testnet"));
const pub = createPublicClient({ chain: d.chain, transport: http() });
const relayer = createWalletClient({ account: privateKeyToAccount(env.RELAYER_PRIVATE_KEY as Hex), chain: d.chain, transport: http() });
const viewer = privateKeyToAccount(env.VIEWER_PRIVATE_KEY as Hex);
const channel = (process.env.CHANNEL ?? env.CREATOR_ADDRESS) as Address;

// The sender's browser makes a one-time claim key; the link carries it, the chain stores its leaf.
const claimKey = privateKeyToAccount(generatePrivateKey());
const slotRoot = await pub.readContract({ address: d.beamClaims, abi: beamClaimsAbi, functionName: "slotLeaf", args: [0, claimKey.address] });

const now = BigInt(Math.floor(Date.now() / 1000));
const params = { channel, slots: 1, slotRoot, expiry: now + 3600n, recipientLabel: process.env.LABEL ?? "@Tunde" };
const meta = { displayName: process.env.NAME ?? "JUDGE", message: process.env.MESSAGE ?? "for you", actionCode: 3 };
const value = parseUsdc(process.env.AMOUNT ?? "1");
const salt = generatePrivateKey();

const nonce = await pub.readContract({
  address: d.beamClaims,
  abi: beamClaimsAbi,
  functionName: "dropNonce",
  args: [viewer.address, 0, params, meta, salt],
});
const sig = hexToSignature(
  await viewer.signTypedData({
    domain: usdcDomain(d),
    types: receiveWithAuthorizationTypes,
    primaryType: "ReceiveWithAuthorization",
    message: { from: viewer.address, to: d.beamClaims, value, validAfter: 0n, validBefore: now + 600n, nonce },
  }),
);
const auth = { from: viewer.address, value, validAfter: 0n, validBefore: now + 600n, salt, v: Number(sig.v), r: sig.r, s: sig.s };

const createHash = await relayer.writeContract({
  address: d.beamClaims,
  abi: beamClaimsAbi,
  functionName: "giftChatter",
  args: [params, meta, auth],
});
const created = await pub.waitForTransactionReceipt({ hash: createHash });
console.log(`drop ${nonce} created: ${created.status} ${d.explorer}/tx/${createHash}`);

// The chatter opens the link: a fresh account (a Mera passkey account in the product) with no MON.
const chatter = privateKeyToAccount(generatePrivateKey()).address;
const digest = await pub.readContract({ address: d.beamClaims, abi: beamClaimsAbi, functionName: "claimDigest", args: [nonce, 0, chatter] });
const claimSig = await claimKey.sign({ hash: digest });
const claimHash = await relayer.writeContract({
  address: d.beamClaims,
  abi: beamClaimsAbi,
  functionName: "claim",
  args: [nonce, 0, chatter, [], claimSig],
});
const claimed = await pub.waitForTransactionReceipt({ hash: claimHash });
const usdcAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
const [chatterUsdc, chatterMon] = await Promise.all([
  pub.readContract({ address: d.usdc, abi: usdcAbi, functionName: "balanceOf", args: [chatter] }),
  pub.getBalance({ address: chatter }),
]);
console.log(`claimed by ${chatter}: ${claimed.status} ${d.explorer}/tx/${claimHash}`);
console.log(`chatter now holds ${chatterUsdc} USDC units and ${chatterMon} wei MON`);
