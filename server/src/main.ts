import { formatEther } from "viem";
import { ChainGiftFeed } from "./chainfeed.js";
import { loadConfig } from "./config.js";
import { CreatorStore } from "./creators.js";
import { Indexed } from "./feed.js";
import { createApp } from "./http.js";
import { Relayer } from "./relayer.js";
import { BeamBot } from "./twitch.js";

const config = loadConfig();
const relayer = new Relayer(config);
const indexed = new Indexed({ httpUrl: config.hasuraHttpUrl, wsUrl: config.hasuraWsUrl, adminSecret: config.hasuraAdminSecret });
const gifts = indexed.streamGifts();
const chain = new ChainGiftFeed(config.d, config.wsUrl).start();
const creators = new CreatorStore(config.d, config.dataDir);
const bot = config.twitch
  ? new BeamBot({ ...config.twitch, publicUrl: config.publicUrl, dataDir: config.dataDir }, creators)
  : null;
void bot?.start().catch((e) => console.error(`[twitch] ${(e as Error).message}`));
const server = createApp({ config, relayer, indexed, gifts, chain, creators, bot });

server.listen(config.port, async () => {
  const balance = await relayer.balance();
  console.log(`beam server on :${config.port} · ${config.d.network} (chain ${config.d.chain.id})`);
  console.log(`relayer ${relayer.address} holds ${formatEther(balance)} MON (floor ${formatEther(config.relayerFloorWei)})`);
  console.log(`live gifts: chain log push via ${config.wsUrl}, Envio stream as backup`);
  console.log(`twitch bot: ${bot ? bot.status : "not configured (TWITCH_CLIENT_ID/SECRET/BOT_ADMIN_KEY)"}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    gifts.close();
    chain.close();
    server.close(() => process.exit(0));
  });
}
