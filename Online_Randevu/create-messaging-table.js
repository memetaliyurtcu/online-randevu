const { Pool } = require('pg');

// Veritabanı bağlantısı
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'online_randevu',
    password: 'postgres',
    port: 5432,
});

async function createMessagingTable() {
    try {
        console.log('Mesajlaşma tablosu oluşturuluyor...');

        // Mesajlaşma tablosu
        await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY,
                appointment_id INTEGER NOT NULL,
                sender_id INTEGER NOT NULL,
                receiver_id INTEGER NOT NULL,
                message TEXT NOT NULL,
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
                FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        console.log('Messages tablosu oluşturuldu');

        // İndeks ekleyelim performans için
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_messages_appointment 
            ON messages(appointment_id)
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_messages_participants 
            ON messages(sender_id, receiver_id)
        `);
        
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_messages_created_at 
            ON messages(created_at)
        `);

        console.log('İndeksler oluşturuldu');
        
        console.log('✅ Mesajlaşma tablosu başarıyla oluşturuldu!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Tablo oluşturma hatası:', error);
        process.exit(1);
    }
}

createMessagingTable(); 