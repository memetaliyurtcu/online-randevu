const { Pool } = require('pg');

// Veritabanı bağlantısı - server.js ile aynı yapılandırma
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'online_randevu',
    password: 'postgres',
    port: 5432,
});

async function updateSchema() {
    try {
        console.log('Veritabanı şeması güncelleniyor...');

        // İşletme adı sütununu ekle (eğer yoksa)
        await pool.query(`
            ALTER TABLE business_profiles 
            ADD COLUMN IF NOT EXISTS business_name VARCHAR(255)
        `);
        console.log('business_name sütunu eklendi veya zaten vardı');

        // Galeri görselleri sütununu ekle (eğer yoksa)
        await pool.query(`
            ALTER TABLE business_profiles 
            ADD COLUMN IF NOT EXISTS gallery_images TEXT DEFAULT '[]'
        `);
        console.log('gallery_images sütunu eklendi veya zaten vardı');

        // business_name sütununu NULL değerleri kabul eder hale getir (geçiş için)
        await pool.query(`
            ALTER TABLE business_profiles 
            ALTER COLUMN business_name DROP NOT NULL
        `).catch(err => {
            // Hata varsa NOT NULL kısıtlaması henüz eklenmiş olabilir, bu yüzden hata görmezden gelinebilir
            console.log('business_name sütunu zaten NULL değerleri kabul ediyor');
        });

        console.log('Veritabanı şeması başarıyla güncellendi');
    } catch (error) {
        console.error('Veritabanı güncelleme hatası:', error);
    } finally {
        // Bağlantıyı kapat
        await pool.end();
    }
}

// Şemayı güncelle
updateSchema();
