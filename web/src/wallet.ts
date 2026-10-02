// Beam's passkey wallet, built on Mera: a passkey's WebAuthn PRF output is a 32-byte secret that
// the same passkey reproduces on every device where it syncs. We treat it as BIP-39 entropy, so
// the wallet is a standard m/44'/60'/0'/0/0 EOA whose recovery phrase any EVM wallet can import.
// No key material is ever stored: only the credential id, to skip the account picker next time.
import {
  type PasskeyCredentialMetadata,
  createPasskeyWithPrfOutput,
  createSecp256k1SigningSession,
  getPasskeyPrfOutput,
  isMeraError,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { LocalAccount } from "viem";

/**
 * Passkeys are bound to this relying party. The registrable domain (beamstreams.xyz) also covers
 * any subdomain, so wallets survive moving the app between subdomains or servers.
 */
export const RP_ID = location.hostname.replace(/^www\./, "");
const CREDENTIAL_KEY = "beam.passkey";
const ADDRESS_KEY = "beam.address";
/** Survives "forget this device": tells the page to look for an existing passkey before creating one. */
const HAD_WALLET_KEY = "beam.hadWallet";

export type Wallet = { account: LocalAccount; end(): void };

function evmKeyFromPrf(prfOutput: Uint8Array): Uint8Array {
  const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
  const node = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0");
  if (!node.privateKey) throw new Error("key derivation produced no key");
  const key = node.privateKey.slice();
  seed.fill(0);
  node.wipePrivateData();
  return key;
}

function walletFromPrf(prfOutput: Uint8Array): Wallet {
  const key = evmKeyFromPrf(prfOutput);
  prfOutput.fill(0);
  const session = createSecp256k1SigningSession({ privateKey: key });
  key.fill(0);
  const account = toViemAccount(session);
  try {
    localStorage.setItem(ADDRESS_KEY, account.address);
    localStorage.setItem(HAD_WALLET_KEY, "1");
  } catch {}
  return { account, end: () => session.end() };
}

function storedCredential(): PasskeyCredentialMetadata | undefined {
  try {
    const raw = localStorage.getItem(CREDENTIAL_KEY);
    return raw ? (JSON.parse(raw) as PasskeyCredentialMetadata) : undefined;
  } catch {
    return undefined;
  }
}

function storeCredential(c: PasskeyCredentialMetadata) {
  try {
    localStorage.setItem(CREDENTIAL_KEY, JSON.stringify({ credentialId: c.credentialId, transports: c.transports }));
  } catch {}
}

/** The address this device last signed in with (public; shown before the passkey prompt). */
export function rememberedAddress(): string | null {
  try {
    return localStorage.getItem(ADDRESS_KEY);
  } catch {
    return null;
  }
}

export const hasPasskeyOnDevice = () => storedCredential() !== undefined;

/** Whether this browser has ever opened a Beam wallet (even if it was later forgotten). */
export function everHadWallet(): boolean {
  try {
    return localStorage.getItem(HAD_WALLET_KEY) === "1";
  } catch {
    return false;
  }
}

/** Creates a new passkey (one or two biometric prompts) and returns its wallet. */
export async function createWallet(displayName: string): Promise<Wallet> {
  const name = displayName.trim() || "Beam viewer";
  const created = await createPasskeyWithPrfOutput({
    rp: { id: RP_ID, name: "Beam" },
    user: { name: `${name} · Beam`, displayName: name },
  });
  storeCredential(created);
  return walletFromPrf(created.prfOutput);
}

/**
 * Signs in with an existing passkey. With `anyPasskey`, the platform offers every Beam passkey
 * (including ones synced from another device): this is account recovery.
 */
export async function signIn(anyPasskey = false): Promise<Wallet> {
  const stored = anyPasskey ? undefined : storedCredential();
  const got = await getPasskeyPrfOutput({ rpId: RP_ID, credential: stored });
  storeCredential({ credentialId: got.credentialId, transports: stored?.transports });
  return walletFromPrf(got.prfOutput);
}

/** Asks for the passkey again and returns the 24-word recovery phrase for this wallet. */
export async function revealRecoveryPhrase(): Promise<string> {
  const got = await getPasskeyPrfOutput({ rpId: RP_ID, credential: storedCredential() });
  const phrase = entropyToMnemonic(got.prfOutput, wordlist);
  got.prfOutput.fill(0);
  return phrase;
}

/** Forgets this device's passkey choice (the passkey itself stays in the user's password manager). */
export function forgetDevice() {
  try {
    localStorage.removeItem(CREDENTIAL_KEY);
    localStorage.removeItem(ADDRESS_KEY);
  } catch {}
}

/** Plain-language message for passkey failures. */
export function passkeyErrorMessage(e: unknown): string {
  if (isMeraError(e)) {
    switch (e.code) {
      case "PRF_UNAVAILABLE":
        return "This passkey provider can't create a Beam wallet. On desktop Chrome, save the passkey to Google Password Manager; on iPhone, use iCloud Keychain.";
      case "PASSKEY_OPERATION_FAILED":
        return "The passkey prompt was closed or failed. Try again.";
      case "CRYPTO_UNAVAILABLE":
        return "This browser can't run passkeys here. Open the page over https in a current browser.";
      case "SESSION_ENDED":
        return "Your wallet session ended. Sign in again.";
      default:
        return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}
