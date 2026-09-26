# Plan: Hermes Hub Lolos Audit `impeccable detect`

Tanggal: 2026-09-26 | Proyek: Hermes Hub (`/home/salahudin/hermes-hub`) | Target: `http://localhost:3456/`
Gate: `bunx --bun impeccable detect <url>` harus exit 0 (0 primary findings), plus viewport mobile `390x844`.

## Baseline
- Desktop: 64 primary + 10 advisory. Mobile: +`cramped-padding`, `body-text-viewport-edge`, `clipped-overflow-container`, `flat-type-hierarchy` (varian angka mobile).
- Kategori: `dark-glow` (4), `undersized-ui-text` (13), `ai-color-palette` (34), `overused-font`, `flat-type-hierarchy`, `skipped-heading` (3), `pulsing-dot` (2), `low-contrast` (4), `line-length`, `nested-cards`, `gpt-thin-border-wide-shadow` (advisory, 10).

## Perubahan (satu file: `public/index.html`)
1. Font: Inter + Plus Jakarta Sans → Sora (+ IBM Plex Sans fallback). Mengatasi `overused-font`.
2. Hierarki tipe: `body 14px`, `h2 18px`, `h1 20px+` (rasio ≥1.25); semua `h4` heading → `h3`. Mengatasi `flat-type-hierarchy`, `skipped-heading`.
3. Teks mikro `text-[10px]` → `text-[11px]`. Mengatasi `undersized-ui-text`.
4. Hapus glow berwarna (`shadow-brand/pink-*` → `shadow-black/30`, `shadow-2xl` → `shadow-md`); hapus `backdrop-filter` pada panel kaca (diganti solid) + naikkan kontras teks sekunder ke `slate-200/300`. Mengatasi `dark-glow`, `low-contrast`, sebagian advisory `gpt-thin-border-wide-shadow`.
5. Netralkan neon: teks `sky/purple/violet/indigo-*` → `slate-200/300`; gradien `to-indigo` dihapus; `think-bar` jadi pink/rose/amber; avatar & idtag agent jadi slate statis; hapus `box-shadow` glow inline di `renderAgents`. Mengatasi `ai-color-palette`.
6. Hapus `animate-pulse` pada dot status. Mengatasi `pulsing-dot`.
7. Flatten kartu: baris agent jadi list `border-b` (tanpa kartu), bubble chat tanpa border, kolom kanban & panel compare & wrapper quota jadi layout-only, outer game jadi layout-only (viewport kanvas tetap satu-satunya kartu). Mengatasi `nested-cards`.
8. Batas lebar baca: `p,li → 54ch` (Sora berwajah lebar; 60ch masih muat 88 char), bubble chat 50–52ch, `compare-output` 56ch, `kanban-card` 48ch, `msg-text` + `overflow-wrap:anywhere` (token JSON panjang), `main` mobile `p-4`. Mengatasi `line-length`, `body-text-viewport-edge`.
9. Padding: badge & input & tombol view `py-1 → py-1.5` (termasuk `showSyncMsg` di JS yang menimpa className). Mengatasi `cramped-padding`.
10. Wrapper kanvas `overflow-hidden` → visible (frame pembulat dipertahankan `game-viewport`); tidak mengubah tampilan desktop. Mengatasi `clipped-overflow-container`.

## Dampak
- Hanya `public/index.html` (CSS/kelas + 2 string className di JS inline). Tanpa perubahan `server.ts`, DB, API.
- Visual: palet ke slate + aksen pink brand; bayangan netral; heading sedikit lebih besar; padding badge +2px. Fungsionalitas tidak berubah.

## Cara testing
- `bunx --bun impeccable detect http://localhost:3456/` → exit 0, 0 findings.
- `bunx --bun impeccable detect --viewport 390x844 http://localhost:3456/` → exit 0.
- Smoke: `/`, `/api/agents`, `/api/providers` 200; judul halaman benar.
