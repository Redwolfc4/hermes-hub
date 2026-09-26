# 🌸 Hermes Agent Hub & 9Router Matrix

Proyek terintegrasi di `/home/salahudin/hermes-hub` yang menggabungkan:
1. **Hermes CLI Agent System** (`hermes`) terhubung ke local 9Router (`127.0.0.1:20128`).
2. **Web Hub**:
   - 💬 **Interactive Agent Chat**: Chat dengan persona Rinna-chan & Blue Archive matrix.
   - 📋 **Kanban Task Board**: Penugasan task terstruktur ke agent.
   - ⚖️ **9Router Model Comparator**: Perbandingan 2 model sekaligus + benchmark response time.
   - 🕹️ **Retro Office Game (RPG)**: Game visual retro 2D di mana Sensei bisa berjalan ke meja kerja agent dan berinteraksi langsung.

---

## 🚀 Cara Menjalankan

### 1. Web Dashboard
```bash
cd /home/salahudin/hermes-hub
bun start
```
Buka browser di: **`http://localhost:3456`**

### 2. Hermes CLI di Terminal
Command `hermes` sudah terpasang di sistem (`/home/salahudin/.local/bin/hermes`):
```bash
# Tanya ke Rinna-chan
hermes --agent rinna-chan "Jelaskan clean architecture di Go desu~"

# Tanya ke Arona
hermes --agent arona-scout "Bantu saya eksplorasi file routing"

# Pakai model spesifik di 9Router
hermes --agent maki-backend --model harbor-ai/claude-sonnet-4.6 "Buat handler fiber v2"
```

---

## ⚙️ 9Router Configuration
- **Base URL**: `http://127.0.0.1:20128/v1`
- Masukkan API Key 9Router Anda langsung di kolom header Web Hub atau set environment variable:
```bash
export NINE_ROUTER_API_KEY="api-key-9router-anda"
```
