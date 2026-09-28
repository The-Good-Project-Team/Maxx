# maxx on dino

The live container definition, copied from `dino:~/Classified/dino/maxx/` (not a git repo)
so a `podman system reset` no longer leaves the only copy on one box (philanthropy#6735).

- `docker-compose.yml`, `Containerfile`: as running (`podman-compose@maxx.service`, project
  `maxx`, working dir `~/Classified/dino/maxx`, build context `../../Maxx` = this repo).
- `.env.example`: variable names only; values stay in `dino:~/Classified/dino/maxx/.env`.

## State

One volume, `maxx_maxx-state` (compose names it `<project>_maxx-state`), mounted at `/data`
(`MAXX_STATE_DIR`). It holds one JSON ledger per handle (`reif.json`, `reif_tgp.json`, ...),
plus `_auth.json` / `_accounts.json`. From empty, maxx self-initialises: emitters
(`emit.mjs --send`) re-send their session windows and the ledgers refill. Older history is
not recoverable from emitters; keep a volume snapshot for that.

Recreate from scratch:
`cd ~/Classified/dino/maxx && MAXX_GIT_SHA=$(git -C ../../Maxx rev-parse HEAD) podman-compose build && podman-compose up -d`
