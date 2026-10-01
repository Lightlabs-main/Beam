import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CreatorConfig, type Deployment, checkCreatorConfig, verifyCreatorConfig } from "@beam/shared";
import { type Address, type Hex, getAddress, isAddress } from "viem";
import { z } from "zod";
import { RelayError } from "./relayer.js";

const address = z.string().refine(isAddress, "invalid address").transform((a) => getAddress(a) as Address);

const configBody = z.object({
  config: z.object({
    creator: address,
    displayName: z.string(),
    goal: z.object({ usdc: z.string(), title: z.string(), since: z.number().int() }).nullable(),
    shares: z.array(z.object({ address, bps: z.number().int(), label: z.string() })).max(9),
    stream: z.object({ platform: z.enum(["twitch", "youtube", "kick"]), channel: z.string().max(64) }).nullable().optional(),
    chatBot: z.boolean().optional(),
    updatedAt: z.number().int(),
  }),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "expected a 65-byte signature").transform((h) => h as Hex),
});

export type SignedConfig = { config: CreatorConfig; signature: Hex };

/**
 * Creators' signed settings, one JSON file each. The server can't forge or alter them: every
 * read serves the creator's own signature alongside, and every write is verified.
 */
export class CreatorStore extends EventEmitter<{ saved: [SignedConfig] }> {
  private readonly cache = new Map<string, SignedConfig | null>();

  constructor(
    private readonly d: Deployment,
    private readonly dir: string,
  ) {
    super();
  }

  /** Every saved creator (for the chat bot to know which channels to join). */
  async all(): Promise<SignedConfig[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.dir)).filter((n) => /^0x[0-9a-f]{40}.json$/.test(n));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const out = await Promise.all(names.map((n) => this.get(n.slice(0, 42))));
    return out.filter((x): x is SignedConfig => x !== null);
  }

  private file(creator: string) {
    return join(this.dir, `${getAddress(creator).toLowerCase()}.json`);
  }

  async get(creator: string): Promise<SignedConfig | null> {
    const key = creator.toLowerCase();
    if (this.cache.has(key)) return this.cache.get(key)!;
    let value: SignedConfig | null = null;
    try {
      value = JSON.parse(await readFile(this.file(creator), "utf8")) as SignedConfig;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.cache.set(key, value);
    return value;
  }

  async put(creator: string, body: unknown): Promise<SignedConfig> {
    const parsed = configBody.safeParse(body);
    if (!parsed.success) throw new RelayError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const { config, signature } = parsed.data;
    if (config.creator.toLowerCase() !== creator.toLowerCase()) throw new RelayError(400, "settings are for a different creator");
    try {
      checkCreatorConfig(config);
    } catch (e) {
      throw new RelayError(400, (e as Error).message);
    }
    if (!(await verifyCreatorConfig(this.d, config, signature))) throw new RelayError(403, "not signed by this creator's wallet");
    const current = await this.get(creator);
    // Monotonic versions: an old signed copy can never be replayed over newer settings.
    if (current && config.updatedAt <= current.config.updatedAt) throw new RelayError(409, "newer settings are already saved");
    if (config.updatedAt > Date.now() + 5 * 60_000) throw new RelayError(400, "settings are dated in the future");

    const value: SignedConfig = { config, signature };
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.file(creator)}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, this.file(creator));
    this.cache.set(creator.toLowerCase(), value);
    this.emit("saved", value);
    return value;
  }
}
