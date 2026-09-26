# Changelog: Hermes Hub Lolos Audit Impeccable (0 Findings, Desktop + Mobile)

Tanggal: 2026-09-26 | Hermes Hub (`/home/salahudin/hermes-hub`) | Server: `http://localhost:3456/`

## Hasil akhir
- `bunx --bun impeccable detect http://localhost:3456/` → exit 0, 0 findings (baseline: 64 primary + 10 advisory).
- `bunx --bun impeccable detect --viewport 390x844 http://localhost:3456/` → exit 0, 0 findings.
- Smoke: `GET /` 200 + judul benar, `/api/agents` 200, `/api/providers` 200 (`9Router Local`, sukses, 849 model).

## File diubah
- `public/index.html` (satu-satunya file; ±60 operasi edit kecil: CSS, kelas Tailwind, 2 string className JS inline).
  - Font: Google Fonts Inter/Plus Jakarta Sans → Sora (+ IBM Plex Sans); `tailwind.config.fontFamily` ikut diganti.
  - Hierarki: `body 14px`, `h1.text-xl`, `h2.text-lg`, CSS `h1 1.55–1.7rem / h2 1.2–1.3rem / h3`; semua `<h4>` heading → `<h3>`.
  - Mikro-teks: `text-[10px]` → `text-[11px]` (8 lokasi).
  - Glow/border-shadow: `shadow-brand/pink-*` → `shadow-black/30`; `shadow-2xl` → `shadow-md`; `.glass-panel` solid tanpa `backdrop-filter`; teks sekunder → `slate-200/300`.
  - Neon: `text-sky/purple/violet/indigo-*` → `slate-200/300`; tombol filter Gemini/Claude/CX → slate; gradien logo/tombol tanpa `indigo`; `think-bar` pink→rose→amber; avatar/idtag agent slate; hapus `box-shadow` glow inline `renderAgents`.
  - `animate-pulse` dihapus dari 2 dot status.
  - Flatten: agent rows (`border-b`, tanpa kartu), bubble chat (tanpa border), lane kanban / panel compare / wrapper quota / outer game → layout-only.
  - Lebar baca: `p,li 54ch`; `.chat-assistant` 50ch; bubble `max-w-[50/52ch]`; `.compare-output` 56ch; `.kanban-card` 48ch; `.msg-text overflow-wrap:anywhere`; `main p-4` di mobile.
  - Padding: badge Sensei/Live, pill provider, `providerSyncMsg` (HTML + JS `showSyncMsg`), input/select quota, tombol view cards/table: `py-1 → py-1.5`.
  - Wrapper kanvas: `overflow-hidden` → visible (frame `game-viewport` tetap `overflow-hidden`).

## Temuan selama pengerjaan
- `ch` Sora lebar: `60ch` masih memuat 88 karakter satu baris (paragraf hint keyboard, tepat 88 char) → cap diketatkan ke `54ch`.
- `showSyncMsg()` di JS menimpa `className` (menggugurkan fix padding versi HTML) → diperbaiki di kedua sisi.
- `cramped-padding` hanya muncul di profil mobile (rule per-viewport); pesan sync provider yang tampil ~6 detik setelah load ikut memengaruhi timing hasil.
- Server sempat mati di tengah pengerjaan (port 3456 kosong); dinyalakan ulang via `setsid nohup bun run server.ts` → 200 OK.
- Subagent Blue Archive gagal dipanggil (batas free-tier OpenCode) → dikerjakan langsung.

## Rollback
- Satu file saja: kembalikan `public/index.html` dari backup/salin sebelumnya, atau revert per-bagian mengikuti daftar di atas. Tanpa migrasi DB; tanpa perubahan API.
