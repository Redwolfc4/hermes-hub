# 2026-09-26 — Changelog: Tool-Call Fix, Secret Sanitasi, Default Model

## Ditambahkan
- `.env` (gitignored) untuk `NINE_ROUTER_API_KEY`, `NINE_ROUTER_BASE_URL`, `AG_CLIENT_ID`, `AG_CLIENT_SECRET`.

## Diubah
- `src/quota-live.ts`: kredensial Google via env, guard `refreshAccessToken` saat kosong.
- `src/config/agents.ts`: hapus API key hardcoded; semua `defaultModel` → `free-combo1`.
- `src/hermes-cli/tools/schema.ts`: JSON Schema tools valid (properti tanpa `required` boolean).
- `server.ts`: parse `reasoning_content`, fallback respons 3 lapis, cegah envelope JSON bocor ke chat, default model `free-combo1`.
- `public/index.html`: default model UI → `free-combo1`, hapus duplikat fallback model.

## Diperbaiki
- HTTP 400 provider `Invalid value at ...parameters.properties[].required (TYPE_STRING)`.
- Reply chat berisi `{"id":"chatcmpl-...}` mentah.
- Push GitHub diblokir secret scanning (GH013).

## Catatan Operasional
- Server dev: `setsid bun server.ts`, PID dicatat di `/tmp/opencode/hermes.pid`.
- Jangan `pkill -f server.ts` — pola cocok dengan shell sendiri (self-kill).
- Quota `ag/*` antigravity habis ~158 jam → pakai `free-combo1`.
- Container Docker `hermes-hub` di host:3457 tidak terdampak (memakai ProviderRepo DB, bukan fallback env).