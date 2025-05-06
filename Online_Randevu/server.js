const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

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

// Yükleme dizininin varlığını kontrol et ve yoksa oluştur
const uploadDir = 'public/uploads/business-profiles';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer ayarları
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: function (req, file, cb) {
        if (!file.originalname.match(/\.(jpg|jpeg|png)$/)) {
            return cb(new Error('Sadece resim dosyaları yüklenebilir!'), false);
        }
        cb(null, true);
    },
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    }
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
                business_name VARCHAR(255) NOT NULL,
                identity_number VARCHAR(11) NOT NULL UNIQUE,
                business_phone VARCHAR(10) NOT NULL UNIQUE,
                business_type VARCHAR(50) NOT NULL,
                city VARCHAR(100) NOT NULL,
                district VARCHAR(100) NOT NULL,
                address TEXT NOT NULL,
                reservation_price DECIMAL(10,2) NOT NULL,
                image_url TEXT,
                gallery_images TEXT DEFAULT '[]',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        `);

        // Hizmetler tablosu
        await pool.query(`
            CREATE TABLE IF NOT EXISTS services (
                id SERIAL PRIMARY KEY,
                business_id INTEGER NOT NULL,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                duration INTEGER NOT NULL, -- dakika cinsinden
                price DECIMAL(10,2) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (business_id) REFERENCES business_profiles(id)
            )
        `);

        // İşletme kaynakları tablosu (klinik, koltuk, oda, saha, masa vb.)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS business_resources (
                id SERIAL PRIMARY KEY,
                business_id INTEGER NOT NULL,
                name VARCHAR(255) NOT NULL,
                resource_type VARCHAR(50) NOT NULL,
                status VARCHAR(20) DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (business_id) REFERENCES business_profiles(id)
            )
        `);

        // Randevular tablosu
        await pool.query(`
            CREATE TABLE IF NOT EXISTS appointments (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER NOT NULL,
                business_id INTEGER NOT NULL,
                service_id INTEGER NOT NULL,
                resource_id INTEGER,
                appointment_date TIMESTAMP NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'Beklemede',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (customer_id) REFERENCES users(id),
                FOREIGN KEY (business_id) REFERENCES business_profiles(id),
                FOREIGN KEY (service_id) REFERENCES services(id),
                FOREIGN KEY (resource_id) REFERENCES business_resources(id)
            )
        `);

        console.log('Tablolar başarıyla oluşturuldu');
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

// İşletme randevu takvimi sayfası için endpoint
app.get('/business-appointment-calendar', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'business-appointment-calendar.html'));
});

// Profil sayfası için endpoint
app.get('/profile', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// İşletme profil sayfası için endpoint
app.get('/business-profile-view', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'business-profile-view.html'));
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

        // Hizmet seçimi yoksa, varsayılan bir service_id kullan (ör: 1)
        const defaultServiceId = 1;

        const result = await pool.query(
            'INSERT INTO appointments (customer_id, business_id, service_id, appointment_date) VALUES ($1, $2, $3, $4) RETURNING *',
            [decoded.userId, business_id, defaultServiceId, appointment_date]
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

// Kimlik doğrulama middleware'i
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Yetkilendirme gerekli' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Geçersiz token' });
        req.user = user;
        next();
    });
}

// İşletme profili oluşturma endpoint'i - Çoklu fotoğraf yükleme desteği
const businessProfileUpload = upload.fields([
    { name: 'profileImage', maxCount: 1 },
    { name: 'galleryImages', maxCount: 10 }
]);

app.post('/api/business-profile', authenticateToken, businessProfileUpload, async (req, res) => {
    try {
        console.log('Form verileri:', req.body);
        console.log('Yüklenen dosyalar:', req.files ? Object.keys(req.files) : 'Yok');
        
        const { businessName, identityNumber, businessPhone, businessType, city, district, address, reservationPrice } = req.body;

        if (!identityNumber || !businessPhone || !businessType || !city || !district || !address || !reservationPrice) {
            return res.status(400).json({ error: 'Tüm alanları doldurunuz' });
        }

        // Profil fotoğrafı kontrolü
        if (!req.files || !req.files.profileImage || !req.files.profileImage[0]) {
            return res.status(400).json({ error: 'En az bir fotoğraf yüklenmelidir' });
        }

        const userId = req.user.userId;
        const profileImagePath = req.files.profileImage[0].path;
        const profileImageUrl = '/uploads/business-profiles/' + req.files.profileImage[0].filename;

        // Galeri fotoğraflarını işle
        let galleryImagesJson = '[]';
        if (req.files.galleryImages && req.files.galleryImages.length > 0) {
            const galleryImages = req.files.galleryImages.map(file => ({
                path: file.path,
                url: '/uploads/business-profiles/' + file.filename
            }));
            galleryImagesJson = JSON.stringify(galleryImages);
        }

        try {
            // İşletme profilini oluştur - business_name NULL olabilir (geriye dönük uyumluluk için)
            const result = await pool.query(
                'INSERT INTO business_profiles (user_id, business_name, identity_number, business_phone, business_type, city, district, address, reservation_price, image_url, gallery_images) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *',
                [userId, businessName || '', identityNumber, businessPhone, businessType, city, district, address, reservationPrice, profileImageUrl, galleryImagesJson]
            );

            res.status(201).json({
                message: 'İşletme profili başarıyla oluşturuldu',
                businessProfile: result.rows[0]
            });
        } catch (dbError) {
            console.error('Veritabanı hatası:', dbError);
            res.status(500).json({ error: `Veritabanı hatası: ${dbError.message}` });
        }
    } catch (error) {
        console.error('İşletme profili oluşturma hatası:', error);
        res.status(500).json({ error: `İşletme profili oluşturulurken bir hata oluştu: ${error.message}` });
    }
});

// İşletme hesabına geçiş endpoint'i
app.post('/api/upgrade-to-business', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'Yetkilendirme gerekli' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Kullanıcının mevcut rolünü kontrol et
        const userCheck = await pool.query(
            'SELECT role FROM users WHERE id = $1',
            [decoded.userId]
        );

        if (userCheck.rows[0].role === 'business_owner') {
            return res.status(400).json({ error: 'Kullanıcı zaten işletme hesabına sahip' });
        }

        // Kullanıcının rolünü güncelle
        await pool.query(
            'UPDATE users SET role = $1 WHERE id = $2',
            ['business_owner', decoded.userId]
        );

        // Yeni token oluştur
        const newToken = jwt.sign(
            { userId: decoded.userId, role: 'business_owner' },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            message: 'Hesap başarıyla işletme hesabına yükseltildi',
            token: newToken
        });

    } catch (error) {
        console.error('İşletme hesabına geçiş hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// İşletme profili görüntüleme endpoint'i
app.get('/api/business-profile', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'Yetkilendirme gerekli' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        
        // İşletme profilini getir
        const result = await pool.query(`
            SELECT 
                bp.*,
                u.name as business_name
            FROM business_profiles bp
            JOIN users u ON bp.user_id = u.id
            WHERE bp.user_id = $1
        `, [decoded.userId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error('İşletme profili görüntüleme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// İşletmeleri listeleme ve filtreleme endpoint'i
app.get('/api/businesses', async (req, res) => {
    try {
        // Filtreleme parametrelerini al
        const { search, type, city, district } = req.query;
        
        // Temel sorgu ve parametreler
        let query = 'SELECT * FROM business_profiles WHERE 1=1';
        const params = [];
        
        // Arama
        if (search) {
            query += ` AND (business_name ILIKE $${params.length + 1} OR business_type ILIKE $${params.length + 1})`;
            params.push(`%${search}%`);
        }
        
        // İşletme türü
        if (type && type !== 'all') {
            query += ` AND business_type = $${params.length + 1}`;
            params.push(type);
        }
        
        // Şehir
        if (city) {
            query += ` AND LOWER(city) = LOWER($${params.length + 1})`;
            params.push(city);
        }
        
        // İlçe
        if (district) {
            query += ` AND LOWER(district) = LOWER($${params.length + 1})`;
            params.push(district);
        }
        
        query += ' ORDER BY id DESC';
        
        console.log('SQL Sorgusu:', query);
        console.log('Parametreler:', params);
        
        // Sorguyu çalıştır
        const result = await pool.query(query, params);
        
        res.json({ businesses: result.rows });
    } catch (error) {
        console.error('İşletme listeleme hatası:', error);
        res.status(500).json({ error: 'İşletmeler listelenirken bir hata oluştu' });
    }
});

// Belirli bir işletmenin detaylarını görüntüleme endpoint'i
app.get('/api/businesses/:id', async (req, res) => {
    try {
        const businessId = req.params.id;
        
        const result = await pool.query(
            'SELECT * FROM business_profiles WHERE id = $1',
            [businessId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme bulunamadı' });
        }
        
        // Galeri görsellerini parse et
        const business = result.rows[0];
        if (business.gallery_images) {
            try {
                business.gallery_images = JSON.parse(business.gallery_images);
            } catch (parseError) {
                console.error('Galeri görselleri parse hatası:', parseError);
                business.gallery_images = [];
            }
        } else {
            business.gallery_images = [];
        }
        
        res.json({ business });
    } catch (error) {
        console.error('İşletme detayları getirme hatası:', error);
        res.status(500).json({ error: 'İşletme detayları getirilirken bir hata oluştu' });
    }
});

// İşletme istatistikleri endpoint'i
app.get('/api/business/stats', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'Yetkilendirme gerekli' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        
        // İşletme ID'sini bul
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [decoded.userId]
        );

        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }

        const businessId = businessResult.rows[0].id;

        // Randevu istatistiklerini getir
        const statsResult = await pool.query(`
            SELECT 
                COUNT(*) FILTER (WHERE status = 'active') as active_appointments,
                COUNT(*) as total_appointments
            FROM appointments
            WHERE business_id = $1
        `, [businessId]);

        res.json(statsResult.rows[0]);
    } catch (error) {
        console.error('İşletme istatistikleri hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// İşletmenin randevularını getiren endpoint
app.get('/api/business/appointments', authenticateToken, async (req, res) => {
    try {
        const businessProfileResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [req.user.userId]
        );

        if (businessProfileResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }

        const businessId = businessProfileResult.rows[0].id;

        // Randevuları getir
        const appointmentsResult = await pool.query(
            `SELECT a.*, u.name as customer_name 
             FROM appointments a 
             JOIN users u ON a.customer_id = u.id 
             WHERE a.business_id = $1 
             ORDER BY a.appointment_date`,
            [businessId]
        );

        res.json(appointmentsResult.rows);
    } catch (error) {
        console.error('Randevu listesi hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Randevu oluşturma/güncelleme endpoint'i
app.post('/api/business/appointments', authenticateToken, async (req, res) => {
    try {
        const { appointmentId, customerId, serviceId, appointmentDate, status } = req.body;

        const businessProfileResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [req.user.userId]
        );

        if (businessProfileResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }

        const businessId = businessProfileResult.rows[0].id;

        let result;
        
        // Mevcut randevu güncelleme
        if (appointmentId) {
            result = await pool.query(
                `UPDATE appointments 
                 SET service_id = $1, appointment_date = $2, status = $3 
                 WHERE id = $4 AND business_id = $5 
                 RETURNING *`,
                [serviceId, appointmentDate, status, appointmentId, businessId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Randevu bulunamadı veya bu işletmeye ait değil' });
            }
        } 
        // Yeni randevu oluşturma
        else {
            result = await pool.query(
                `INSERT INTO appointments (customer_id, business_id, service_id, appointment_date, status) 
                 VALUES ($1, $2, $3, $4, $5) 
                 RETURNING *`,
                [customerId, businessId, serviceId, appointmentDate, status || 'active']
            );
        }

        res.status(appointmentId ? 200 : 201).json({
            message: appointmentId ? 'Randevu güncellendi' : 'Randevu oluşturuldu',
            appointment: result.rows[0]
        });
    } catch (error) {
        console.error('Randevu oluşturma/güncelleme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// İşletme kaynakları için API endpoint'leri (işletme sahipleri için)
app.get('/api/business/resources', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        
        // Önce kullanıcının işletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id, business_type FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // İşletmeye ait kaynakları getir
        const resourcesResult = await pool.query(
            'SELECT id, name, resource_type, status, created_at FROM business_resources WHERE business_id = $1 ORDER BY created_at DESC',
            [businessId]
        );
        
        res.json({
            businessType: businessResult.rows[0].business_type,
            resources: resourcesResult.rows
        });
    } catch (error) {
        console.error('Kaynakları getirme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.post('/api/business/resources', authenticateToken, async (req, res) => {
    try {
        const { name, resourceType } = req.body;
        const userId = req.user.userId;
        
        if (!name || !resourceType) {
            return res.status(400).json({ error: 'Kaynak adı ve türü gereklidir' });
        }
        
        // Önce kullanıcının işletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Yeni kaynağı ekle
        const result = await pool.query(
            'INSERT INTO business_resources (business_id, name, resource_type) VALUES ($1, $2, $3) RETURNING id, name, resource_type, status, created_at',
            [businessId, name, resourceType]
        );
        
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Kaynak ekleme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.put('/api/business/resources/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, status } = req.body;
        const userId = req.user.userId;
        
        // Önce kullanıcının işletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Kaynağın bu işletmeye ait olduğunu doğrula
        const resourceCheck = await pool.query(
            'SELECT id FROM business_resources WHERE id = $1 AND business_id = $2',
            [id, businessId]
        );
        
        if (resourceCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Kaynak bulunamadı veya bu işletmeye ait değil' });
        }
        
        // Kaynağı güncelle
        let query = 'UPDATE business_resources SET ';
        const params = [];
        const updateFields = [];
        
        if (name !== undefined) {
            params.push(name);
            updateFields.push(`name = $${params.length}`);
        }
        
        if (status !== undefined) {
            params.push(status);
            updateFields.push(`status = $${params.length}`);
        }
        
        if (updateFields.length === 0) {
            return res.status(400).json({ error: 'Güncellenecek alan belirtilmedi' });
        }
        
        query += updateFields.join(', ');
        params.push(id);
        query += ` WHERE id = $${params.length} RETURNING id, name, resource_type, status, created_at`;
        
        const result = await pool.query(query, params);
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Kaynak güncelleme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

app.delete('/api/business/resources/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.userId;
        
        // Önce kullanıcının işletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Kaynağın bu işletmeye ait olduğunu doğrula
        const resourceCheck = await pool.query(
            'SELECT id FROM business_resources WHERE id = $1 AND business_id = $2',
            [id, businessId]
        );
        
        if (resourceCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Kaynak bulunamadı veya bu işletmeye ait değil' });
        }
        
        // Kaynağı sil
        await pool.query(
            'DELETE FROM business_resources WHERE id = $1',
            [id]
        );
        
        res.json({ message: 'Kaynak başarıyla silindi' });
    } catch (error) {
        console.error('Kaynak silme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Müşteriler için public kaynak görüntüleme endpoint'i
app.get('/api/business/resources/public', async (req, res) => {
    try {
        const { businessId, includeInactive } = req.query;
        
        if (!businessId) {
            return res.status(400).json({ error: 'İşletme ID gereklidir' });
        }
        
        // Önce işletme türünü al
        const businessResult = await pool.query(
            'SELECT business_type FROM business_profiles WHERE id = $1',
            [businessId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme bulunamadı' });
        }
        
        const businessType = businessResult.rows[0].business_type;
        
        // İşletmeye ait kaynakları getir
        let resourcesQuery;
        let queryParams;
        
        if (includeInactive === 'true') {
            // Tüm kaynakları getir (aktif veya değil)
            resourcesQuery = 'SELECT id, name, resource_type, status, created_at FROM business_resources WHERE business_id = $1 ORDER BY created_at DESC';
            queryParams = [businessId];
        } else {
            // Sadece aktif kaynakları getir
            resourcesQuery = 'SELECT id, name, resource_type, status, created_at FROM business_resources WHERE business_id = $1 AND status = $2 ORDER BY created_at DESC';
            queryParams = [businessId, 'active'];
        }
        
        const resourcesResult = await pool.query(resourcesQuery, queryParams);
        
        res.json({
            businessType: businessType,
            resources: resourcesResult.rows
        });
    } catch (error) {
        console.error('Public kaynakları getirme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Kaynak durumunu değiştirme endpoint'i
app.put('/api/business/resources/:id/status', authenticateToken, async (req, res) => {
    try {
        const resourceId = req.params.id;
        const { status } = req.body;
        
        if (!status || (status !== 'active' && status !== 'inactive')) {
            return res.status(400).json({ error: 'Geçersiz durum değeri. "active" veya "inactive" olmalıdır.' });
        }
        
        // İşletme ID'sini bul
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [req.user.userId]
        );

        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }

        const businessId = businessResult.rows[0].id;
        
        // Kaynağı güncelle
        const updateResult = await pool.query(
            'UPDATE business_resources SET status = $1 WHERE id = $2 AND business_id = $3 RETURNING *',
            [status, resourceId, businessId]
        );
        
        if (updateResult.rows.length === 0) {
            return res.status(404).json({ 
                error: 'Kaynak bulunamadı veya bu kaynağı güncelleme yetkiniz yok' 
            });
        }
        
        res.json({ 
            message: 'Kaynak durumu başarıyla güncellendi',
            resource: updateResult.rows[0]
        });
        
    } catch (error) {
        console.error('Kaynak durumu güncelleme hatası:', error);
        res.status(500).json({ error: 'Kaynak durumu güncellenirken bir hata oluştu' });
    }
});

// Müsait randevu saatlerini getiren endpoint
app.get('/api/available-slots', async (req, res) => {
    try {
        const { businessId, date, resourceId } = req.query;
        
        if (!businessId || !date) {
            return res.status(400).json({ error: 'İşletme ID ve tarih bilgisi zorunludur' });
        }
        
        // Tarih kontrolü
        const selectedDate = new Date(date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        if (selectedDate < today) {
            return res.status(400).json({ error: 'Geçmiş tarihler için randevu alınamaz' });
        }
        
        // Günün başlangıç ve bitiş zamanları
        const startOfDay = new Date(selectedDate);
        startOfDay.setHours(0, 0, 0, 0);
        
        const endOfDay = new Date(selectedDate);
        endOfDay.setHours(23, 59, 59, 999);
        
        // Mevcut randevuları getir
        let appointmentsQuery = `
            SELECT appointment_date
            FROM appointments
            WHERE business_id = $1
            AND appointment_date BETWEEN $2 AND $3
        `;
        
        let queryParams = [businessId, startOfDay, endOfDay];
        let paramIndex = 4;
        
        // Eğer belirli bir kaynak için filtreleme yapılıyorsa query'yi güncelle
        if (resourceId) {
            appointmentsQuery += ` AND resource_id = $${paramIndex}`;
            queryParams.push(resourceId);
            paramIndex++;
        }
        
        const appointmentsResult = await pool.query(appointmentsQuery, queryParams);
        
        // Dolu saatleri al
        const bookedTimes = appointmentsResult.rows.map(row => {
            const date = new Date(row.appointment_date);
            return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
        });
        
        // Tüm saatleri oluştur (09:00 - 18:00 arası saatlik dilimler)
        const allTimes = [];
        for (let hour = 9; hour <= 18; hour++) {
            allTimes.push(`${hour.toString().padStart(2, '0')}:00`);
        }
        
        // Müsait saatleri filtrele
        const availableTimes = allTimes.filter(time => !bookedTimes.includes(time));
        
        res.json(availableTimes);
    } catch (error) {
        console.error('Müsait saatleri getirme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
    }
});

// Kaynak bazlı randevu sayılarını getiren endpoint
app.get('/api/business/resource-appointments/count', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        
        // Önce işletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Her kaynak için bekleyen randevu sayısını al
        const result = await pool.query(`
            SELECT 
                resource_id, 
                COUNT(CASE WHEN status = 'Beklemede' THEN 1 END) as pending,
                COUNT(CASE WHEN status = 'Onaylandı' THEN 1 END) as approved,
                COUNT(CASE WHEN status = 'Reddedildi' THEN 1 END) as rejected,
                COUNT(*) as total
            FROM appointments 
            WHERE business_id = $1 AND resource_id IS NOT NULL
            GROUP BY resource_id
        `, [businessId]);
        
        // Sonuçları uygun formata dönüştür
        const countByResource = {};
        result.rows.forEach(row => {
            countByResource[row.resource_id] = {
                pending: parseInt(row.pending) || 0,
                approved: parseInt(row.approved) || 0,
                rejected: parseInt(row.rejected) || 0,
                total: parseInt(row.total) || 0
            };
        });
        
        res.json(countByResource);
    } catch (error) {
        console.error('Randevu sayıları getirme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Belirli bir kaynağa ait randevuları getiren endpoint
app.get('/api/business/resource-appointments/:resourceId', authenticateToken, async (req, res) => {
    try {
        const { resourceId } = req.params;
        const userId = req.user.userId;
        
        // Önce işletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Kaynağın bu işletmeye ait olduğunu kontrol et
        const resourceCheck = await pool.query(
            'SELECT id FROM business_resources WHERE id = $1 AND business_id = $2',
            [resourceId, businessId]
        );
        
        if (resourceCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Kaynak bulunamadı veya bu işletmeye ait değil' });
        }
        
        // Kaynağa ait randevuları getir
        const result = await pool.query(`
            SELECT a.*, u.name as customer_name
            FROM appointments a
            JOIN users u ON a.customer_id = u.id
            WHERE a.business_id = $1 AND a.resource_id = $2
            ORDER BY a.appointment_date DESC
        `, [businessId, resourceId]);
        
        res.json(result.rows);
    } catch (error) {
        console.error('Kaynak randevuları getirme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Randevular için endpoint
app.post('/api/appointments', authenticateToken, async (req, res) => {
    try {
        const { businessId, date, time, resourceId, note } = req.body;
        const userId = req.user.userId;
        
        if (!businessId || !date || !time) {
            return res.status(400).json({ error: 'İşletme, tarih ve saat bilgileri zorunludur' });
        }
        
        // Servis kontrolü - servis ID'si gelmezse varsayılan bir servis oluştur
        let serviceId;
        const serviceCheck = await pool.query('SELECT id FROM services WHERE business_id = $1 LIMIT 1', [businessId]);
        
        if (serviceCheck.rows.length > 0) {
            serviceId = serviceCheck.rows[0].id;
        } else {
            // Varsayılan bir servis ekleme
            const serviceInsert = await pool.query(
                'INSERT INTO services (business_id, name, duration, price, description) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                [businessId, 'Standart Randevu', 60, 0, 'Otomatik oluşturulan randevu']
            );
            serviceId = serviceInsert.rows[0].id;
        }
        
        // Tarih ve saati birleştir
        const appointmentDate = new Date(`${date}T${time}`);
        
        // Randevu oluştur
        const result = await pool.query(
            'INSERT INTO appointments (customer_id, business_id, service_id, resource_id, appointment_date, status, notes) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
            [userId, businessId, serviceId, resourceId, appointmentDate, 'Beklemede', note || null]
        );
        
        res.status(201).json({ 
            success: true,
            message: 'Randevunuz başarıyla oluşturuldu',
            appointmentId: result.rows[0].id 
        });
    } catch (error) {
        console.error('Randevu oluşturma hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
    }
});

// Port dinleme
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server ${PORT} portunda çalışıyor...`);
});