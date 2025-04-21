const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');

const app = express();

// JWT Secret Key
const JWT_SECRET = 'online-randevu-secret-key-2024';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// PostgreSQL bağlantısı
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'online_randevu',
    password: 'postgres',
    port: 5432,
});

// Tabloları oluştur
async function createTables() {
    try {
        // Kullanıcılar tablosu
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                phone VARCHAR(20) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // İşletme profilleri tablosu
        await pool.query(`
            CREATE TABLE IF NOT EXISTS business_profiles (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                business_type VARCHAR(50) NOT NULL,
                business_phone VARCHAR(20) UNIQUE NOT NULL,
                identity_number VARCHAR(11) NOT NULL UNIQUE,
                city VARCHAR(100) NOT NULL,
                district VARCHAR(100) NOT NULL,
                address TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        `);

        console.log('Tablolar kontrol edildi');
    } catch (error) {
        console.error('Tablo oluşturma hatası:', error);
    }
}

// Tabloları kontrol et ve gerekirse oluştur
createTables();

// Customer dashboard sayfası için endpoint
app.get('/customer-dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'customer-dashboard.html'));
});

// Business dashboard sayfası için endpoint
app.get('/business-dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'business-dashboard.html'));
});

// Dashboard sayfası için endpoint
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Profil sayfası için endpoint
app.get('/profile', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// Kullanıcı profil bilgileri endpoint'i
app.get('/api/user/profile', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'Yetkilendirme gerekli' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        
        const result = await pool.query(
            'SELECT id, name, email, phone, role FROM users WHERE id = $1',
            [decoded.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('Profil bilgileri hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Randevu geçmişi endpoint'i
app.get('/api/appointments/history', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'Yetkilendirme gerekli' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        
        let query;
        let params;

        if (decoded.role === 'customer') {
            query = `
                SELECT 
                    a.id,
                    a.appointment_date as date,
                    a.status,
                    b.business_name as "businessName",
                    s.name as "serviceName"
                FROM appointments a
                JOIN businesses b ON a.business_id = b.id
                JOIN services s ON a.service_id = s.id
                WHERE a.customer_id = $1
                ORDER BY a.appointment_date DESC
            `;
            params = [decoded.userId];
        } else {
            query = `
                SELECT 
                    a.id,
                    a.appointment_date as date,
                    a.status,
                    u.name as "customerName",
                    s.name as "serviceName"
                FROM appointments a
                JOIN users u ON a.customer_id = u.id
                JOIN services s ON a.service_id = s.id
                WHERE a.business_id IN (
                    SELECT id FROM businesses WHERE owner_id = $1
                )
                ORDER BY a.appointment_date DESC
            `;
            params = [decoded.userId];
        }

        const result = await pool.query(query, params);
        
        // Tarih ve saat bilgisini ayır
        const appointments = result.rows.map(appointment => ({
            ...appointment,
            time: new Date(appointment.date).toLocaleTimeString('tr-TR', {
                hour: '2-digit',
                minute: '2-digit'
            }),
            date: new Date(appointment.date).toISOString().split('T')[0]
        }));

        res.json(appointments);
    } catch (error) {
        console.error('Randevu geçmişi hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Aktif randevular endpoint'i
app.get('/api/appointments/active', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'Yetkilendirme gerekli' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        
        let query;
        let params;

        if (decoded.role === 'customer') {
            query = `
                SELECT 
                    a.id,
                    a.appointment_date as date,
                    a.status,
                    b.business_name as "businessName",
                    s.name as "serviceName"
                FROM appointments a
                JOIN businesses b ON a.business_id = b.id
                JOIN services s ON a.service_id = s.id
                WHERE a.customer_id = $1 
                AND a.status = 'active'
                AND a.appointment_date >= CURRENT_DATE
                ORDER BY a.appointment_date ASC
            `;
            params = [decoded.userId];
        } else {
            query = `
                SELECT 
                    a.id,
                    a.appointment_date as date,
                    a.status,
                    u.name as "customerName",
                    s.name as "serviceName"
                FROM appointments a
                JOIN users u ON a.customer_id = u.id
                JOIN services s ON a.service_id = s.id
                WHERE a.business_id IN (
                    SELECT id FROM businesses WHERE owner_id = $1
                )
                AND a.status = 'active'
                AND a.appointment_date >= CURRENT_DATE
                ORDER BY a.appointment_date ASC
            `;
            params = [decoded.userId];
        }

        const result = await pool.query(query, params);
        
        // Tarih ve saat bilgisini ayır
        const appointments = result.rows.map(appointment => ({
            ...appointment,
            time: new Date(appointment.date).toLocaleTimeString('tr-TR', {
                hour: '2-digit',
                minute: '2-digit'
            }),
            date: new Date(appointment.date).toISOString().split('T')[0]
        }));

        res.json(appointments);
    } catch (error) {
        console.error('Aktif randevular hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Randevu iptal etme endpoint'i
app.post('/api/appointments/:id/cancel', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'Yetkilendirme gerekli' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const appointmentId = req.params.id;

        // Randevunun varlığını ve kullanıcıya ait olduğunu kontrol et
        const checkQuery = `
            SELECT * FROM appointments 
            WHERE id = $1 
            AND (
                customer_id = $2 
                OR business_id IN (
                    SELECT id FROM businesses WHERE owner_id = $2
                )
            )
        `;
        
        const checkResult = await pool.query(checkQuery, [appointmentId, decoded.userId]);
        
        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: 'Randevu bulunamadı' });
        }

        const appointment = checkResult.rows[0];
        
        // Randevunun iptal edilebilir olduğunu kontrol et
        if (appointment.status !== 'active') {
            return res.status(400).json({ error: 'Bu randevu iptal edilemez' });
        }

        // Randevuyu iptal et
        await pool.query(
            'UPDATE appointments SET status = $1 WHERE id = $2',
            ['cancelled', appointmentId]
        );

        res.json({ message: 'Randevu başarıyla iptal edildi' });
    } catch (error) {
        console.error('Randevu iptal hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Kayıt olma endpoint'i
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, phone, password, role } = req.body;

        // Email kontrolü
        const emailExists = await pool.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );

        if (emailExists.rows.length > 0) {
            return res.status(400).json({ error: 'Bu email adresi zaten kullanımda' });
        }

        // Telefon numarası kontrolü
        const phoneExists = await pool.query(
            'SELECT * FROM users WHERE phone = $1',
            [phone]
        );

        if (phoneExists.rows.length > 0) {
            return res.status(400).json({ error: 'Bu telefon numarası zaten kullanımda' });
        }

        // İşletme profillerinde de telefon numarası kontrolü
        const businessPhoneExists = await pool.query(
            'SELECT * FROM business_profiles WHERE business_phone = $1',
            [phone]
        );

        if (businessPhoneExists.rows.length > 0) {
            return res.status(400).json({ error: 'Bu telefon numarası zaten kullanımda' });
        }

        // Şifre hashleme
        const hashedPassword = await bcrypt.hash(password, 10);

        // Kullanıcıyı veritabanına ekleme
        const result = await pool.query(
            'INSERT INTO users (name, email, phone, password, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, role',
            [name, email, phone, hashedPassword, role]
        );

        // JWT token oluşturma
        const token = jwt.sign(
            { userId: result.rows[0].id, role: result.rows[0].role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.status(201).json({
            message: 'Kayıt başarılı',
            token,
            user: result.rows[0]
        });
    } catch (error) {
        console.error('Kayıt hatası:', error);
        if (error.code === '23505') { // Unique constraint violation
            if (error.constraint.includes('email')) {
                return res.status(400).json({ error: 'Bu email adresi zaten kullanımda' });
            } else if (error.constraint.includes('phone')) {
                return res.status(400).json({ error: 'Bu telefon numarası zaten kullanımda' });
            }
        }
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Giriş yapma endpoint'i
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Kullanıcıyı bulma
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ message: 'Geçersiz email veya şifre' });
        }

        const user = result.rows[0];

        // Şifre kontrolü
        const validPassword = await bcrypt.compare(password, user.password);

        if (!validPassword) {
            return res.status(401).json({ message: 'Geçersiz email veya şifre' });
        }

        // JWT token oluşturma
        const token = jwt.sign(
            { 
                userId: user.id,
                role: user.role 
            },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            message: 'Giriş başarılı',
            token,
            user: {
                id: user.id,
                email: user.email,
                role: user.role
            }
        });

    } catch (error) {
        console.error('Giriş hatası:', error);
        res.status(500).json({ message: 'Sunucu hatası' });
    }
});

// İşletme oluşturma endpoint'i
app.post('/api/businesses', async (req, res) => {
    try {
        const { business_name, category, location, description } = req.body;
        const token = req.headers.authorization?.split(' ')[1];

        if (!token) {
            return res.status(401).json({ message: 'Yetkilendirme gerekli' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);

        // Kullanıcı rolünü kontrol etme
        const userResult = await pool.query(
            'SELECT role FROM users WHERE id = $1',
            [decoded.userId]
        );

        if (userResult.rows[0].role !== 'business_owner') {
            return res.status(403).json({ message: 'Bu işlem için yetkiniz yok' });
        }

        // İşletmeyi oluşturma
        const result = await pool.query(
            'INSERT INTO businesses (owner_id, business_name, category, location, description) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [decoded.userId, business_name, category, location, description]
        );

        res.status(201).json({
            message: 'İşletme başarıyla oluşturuldu',
            business: result.rows[0]
        });

    } catch (error) {
        console.error('İşletme oluşturma hatası:', error);
        res.status(500).json({ message: 'Sunucu hatası' });
    }
});

// Randevu oluşturma endpoint'i
app.post('/api/appointments', async (req, res) => {
    try {
        const { business_id, appointment_date } = req.body;
        const token = req.headers.authorization?.split(' ')[1];

        if (!token) {
            return res.status(401).json({ message: 'Yetkilendirme gerekli' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);

        // Randevuyu oluşturma
        const result = await pool.query(
            'INSERT INTO appointments (customer_id, business_id, appointment_date) VALUES ($1, $2, $3) RETURNING *',
            [decoded.userId, business_id, appointment_date]
        );

        res.status(201).json({
            message: 'Randevu başarıyla oluşturuldu',
            appointment: result.rows[0]
        });

    } catch (error) {
        console.error('Randevu oluşturma hatası:', error);
        res.status(500).json({ message: 'Sunucu hatası' });
    }
});

// İşletme kayıt endpoint'i
app.post('/api/business/register', async (req, res) => {
    const { businessType, businessPhone, identityNumber, city, district, address } = req.body;
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Yetkilendirme gerekli' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Kullanıcının rolünü kontrol et
        const userResult = await pool.query(
            'SELECT role FROM users WHERE id = $1',
            [decoded.userId]
        );

        if (userResult.rows.length === 0 || userResult.rows[0].role !== 'business_owner') {
            return res.status(403).json({ error: 'Bu işlem için işletme hesabı gerekiyor.' });
        }

        // Telefon numarası kontrolü
        const phoneExists = await pool.query(
            'SELECT id FROM business_profiles WHERE business_phone = $1',
            [businessPhone]
        );

        if (phoneExists.rows.length > 0) {
            return res.status(400).json({ error: 'Bu telefon numarası zaten kullanımda.' });
        }

        // TC Kimlik numarası kontrolü
        const identityExists = await pool.query(
            'SELECT id FROM business_profiles WHERE identity_number = $1',
            [identityNumber]
        );

        if (identityExists.rows.length > 0) {
            return res.status(400).json({ error: 'Bu TC Kimlik numarası zaten kullanımda.' });
        }

        // İşletme profilini kaydet
        await pool.query(
            `INSERT INTO business_profiles 
            (user_id, business_type, business_phone, identity_number, city, district, address) 
            VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [decoded.userId, businessType, businessPhone, identityNumber, city, district, address]
        );

        res.json({ message: 'İşletme profili başarıyla oluşturuldu.' });
    } catch (error) {
        console.error('İşletme kayıt hatası:', error);
        if (error.code === '23505') { // Unique constraint violation
            if (error.constraint.includes('business_phone')) {
                return res.status(400).json({ error: 'Bu telefon numarası zaten kullanımda.' });
            } else if (error.constraint.includes('identity_number')) {
                return res.status(400).json({ error: 'Bu TC Kimlik numarası zaten kullanımda.' });
            }
        }
        res.status(500).json({ error: 'İşletme profili oluşturulurken bir hata oluştu.' });
    }
});

app.listen(3000, '0.0.0.0', () => {
    console.log('Server 3000 portunda çalışıyor');
}); 