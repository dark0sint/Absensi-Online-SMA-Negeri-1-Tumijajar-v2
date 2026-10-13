# Absensi Online — SMA Negeri 1 Tumijajar

Aplikasi web (PWA) siap deploy: profil sekolah, menu informasi interaktif, **form absensi siswa**, dan **dashboard guru**.
Bisa dibuka dari HP maupun komputer, dan dapat "diinstal" ke layar utama HP.

## Fitur
| Fitur | Cara kerja |
|---|---|
| Validasi identitas otomatis | Siswa cukup memasukkan NIS sekali (diingat di perangkat). Nama & kelas terisi otomatis dari database. PIN siswa opsional untuk mencegah titip absen. |
| Pembatasan waktu | Waktu dicatat **oleh server** (WIB, detik). Jam buka, batas tepat waktu, dan jam tutup bisa diatur. Setelah batas → "Terlambat"; setelah jam tutup → form menolak. |
| Geotagging | GPS dicek di HP dan **divalidasi ulang di server** (rumus Haversine, radius bisa diatur). Koordinat & jarak tersimpan. |
| Selfie | Hanya dari kamera langsung (tanpa galeri), diberi watermark waktu/NIS/GPS, disimpan di server dan hanya bisa dilihat guru. |
| Rekap otomatis | Dashboard guru: status harian, rekap per siswa (hadir/terlambat/izin/sakit/alfa + persen), ekspor CSV (bisa dibuka di Excel/Google Sheets). Alfa dihitung otomatis. |
| Login wali kelas | Admin membuat akun per kelas (menu *Wali Kelas*). Wali kelas hanya melihat/mengoreksi absensi, foto, rekap, dan laporan **kelasnya sendiri**; tidak bisa membuka pengaturan, data kelas lain, atau akun. Dibatasi di server, bukan hanya di tampilan. |
| WhatsApp ke orang tua | Siswa berstatus **Alfa** mendapat tombol *💬 WA Ortu* (butuh No. HP orang tua di data siswa). WhatsApp terbuka dengan pesan siap kirim; sistem menandai "Terkirim ✓" agar tidak dobel. Teks pesan bisa diubah di Pengaturan (`{nama}`, `{kelas}`, `{tanggal}`). |
| Laporan PDF bulanan | Menu *Laporan PDF*: daftar hadir per tanggal (H/T/I/S/A) per kelas, total per siswa, rata-rata kehadiran, kolom tanda tangan kepala sekolah & wali kelas. A4 landscape, otomatis multi-halaman. |
| Spreadsheet otomatis | Menu *Laporan PDF* (admin) menyediakan rumus `=IMPORTDATA("https://domain/api/feed/harian.csv?key=…")` untuk **Google Sheets**. Tempel di sel A1, data absensi tampil dan diperbarui otomatis (log harian & rekap per siswa). Link dilindungi kunci rahasia yang bisa diganti. Tersedia juga unduhan CSV manual (rekap & log). |
| Lainnya | Izin/sakit dengan keterangan, koreksi manual oleh guru, hari libur, pengumuman, impor siswa CSV, mode gelap. |

## Menjalankan

### Opsi A — Docker (disarankan)
```bash
cp .env.example .env      # lalu edit ADMIN_PASSWORD
docker compose up -d --build
```
Buka `http://IP-SERVER:3000`. Data (database + foto) ada di folder `./data`.

### Opsi B — Node.js langsung (butuh Node.js ≥ 22.13)
```bash
ADMIN_PASSWORD='PasswordKuat' PORT=3000 node --no-warnings server.js
```
Agar jalan terus: gunakan `absensi.service.contoh` (systemd) atau `pm2 start server.js --name absensi`.
Tidak ada `npm install` — aplikasi ini tanpa dependensi eksternal.

## ⚠️ WAJIB: HTTPS
Browser HP **hanya mengizinkan kamera & GPS lewat HTTPS**. Pasang domain + sertifikat:
- Nginx + Let's Encrypt: lihat `nginx.conf.contoh` (`certbot --nginx`), atau
- Cloudflare Tunnel / Caddy (HTTPS otomatis).

Set `TRUST_PROXY=1` jika di belakang proxy.

## Setelan pertama kali (±5 menit)
1. Buka `https://domain-anda/#/admin`, login dengan `ADMIN_PASSWORD`.
2. **Pengaturan → Lokasi Sekolah**: berdiri di tengah sekolah, tekan *"Gunakan lokasi saya sekarang"*, atur radius (mulai dari 150–200 m), **Simpan**.
   *Selama koordinat kosong, validasi lokasi belum aktif.*
3. Atur jam absensi, hari belajar, dan hari libur.
4. **Siswa**: hapus data contoh (NIS 1001–1005), lalu impor CSV `nis,nama,kelas,jk,pin,hp_ortu` (kolom setelah `kelas` boleh kosong).
5. **Wali Kelas**: buat akun per kelas. Nama kelas harus **sama persis** dengan di data siswa (mis. `X IPA 1`).
6. Isi **nama kepala sekolah** di `data/school.json` (`kepalaSekolah`) agar tercetak di laporan PDF.
7. Sebarkan link/QR ke siswa. Di HP: menu browser → *Tambahkan ke layar utama*.

## Ubah profil sekolah
Teks profil, visi-misi, ekskul, fasilitas, jadwal, aturan, dan kontak ada di **`data/school.json`** (dibuat otomatis saat pertama jalan dari `school.default.json`). Edit file itu, simpan — langsung tampil tanpa restart.
> Isi bawaan adalah **contoh umum**. Mohon disesuaikan dengan data resmi sekolah (visi-misi, kepala sekolah, kontak, dll.). Logo ada di `public/logo.svg` & ikon `public/icon-*.png` — ganti dengan logo resmi sekolah.

## Catatan Spreadsheet
- Server harus bisa diakses dari internet lewat HTTPS agar Google Sheets dapat membaca feed.
- Google menyegarkan `IMPORTDATA` secara berkala (beberapa menit hingga ±1 jam), bukan detik demi detik.
- Parameter opsional di URL: `&from=2026-07-01&to=2026-12-31`, `&kelas=X%20IPA%201`.
- Link memuat nama siswa. Jangan dibagikan; jika bocor, tekan *Ganti kunci* lalu tempel ulang rumus. Sel yang diawali `= + - @` diamankan agar tidak dieksekusi sebagai rumus.
- Alternatif tanpa internet publik: unduh CSV dari menu Rekap lalu buka di Excel.

## Catatan WhatsApp
Pengiriman dilakukan **semi-otomatis**: guru menekan tombol, lalu WhatsApp (HP/Web) dari akun guru itu sendiri terbuka dengan pesan siap kirim. Ini tidak membutuhkan biaya, API, atau akun khusus. Pengiriman massal otomatis tanpa klik memerlukan layanan WhatsApp Business API / gateway pihak ketiga (berbayar, dan perlu mematuhi kebijakan WhatsApp); fitur itu **belum** disertakan.
Nomor HP orang tua adalah data pribadi: batasi akses dashboard dan gunakan hanya untuk keperluan sekolah.

## Backup
Salin folder `data/` secara berkala (berisi `absensi.db`, `foto/`, `school.json`).

## Keamanan
- Password guru lewat environment variable; sesi 12 jam bertoken HMAC; batas percobaan login & absen per IP.
- Foto hanya bisa diakses dengan token guru. Waktu ditentukan server, bukan HP.
- Batasan jujur: GPS dari browser **bisa dipalsukan** dengan aplikasi fake-GPS di HP yang dimodifikasi. Kombinasi selfie live + PIN + pengecekan foto oleh guru memperkecil risiko. Aplikasi native bisa mendeteksi mock-location lebih baik, tetapi tidak tersedia pada web.
- Foto selfie adalah data pribadi siswa: informasikan penggunaannya kepada siswa/orang tua dan batasi akses dashboard.

## API singkat
`GET /api/public` · `GET /api/siswa/:nis` · `POST /api/absen` · `POST /api/admin/login` · `GET /api/admin/{harian,rekap,export,laporan.pdf,siswa,guru,settings}` · `POST /api/admin/wa-log` · `GET /healthz`


<img width="2860" height="1864" alt="03_Laporan_PDF_dan_Spreadsheet" src="https://github.com/user-attachments/assets/ca3d7420-48ad-4b08-bd70-b66667904257" />

<img width="2700" height="4623" alt="02_Dashboard_Guru_Desktop" src="https://github.com/user-attachments/assets/e336c1c3-caf6-4a6a-9078-c5b51ee7d64c" />

<img width="2700" height="3432" alt="01_Aplikasi_Siswa_Mobile" src="https://github.com/user-attachments/assets/f65e7e47-a25e-4ee1-8952-158d3f101b74" />
