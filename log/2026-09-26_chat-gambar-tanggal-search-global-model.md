# Changelog: Chat Gambar + Timestamp/Grouping + Search + Global Model

Tanggal: 2026-09-26 | Hermes Hub (`/home/salahudin/hermes-hub`) | Server: `http://localhost:3456/`

## Backend (`server.ts`, `src/db.ts`)
- Migrasi `messages.image_url TEXT` (aman bila sudah ada); `ChatRepo` select/insert sertakan `image_url`.
- `POST /api/uploads`: multipart image (PNG/JPEG/WebP/GIF, maks 5MB) → `data/uploads/<id>.<ext>` → `{url}`. Validasi MIME + size + sanitize nama file.
- `GET /uploads/*`: serve dengan MIME benar + basename whitelist.
- `/api/chat`: terima `image` (path `/uploads/...` / data URL), persist, dan kirim ke provider sebagai pesan vision OpenAI-compatible (`content parts` text + `image_url` base64 — base64 karena upstream remote tak bisa akses localhost).

## Frontend (`public/index.html`)
- Tombol attach (paperclip) + popup menu WA-style (Foto & Gambar + tips paste/drag-drop); paste `Ctrl+V` dan drag-drop ke area chat; preview thumbnail + hapus sebelum kirim.
- Kirim: upload dulu, lalu chat sertakan `image`; bubble user & riwayat render gambar (klik untuk buka penuh).
- Timestamp `HH:MM` tiap bubble + separator grup hari (`Hari ini` / `Kemarin` / `Senin, 12 Mei 2026` id-ID).
- Search chat (ikon kaca pembesar): highlight kuning, counter `n / total`, navigasi atas/bawah + Enter, Esc menutup.
- Ikon gear → modal Model Global: filter + radio + `Pakai untuk semua ✓` (tersimpan `localStorage`, badge `GLOBAL` di dropdown) + `Kembalikan per-agent`; `selectAgent` menghormati override global.
- Kelas `msg-text` di semua teks pesan agar search/typewriter konsisten.

## Verifikasi
- `node --check` 3 inline script: OK. `bun build server.ts`: OK.
- `POST /api/uploads` PNG 70B → `200 {url}`; TXT → `400` ditolak; `GET /uploads/...` → `200 image/png`.
- `ChatRepo` round-trip `image_url` OK; `GET /api/chats` kembalikan `image_url` (null bila teks).
- Server restart + berjalan di `:3456`.

## Catatan
- Subagent Blue Archive gagal dipanggil (batas free-tier) → dikerjakan langsung Rinna-chan.
- `pkill -f "bun.*..."` menembak shell-nya sendiri → gunakan pola `[h]ermes-hub/server.ts` dan launch langsung via background shell.
