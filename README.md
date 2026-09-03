# Gamma X Unified Backend — v2 (Angel-primary / Dhan-secondary + Dhan TOTP login)

This is the same tested, fixed backend as before, rewired to match your
new environment variable format.

## What changed from the previous zip

- **`PRIMARY_BROKER` / `SECONDARY_BROKER`** now control candle-fetch
  order. You set `PRIMARY_BROKER=ANGEL`, `SECONDARY_BROKER=DHAN` — so for
  every index, the backend tries Angel One first, and only falls back to
  Dhan if Angel fails or returns no candles.
- **Option chain (straddle price + IV) always comes from Dhan**, no
  matter what you set `PRIMARY_BROKER` to — Angel One has no native
  option-chain endpoint, this hasn't changed.
- **Dhan now supports PIN + TOTP auto-login**, matching the variables you
  gave me (`DHAN_CLIENT_ID`, `DHAN_PIN`, `DHAN_TOTP_SECRET` — no
  `DHAN_ACCESS_TOKEN` needed). This uses Dhan's own confirmed endpoint:
  ```
  POST https://auth.dhan.co/app/generateAccessToken?dhanClientId=...&pin=...&totp=...
  ```
  It auto-regenerates the token roughly every `DHAN_RENEW_EVERY_HOURS`
  (default 20), so you never have to touch it again. **Requirement:** you
  must have TOTP enabled on your Dhan account first — Dhan Web → Profile
  → DhanHQ Trading APIs → enable TOTP — that's where you get the
  `DHAN_TOTP_SECRET` (same kind of base32 secret as any authenticator
  app QR code). If you'd rather keep pasting a manually-generated token,
  you still can: just set `DHAN_ACCESS_TOKEN` and leave `DHAN_PIN` /
  `DHAN_TOTP_SECRET` blank — it takes priority if present.
- Angel One vars are now consistently prefixed: `ANGEL_API_KEY`,
  `ANGEL_CLIENT_CODE`, `ANGEL_PIN`, `ANGEL_TOTP_SECRET`.
- `.env.example` in this zip already has your real `VAPID_PUBLIC_KEY` /
  `VAPID_PRIVATE_KEY` filled in, since you'd already generated them —
  this file is private to your zip/repo, don't share it further since
  those are real secret keys, not placeholders.

Everything else — the 502 fixes (missing `brokers/` folder, health-check
path mismatch), the live Dhan-scrip-master security ID resolution, the
"bind the port before slow setup" boot order, `/health` + `/api/health`
diagnostics — is unchanged from the previous fix, since none of that was
related to the env var naming.

## Deploy

1. Replace your GitHub repo contents with this zip's contents (keep the
   `brokers/` folder as a real folder).
2. In Render → your service → Environment, update the variable **names**
   to match this list (values you fill in yourself):
   ```
   PRIMARY_BROKER=ANGEL
   SECONDARY_BROKER=DHAN
   ANGEL_API_KEY=
   ANGEL_CLIENT_CODE=
   ANGEL_PIN=
   ANGEL_TOTP_SECRET=
   DHAN_CLIENT_ID=
   DHAN_PIN=
   DHAN_TOTP_SECRET=
   VAPID_PUBLIC_KEY=
   VAPID_PRIVATE_KEY=
   VAPID_SUBJECT=
   CORS_ORIGINS=*
   ```
3. Confirm Render → Settings → Health Check Path = `/health`.
4. Deploy, then check:
   - `/health` → `{"ok":true,...}`
   - `/api/health` → shows `brokerOrder: ["ANGEL","DHAN"]`, whether each
     broker has valid credentials, Dhan's token/auth status, and which
     broker actually served the last candle per index.

## Honest caveats

- I still can't reach the internet from this sandbox, so the actual
  Dhan TOTP login call and Angel One login couldn't be live-tested here
  — only boot-tested with every network call simulated as failing (to
  confirm the server doesn't crash and logs errors cleanly, which it
  does). The endpoint and parameter names for Dhan's TOTP login are
  taken directly from Dhan's own current documentation.
- If Dhan's TOTP login fails on first real deploy, check `/api/health` →
  `dhan.lastAuthError` first — it will show Dhan's actual rejection
  reason (wrong PIN, TOTP not enabled on the account, clock drift on
  the TOTP code, etc.) rather than a generic failure.
