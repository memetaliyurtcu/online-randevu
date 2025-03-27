const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Kayıt olma endpoint'i
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, phone, password, role } = req.body;

        // Email kontrolü
        const userExists = await db.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );

        if (userExists.rows.length > 0) {
            return res.status(400).json({ message: 'Bu email adresi zaten kullanımda' });
        }

        // Şifre hashleme
        const hashedPassword = await bcrypt.hash(password, 10);

        // Kullanıcıyı veritabanına ekleme
        const result = await db.query(
            'INSERT INTO users (name, email, phone, password, role) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [name, email, phone, hashedPassword, role]
        );

        // JWT token oluşturma
        const token = jwt.sign(
            { userId: result.rows[0].id },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.status(201).json({
            message: 'Kayıt başarılı',
            token
        });

    } catch (error) {
        console.error('Kayıt hatası:', error);
        res.status(500).json({ message: 'Sunucu hatası' });
    }
});

// Giriş yapma endpoint'i
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // Kullanıcıyı bulma
        const result = await db.query(
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
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            message: 'Giriş başarılı',
            token,
            user: {
                id: user.id,
                name: user.name,
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

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Kullanıcı rolünü kontrol etme
        const userResult = await db.query(
            'SELECT role FROM users WHERE id = $1',
            [decoded.userId]
        );

        if (userResult.rows[0].role !== 'business_owner') {
            return res.status(403).json({ message: 'Bu işlem için yetkiniz yok' });
        }

        // İşletmeyi oluşturma
        const result = await db.query(
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

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Randevuyu oluşturma
        const result = await db.query(
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

app.listen(3000, '0.0.0.0', () => {
    console.log('Server 3000 portunda çalışıyor');
}); 