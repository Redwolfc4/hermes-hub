# Plan: Chat Input Gambar + Timestamp/Grouping + Search + Global Model

Tanggal: 2026-09-26 | Hermes Hub (`/home/salahudin/hermes-hub`)

## Tujuan
1. Input chat dukung gambar (pilih file, paste, drag-drop) ala WhatsApp + terkirim ke model vision.
2. Setiap pesan ada jam + separator grup tanggal (Hari ini / Kemarin / tanggal-bulan-tahun).
3. Pencarian dalam chat (highlight + navigasi hasil).
4. Modal setting model global (ikon gear) — satu model dipakai semua agent.

## Sub-task
1. **DB** (`src/db.ts`): migrasi `ALTER TABLE messages ADD COLUMN image_url TEXT`; `ChatRepo` select/insert sertakan `image_url`.
2. **Backend** (`server.ts`):
   - `POST /api/uploads` — terima multipart image (PNG/JPEG/WebP/GIF, maks 5MB) → simpan `data/uploads/` → balas `{url}`.
   - Serve statis `GET /uploads/*` dengan MIME benar.
   - `/api/chat` terima field `image` (URL uploads / data URL), persist, dan bangun pesan vision OpenAI-compatible (`content parts` + data URL base64) untuk user message bergambar; riwayat teks tetap seperti semula.
3. **Frontend** (`public/index.html`):
   - Tombol attach (paperclip) + popup menu WA-style + hidden file input; paste & drag-drop ke area chat; preview thumbnail + hapus sebelum kirim.
   - Upload dulu via `/api/uploads`, lalu kirim chat sertakan `image`; bubble user & riwayat render `<img>`.
   - Helper tanggal id-ID: jam `HH:MM` per bubble + separator hari (Hari ini/Kemarin/tanggal lengkap).
   - Search bar toggle di header chat: highlight `<mark>`, counter, tombol prev/next + Enter.
   - Ikon gear → modal model global (search + radio + Terapkan/Kembalikan); `selectAgent` hormati `globalModel` (localStorage).
4. **Verifikasi**: `node --check` semua inline script; `curl` uploads (valid/invalid), `/api/chat` dengan gambar, `/api/chats` memuat `image_url`; cek browser.
5. **Docs**: changelog di `log/`.

## Risiko & mitigasi
- File besar → batasi 5MB + hanya 4 MIME image; DB hanya simpan path, bukan base64.
- Provider non-vision → image parts standar OpenAI; jika model menolak, error tampil normal di bubble merah.
- XSS via nama file → sanitize basename saat serve; render pesan tetap pola lama + `textContent` untuk typewriter.
