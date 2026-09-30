# Recording the Beam video

A 2–3 minute screen recording of the hero flow (spec §7): scan, passkey, gift, confetti on stream,
creator already paid; then a walletless chatter claiming real money. Everything shown is real: real
passkeys, real on-chain gifts, alerts fired by real events. Nothing is staged.

Network: **Monad testnet** (test USDC). Say so once, plainly. Re-record the gift moment on mainnet
once it is deployed.

## Before you record (10 minutes, once)

### PC

1. Install OBS Studio (obsproject.com).
2. Make a scene with something behind the overlay: your webcam, a game, or a browser window.
3. **Sources → + → Browser**:
   - URL: `https://beamstreams.xyz/overlay?creator=0xF5446059ba06Fe5381c6CBD21294A43E19B31159`
   - Width **1920**, height **1080**. Click OK.
   - Put it at the top of the source list.
   You should see the QR (bottom right), "Recording goal $0 / $25" and recent gifts (bottom left).
4. Open a browser tab (for the proof beat) at the creator's page on the explorer:
   `https://testnet.monadscan.com/address/0xF5446059ba06Fe5381c6CBD21294A43E19B31159#tokentxns`
5. In OBS: **Settings → Output** → recording format MP4. Use **Start Recording** for the take.

### Phone 1 (the viewer: you)

- Your passkey wallet `0x2091…0086` already holds $8.50 of test USDC. Nothing to set up.
- Rehearse once: scan the QR on the OBS screen with the camera app, tap the link, tap **Continue as
  0x2091…0086**, send **$0.50**. The alert should fire on the OBS screen within about a second.

### Phone 2 or a laptop (the chatter, for the originality beat)

- A friend's phone is ideal. It needs a passkey provider: iPhone (iOS 18+, Safari) or Android
  (Chrome). A desktop Chrome works only with Google Password Manager passkeys.
- Nothing to install. They'll create their wallet during the take.

## The take (about 2 minutes)

| # | Screen | You do | You say |
|---|---|---|---|
| 1 | OBS | Show the stream with the Beam overlay | "This is a live stream with Beam: one browser source in OBS." |
| 2 | Phone | Scan the QR with the camera | "A viewer scans the QR." |
| 3 | Phone | Tap **Continue**, approve Face ID/fingerprint | "Their wallet is a passkey. No app, no seed phrase, no gas token." |
| 4 | Phone | Tap **$1**, type a message, tap **Send $1** | "They pick an amount and send." |
| 5 | OBS | Confetti: "JUDGE gifted $1 🎉", goal ticks up | "And it's on stream." |
| 6 | Explorer | Refresh: the $1 is already in the creator's wallet | "The creator already holds the money. That animation isn't a promise to pay later. **The animation is the settlement.**" |
| 7 | Phone | Tap **A chatter**, type `@Ada`, $1, **Gift**, **Copy** the claim link | "Now gift someone in chat who has no wallet at all." |
| 8 | Phone 2 | Open the link, **Create my wallet with a passkey** | "They open the link, make a passkey wallet…" |
| 9 | OBS | "🎁 @Ada claimed $1 from JUDGE" | "…and they've been paid. No crypto needed. A card processor can't do that." |

Optional closer: tap **Beam Bomb 💣**, $1 for 3 chatters, paste the link; two phones grab shares
and the stream shows each one.

## If something goes wrong mid-take

| Symptom | Fix |
|---|---|
| No alert after sending | Check the phone showed "is on stream". If yes, the overlay lost its connection: right-click the Browser source → **Refresh**. |
| "Beam offline · reconnecting" on the overlay | Wait 10 seconds; it reconnects by itself. |
| Passkey prompt says the provider can't create a wallet | That phone's passkey provider has no PRF support. Use iCloud Keychain (iPhone) or Google Password Manager (Android). |
| "Not enough USDC" | Tell Claude; the test wallet can be topped up in a minute. |
| The claim link says "Already claimed" | Each link works once. Send a new chatter gift. |

## After recording

- Trim to under 3 minutes. Keep the moment between tapping **Send** and the confetti uncut: that
  second is the product.
- Put the video link in the README under Status.
