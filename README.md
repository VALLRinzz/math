# Math Battle Online

Website duel perkalian online untuk dua pemain. Frontend menggunakan HTML, CSS, JavaScript ES modules, Firebase Anonymous Authentication, Firebase Realtime Database, dan dapat di-host di Vercel.

## Fitur

- Buat room dengan kode 5 karakter.
- Pemain kedua bergabung menggunakan kode room.
- Kedua pemain harus menekan tombol siap.
- Soal perkalian acak dari 1 sampai 100.
- Waktu setiap soal 20 detik.
- Jawaban benar pertama mendapat 1 poin.
- Target kemenangan 10 poin.
- Skor dan status tersinkronisasi melalui Firebase Realtime Database.

## 1. Buat project Firebase

1. Buka https://console.firebase.google.com/ lalu buat project.
2. Tambahkan aplikasi Web (ikon `</>`).
3. Salin konfigurasi Firebase Web App.
4. Buka `firebase-config.js` dan ganti seluruh nilai `GANTI_DENGAN_...` dengan nilai dari Firebase Console.
5. Pastikan `databaseURL` disalin dari halaman Realtime Database, bukan ditebak. Format URL dapat berbeda menurut region.

## 2. Aktifkan Anonymous Authentication

1. Firebase Console → Authentication.
2. Buka tab Sign-in method.
3. Aktifkan provider **Anonymous**.
4. Simpan.

## 3. Buat Realtime Database

1. Firebase Console → Build → Realtime Database.
2. Klik Create Database.
3. Pilih lokasi database.
4. Setelah database dibuat, salin URL database ke `databaseURL` di `firebase-config.js`.
5. Buka tab Rules.
6. Ganti rules dengan isi file `database.rules.json`.
7. Klik Publish.

Rules ini mengharuskan pengguna terautentikasi, membatasi pembuatan room pada host, dan membatasi akses tulis pada anggota room. Namun ini adalah starter multiplayer kasual, bukan sistem anti-cheat untuk kompetisi berperingkat. Untuk kompetisi serius, pindahkan pembuatan soal, timer, validasi jawaban, dan pemberian skor ke backend tepercaya (misalnya Cloud Functions) dan validasi setiap transisi status di server.

## 4. Jalankan di komputer

Jangan membuka `index.html` langsung dengan `file://`, karena file JavaScript menggunakan ES modules.

Cara termudah:
- Buka folder ini di Visual Studio Code.
- Jalankan dengan ekstensi Live Server, atau
- Jalankan server lokal seperti `python -m http.server 5500`, lalu buka `http://localhost:5500`.

Jika memakai Live Server, pastikan kedua perangkat bisa mengakses URL yang sama melalui jaringan lokal untuk uji coba lokal. Untuk bermain dari jaringan berbeda, deploy ke Vercel.

## 5. Deploy ke Vercel

1. Upload folder project ke repository GitHub.
2. Buka https://vercel.com/ dan login.
3. Pilih Add New → Project, lalu import repository.
4. Karena ini website statis, biarkan Framework Preset sebagai Other.
5. Build Command dan Output Directory dapat dikosongkan untuk project HTML statis sederhana.
6. Klik Deploy.
7. Buka URL Vercel di kedua perangkat.

Tambahkan domain Vercel ke Firebase Authentication → Settings → Authorized domains bila Firebase meminta domain tersebut. Untuk domain sendiri, tambahkan juga domain itu.

## Catatan penting

- Jangan pernah menaruh service account key atau Firebase Admin SDK private key di frontend.
- Firebase Web config memang digunakan di browser, tetapi keamanan harus berasal dari Authentication dan Database Rules.
- Anonymous Auth membuat identitas tamu sementara. Jika browser/site data dihapus, identitas perangkat dapat berubah.
- Host harus tetap membuka halaman selama pertandingan karena pada versi starter ini host yang mengatur transisi ronde dan timeout.
- Room yang ditinggalkan host akan dihapus. Jika host menutup browser mendadak, room dapat tertinggal di database; hapus room lama dari Realtime Database Console bila diperlukan.
- Periksa penggunaan dan batas paket Firebase sebelum membagikan website secara luas.

## Struktur file

- `index.html`
- `style.css`
- `firebase-config.js`
- `script.js`
- `database.rules.json`
