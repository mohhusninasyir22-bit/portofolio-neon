const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

// Format waktu standar Asia/Jakarta (dd/MM/yyyy HH:mm:ss)
function formatWaktuJakarta(dateInput) {
  if (!dateInput) return '-';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return String(dateInput);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(d);
  const map = {};
  parts.forEach(function (p) {
    map[p.type] = p.value;
  });
  return map.day + '/' + map.month + '/' + map.year + ' ' + map.hour + ':' + map.minute + ':' + map.second;
}

// Membuat token sesi login admin berbasis HMAC-SHA256
function buatTokenAdmin(adminId, username) {
  const secret = process.env.DATABASE_URL || 'zettbot-portofolio-secret';
  const payload = String(adminId) + ':' + String(username);
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(payload + ':' + signature).toString('base64');
}

// Memeriksa keaslian token admin
function cekTokenAdmin(token) {
  if (!token) return null;
  try {
    const decoded = Buffer.from(String(token), 'base64').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 3) return null;
    const payload = parts[0] + ':' + parts[1];
    const secret = process.env.DATABASE_URL || 'zettbot-portofolio-secret';
    const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (parts[2] !== expectedSig) return null;
    return { id: Number(parts[0]), username: parts[1] };
  } catch (err) {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (!process.env.DATABASE_URL) {
    return res.status(500).json({
      sukses: false,
      pesan: 'DATABASE_URL belum diatur di Environment Variables server.'
    });
  }

  const sql = neon(process.env.DATABASE_URL);
  const query = req.query || {};
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = String(query.action || body.action || 'public_data');

  try {
    // 1. AMBIL DATA PUBLIK UNTUK PENGUNJUNG (5 MENU)
    if (action === 'public_data') {
      const adminRows = await sql`
        SELECT nama_tampilan FROM admins ORDER BY id ASC LIMIT 1
      `;
      const berandaRows = await sql`
        SELECT * FROM konten_beranda WHERE status_aktif = TRUE ORDER BY id DESC LIMIT 1
      `;
      const tentangRows = await sql`
        SELECT * FROM konten_tentang ORDER BY urutan ASC, id ASC
      `;
      const pekerjaanRows = await sql`
        SELECT * FROM konten_pekerjaan WHERE status_tampil = TRUE ORDER BY urutan ASC, id DESC
      `;
      const proyekRows = await sql`
        SELECT * FROM konten_proyek WHERE status_tampil = TRUE ORDER BY fitur_unggulan DESC, id DESC LIMIT 12
      `;
      const kontakRows = await sql`
        SELECT * FROM kontak_info ORDER BY urutan ASC, id ASC
      `;

      return res.status(200).json({
        sukses: true,
        data: {
          profil: {
            nama_tampilan: adminRows[0] ? adminRows[0].nama_tampilan : 'Portofolio Pribadi'
          },
          beranda: berandaRows[0] || null,
          tentang: tentangRows,
          pekerjaan: pekerjaanRows,
          proyek: proyekRows,
          kontak: kontakRows
        }
      });
    }

    // 2. FILTER & PAGINATION PROYEK DI BACKEND (ANTI-LAG)
    if (action === 'filter_proyek') {
      const kategori = String(query.kategori || 'Semua');
      const cari = String(query.cari || '').trim();
      const limit = Math.min(Math.max(Number(query.limit) || 6, 1), 50);
      const offset = Math.max(Number(query.offset) || 0, 0);
      const polaCari = '%' + cari + '%';

      let rows;
      if (kategori !== 'Semua') {
        rows = await sql`
          SELECT * FROM konten_proyek
          WHERE status_tampil = TRUE
            AND kategori_proyek = ${kategori}
            AND (judul_proyek ILIKE ${polaCari} OR ringkasan ILIKE ${polaCari} OR teknologi_dipakai ILIKE ${polaCari})
          ORDER BY fitur_unggulan DESC, id DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      } else {
        rows = await sql`
          SELECT * FROM konten_proyek
          WHERE status_tampil = TRUE
            AND (judul_proyek ILIKE ${polaCari} OR ringkasan ILIKE ${polaCari} OR teknologi_dipakai ILIKE ${polaCari})
          ORDER BY fitur_unggulan DESC, id DESC
          LIMIT ${limit} OFFSET ${offset}
        `;
      }

      return res.status(200).json({
        sukses: true,
        proyek: rows,
        hasMore: rows.length === limit
      });
    }

    // 3. MENCATAT PROGRES KUNJUNGAN PENGUNJUNG (VIEW TRACKER)
    if (action === 'track_view') {
      const visitorHash = String(body.visitor_hash || 'anonim').slice(0, 120);
      const halaman = String(body.halaman || 'beranda').slice(0, 50);
      const perangkat = body.tipe_perangkat === 'mobile' ? 'mobile' : 'desktop';

      await sql`
        INSERT INTO site_views (visitor_hash, halaman_dikunjungi, tipe_perangkat)
        VALUES (${visitorHash}, ${halaman}, ${perangkat})
      `;

      return res.status(200).json({ sukses: true });
    }

    // 4. PENGUNJUNG MENGIRIM PESAN DI MENU KONTAK SAYA
    if (action === 'kirim_pesan') {
      const nama = String(body.nama_pengirim || '').trim();
      const email = String(body.email_pengirim || '').trim();
      const subjek = String(body.subjek || 'Pesan Portofolio').trim();
      const isi = String(body.isi_pesan || '').trim();

      if (!nama || !email || !isi) {
        return res.status(400).json({
          sukses: false,
          pesan: 'Nama, email, dan isi pesan wajib diisi.'
        });
      }

      await sql`
        INSERT INTO kontak_pesan (nama_pengirim, email_pengirim, subjek, isi_pesan)
        VALUES (${nama}, ${email}, ${subjek}, ${isi})
      `;

      return res.status(200).json({
        sukses: true,
        pesan: 'Pesan Anda berhasil terkirim!'
      });
    }

    // 5. LOGIN ADMIN (DIBLOKIR JIKA DARI PERANGKAT MOBILE)
    if (action === 'login') {
      const perangkat = String(body.tipe_perangkat || '');
      if (perangkat === 'mobile') {
        return res.status(403).json({
          sukses: false,
          pesan: 'Akses login admin hanya tersedia melalui perangkat Laptop/Desktop.'
        });
      }

      const username = String(body.username || '').trim();
      const password = String(body.password || '').trim();

      const adminRows = await sql`
        SELECT id, username, password_hash, nama_tampilan
        FROM admins
        WHERE username = ${username}
        LIMIT 1
      `;

      if (adminRows.length === 0 || adminRows[0].password_hash !== password) {
        return res.status(401).json({
          sukses: false,
          pesan: 'Username atau password admin salah.'
        });
      }

      const admin = adminRows[0];
      await sql`UPDATE admins SET last_login = CURRENT_TIMESTAMP WHERE id = ${admin.id}`;

      const token = buatTokenAdmin(admin.id, admin.username);
      return res.status(200).json({
        sukses: true,
        token: token,
        admin: {
          id: admin.id,
          username: admin.username,
          nama_tampilan: admin.nama_tampilan
        }
      });
    }

    // ========================================================================
    // AREA KHUSUS PANEL ADMIN (WAJIB MEMBAWA TOKEN LOGIN YANG SAH)
    // ========================================================================
    const tokenHeader = req.headers['x-admin-token'] || body.token || '';
    const adminSesi = cekTokenAdmin(tokenHeader);

    if (!adminSesi) {
      return res.status(401).json({
        sukses: false,
        pesan: 'Sesi admin tidak valid atau sudah berakhir. Silakan login kembali di Laptop.'
      });
    }

    // 6. AMBIL DATA LENGKAP DASHBOARD ADMIN & STATISTIK PENGUNJUNG
    if (action === 'admin_dashboard') {
      const adminInfoRows = await sql`
        SELECT id, username, nama_tampilan FROM admins WHERE id = ${adminSesi.id} LIMIT 1
      `;
      const totalViewsRows = await sql`SELECT COUNT(*)::int AS total FROM site_views`;
      const unikRows = await sql`SELECT COUNT(DISTINCT visitor_hash)::int AS total FROM site_views`;
      const deviceRows = await sql`
        SELECT tipe_perangkat, COUNT(*)::int AS jumlah
        FROM site_views
        GROUP BY tipe_perangkat
      `;
      const menuRows = await sql`
        SELECT halaman_dikunjungi, COUNT(*)::int AS jumlah
        FROM site_views
        GROUP BY halaman_dikunjungi
        ORDER BY jumlah DESC
      `;
      const logTerbaruRows = await sql`
        SELECT id, visitor_hash, halaman_dikunjungi, tipe_perangkat, waktu_kunjung
        FROM site_views
        ORDER BY id DESC
        LIMIT 15
      `;

      const berandaAll = await sql`SELECT * FROM konten_beranda ORDER BY id DESC`;
      const tentangAll = await sql`SELECT * FROM konten_tentang ORDER BY urutan ASC, id ASC`;
      const pekerjaanAll = await sql`SELECT * FROM konten_pekerjaan ORDER BY urutan ASC, id DESC`;
      const proyekAll = await sql`SELECT * FROM konten_proyek ORDER BY id DESC`;
      const kontakInfoAll = await sql`SELECT * FROM kontak_info ORDER BY urutan ASC, id ASC`;
      const pesanAll = await sql`SELECT * FROM kontak_pesan ORDER BY id DESC LIMIT 50`;

      const logTerformat = logTerbaruRows.map(function (item) {
        return {
          id: item.id,
          visitor_hash: item.visitor_hash,
          halaman_dikunjungi: item.halaman_dikunjungi,
          tipe_perangkat: item.tipe_perangkat,
          waktu_kunjung: formatWaktuJakarta(item.waktu_kunjung)
        };
      });

      const pesanTerformat = pesanAll.map(function (p) {
        return {
          id: p.id,
          nama_pengirim: p.nama_pengirim,
          email_pengirim: p.email_pengirim,
          subjek: p.subjek,
          isi_pesan: p.isi_pesan,
          status_baca: p.status_baca,
          waktu_kirim: formatWaktuJakarta(p.waktu_kirim)
        };
      });

      return res.status(200).json({
        sukses: true,
        profil_admin: adminInfoRows[0] || {
          username: adminSesi.username,
          nama_tampilan: 'Administrator Portofolio'
        },
        statistik: {
          total_views: totalViewsRows[0] ? totalViewsRows[0].total : 0,
          pengunjung_unik: unikRows[0] ? unikRows[0].total : 0,
          perangkat: deviceRows,
          menu_populer: menuRows,
          log_terbaru: logTerformat
        },
        konten: {
          beranda: berandaAll,
          tentang: tentangAll,
          pekerjaan: pekerjaanAll,
          proyek: proyekAll,
          kontak_info: kontakInfoAll,
          pesan_masuk: pesanTerformat
        }
      });
    }

    // 7. OPERASIONAL CRUD 5 MENU OLEH ADMIN
    if (action === 'admin_crud') {
      const modul = String(body.modul || '');
      const operasi = String(body.operasi || 'simpan');
      const payload = body.payload || {};

      // A. MENU BERANDA
      if (modul === 'beranda') {
        const headline = String(payload.headline || '').trim();
        const subheadline = String(payload.subheadline || '').trim();
        const deskripsi = String(payload.deskripsi_singkat || '').trim();
        const foto = String(payload.url_foto_profil || '').trim();
        const cv = String(payload.url_cv || '').trim();
        const cta = String(payload.teks_tombol_cta || 'Lihat Proyek Saya').trim();

        if (payload.id) {
          const updated = await sql`
            UPDATE konten_beranda
            SET headline = ${headline},
                subheadline = ${subheadline},
                deskripsi_singkat = ${deskripsi},
                url_foto_profil = ${foto},
                url_cv = ${cv},
                teks_tombol_cta = ${cta},
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ${Number(payload.id)}
            RETURNING *
          `;
          return res.status(200).json({ sukses: true, item: updated[0] });
        } else {
          const inserted = await sql`
            INSERT INTO konten_beranda (headline, subheadline, deskripsi_singkat, url_foto_profil, url_cv, teks_tombol_cta, status_aktif)
            VALUES (${headline}, ${subheadline}, ${deskripsi}, ${foto}, ${cv}, ${cta}, TRUE)
            RETURNING *
          `;
          return res.status(200).json({ sukses: true, item: inserted[0] });
        }
      }

      // B. MENU TENTANG SAYA
      if (modul === 'tentang') {
        if (operasi === 'hapus') {
          await sql`DELETE FROM konten_tentang WHERE id = ${Number(payload.id)}`;
          return res.status(200).json({ sukses: true });
        }
        const kategori = String(payload.kategori || 'bio').trim();
        const judul = String(payload.judul || '').trim();
        const deskripsi = String(payload.deskripsi || '').trim();
        const persen = Math.min(Math.max(Number(payload.persentase_skill) || 0, 0), 100);
        const urutan = Number(payload.urutan) || 1;

        if (payload.id) {
          const updated = await sql`
            UPDATE konten_tentang
            SET kategori = ${kategori}, judul = ${judul}, deskripsi = ${deskripsi},
                persentase_skill = ${persen}, urutan = ${urutan}, updated_at = CURRENT_TIMESTAMP
            WHERE id = ${Number(payload.id)}
            RETURNING *
          `;
          return res.status(200).json({ sukses: true, item: updated[0] });
        } else {
          const inserted = await sql`
            INSERT INTO konten_tentang (kategori, judul, deskripsi, persentase_skill, urutan)
            VALUES (${kategori}, ${judul}, ${deskripsi}, ${persen}, ${urutan})
            RETURNING *
          `;
          return res.status(200).json({ sukses: true, item: inserted[0] });
        }
      }

      // C. MENU PEKERJAAN
      if (modul === 'pekerjaan') {
        if (operasi === 'hapus') {
          await sql`DELETE FROM konten_pekerjaan WHERE id = ${Number(payload.id)}`;
          return res.status(200).json({ sukses: true });
        }
        const posisi = String(payload.posisi || '').trim();
        const perusahaan = String(payload.nama_perusahaan || '').trim();
        const lokasi = String(payload.lokasi || '').trim();
        const mulai = String(payload.periode_mulai || '').trim();
        const selesai = String(payload.periode_selesai || 'Sekarang').trim();
        const tugas = String(payload.deskripsi_tugas || '').trim();
        const urutan = Number(payload.urutan) || 1;
        const tampil = payload.status_tampil !== false;

        if (payload.id) {
          const updated = await sql`
            UPDATE konten_pekerjaan
            SET posisi = ${posisi}, nama_perusahaan = ${perusahaan}, lokasi = ${lokasi},
                periode_mulai = ${mulai}, periode_selesai = ${selesai}, deskripsi_tugas = ${tugas},
                urutan = ${urutan}, status_tampil = ${tampil}
            WHERE id = ${Number(payload.id)}
            RETURNING *
          `;
          return res.status(200).json({ sukses: true, item: updated[0] });
        } else {
          const inserted = await sql`
            INSERT INTO konten_pekerjaan (posisi, nama_perusahaan, lokasi, periode_mulai, periode_selesai, deskripsi_tugas, urutan, status_tampil)
            VALUES (${posisi}, ${perusahaan}, ${lokasi}, ${mulai}, ${selesai}, ${tugas}, ${urutan}, ${tampil})
            RETURNING *
          `;
          return res.status(200).json({ sukses: true, item: inserted[0] });
        }
      }

      // D. MENU PROYEK
      if (modul === 'proyek') {
        if (operasi === 'hapus') {
          await sql`DELETE FROM konten_proyek WHERE id = ${Number(payload.id)}`;
          return res.status(200).json({ sukses: true });
        }
        const judul = String(payload.judul_proyek || '').trim();
        const kategori = String(payload.kategori_proyek || 'Web App').trim();
        const ringkasan = String(payload.ringkasan || '').trim();
        const thumb = String(payload.url_thumbnail || '').trim();
        const demo = String(payload.url_demo || '').trim();
        const repo = String(payload.url_repo || '').trim();
        const tekno = String(payload.teknologi_dipakai || '').trim();
        const unggulan = Boolean(payload.fitur_unggulan);
        const tampil = payload.status_tampil !== false;

        if (payload.id) {
          const updated = await sql`
            UPDATE konten_proyek
            SET judul_proyek = ${judul}, kategori_proyek = ${kategori}, ringkasan = ${ringkasan},
                url_thumbnail = ${thumb}, url_demo = ${demo}, url_repo = ${repo},
                teknologi_dipakai = ${tekno}, fitur_unggulan = ${unggulan}, status_tampil = ${tampil}
            WHERE id = ${Number(payload.id)}
            RETURNING *
          `;
          return res.status(200).json({ sukses: true, item: updated[0] });
        } else {
          const inserted = await sql`
            INSERT INTO konten_proyek (judul_proyek, kategori_proyek, ringkasan, url_thumbnail, url_demo, url_repo, teknologi_dipakai, fitur_unggulan, status_tampil)
            VALUES (${judul}, ${kategori}, ${ringkasan}, ${thumb}, ${demo}, ${repo}, ${tekno}, ${unggulan}, ${tampil})
            RETURNING *
          `;
          return res.status(200).json({ sukses: true, item: inserted[0] });
        }
      }

      // E. MENU KONTAK INFO & PESAN MASUK
      if (modul === 'kontak_info') {
        if (operasi === 'hapus') {
          await sql`DELETE FROM kontak_info WHERE id = ${Number(payload.id)}`;
          return res.status(200).json({ sukses: true });
        }
        const platform = String(payload.platform || '').trim();
        const label = String(payload.label || '').trim();
        const nilai = String(payload.nilai_kontak || '').trim();
        const tautan = String(payload.url_tautan || '').trim();
        const urutan = Number(payload.urutan) || 1;

        if (payload.id) {
          const updated = await sql`
            UPDATE kontak_info
            SET platform = ${platform}, label = ${label}, nilai_kontak = ${nilai}, url_tautan = ${tautan}, urutan = ${urutan}
            WHERE id = ${Number(payload.id)}
            RETURNING *
          `;
          return res.status(200).json({ sukses: true, item: updated[0] });
        } else {
          const inserted = await sql`
            INSERT INTO kontak_info (platform, label, nilai_kontak, url_tautan, urutan)
            VALUES (${platform}, ${label}, ${nilai}, ${tautan}, ${urutan})
            RETURNING *
          `;
          return res.status(200).json({ sukses: true, item: inserted[0] });
        }
      }

      if (modul === 'kontak_pesan') {
        if (operasi === 'hapus') {
          await sql`DELETE FROM kontak_pesan WHERE id = ${Number(payload.id)}`;
          return res.status(200).json({ sukses: true });
        }
        if (operasi === 'tandai_baca') {
          await sql`UPDATE kontak_pesan SET status_baca = TRUE WHERE id = ${Number(payload.id)}`;
          return res.status(200).json({ sukses: true });
        }
      }

      // F. PENGATURAN AKUN ADMIN
      if (modul === 'akun_admin') {
        const namaBaru = String(payload.nama_tampilan || '').trim();
        const userBaru = String(payload.username || '').trim();
        const passBaru = String(payload.password_baru || '').trim();

        if (passBaru) {
          await sql`
            UPDATE admins
            SET nama_tampilan = ${namaBaru}, username = ${userBaru}, password_hash = ${passBaru}
            WHERE id = ${adminSesi.id}
          `;
        } else {
          await sql`
            UPDATE admins
            SET nama_tampilan = ${namaBaru}, username = ${userBaru}
            WHERE id = ${adminSesi.id}
          `;
        }
        return res.status(200).json({ sukses: true });
      }
    }

    return res.status(400).json({ sukses: false, pesan: 'Aksi tidak dikenali.' });
  } catch (error) {
    return res.status(500).json({
      sukses: false,
      pesan: 'Terjadi kesalahan pada server database: ' + error.message
    });
  }
};
