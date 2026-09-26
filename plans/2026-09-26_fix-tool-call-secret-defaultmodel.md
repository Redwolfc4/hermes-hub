# 2026-09-26 — Fix Native Tool-Calling, Sanitasi Secret, Pindah Default Model

## Masalah
1. Push GitHub ditolak (GH013) karena 2 secret Google OAuth + 1 API key 9Router hardcoded.
2. `/api/chat` gagal 400: schema tools mengirim `required` boolean di level properti (Gemini minta string array).
3. Model default (`ag/gemini-3.8-*`) kena 429 quota antigravity (reset 158 jam).
4. Reply chat bisa berisi envelope JSON mentah provider saat `content` kosong (`reasoning_content` diabaikan).
5. Riwayat chat terkontaminasi envelope JSON mentah di SQLite.

## Perubahan
| File | Perubahan |
|------|-----------|
| `src/quota-live.ts` | `AG_CLIENT_ID`/`AG_CLIENT_SECRET` fallback kosong + guard `refreshAccessToken`. |
| `src/config/agents.ts` | `apiKey` fallback kosong; 13 `defaultModel` → `free-combo1`. |
| `src/hermes-cli/tools/schema.ts` | `getToolSchema` strip `required` boolean dari `properties`. |
| `server.ts` | Baca `reasoning_content`; fallback 3 lapis; jangan pernah tampilkan envelope JSON; 8 default model → `free-combo1`. |
| `public/index.html` | Default model global + fallback compare → `free-combo1`. |
| `.env` (gitignored) | Menampung semua secret. |

## Verifikasi
- `bunx tsc --noEmit` = 0 error.
- `POST /api/chat` → `read_file erp-app/package.json` → `dev: next dev --webpack`, `typescript: ^5` (cocok file asli).
- Scan tree: tidak ada secret tertinggal; `.env` tidak ter-track.
- Commit di-amend (single commit) → push bersih tanpa rewrite history.