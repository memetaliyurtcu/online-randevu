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

        // Kategoriler tablosu
        await pool.query(`
            CREATE TABLE IF NOT EXISTS categories (
                id SERIAL PRIMARY KEY,
                business_id INTEGER NOT NULL,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                color VARCHAR(7) DEFAULT '#007bff',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (business_id) REFERENCES business_profiles(id)
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
                category_id INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (business_id) REFERENCES business_profiles(id),
                FOREIGN KEY (category_id) REFERENCES categories(id)
            )
        `);

        // Mevcut services tablosunda category_id sütunu yoksa ekle
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'services' AND column_name = 'category_id'
                ) THEN
                    ALTER TABLE services ADD COLUMN category_id INTEGER;
                    ALTER TABLE services ADD CONSTRAINT fk_services_category 
                        FOREIGN KEY (category_id) REFERENCES categories(id);
                END IF;
            END $$;
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

        // İşletme çalışma saatleri tablosu
        await pool.query(`
            CREATE TABLE IF NOT EXISTS business_schedule (
                id SERIAL PRIMARY KEY,
                business_id INTEGER NOT NULL,
                day_of_week INTEGER NOT NULL, -- 0: Pazartesi, 1: Salı, ... 6: Pazar
                is_working BOOLEAN NOT NULL DEFAULT true,
                start_time TIME NOT NULL DEFAULT '09:00',
                end_time TIME NOT NULL DEFAULT '17:00',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (business_id) REFERENCES business_profiles(id)
            )
        `);

        // Engellenen saat dilimleri tablosu
        await pool.query(`
            CREATE TABLE IF NOT EXISTS blocked_slots (
                id SERIAL PRIMARY KEY,
                business_id INTEGER NOT NULL,
                resource_id INTEGER NOT NULL,
                blocked_date DATE NOT NULL,
                blocked_time TIME NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (business_id) REFERENCES business_profiles(id),
                FOREIGN KEY (resource_id) REFERENCES business_resources(id),
                UNIQUE(resource_id, blocked_date, blocked_time)
            )
        `);

        // CHECK constraint'ini kaldır (varsa)
        try {
            await pool.query(`
                ALTER TABLE appointments 
                DROP CONSTRAINT IF EXISTS appointments_status_check
            `);
            console.log('Status check constraint kaldırıldı');
        } catch (error) {
            console.log('Check constraint kaldırma hatası (normal olabilir):', error.message);
        }

        // Değerlendirmeler tablosu
        await pool.query(`
            CREATE TABLE IF NOT EXISTS reviews (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER NOT NULL,
                business_id INTEGER NOT NULL,
                appointment_id INTEGER,
                rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
                comment TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (customer_id) REFERENCES users(id),
                FOREIGN KEY (business_id) REFERENCES business_profiles(id),
                FOREIGN KEY (appointment_id) REFERENCES appointments(id),
                UNIQUE(customer_id, appointment_id)
            )
        `);

        // Reviews tablosuna yeni alanlar ekle (varsa eklenmez)
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'reviews' AND column_name = 'business_response'
                ) THEN
                    ALTER TABLE reviews ADD COLUMN business_response TEXT;
                END IF;
            END $$;
        `);

        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'reviews' AND column_name = 'response_date'
                ) THEN
                    ALTER TABLE reviews ADD COLUMN response_date TIMESTAMP;
                END IF;
            END $$;
        `);

        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'reviews' AND column_name = 'is_reported'
                ) THEN
                    ALTER TABLE reviews ADD COLUMN is_reported BOOLEAN DEFAULT FALSE;
                END IF;
            END $$;
        `);

        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'reviews' AND column_name = 'report_reason'
                ) THEN
                    ALTER TABLE reviews ADD COLUMN report_reason TEXT;
                END IF;
            END $$;
        `);

        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'reviews' AND column_name = 'report_date'
                ) THEN
                    ALTER TABLE reviews ADD COLUMN report_date TIMESTAMP;
                END IF;
            END $$;
        `);

        // Business profiles tablosuna working_hours kolonu ekle (varsa eklenmez)
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'business_profiles' AND column_name = 'working_hours'
                ) THEN
                    ALTER TABLE business_profiles ADD COLUMN working_hours JSONB;
                END IF;
            END $$;
        `);

        // Müşteri sadakat puanları tablosu
        await pool.query(`
            CREATE TABLE IF NOT EXISTS customer_loyalty_points (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER NOT NULL,
                total_points INTEGER DEFAULT 0,
                completed_appointments INTEGER DEFAULT 0,
                total_spent DECIMAL(10,2) DEFAULT 0,
                last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (customer_id) REFERENCES users(id),
                UNIQUE(customer_id)
            )
        `);

        // Müşteri kuponları tablosu
        await pool.query(`
            CREATE TABLE IF NOT EXISTS customer_coupons (
                id SERIAL PRIMARY KEY,
                customer_id INTEGER NOT NULL,
                discount_amount DECIMAL(10,2) NOT NULL,
                description TEXT NOT NULL,
                used BOOLEAN DEFAULT FALSE,
                used_date TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP + INTERVAL '1 year',
                FOREIGN KEY (customer_id) REFERENCES users(id)
            )
        `);

        // Appointments tablosuna total_amount kolonu ekle (varsa eklenmez)
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'appointments' AND column_name = 'total_amount'
                ) THEN
                    ALTER TABLE appointments ADD COLUMN total_amount DECIMAL(10,2) DEFAULT 0;
                END IF;
            END $$;
        `);

        // Appointments tablosuna coupon_id kolonu ekle (varsa eklenmez)
        await pool.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'appointments' AND column_name = 'coupon_id'
                ) THEN
                    ALTER TABLE appointments ADD COLUMN coupon_id INTEGER;
                    ALTER TABLE appointments ADD CONSTRAINT fk_appointments_coupon 
                        FOREIGN KEY (coupon_id) REFERENCES customer_coupons(id);
                END IF;
            END $$;
        `);

        console.log('Tablolar başarıyla oluşturuldu');
    } catch (error) {
        console.error('Tablo oluşturma hatası:', error);
    }
}

// Tabloları kontrol et ve gerekirse oluştur
createTables();

// Değerlendirme ekleme endpoint'i
app.post('/api/reviews', authenticateToken, async (req, res) => {
    try {
        const { appointmentId, businessId, rating, comment } = req.body;
        const customerId = req.user.userId;

        // Randevunun varlığını ve kullanıcıya ait olduğunu kontrol et
        const appointmentCheck = await pool.query(
            'SELECT id, status FROM appointments WHERE id = $1 AND customer_id = $2',
            [appointmentId, customerId]
        );

        if (appointmentCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Randevu bulunamadı' });
        }

        const appointment = appointmentCheck.rows[0];

        // Sadece tamamlanan randevular değerlendirilebilir
        if (appointment.status !== 'Tamamlandı' && appointment.status !== 'completed') {
            return res.status(400).json({ 
                error: 'Sadece tamamlanan randevular değerlendirilebilir' 
            });
        }

        // Bu randevu için daha önce değerlendirme yapılmış mı kontrol et
        const existingReview = await pool.query(
            'SELECT id FROM reviews WHERE customer_id = $1 AND appointment_id = $2',
            [customerId, appointmentId]
        );

        if (existingReview.rows.length > 0) {
            return res.status(400).json({ 
                error: 'Bu randevu için zaten değerlendirme yapılmış' 
            });
        }

        // Bu işletme için daha önce değerlendirme yapılmış mı kontrol et (ek güvenlik)
        const businessReviewCheck = await pool.query(
            'SELECT COUNT(*) as review_count FROM reviews WHERE customer_id = $1 AND business_id = $2',
            [customerId, businessId]
        );

        const reviewCount = parseInt(businessReviewCheck.rows[0].review_count);
        if (reviewCount >= 3) { // Maksimum 3 değerlendirme
            return res.status(400).json({ 
                error: 'Bu işletme için maksimum değerlendirme sayısına ulaştınız' 
            });
        }

        // Değerlendirmeyi ekle
        const result = await pool.query(
            'INSERT INTO reviews (customer_id, business_id, appointment_id, rating, comment) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [customerId, businessId, appointmentId, rating, comment]
        );

        res.status(201).json({ 
            message: 'Değerlendirme başarıyla eklendi',
            reviewId: result.rows[0].id
        });

    } catch (error) {
        console.error('Değerlendirme ekleme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Değerlendirme güncelleme endpoint'i
app.put('/api/reviews/:reviewId', authenticateToken, async (req, res) => {
    try {
        const { reviewId } = req.params;
        const { rating, comment } = req.body;
        const customerId = req.user.userId;

        // Değerlendirmenin varlığını ve kullanıcıya ait olduğunu kontrol et
        const reviewCheck = await pool.query(
            'SELECT id FROM reviews WHERE id = $1 AND customer_id = $2',
            [reviewId, customerId]
        );

        if (reviewCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Değerlendirme bulunamadı' });
        }

        // Değerlendirmeyi güncelle
        await pool.query(
            'UPDATE reviews SET rating = $1, comment = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
            [rating, comment, reviewId]
        );

        res.json({ message: 'Değerlendirme başarıyla güncellendi' });

    } catch (error) {
        console.error('Değerlendirme güncelleme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Değerlendirme silme endpoint'i
app.delete('/api/reviews/:reviewId', authenticateToken, async (req, res) => {
    try {
        const { reviewId } = req.params;
        const customerId = req.user.userId;

        // Değerlendirmenin varlığını ve kullanıcıya ait olduğunu kontrol et
        const reviewCheck = await pool.query(
            'SELECT id FROM reviews WHERE id = $1 AND customer_id = $2',
            [reviewId, customerId]
        );

        if (reviewCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Değerlendirme bulunamadı' });
        }

        // Değerlendirmeyi sil
        await pool.query(
            'DELETE FROM reviews WHERE id = $1',
            [reviewId]
        );

        res.json({ message: 'Değerlendirme başarıyla silindi' });

    } catch (error) {
        console.error('Değerlendirme silme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Müşteri sadakat puanlarını getir
app.get('/api/customer/loyalty-points', authenticateToken, async (req, res) => {
    try {
        const customerId = req.user.userId;

        let loyaltyData = await pool.query(
            'SELECT * FROM customer_loyalty_points WHERE customer_id = $1',
            [customerId]
        );

        if (loyaltyData.rows.length === 0) {
            // İlk kez kayıt oluştur
            await pool.query(
                'INSERT INTO customer_loyalty_points (customer_id) VALUES ($1)',
                [customerId]
            );
            
            loyaltyData = await pool.query(
                'SELECT * FROM customer_loyalty_points WHERE customer_id = $1',
                [customerId]
            );
        }

        res.json(loyaltyData.rows[0]);
    } catch (error) {
        console.error('Sadakat puanları getirme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// İndirim hakkını kullan
app.post('/api/customer/use-discount', authenticateToken, async (req, res) => {
    try {
        const customerId = req.user.userId;

        // Müşteriñin mevcut puanlarını kontrol et
        const loyaltyData = await pool.query(
            'SELECT * FROM customer_loyalty_points WHERE customer_id = $1',
            [customerId]
        );

        if (loyaltyData.rows.length === 0) {
            return res.status(404).json({ error: 'Sadakat puanı kaydı bulunamadı' });
        }

        const currentPoints = loyaltyData.rows[0].total_points || 0;

        // 40 puana ulaşmış mı kontrol et
        if (currentPoints < 40) {
            return res.status(400).json({ 
                error: 'İndirim hakkı için en az 40 puana ihtiyacınız var',
                currentPoints: currentPoints,
                requiredPoints: 40
            });
        }

        // Puanları sıfırla (40 puan harcanır)
        await pool.query(`
            UPDATE customer_loyalty_points 
            SET total_points = total_points - 40,
                last_updated = CURRENT_TIMESTAMP
            WHERE customer_id = $1
        `, [customerId]);

        // Güncellenmiş verileri getir
        const updatedLoyaltyData = await pool.query(
            'SELECT * FROM customer_loyalty_points WHERE customer_id = $1',
            [customerId]
        );

        res.json({
            message: 'İndirim hakkınız başarıyla kullanıldı! 100 TL indiriminiz aktif.',
            discountAmount: 100,
            remainingPoints: updatedLoyaltyData.rows[0].total_points,
            loyaltyData: updatedLoyaltyData.rows[0]
        });

    } catch (error) {
        console.error('İndirim kullanma hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Müşteri kuponlarını getir
app.get('/api/customer/coupons', authenticateToken, async (req, res) => {
    try {
        const customerId = req.user.userId;

        const result = await pool.query(
            'SELECT * FROM customer_coupons WHERE customer_id = $1 ORDER BY created_at DESC',
            [customerId]
        );

        res.json({ coupons: result.rows });
    } catch (error) {
        console.error('Kupon getirme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// İndirim kuponu oluştur (40 puan karşılığında)
app.post('/api/customer/create-loyalty-coupon', authenticateToken, async (req, res) => {
    try {
        const customerId = req.user.userId;
        const { discount_amount, description } = req.body;

        // Müşterinin mevcut puanlarını kontrol et
        const loyaltyData = await pool.query(
            'SELECT * FROM customer_loyalty_points WHERE customer_id = $1',
            [customerId]
        );

        if (loyaltyData.rows.length === 0) {
            return res.status(404).json({ error: 'Sadakat puanı kaydı bulunamadı' });
        }

        const currentPoints = loyaltyData.rows[0].total_points || 0;

        // 40 puana ulaşmış mı kontrol et
        if (currentPoints < 40) {
            return res.status(400).json({ 
                error: 'İndirim kuponu oluşturmak için en az 40 puana ihtiyacınız var',
                currentPoints: currentPoints,
                requiredPoints: 40
            });
        }

        // Kullanılmamış kupon var mı kontrol et
        const unusedCoupons = await pool.query(
            'SELECT COUNT(*) as count FROM customer_coupons WHERE customer_id = $1 AND used = false',
            [customerId]
        );

        if (parseInt(unusedCoupons.rows[0].count) > 0) {
            return res.status(400).json({ 
                error: 'Mevcut kullanılmamış kuponunuzu önce kullanmalısınız'
            });
        }

        // İndirim kuponunu oluştur
        const couponResult = await pool.query(
            'INSERT INTO customer_coupons (customer_id, discount_amount, description) VALUES ($1, $2, $3) RETURNING id',
            [customerId, discount_amount, description]
        );

        // Puanları düş (40 puan harcanır)
        await pool.query(`
            UPDATE customer_loyalty_points 
            SET total_points = total_points - 40,
                last_updated = CURRENT_TIMESTAMP
            WHERE customer_id = $1
        `, [customerId]);

        res.status(201).json({
            message: 'İndirim kuponunuz başarıyla oluşturuldu!',
            coupon: {
                id: couponResult.rows[0].id,
                discount_amount: discount_amount,
                description: description
            }
        });

    } catch (error) {
        console.error('Kupon oluşturma hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Randevu tamamlandığında sadakat puanını güncelle
async function updateLoyaltyPoints(customerId, appointmentAmount, appointmentId = null) {
    try {
        console.log('🎯 Sadakat puanı güncelleme başladı:', {
            customerId,
            appointmentAmount,
            appointmentId
        });

        // Kullanılmamış kupon var mı kontrol et
        const unusedCoupons = await pool.query(
            'SELECT COUNT(*) as count FROM customer_coupons WHERE customer_id = $1 AND used = false',
            [customerId]
        );

        const hasUnusedCoupons = parseInt(unusedCoupons.rows[0].count) > 0;
        console.log('🎫 Kullanılmamış kupon kontrolü:', {
            customerId,
            hasUnusedCoupons,
            couponCount: unusedCoupons.rows[0].count
        });

        // Eğer kullanılmamış kupon varsa, puan ekleme
        if (hasUnusedCoupons) {
            console.log(`🚫 Müşteri ${customerId} için kullanılmamış kupon bulundu, sadakat puanı eklenmiyor`);
            // Sadece harcama ve randevu sayısını güncelle
            await pool.query(`
                INSERT INTO customer_loyalty_points (customer_id, total_points, completed_appointments, total_spent)
                VALUES ($1, 0, 1, $2)
                ON CONFLICT (customer_id) 
                DO UPDATE SET 
                    completed_appointments = customer_loyalty_points.completed_appointments + 1,
                    total_spent = customer_loyalty_points.total_spent + $2,
                    last_updated = CURRENT_TIMESTAMP
            `, [customerId, appointmentAmount]);
            console.log('✅ Sadece harcama ve randevu sayısı güncellendi (kupon var)');
            return;
        }

        // 100 TL ve üzeri harcamalarda 10 puan ekle (kupon yoksa)
        if (appointmentAmount >= 100) {
            console.log(`💰 100 TL üzeri harcama (${appointmentAmount} TL), 10 puan ekleniyor`);
            await pool.query(`
                INSERT INTO customer_loyalty_points (customer_id, total_points, completed_appointments, total_spent)
                VALUES ($1, 10, 1, $2)
                ON CONFLICT (customer_id) 
                DO UPDATE SET 
                    total_points = customer_loyalty_points.total_points + 10,
                    completed_appointments = customer_loyalty_points.completed_appointments + 1,
                    total_spent = customer_loyalty_points.total_spent + $2,
                    last_updated = CURRENT_TIMESTAMP
            `, [customerId, appointmentAmount]);
            console.log('✅ 10 sadakat puanı eklendi');
        } else {
            console.log(`💸 100 TL altı harcama (${appointmentAmount} TL), puan eklenmiyor`);
            // 100 TL altında sadece harcama ve randevu sayısını güncelle
            await pool.query(`
                INSERT INTO customer_loyalty_points (customer_id, total_points, completed_appointments, total_spent)
                VALUES ($1, 0, 1, $2)
                ON CONFLICT (customer_id) 
                DO UPDATE SET 
                    completed_appointments = customer_loyalty_points.completed_appointments + 1,
                    total_spent = customer_loyalty_points.total_spent + $2,
                    last_updated = CURRENT_TIMESTAMP
            `, [customerId, appointmentAmount]);
            console.log('✅ Sadece harcama ve randevu sayısı güncellendi (100 TL altı)');
        }

        // Güncellenmiş sadakat puanlarını kontrol et
        const updatedPoints = await pool.query(
            'SELECT total_points, completed_appointments, total_spent FROM customer_loyalty_points WHERE customer_id = $1',
            [customerId]
        );
        console.log('📊 Güncellenmiş sadakat puanları:', updatedPoints.rows[0]);

    } catch (error) {
        console.error('❌ Sadakat puanı güncelleme hatası:', error);
    }
}

// İşletme değerlendirmelerini getirme endpoint'i
app.get('/api/businesses/:id/reviews', async (req, res) => {
    try {
        const businessId = req.params.id;
        
        const result = await pool.query(`
            SELECT 
                r.id,
                r.rating,
                r.comment,
                r.created_at,
                r.business_response,
                r.response_date,
                u.name as customer_name
            FROM reviews r
            JOIN users u ON r.customer_id = u.id
            WHERE r.business_id = $1
            ORDER BY r.created_at DESC
        `, [businessId]);

        // Ortalama puanı hesapla
        const avgResult = await pool.query(`
            SELECT 
                AVG(rating)::NUMERIC(3,2) as avg_rating,
                COUNT(*) as total_reviews
            FROM reviews 
            WHERE business_id = $1
        `, [businessId]);

        const avgRating = avgResult.rows[0].avg_rating || 0;
        const totalReviews = parseInt(avgResult.rows[0].total_reviews) || 0;

        res.json({
            reviews: result.rows,
            averageRating: parseFloat(avgRating),
            totalReviews
        });

    } catch (error) {
        console.error('Değerlendirmeler getirme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

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
                    a.business_id,
                    a.appointment_date as date,
                    a.status,
                    a.notes,
                    b.business_name,
                    s.name as service_name,
                    s.price,
                    r.name as resource_name
                FROM appointments a
                JOIN business_profiles b ON a.business_id = b.id
                LEFT JOIN services s ON a.service_id = s.id
                LEFT JOIN business_resources r ON a.resource_id = r.id
                WHERE a.customer_id = $1
                AND (
                    a.appointment_date < NOW()
                    OR a.status IN ('Tamamlandı', 'completed', 'İptal Edildi', 'cancelled', 'Gelmedi', 'noShow', 'Reddedildi', 'rejected')
                )
                ORDER BY a.appointment_date DESC
            `;
            params = [decoded.userId];
        } else {
            query = `
                SELECT 
                    a.id,
                    a.business_id,
                    a.appointment_date as date,
                    a.status,
                    a.notes,
                    u.name as "customerName",
                    s.name as "serviceName"
                FROM appointments a
                JOIN users u ON a.customer_id = u.id
                LEFT JOIN services s ON a.service_id = s.id
                WHERE a.business_id IN (
                    SELECT id FROM business_profiles WHERE user_id = $1
                )
                AND (
                    a.appointment_date < NOW()
                    OR a.status IN ('Tamamlandı', 'completed', 'İptal Edildi', 'cancelled', 'Gelmedi', 'noShow', 'Reddedildi', 'rejected')
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
                    a.notes,
                    a.selected_services,
                    b.business_name as "businessName",
                    s.name as "serviceName",
                    s.price as "servicePrice",
                    r.name as "resourceName"
                FROM appointments a
                JOIN business_profiles b ON a.business_id = b.id
                LEFT JOIN services s ON a.service_id = s.id
                LEFT JOIN business_resources r ON a.resource_id = r.id
                WHERE a.customer_id = $1 
                AND (
                    a.status = 'Onaylandı' AND a.appointment_date >= NOW()
                    OR a.status = 'Beklemede'
                    OR a.status = 'active' 
                    OR a.status = 'pending' 
                    OR a.status = 'confirmed'
                )
                AND a.status NOT IN ('Tamamlandı', 'completed')
                ORDER BY a.appointment_date ASC
            `;
            params = [decoded.userId];
        } else {
            query = `
                SELECT 
                    a.id,
                    a.appointment_date as date,
                    a.status,
                    a.notes,
                    a.selected_services,
                    u.name as "customerName",
                    u.phone as "customerPhone",
                    s.name as "serviceName",
                    s.price as "servicePrice",
                    r.name as "resourceName"
                FROM appointments a
                JOIN users u ON a.customer_id = u.id
                LEFT JOIN services s ON a.service_id = s.id
                LEFT JOIN business_resources r ON a.resource_id = r.id
                WHERE a.business_id IN (
                    SELECT id FROM business_profiles WHERE user_id = $1
                )
                AND (
                    a.status = 'Onaylandı' AND a.appointment_date >= NOW()
                    OR a.status = 'Beklemede'
                    OR a.status = 'active' 
                    OR a.status = 'pending' 
                    OR a.status = 'confirmed'
                )
                AND a.status NOT IN ('Tamamlandı', 'completed')
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
app.post('/api/appointments/:id/cancel', authenticateToken, async (req, res) => {
    try {
        const appointmentId = req.params.id;
        const userId = req.user.userId;

        // Randevunun varlığını ve kullanıcıya ait olduğunu kontrol et
        const checkQuery = `
            SELECT * FROM appointments 
            WHERE id = $1 
            AND (
                customer_id = $2 
                OR business_id IN (
                    SELECT id FROM business_profiles WHERE user_id = $2
                )
            )
        `;
        
        const checkResult = await pool.query(checkQuery, [appointmentId, userId]);
        
        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: 'Randevu bulunamadı' });
        }

        const appointment = checkResult.rows[0];
        
        // Sadece "Beklemede" durumundaki randevular iptal edilebilir
        if (appointment.status !== 'Beklemede') {
            return res.status(400).json({ 
                error: 'Sadece onay bekleyen randevular iptal edilebilir' 
            });
        }

        // Randevuyu iptal et
        await pool.query(
            'UPDATE appointments SET status = $1 WHERE id = $2',
            ['İptal Edildi', appointmentId]
        );

        res.json({ message: 'Randevu başarıyla iptal edildi' });
    } catch (error) {
        console.error('Randevu iptal hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Randevu detayları endpoint'i
app.get('/api/appointments/:id/details', authenticateToken, async (req, res) => {
    try {
        const appointmentId = req.params.id;
        const userId = req.user.userId;
        console.log('Randevu detayları isteniyor - ID:', appointmentId, 'User ID:', userId);

        // Randevunun varlığını ve kullanıcıya ait olduğunu kontrol et
        const query = `
            SELECT 
                a.id,
                a.appointment_date,
                a.status,
                a.notes,
                a.selected_services,
                b.business_name,
                b.id as business_id,
                s.name as service_name,
                s.price as service_price,
                r.name as resource_name,
                CASE 
                    WHEN rev.id IS NOT NULL THEN true 
                    ELSE false 
                END as has_review,
                CASE 
                    WHEN (a.status = 'Tamamlandı' OR a.status = 'completed') AND rev.id IS NULL THEN true
                    ELSE false 
                END as can_review
            FROM appointments a
            JOIN business_profiles b ON a.business_id = b.id
            LEFT JOIN services s ON a.service_id = s.id
            LEFT JOIN business_resources r ON a.resource_id = r.id
            LEFT JOIN reviews rev ON rev.appointment_id = a.id AND rev.customer_id = $2
            WHERE a.id = $1 AND a.customer_id = $2
        `;
        
        const result = await pool.query(query, [appointmentId, userId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Randevu bulunamadı' });
        }

        const appointment = result.rows[0];
        
        // Tarih ve saat bilgisini ayır
        const appointmentDetails = {
            ...appointment,
            time: new Date(appointment.appointment_date).toLocaleTimeString('tr-TR', {
                hour: '2-digit',
                minute: '2-digit'
            }),
            date: new Date(appointment.appointment_date).toISOString().split('T')[0]
        };

        res.json(appointmentDetails);
    } catch (error) {
        console.error('Randevu detayları hatası:', error);
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

// Randevular için endpoint
app.post('/api/appointments', authenticateToken, async (req, res) => {
    try {
        console.log('Randevu API çağrıldı');
        console.log('HTTP Headers:', req.headers);
        console.log('Request body:', req.body);
        
        const { businessId, date, time, resourceId, serviceId, selectedServices, note, couponId } = req.body;
        const userId = req.user.userId;
        
        console.log('Randevu oluşturma isteği:', { businessId, date, time, resourceId, serviceId, selectedServices, userId });
        
        if (!businessId || !date || !time) {
            console.log('Eksik bilgi:', { businessId, date, time });
            return res.status(400).json({ error: 'İşletme, tarih ve saat bilgileri zorunludur' });
        }
        
        // Çoklu hizmet desteği
        const servicesToProcess = selectedServices && selectedServices.length > 0 ? selectedServices : [];
        console.log('İşlenecek hizmetler:', servicesToProcess);
        console.log('selectedServices tipi:', typeof selectedServices);
        console.log('selectedServices Array mi?:', Array.isArray(selectedServices));
        
        // Eğer selectedServices boşsa, tek hizmet (serviceId) kullan
        if (servicesToProcess.length === 0 && serviceId) {
            servicesToProcess.push({ id: serviceId });
            console.log('Tek hizmet eklendi:', servicesToProcess);
        }
        
        // Servis kontrolü - eğer serviceId gönderilmişse onu kullan, yoksa varsayılan oluştur
        let finalServiceId;
        
        if (serviceId) {
            // Gönderilen serviceId'nin bu işletmeye ait olduğunu kontrol et
            const serviceCheck = await pool.query(
                'SELECT id FROM services WHERE id = $1 AND business_id = $2', 
                [serviceId, businessId]
            );
            
            if (serviceCheck.rows.length > 0) {
                finalServiceId = serviceId;
                console.log('Seçilen servis ID kullanılıyor:', finalServiceId);
            } else {
                console.log('Geçersiz servis ID, varsayılan servis aranıyor');
                finalServiceId = null;
            }
        }
        
        // Eğer serviceId yoksa veya geçersizse varsayılan servis bul/oluştur
        if (!finalServiceId) {
            const defaultServiceCheck = await pool.query('SELECT id FROM services WHERE business_id = $1 LIMIT 1', [businessId]);
            
            if (defaultServiceCheck.rows.length > 0) {
                finalServiceId = defaultServiceCheck.rows[0].id;
                console.log('Mevcut varsayılan servis ID:', finalServiceId);
            } else {
                // Varsayılan bir servis ekleme
                console.log('Varsayılan servis oluşturuluyor, işletme ID:', businessId);
                const serviceInsert = await pool.query(
                    'INSERT INTO services (business_id, name, duration, price, description) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                    [businessId, 'Standart Randevu', 60, 0, 'Otomatik oluşturulan randevu']
                );
                finalServiceId = serviceInsert.rows[0].id;
                console.log('Oluşturulan servis ID:', finalServiceId);
            }
        }
        
        // Tarih ve saati birleştir
        const appointmentDate = new Date(`${date}T${time}`);
        console.log('Oluşturulacak randevu tarihi:', appointmentDate);
        
        // ÇAKIŞMA KONTROLÜ: Aynı tarih, saat ve kaynakta başka randevu var mı kontrol et
        const conflictQuery = `
            SELECT id, status, customer_id 
            FROM appointments 
            WHERE business_id = $1 
            AND resource_id = $2 
            AND appointment_date = $3 
            AND status IN ('Beklemede', 'Onaylandı', 'confirmed', 'pending')
        `;
        
        const conflictResult = await pool.query(conflictQuery, [businessId, resourceId, appointmentDate]);
        
        if (conflictResult.rows.length > 0) {
            const existingAppointment = conflictResult.rows[0];
            console.log('Çakışan randevu bulundu:', existingAppointment);
            
            // Aynı müşteri aynı saat için ikinci kez randevu alıyorsa farklı mesaj
            if (existingAppointment.customer_id === userId) {
                return res.status(409).json({ 
                    error: 'Bu tarih ve saatte zaten bir randevunuz bulunmaktadır.' 
                });
            } else {
                return res.status(409).json({ 
                    error: 'Bu tarih ve saat için seçtiğiniz kaynak müsait değil. Lütfen başka bir saat seçin.' 
                });
            }
        }
        
        // Seçilen hizmetleri JSON olarak hazırla
        const selectedServicesJSON = servicesToProcess.length > 0 ? JSON.stringify(servicesToProcess) : null;
        console.log('Kaydedilecek hizmetler JSON:', selectedServicesJSON);
        
        // Randevu oluştur - selected_services alanını da ekle
        try {
            // Önce appointments tablosuna selected_services kolonu var mı kontrol et, yoksa ekle
            try {
                await pool.query('ALTER TABLE appointments ADD COLUMN IF NOT EXISTS selected_services JSONB');
                console.log('selected_services kolonu eklendi/mevcut');
            } catch (alterError) {
                console.log('Kolun eklerken hata (normal olabilir):', alterError.message);
            }
            
            // Toplam fiyatı hesapla
            let totalAmount = 0;
            
            // Önce işletmenin rezervasyon ücretini al
            const businessResult = await pool.query(
                'SELECT reservation_price FROM business_profiles WHERE id = $1',
                [businessId]
            );
            
            // Rezervasyon ücretini ekle
            if (businessResult.rows.length > 0 && businessResult.rows[0].reservation_price) {
                totalAmount += parseFloat(businessResult.rows[0].reservation_price);
                console.log('💰 Rezervasyon ücreti eklendi:', businessResult.rows[0].reservation_price);
            }
            
            // Seçilen hizmetlerin fiyatlarını ekle
            if (servicesToProcess && servicesToProcess.length > 0) {
                const servicesTotal = servicesToProcess.reduce((total, service) => {
                    const servicePrice = parseFloat(service.price || 0);
                    const quantity = service.quantity || 1;
                    return total + (servicePrice * quantity);
                }, 0);
                totalAmount += servicesTotal;
                console.log('💰 Hizmetler toplamı eklendi:', servicesTotal);
            }
            
            totalAmount = Math.round(totalAmount * 100) / 100;
            console.log('💰 Server: Final toplam fiyat:', totalAmount);

            // Kupon kontrolü ve uygulama
            let discountAmount = 0;
            let finalCouponId = null;
            
            if (couponId) {
                // Kuponun geçerliliğini kontrol et
                const couponResult = await pool.query(
                    'SELECT * FROM customer_coupons WHERE id = $1 AND customer_id = $2 AND used = false',
                    [couponId, userId]
                );

                if (couponResult.rows.length === 0) {
                    return res.status(400).json({ error: 'Geçersiz veya kullanılmış kupon' });
                }

                const coupon = couponResult.rows[0];
                discountAmount = coupon.discount_amount;

                // Minimum tutar kontrolü (180 TL)
                if (totalAmount < 180) {
                    return res.status(400).json({ 
                        error: 'İndirim kuponunu kullanabilmek için en az 180 TL\'lik hizmet seçmelisiniz',
                        currentTotal: totalAmount,
                        minimumRequired: 180
                    });
                }

                // İndirim tutarını düş
                totalAmount = Math.max(0, totalAmount - discountAmount);
                finalCouponId = couponId;

                // Kuponu kullanılmış olarak işaretle
                await pool.query(
                    'UPDATE customer_coupons SET used = true, used_date = CURRENT_TIMESTAMP WHERE id = $1',
                    [couponId]
                );

                console.log(`Kupon kullanıldı: ${coupon.description}, İndirim: ${discountAmount} TL`);
            }

            const result = await pool.query(
                'INSERT INTO appointments (customer_id, business_id, service_id, resource_id, appointment_date, status, notes, selected_services, total_amount, coupon_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, status',
                [userId, businessId, finalServiceId, resourceId, appointmentDate, 'Beklemede', note || null, selectedServicesJSON, totalAmount, finalCouponId]
            );
            
            console.log('Randevu oluşturma sonucu:', result.rows);
            
            res.status(201).json({ 
                success: true,
                message: 'Randevunuz başarıyla oluşturuldu',
                appointment: result.rows[0]
            });
        } catch (dbError) {
            console.error('SQL hatası:', dbError);
            
            // Sütun isimleriyle ilgili hata olabilir, alternatif sorgu dene
            console.log('Alternatif sorgu deneniyor...');
            // Toplam fiyatı hesapla
            let totalAmount = 0;
            
            // Önce işletmenin rezervasyon ücretini al
            const businessResult = await pool.query(
                'SELECT reservation_price FROM business_profiles WHERE id = $1',
                [businessId]
            );
            
            // Rezervasyon ücretini ekle
            if (businessResult.rows.length > 0 && businessResult.rows[0].reservation_price) {
                totalAmount += parseFloat(businessResult.rows[0].reservation_price);
                console.log('💰 (Alternatif) Rezervasyon ücreti eklendi:', businessResult.rows[0].reservation_price);
            }
            
            // Seçilen hizmetlerin fiyatlarını ekle
            if (servicesToProcess && servicesToProcess.length > 0) {
                const servicesTotal = servicesToProcess.reduce((total, service) => {
                    const servicePrice = parseFloat(service.price || 0);
                    const quantity = service.quantity || 1;
                    return total + (servicePrice * quantity);
                }, 0);
                totalAmount += servicesTotal;
                console.log('💰 (Alternatif) Hizmetler toplamı eklendi:', servicesTotal);
            }
            
            totalAmount = Math.round(totalAmount * 100) / 100;
            console.log('💰 Server (alternatif): Final toplam fiyat:', totalAmount);

            // Kupon kontrolü ve uygulama (alternatif sorgu için)
            let discountAmount = 0;
            let finalCouponId = null;
            
            if (couponId) {
                // Kuponun geçerliliğini kontrol et
                const couponResult = await pool.query(
                    'SELECT * FROM customer_coupons WHERE id = $1 AND customer_id = $2 AND used = false',
                    [couponId, userId]
                );

                if (couponResult.rows.length === 0) {
                    return res.status(400).json({ error: 'Geçersiz veya kullanılmış kupon' });
                }

                const coupon = couponResult.rows[0];
                discountAmount = coupon.discount_amount;

                // Minimum tutar kontrolü (180 TL)
                if (totalAmount < 180) {
                    return res.status(400).json({ 
                        error: 'İndirim kuponunu kullanabilmek için en az 180 TL\'lik hizmet seçmelisiniz',
                        currentTotal: totalAmount,
                        minimumRequired: 180
                    });
                }

                // İndirim tutarını düş
                totalAmount = Math.max(0, totalAmount - discountAmount);
                finalCouponId = couponId;

                // Kuponu kullanılmış olarak işaretle
                await pool.query(
                    'UPDATE customer_coupons SET used = true, used_date = CURRENT_TIMESTAMP WHERE id = $1',
                    [couponId]
                );

                console.log(`Kupon kullanıldı (alternatif): ${coupon.description}, İndirim: ${discountAmount} TL`);
            }

            const result = await pool.query(
                `INSERT INTO appointments 
                (customer_id, business_id, service_id, resource_id, appointment_date, status, notes, selected_services, total_amount, coupon_id) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
                RETURNING id, status`,
                [userId, businessId, finalServiceId, resourceId, appointmentDate, 'Beklemede', note || null, selectedServicesJSON, totalAmount, finalCouponId]
            );
            
            console.log('Alternatif sorgu sonucu:', result.rows);
            
            res.status(201).json({ 
                success: true,
                message: 'Randevunuz başarıyla oluşturuldu',
                appointment: result.rows[0]
            });
        }
    } catch (error) {
        console.error('Randevu oluşturma hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
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
    console.log('Token doğrulama çağrıldı');
    const authHeader = req.headers['authorization'];
    console.log('Auth Header:', authHeader);
    
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
        console.log('Token bulunamadı');
        return res.status(401).json({ error: 'Yetkilendirme gerekli' });
    }
    
    console.log('Token doğrulanıyor:', token.substring(0, 15) + '...');
    try {
        const user = jwt.verify(token, JWT_SECRET);
        console.log('Token geçerli, kullanıcı:', user);
        req.user = user;
        next();
    } catch (err) {
        console.log('Token doğrulama hatası:', err.message);
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token süresi doldu, lütfen yeniden giriş yapın' });
        }
        return res.status(403).json({ error: 'Geçersiz token: ' + err.message });
    }
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
        
        const { businessName, identityNumber, businessPhone, businessType, city, district, address, reservationPrice, businessDescription } = req.body;

        if (!identityNumber || !businessPhone || !businessType || !city || !district || !address || !reservationPrice) {
            return res.status(400).json({ error: 'Tüm alanları doldurunuz' });
        }

        // Rezervasyon ücreti minimum kontrolü
        const price = parseFloat(reservationPrice);
        if (price < 25) {
            return res.status(400).json({ error: 'Rezervasyon ücreti minimum 25 TL olmalıdır' });
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
                'INSERT INTO business_profiles (user_id, business_name, identity_number, business_phone, business_type, city, district, address, reservation_price, description, image_url, gallery_images) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *',
                [userId, businessName || '', identityNumber, businessPhone, businessType, city, district, address, reservationPrice, businessDescription || null, profileImageUrl, galleryImagesJson]
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

// Randevu geldi olarak işaretleme endpoint'i
app.post('/api/appointments/mark-attended', authenticateToken, async (req, res) => {
    try {
        const { id } = req.body;
        const userId = req.user.userId;
        
        console.log('Randevu geldi olarak işaretleme isteği:', { id, userId });
        
        if (!id) {
            return res.status(400).json({ error: 'Randevu ID bilgisi zorunludur' });
        }
        
        // Önce işletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        console.log('İşletme profili sorgusu sonucu:', businessResult.rows);
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Randevunun bu işletmeye ait olduğunu kontrol et
        const appointmentCheck = await pool.query(
            'SELECT id, status FROM appointments WHERE id = $1 AND business_id = $2',
            [id, businessId]
        );
        
        console.log('Randevu kontrol sorgusu sonucu:', appointmentCheck.rows);
        
        if (appointmentCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Randevu bulunamadı veya bu işletmeye ait değil' });
        }
        
        // Randevu durumunu güncelle - "Onaylandı" statüsünden sonra "Tamamlandı" olarak işaretle
        const updateResult = await pool.query(
            'UPDATE appointments SET status = $1 WHERE id = $2 RETURNING id, status, customer_id, total_amount',
            ['Tamamlandı', id]
        );
        
        console.log('Randevu güncelleme sonucu:', updateResult.rows);
        
        // Sadakat puanını güncelle
        const appointment = updateResult.rows[0];
        if (appointment) {
            await updateLoyaltyPoints(appointment.customer_id, appointment.total_amount || 0);
        }
        
        res.json({
            success: true,
            message: 'Randevu geldi olarak işaretlendi',
            appointment: updateResult.rows[0]
        });
    } catch (error) {
        console.error('Randevu işaretleme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
    }
});

// Randevu gelmedi olarak işaretleme endpoint'i
app.post('/api/appointments/mark-not-attended', authenticateToken, async (req, res) => {
    try {
        const { id } = req.body;
        const userId = req.user.userId;
        
        console.log('Randevu gelmedi olarak işaretleme isteği:', { id, userId });
        
        if (!id) {
            return res.status(400).json({ error: 'Randevu ID bilgisi zorunludur' });
        }
        
        // Önce işletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        console.log('İşletme profili sorgusu sonucu:', businessResult.rows);
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Randevunun bu işletmeye ait olduğunu kontrol et
        const appointmentCheck = await pool.query(
            'SELECT id, status FROM appointments WHERE id = $1 AND business_id = $2',
            [id, businessId]
        );
        
        console.log('Randevu kontrol sorgusu sonucu:', appointmentCheck.rows);
        
        if (appointmentCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Randevu bulunamadı veya bu işletmeye ait değil' });
        }
        
        // Randevu durumunu güncelle - statüsü "Gelmedi" olarak işaretle
        const updateResult = await pool.query(
            'UPDATE appointments SET status = $1 WHERE id = $2 RETURNING id, status',
            ['Gelmedi', id]
        );
        
        console.log('Randevu güncelleme sonucu:', updateResult.rows);
        
        res.json({
            success: true,
            message: 'Randevu gelmedi olarak işaretlendi',
            appointment: updateResult.rows[0]
        });
    } catch (error) {
        console.error('Randevu işaretleme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
    }
});

// ... (rest of the code remains unchanged)

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
        
        // Her işletme için hizmetleri de getir
        const businessesWithServices = await Promise.all(
            result.rows.map(async (business) => {
                try {
                    // İşletmenin hizmetlerini kategorilerle birlikte getir
                    const servicesResult = await pool.query(`
                        SELECT 
                            s.id, 
                            s.name, 
                            s.description, 
                            s.duration, 
                            s.price,
                            c.id as category_id,
                            c.name as category_name,
                            c.color as category_color
                        FROM services s
                        LEFT JOIN categories c ON s.category_id = c.id
                        WHERE s.business_id = $1
                        ORDER BY c.name NULLS LAST, s.name
                    `, [business.id]);
                    
                    // Hizmetleri business objesine ekle
                    business.services = servicesResult.rows;
                    
                    console.log(`İşletme ${business.business_name} için ${servicesResult.rows.length} hizmet bulundu:`, servicesResult.rows);
                    
                    return business;
                } catch (serviceError) {
                    console.error(`İşletme ${business.id} için hizmet getirme hatası:`, serviceError);
                    business.services = [];
                    return business;
                }
            })
        );
        
        res.json({ businesses: businessesWithServices });
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
        
        // İşletmenin hizmetlerini kategorilerle birlikte getir
        try {
            const servicesResult = await pool.query(`
                SELECT 
                    s.id, 
                    s.name, 
                    s.description, 
                    s.duration, 
                    s.price,
                    c.id as category_id,
                    c.name as category_name,
                    c.color as category_color
                FROM services s
                LEFT JOIN categories c ON s.category_id = c.id
                WHERE s.business_id = $1
                ORDER BY c.name NULLS LAST, s.name
            `, [businessId]);
            
            business.services = servicesResult.rows;
            console.log(`İşletme ${business.business_name} için ${servicesResult.rows.length} hizmet bulundu:`, servicesResult.rows);
        } catch (serviceError) {
            console.error(`İşletme ${businessId} için hizmet getirme hatası:`, serviceError);
            business.services = [];
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

// Randevu onaylama endpoint'i
app.post('/api/appointments/approve', authenticateToken, async (req, res) => {
    try {
        const { id } = req.body;
        const userId = req.user.userId;
        
        console.log('Randevu onaylama isteği:', { id, userId });
        
        if (!id) {
            return res.status(400).json({ error: 'Randevu ID bilgisi zorunludur' });
        }
        
        // Önce işletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        console.log('İşletme profili sorgusu sonucu:', businessResult.rows);
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Randevunun bu işletmeye ait olduğunu kontrol et
        const appointmentCheck = await pool.query(
            'SELECT id, status FROM appointments WHERE id = $1 AND business_id = $2',
            [id, businessId]
        );
        
        console.log('Randevu kontrol sorgusu sonucu:', appointmentCheck.rows);
        
        if (appointmentCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Randevu bulunamadı veya bu işletmeye ait değil' });
        }
        
        // Randevu durumunu güncelle
        const updateResult = await pool.query(
            'UPDATE appointments SET status = $1 WHERE id = $2 RETURNING id, status',
            ['Onaylandı', id]
        );
        
        console.log('Randevu güncelleme sonucu:', updateResult.rows);
        
        res.json({
            success: true,
            message: 'Randevu başarıyla onaylandı',
            appointment: updateResult.rows[0]
        });
    } catch (error) {
        console.error('Randevu onaylama hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
    }
});

// Randevu reddetme endpoint'i
app.post('/api/appointments/reject', authenticateToken, async (req, res) => {
    try {
        const { id } = req.body;
        const userId = req.user.userId;
        
        console.log('Randevu reddetme isteği:', { id, userId });
        
        if (!id) {
            return res.status(400).json({ error: 'Randevu ID bilgisi zorunludur' });
        }
        
        // Önce işletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        console.log('İşletme profili sorgusu sonucu:', businessResult.rows);
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Randevunun bu işletmeye ait olduğunu kontrol et
        const appointmentCheck = await pool.query(
            'SELECT id, status FROM appointments WHERE id = $1 AND business_id = $2',
            [id, businessId]
        );
        
        console.log('Randevu kontrol sorgusu sonucu:', appointmentCheck.rows);
        
        if (appointmentCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Randevu bulunamadı veya bu işletmeye ait değil' });
        }
        
        // Randevu durumunu güncelle
        const updateResult = await pool.query(
            'UPDATE appointments SET status = $1 WHERE id = $2 RETURNING id, status',
            ['Reddedildi', id]
        );
        
        console.log('Randevu güncelleme sonucu:', updateResult.rows);
        
        res.json({
            success: true,
            message: 'Randevu başarıyla reddedildi',
            appointment: updateResult.rows[0]
        });
    } catch (error) {
        console.error('Randevu reddetme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
    }
});

// Randevu "Gelmedi" olarak işaretleme endpoint'i
app.post('/api/appointments/no-show', authenticateToken, async (req, res) => {
    try {
        const { id } = req.body;
        const userId = req.user.userId;
        
        console.log('Randevu gelmedi işaretleme isteği:', { id, userId });
        
        if (!id) {
            return res.status(400).json({ error: 'Randevu ID bilgisi zorunludur' });
        }
        
        // Önce işletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Randevunun bu işletmeye ait olduğunu kontrol et
        const appointmentCheck = await pool.query(
            'SELECT id, status FROM appointments WHERE id = $1 AND business_id = $2',
            [id, businessId]
        );
        
        if (appointmentCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Randevu bulunamadı veya bu işletmeye ait değil' });
        }
        
        // Randevu durumunu güncelle
        const updateResult = await pool.query(
            'UPDATE appointments SET status = $1 WHERE id = $2 RETURNING id, status',
            ['Gelmedi', id]
        );
        
        console.log('Randevu gelmedi güncelleme sonucu:', updateResult.rows);
        
        res.json({
            success: true,
            message: 'Randevu "Gelmedi" olarak işaretlendi',
            appointment: updateResult.rows[0]
        });
    } catch (error) {
        console.error('Randevu gelmedi işaretleme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
    }
});

// Randevu "Tamamlandı" olarak işaretleme endpoint'i
app.post('/api/appointments/complete', authenticateToken, async (req, res) => {
    try {
        const { id } = req.body;
        const userId = req.user.userId;
        
        console.log('Randevu tamamlandı işaretleme isteği:', { id, userId });
        
        if (!id) {
            return res.status(400).json({ error: 'Randevu ID bilgisi zorunludur' });
        }
        
        // Önce işletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Randevunun bu işletmeye ait olduğunu kontrol et
        const appointmentCheck = await pool.query(
            'SELECT id, status, customer_id, total_amount FROM appointments WHERE id = $1 AND business_id = $2',
            [id, businessId]
        );
        
        if (appointmentCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Randevu bulunamadı veya bu işletmeye ait değil' });
        }
        
        // Randevu durumunu güncelle
        const updateResult = await pool.query(
            'UPDATE appointments SET status = $1 WHERE id = $2 RETURNING id, status, customer_id, total_amount',
            ['Tamamlandı', id]
        );
        
        console.log('Randevu tamamlandı güncelleme sonucu:', updateResult.rows);
        
        // Sadakat puanını güncelle
        const appointment = updateResult.rows[0];
        if (appointment) {
            console.log('Sadakat puanı güncelleniyor:', {
                customerId: appointment.customer_id,
                totalAmount: appointment.total_amount
            });
            await updateLoyaltyPoints(appointment.customer_id, appointment.total_amount || 0);
        }
        
        res.json({
            success: true,
            message: 'Randevu "Tamamlandı" olarak işaretlendi',
            appointment: updateResult.rows[0]
        });
    } catch (error) {
        console.error('Randevu tamamlandı işaretleme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
    }
});

// İşletme çalışma saatlerini kaydetme endpoint'i
app.post('/api/business/schedule', authenticateToken, async (req, res) => {
    try {
        const { schedule } = req.body;
        const userId = req.user.userId;
        
        console.log('Çalışma saatleri kaydetme isteği:', { userId, scheduleCount: schedule.length });
        
        if (!schedule || !Array.isArray(schedule)) {
            return res.status(400).json({ error: 'Geçersiz çalışma saatleri verisi' });
        }
        
        // Önce işletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // İşletmenin mevcut çalışma saatlerini sil
        await pool.query(
            'DELETE FROM business_schedule WHERE business_id = $1',
            [businessId]
        );
        
        // Yeni çalışma saatlerini ekle
        for (const day of schedule) {
            await pool.query(
                `INSERT INTO business_schedule 
                (business_id, day_of_week, is_working, start_time, end_time) 
                VALUES ($1, $2, $3, $4, $5)`,
                [businessId, day.day_of_week, day.is_working, day.start_time, day.end_time]
            );
        }
        
        res.json({ message: 'Çalışma saatleri başarıyla güncellendi' });
    } catch (error) {
        console.error('Çalışma saatleri kaydetme hatası:', error);
        res.status(500).json({ error: 'Çalışma saatleri güncellenirken bir hata oluştu' });
    }
});

// İşletme çalışma saatlerini getirme endpoint'i
app.get('/api/business/schedule', authenticateToken, async (req, res) => {
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
        
        // Çalışma saatlerini getir
        const scheduleResult = await pool.query(
            'SELECT day_of_week, is_working, start_time, end_time FROM business_schedule WHERE business_id = $1 ORDER BY day_of_week',
            [businessId]
        );
        
        res.json(scheduleResult.rows);
    } catch (error) {
        console.error('Çalışma saatleri getirme hatası:', error);
        res.status(500).json({ error: 'Çalışma saatleri getirilirken bir hata oluştu' });
    }
});

// İşletme çalışma saatlerini müşteri için getirme endpoint'i
app.get('/api/business/schedule/public', async (req, res) => {
    try {
        const rawBusinessId = req.query.businessId;
        
        console.log(`Müşteri için çalışma saatleri isteniyor - Ham ID: ${rawBusinessId}`);
        
        if (!rawBusinessId) {
            console.log('İşletme ID parametresi eksik');
            return res.status(400).json({ error: 'İşletme ID\'si gereklidir' });
        }
        
        // String ID'yi sayıya dönüştür
        const businessId = parseInt(rawBusinessId, 10);
        
        if (isNaN(businessId)) {
            console.log(`Geçersiz işletme ID formatı: "${rawBusinessId}"`);
            return res.status(400).json({ error: 'Geçersiz işletme ID formatı' });
        }
        
        console.log(`Müşteri için çalışma saatleri sorgulanıyor - İşletme ID: ${businessId}`);
        
        // Önce işletmenin var olup olmadığını kontrol et
        const businessCheck = await pool.query(
            'SELECT id FROM business_profiles WHERE id = $1',
            [businessId]
        );
        
        if (businessCheck.rows.length === 0) {
            console.log(`İşletme bulunamadı, ID: ${businessId}`);
            return res.status(404).json({ error: 'İşletme bulunamadı' });
        }
        
        // Çalışma saatlerini getir
        const scheduleResult = await pool.query(
            'SELECT day_of_week, is_working, start_time, end_time FROM business_schedule WHERE business_id = $1 ORDER BY day_of_week',
            [businessId]
        );
        
        console.log(`Bulunan çalışma saatleri: ${scheduleResult.rows.length} kayıt, İşletme ID: ${businessId}`);
        
        // Sorgu sonuçlarını incele
        if (scheduleResult.rows.length > 0) {
            console.log('İlk kayıt örneği:', scheduleResult.rows[0]);
        }
        
        // Hiç kayıt yoksa varsayılan çalışma saatlerini döndür
        if (scheduleResult.rows.length === 0) {
            console.log(`Kayıtlı çalışma saati bulunamadı, İşletme ID: ${businessId}, varsayılan değerler kullanılıyor`);
            const defaultSchedule = [
                { day_of_week: 0, is_working: true, start_time: '09:00', end_time: '17:00' },
                { day_of_week: 1, is_working: true, start_time: '09:00', end_time: '17:00' },
                { day_of_week: 2, is_working: true, start_time: '09:00', end_time: '17:00' },
                { day_of_week: 3, is_working: true, start_time: '09:00', end_time: '17:00' },
                { day_of_week: 4, is_working: true, start_time: '09:00', end_time: '17:00' },
                { day_of_week: 5, is_working: false, start_time: '09:00', end_time: '17:00' },
                { day_of_week: 6, is_working: false, start_time: '09:00', end_time: '17:00' }
            ];
            return res.json(defaultSchedule);
        }
        
        // Veritabanından gelen is_working değerini Boolean'a çevir
        const formattedSchedule = scheduleResult.rows.map(day => ({
            ...day,
            is_working: day.is_working === true || day.is_working === 't' || day.is_working === true
        }));
        
        console.log('Müşteriye gönderilen çalışma saatleri formatı:', formattedSchedule[0]);
        res.json(formattedSchedule);
    } catch (error) {
        console.error('Müşteri için çalışma saatleri getirme hatası:', error);
        res.status(500).json({ error: 'Çalışma saatleri getirilirken bir hata oluştu' });
    }
});

// İşletme kaynakları için API endpoint'leri (işletme sahipleri için)
app.get('/api/business/resources', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        
        console.log('İşletme kaynakları isteği, kullanıcı ID:', userId);
        
        // Önce kullanıcının işletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id, business_type FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        console.log('İşletme profili sorgusu sonucu:', businessResult.rows);
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // İşletmeye ait kaynakları getir
        const resourcesResult = await pool.query(
            'SELECT id, name, resource_type, status, created_at FROM business_resources WHERE business_id = $1 ORDER BY created_at DESC',
            [businessId]
        );
        
        console.log('Kaynaklar sorgusu sonucu:', resourcesResult.rows.length, 'kaynak bulundu');
        
        res.json({
            businessType: businessResult.rows[0].business_type,
            resources: resourcesResult.rows
        });
    } catch (error) {
        console.error('Kaynakları getirme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
    }
});

app.post('/api/business/resources', authenticateToken, async (req, res) => {
    try {
        const { name, resourceType } = req.body;
        const userId = req.user.userId;
        
        if (!name) {
            return res.status(400).json({ error: 'Kaynak adı gereklidir' });
        }
        
        // Önce kullanıcının işletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id, business_type FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        const businessType = businessResult.rows[0].business_type;
        
        // İşletme türüne göre varsayılan kaynak türünü belirle
        let defaultResourceType = 'generic';
        switch(businessType) {
            case 'kuafor':
            case 'berber':
                defaultResourceType = 'koltuk';
                break;
            case 'klinik':
                defaultResourceType = 'oda';
                break;
            case 'restoran':
                defaultResourceType = 'masa';
                break;
            case 'spor':
                defaultResourceType = 'saha';
                break;
        }
        
        // Yeni kaynağı ekle
        const result = await pool.query(
            'INSERT INTO business_resources (business_id, name, resource_type, status) VALUES ($1, $2, $3, $4) RETURNING id, name, resource_type, status, created_at',
            [businessId, name, resourceType || defaultResourceType, 'active']
        );
        
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Kaynak ekleme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
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
        res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
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
        res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
    }
});

// Kaynak bazlı randevu sayılarını getiren endpoint
app.get('/api/business/resource-appointments/count', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        console.log('Randevu sayıları isteniyor, kullanıcı ID:', userId);
        
        // Önce işletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        console.log('İşletme ID:', businessId);
        
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
        
        console.log('Randevu sayıları sorgusu sonucu:', result.rows);
        
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
        res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
    }
});

// Belirli bir kaynağa ait randevuları getiren endpoint
app.get('/api/business/resource-appointments/:resourceId', authenticateToken, async (req, res) => {
    try {
        const { resourceId } = req.params;
        const userId = req.user.userId;
        
        console.log('Kaynak randevuları isteniyor, kaynak ID:', resourceId);
        
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
        
        // Sadece aktif süreçteki randevuları getir (Beklemede ve Onaylandı)
        const result = await pool.query(`
            SELECT 
                a.*, 
                u.name as customer_name, 
                u.phone as customer_phone, 
                s.name as service_name, 
                s.price as service_price,
                a.selected_services,
                a.notes,
                r.name as resource_name
            FROM appointments a
            JOIN users u ON a.customer_id = u.id
            LEFT JOIN services s ON a.service_id = s.id
            LEFT JOIN business_resources r ON a.resource_id = r.id
            WHERE a.business_id = $1 AND a.resource_id = $2
            AND a.status IN ('Beklemede', 'Onaylandı')
            ORDER BY a.appointment_date ASC
        `, [businessId, resourceId]);
        
        console.log('Kaynak randevuları sorgusu sonucu:', result.rows.length, 'randevu bulundu');
        
        // Çoklu hizmet desteği için verileri işle
        const processedAppointments = await Promise.all(result.rows.map(async (appointment) => {
            console.log('📋 Appointment verisi:', appointment.id, appointment.selected_services);
            console.log('📋 selected_services tipi:', typeof appointment.selected_services);
            console.log('📋 selected_services değeri (ilk 100 karakter):', String(appointment.selected_services).substring(0, 100));
            
            // Eğer selected_services varsa, hizmet bilgilerini al
            if (appointment.selected_services) {
                try {
                    // Eğer zaten object ise doğrudan kullan
                    let selectedServices;
                    if (typeof appointment.selected_services === 'object') {
                        selectedServices = appointment.selected_services;
                        console.log('✅ selected_services zaten object:', selectedServices);
                    } else if (typeof appointment.selected_services === 'string') {
                        if (appointment.selected_services.startsWith('[object')) {
                            console.log('❌ selected_services [object Object] string, atlanıyor');
                            return appointment;
                        }
                        selectedServices = JSON.parse(appointment.selected_services);
                        console.log('✅ selected_services string\'den parse edildi:', selectedServices);
                    } else {
                        console.log('❌ Bilinmeyen selected_services tipi:', typeof appointment.selected_services);
                        return appointment;
                    }
                    
                    // Sadece sayısal ID'leri al (standard hariç)
                    const serviceIds = selectedServices
                        .map(s => s.id)
                        .filter(id => id !== 'standard' && !isNaN(parseInt(id)));
                    
                    console.log('🔍 Veritabanında aranacak service ID\'ler:', serviceIds);
                    
                    let serviceDetails = [];
                    if (serviceIds.length > 0) {
                        const servicesQuery = await pool.query(
                            'SELECT id, name, price FROM services WHERE id = ANY($1)',
                            [serviceIds]
                        );
                        serviceDetails = servicesQuery.rows;
                        console.log('🔍 Bulunan hizmet detayları:', serviceDetails);
                    }
                    
                    // Hizmet isimlerini ve toplam fiyatı hesapla
                    let serviceNames = [];
                    let totalPrice = 0;
                    
                    selectedServices.forEach(selectedService => {
                        console.log('🔍 İşlenen hizmet:', selectedService);
                        
                        // Standart randevu kontrolü
                        if (selectedService.id === 'standard') {
                            serviceNames.push('Standart Randevu');
                            totalPrice += parseFloat(selectedService.price) || 0;
                            console.log('✅ Standart randevu eklendi:', selectedService.price);
                            return;
                        }
                        
                        const serviceDetail = serviceDetails.find(sd => sd.id == selectedService.id);
                        if (serviceDetail) {
                            // Miktar bilgisi varsa kullan
                            const quantity = selectedService.quantity || 1;
                            const serviceName = quantity > 1 ? `${serviceDetail.name} (${quantity}x)` : serviceDetail.name;
                            serviceNames.push(serviceName);
                            totalPrice += (parseFloat(serviceDetail.price) || 0) * quantity;
                            console.log('✅ Hizmet eklendi:', serviceName, 'Fiyat:', serviceDetail.price, 'Miktar:', quantity);
                        } else {
                            console.log('❌ Hizmet detayı bulunamadı, ID:', selectedService.id);
                        }
                    });
                    
                    console.log('🎯 Final hizmet isimleri:', serviceNames);
                    console.log('🎯 Final toplam fiyat:', totalPrice);
                    
                    // Güncellenmiş hizmet bilgilerini randevuya ekle
                    appointment.service_name = serviceNames.length > 0 ? serviceNames.join(', ') : 'Hizmet belirtilmemiş';
                    appointment.service_price = totalPrice;
                    appointment.selected_services_details = selectedServices;
                } catch (parseError) {
                    console.error('Selected services parse hatası:', parseError);
                }
            }
            
            return appointment;
        }));
        
        res.json(processedAppointments);
    } catch (error) {
        console.error('Kaynak randevuları getirme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
    }
});

// İletişim bilgilerini güncelleme endpoint'i
app.post('/api/user/update-contact', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'Yetkilendirme gerekli' });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        const { email, phone } = req.body;
        
        // Gerekli alanların kontrolü
        if (!email || !phone) {
            return res.status(400).json({ error: 'E-posta ve telefon bilgileri gereklidir' });
        }
        
        // E-posta formatı kontrolü
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Geçerli bir e-posta adresi giriniz' });
        }
        
        // Telefon numarası formatı kontrolü
        const phoneRegex = /^[0-9]{10}$/;
        if (!phoneRegex.test(phone)) {
            return res.status(400).json({ error: 'Geçerli bir telefon numarası giriniz (10 haneli ve sadece rakamlardan oluşmalı)' });
        }

        // E-posta ve telefon numarasının başka kullanıcıda olup olmadığını kontrol et
        const duplicateCheck = await pool.query(
            'SELECT * FROM users WHERE (email = $1 OR phone = $2) AND id != $3',
            [email, phone, decoded.userId]
        );

        if (duplicateCheck.rows.length > 0) {
            // Hangi bilginin çakıştığını kontrol et
            const duplicate = duplicateCheck.rows[0];
            if (duplicate.email === email) {
                return res.status(400).json({ error: 'Bu e-posta adresi başka bir kullanıcı tarafından kullanılıyor' });
            }
            if (duplicate.phone === phone) {
                return res.status(400).json({ error: 'Bu telefon numarası başka bir kullanıcı tarafından kullanılıyor' });
            }
        }

        // Kullanıcı bilgilerini güncelle
        await pool.query(
            'UPDATE users SET email = $1, phone = $2 WHERE id = $3',
            [email, phone, decoded.userId]
        );

        // Güncellenmiş kullanıcı bilgilerini getir
        const userResult = await pool.query(
            'SELECT id, name, email, phone, role FROM users WHERE id = $1',
            [decoded.userId]
        );

        const updatedUser = userResult.rows[0];

        // Yeni token oluştur
        const newToken = jwt.sign(
            { userId: updatedUser.id, role: updatedUser.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            message: 'İletişim bilgileri başarıyla güncellendi',
            token: newToken,
            user: updatedUser
        });
    } catch (error) {
        console.error('İletişim bilgileri güncelleme hatası:', error);
        
        // Özel hata mesajları
        if (error.code === '23505') { // Unique constraint violation
            if (error.constraint.includes('email')) {
                return res.status(400).json({ error: 'Bu e-posta adresi başka bir kullanıcı tarafından kullanılıyor' });
            } else if (error.constraint.includes('phone')) {
                return res.status(400).json({ error: 'Bu telefon numarası başka bir kullanıcı tarafından kullanılıyor' });
            }
        }
        
        res.status(500).json({ error: 'Sunucu hatası' });
    }
});

// Geçmiş randevuları getiren endpoint
app.get('/api/business/past-appointments', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { page = 1, pageSize = 10, dateFilter = 'all', statusFilter = 'all' } = req.query;
        
        console.log('Geçmiş randevular isteği alındı:', req.query);
        
        // Önce işletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Tarih filtresi için sorgu koşulları
        let dateCondition = '';
        
        switch(dateFilter) {
            case 'today':
                dateCondition = "AND DATE(a.appointment_date) = CURRENT_DATE";
                break;
            case 'yesterday':
                dateCondition = "AND DATE(a.appointment_date) = CURRENT_DATE - INTERVAL '1 day'";
                break;
            case 'lastWeek':
                dateCondition = "AND a.appointment_date >= CURRENT_DATE - INTERVAL '7 days'";
                break;
            case 'lastMonth':
                dateCondition = "AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days'";
                break;
            default:
                dateCondition = '';
        }
        
        // Durum filtresi için sorgu koşulları
        let statusCondition = '';
        
        switch(statusFilter) {
            case 'completed':
            case 'Tamamlandı':
                statusCondition = "AND (a.status = 'completed' OR a.status = 'Tamamlandı')";
                break;
            case 'cancelled':
            case 'İptal Edildi':
                statusCondition = "AND (a.status = 'cancelled' OR a.status = 'İptal Edildi')";
                break;
            case 'noShow':
            case 'Gelmedi':
                statusCondition = "AND (a.status = 'noShow' OR a.status = 'Gelmedi')";
                break;
            case 'rejected':
            case 'Reddedildi':
                statusCondition = "AND (a.status = 'rejected' OR a.status = 'Reddedildi')";
                break;
            case 'pending':
            case 'Beklemede':
                statusCondition = "AND (a.status = 'pending' OR a.status = 'Beklemede')";
                break;
            case 'confirmed':
            case 'Onaylandı':
                statusCondition = "AND (a.status = 'confirmed' OR a.status = 'Onaylandı')";
                break;
            default:
                statusCondition = '';
        }
        
        console.log('Filtre koşulları:', { dateCondition, statusCondition });
        
        // Toplam randevu sayısını al
        const countQuery = `
            SELECT COUNT(*) as total
            FROM appointments a
            WHERE a.business_id = $1
            ${dateCondition}
            ${statusCondition}
        `;
        
        const countResult = await pool.query(countQuery, [businessId]);
        const total = parseInt(countResult.rows[0].total);
        
        console.log('Toplam randevu sayısı:', total);
        
        // Sayfalama için sınırları hesapla
        const offset = (parseInt(page) - 1) * parseInt(pageSize);
        const limit = parseInt(pageSize);
        
        // Randevuları getir
        const appointmentsQuery = `
            SELECT 
                a.id,
                a.appointment_date as date,
                TO_CHAR(a.appointment_date, 'HH24:MI') as time,
                a.status,
                a.notes,
                a.selected_services,
                a.total_amount,
                u.name as "customerName",
                u.phone as "customerPhone",
                r.name as "resourceName"
            FROM appointments a
            JOIN users u ON a.customer_id = u.id
            LEFT JOIN business_resources r ON a.resource_id = r.id
            WHERE a.business_id = $1
            ${dateCondition}
            ${statusCondition}
            ORDER BY a.appointment_date DESC
            LIMIT $2 OFFSET $3
        `;
        
        console.log('Randevular sorgusu:', appointmentsQuery.replace(/\s+/g, ' '));
        
        const appointmentsResult = await pool.query(appointmentsQuery, [businessId, limit, offset]);
        
        console.log(`${appointmentsResult.rows.length} randevu bulundu`);
        
        // Randevu verilerini işle ve hizmet bilgilerini ekle
        const processedAppointments = appointmentsResult.rows.map(appointment => {
            let serviceName = 'Hizmet belirtilmemiş';
            let servicePrice = appointment.total_amount || 0;
            
            // selected_services alanını parse et
            if (appointment.selected_services) {
                try {
                    const services = JSON.parse(appointment.selected_services);
                    if (services && services.length > 0) {
                        // İlk hizmeti ana hizmet olarak göster
                        serviceName = services[0].name;
                        
                        // Eğer birden fazla hizmet varsa, toplam sayıyı göster
                        if (services.length > 1) {
                            serviceName += ` (+${services.length - 1} hizmet daha)`;
                        }
                        
                        // Toplam fiyatı hesapla
                        servicePrice = services.reduce((total, service) => {
                            const price = parseFloat(service.price) || 0;
                            const quantity = parseInt(service.quantity) || 1;
                            return total + (price * quantity);
                        }, 0);
                    }
                } catch (error) {
                    console.error('selected_services parse hatası:', error);
                }
            }
            
            return {
                ...appointment,
                serviceName,
                servicePrice
            };
        });
        
        // Sonuç
        res.json({
            appointments: processedAppointments,
            totalCount: total,
            page: parseInt(page),
            pageSize: parseInt(pageSize),
            pageCount: Math.ceil(total / pageSize),
            hasNextPage: offset + limit < total
        });
    } catch (error) {
        console.error('Geçmiş randevuları getirme hatası:', error);
        res.status(500).json({ error: 'Sunucu hatası: ' + error.message });
    }
});

// İşletme hizmetleri API endpoint'i
app.get('/api/business/services', authenticateToken, async (req, res) => {
    try {
        // Kullanıcıya ait işletme ID'sini bul
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [req.user.userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Hizmetleri getir
        const servicesResult = await pool.query(
            'SELECT s.*, c.name as category_name, c.color as category_color FROM services s LEFT JOIN categories c ON s.category_id = c.id WHERE s.business_id = $1 ORDER BY c.name, s.created_at DESC',
            [businessId]
        );
        
        res.json(servicesResult.rows);
    } catch (error) {
        console.error('Hizmetler alınırken hata:', error);
        res.status(500).json({ error: 'Hizmetler alınamadı' });
    }
});

// Yeni hizmet ekleme endpoint'i
app.post('/api/business/services', authenticateToken, async (req, res) => {
    try {
        const { name, price, duration, categoryId } = req.body;
        
        if (!name || price === undefined) {
            return res.status(400).json({ error: 'Hizmet adı ve fiyat bilgisi zorunludur' });
        }
        
        // Kullanıcıya ait işletme ID'sini bul
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [req.user.userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Eğer kategori ID verilmişse, bu kategorinin işletmeye ait olduğunu kontrol et
        if (categoryId) {
            const categoryCheck = await pool.query(
                'SELECT id FROM categories WHERE id = $1 AND business_id = $2',
                [categoryId, businessId]
            );
            
            if (categoryCheck.rows.length === 0) {
                return res.status(400).json({ error: 'Geçersiz kategori ID' });
            }
        }
        
        // Hizmet ekle - Süre belirtilmemişse varsayılan olarak 0 kullan
        const serviceDuration = duration !== undefined ? duration : 0;
        
        const insertResult = await pool.query(
            'INSERT INTO services (business_id, name, duration, price, category_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [businessId, name, serviceDuration, price, categoryId || null]
        );
        
        res.status(201).json(insertResult.rows[0]);
    } catch (error) {
        console.error('Hizmet eklenirken hata:', error);
        res.status(500).json({ error: 'Hizmet eklenemedi' });
    }
});

// Hizmet güncelleme endpoint'i
app.put('/api/business/services/:id', authenticateToken, async (req, res) => {
    try {
        const serviceId = req.params.id;
        const { name, price, duration, categoryId } = req.body;
        
        if (!name || price === undefined ) {
            return res.status(400).json({ error: 'Hizmet adı ve fiyat bilgisi zorunludur' });
        }
        
        // Kullanıcıya ait işletme ID'sini bul
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [req.user.userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Eğer kategori ID verilmişse, bu kategorinin işletmeye ait olduğunu kontrol et
        if (categoryId) {
            const categoryCheck = await pool.query(
                'SELECT id FROM categories WHERE id = $1 AND business_id = $2',
                [categoryId, businessId]
            );
            
            if (categoryCheck.rows.length === 0) {
                return res.status(400).json({ error: 'Geçersiz kategori ID' });
            }
        }
        
        // Hizmetin işletmeye ait olup olmadığını kontrol et
        const checkResult = await pool.query(
            'SELECT id FROM services WHERE id = $1 AND business_id = $2',
            [serviceId, businessId]
        );
        
        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: 'Hizmet bulunamadı veya bu işletmeye ait değil' });
        }
        
        // Süre belirtilmemişse varsayılan olarak 0 kullan
        const serviceDuration = duration !== undefined ? duration : 0;
        
        // Hizmeti güncelle
        const updateResult = await pool.query(
            'UPDATE services SET name = $1, price = $2, duration = $3, category_id = $4 WHERE id = $5 AND business_id = $6 RETURNING *',
            [name, price, serviceDuration, categoryId || null, serviceId, businessId]
        );
        
        res.json(updateResult.rows[0]);
    } catch (error) {
        console.error('Hizmet güncellenirken hata:', error);
        res.status(500).json({ error: 'Hizmet güncellenemedi' });
    }
});

// Hizmet silme endpoint'i
app.delete('/api/business/services/:id', authenticateToken, async (req, res) => {
    try {
        const serviceId = req.params.id;
        
        // Kullanıcıya ait işletme ID'sini bul
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [req.user.userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Hizmetin işletmeye ait olup olmadığını kontrol et
        const checkResult = await pool.query(
            'SELECT id FROM services WHERE id = $1 AND business_id = $2',
            [serviceId, businessId]
        );
        
        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: 'Hizmet bulunamadı veya bu işletmeye ait değil' });
        }
        
        // Hizmeti sil (soft delete)
        await pool.query(
            'DELETE FROM services WHERE id = $1 AND business_id = $2',
            [serviceId, businessId]
        );
        
        res.json({ message: 'Hizmet başarıyla silindi' });
    } catch (error) {
        console.error('Hizmet silinirken hata:', error);
        res.status(500).json({ error: 'Hizmet silinemedi' });
    }
});

// ===== KATEGORİ YÖNETİMİ API ENDPOINT'LERİ =====

// Kategorileri listeleme endpoint'i
app.get('/api/business/categories', authenticateToken, async (req, res) => {
    try {
        // Kullanıcıya ait işletme ID'sini bul
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [req.user.userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Kategorileri getir
        const categoriesResult = await pool.query(
            'SELECT * FROM categories WHERE business_id = $1 ORDER BY created_at DESC',
            [businessId]
        );
        
        res.json(categoriesResult.rows);
    } catch (error) {
        console.error('Kategoriler alınırken hata:', error);
        res.status(500).json({ error: 'Kategoriler alınamadı' });
    }
});

// Yeni kategori ekleme endpoint'i
app.post('/api/business/categories', authenticateToken, async (req, res) => {
    try {
        const { name, description, color } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: 'Kategori adı zorunludur' });
        }
        
        // Kullanıcıya ait işletme ID'sini bul
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [req.user.userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Kategori ekle
        const insertResult = await pool.query(
            'INSERT INTO categories (business_id, name, description, color) VALUES ($1, $2, $3, $4) RETURNING *',
            [businessId, name, description || null, color || '#007bff']
        );
        
        res.status(201).json(insertResult.rows[0]);
    } catch (error) {
        console.error('Kategori eklenirken hata:', error);
        res.status(500).json({ error: 'Kategori eklenemedi' });
    }
});

// Kategori güncelleme endpoint'i
app.put('/api/business/categories/:id', authenticateToken, async (req, res) => {
    try {
        const categoryId = req.params.id;
        const { name, description, color } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: 'Kategori adı zorunludur' });
        }
        
        // Kullanıcıya ait işletme ID'sini bul
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [req.user.userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Kategorinin işletmeye ait olup olmadığını kontrol et
        const checkResult = await pool.query(
            'SELECT id FROM categories WHERE id = $1 AND business_id = $2',
            [categoryId, businessId]
        );
        
        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: 'Kategori bulunamadı veya bu işletmeye ait değil' });
        }
        
        // Kategoriyi güncelle
        const updateResult = await pool.query(
            'UPDATE categories SET name = $1, description = $2, color = $3 WHERE id = $4 AND business_id = $5 RETURNING *',
            [name, description || null, color || '#007bff', categoryId, businessId]
        );
        
        res.json(updateResult.rows[0]);
    } catch (error) {
        console.error('Kategori güncellenirken hata:', error);
        res.status(500).json({ error: 'Kategori güncellenemedi' });
    }
});

// Kategori silme endpoint'i
app.delete('/api/business/categories/:id', authenticateToken, async (req, res) => {
    try {
        const categoryId = req.params.id;
        
        // Kullanıcıya ait işletme ID'sini bul
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [req.user.userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Kategorinin işletmeye ait olup olmadığını kontrol et
        const checkResult = await pool.query(
            'SELECT id FROM categories WHERE id = $1 AND business_id = $2',
            [categoryId, businessId]
        );
        
        if (checkResult.rows.length === 0) {
            return res.status(404).json({ error: 'Kategori bulunamadı veya bu işletmeye ait değil' });
        }
        
        // Bu kategoriye ait hizmet var mı kontrol et
        const serviceCheckResult = await pool.query(
            'SELECT COUNT(*) as count FROM services WHERE category_id = $1',
            [categoryId]
        );
        
        if (parseInt(serviceCheckResult.rows[0].count) > 0) {
            return res.status(400).json({ 
                error: 'Bu kategoriye ait hizmetler bulunuyor. Önce hizmetleri başka kategorilere taşıyın veya silin.' 
            });
        }
        
        // Kategoriyi sil
        await pool.query(
            'DELETE FROM categories WHERE id = $1 AND business_id = $2',
            [categoryId, businessId]
        );
        
        res.json({ message: 'Kategori başarıyla silindi' });
    } catch (error) {
        console.error('Kategori silinirken hata:', error);
        res.status(500).json({ error: 'Kategori silinemedi' });
    }
});

// ===== MESAJLAŞMA API ENDPOINT'LERİ =====

// Randevuya ait mesajları getirme endpoint'i
app.get('/api/messages/:appointmentId', authenticateToken, async (req, res) => {
    try {
        const { appointmentId } = req.params;
        const userId = req.user.userId;
        
        console.log('Mesajlar isteniyor, randevu ID:', appointmentId, 'kullanıcı ID:', userId);
        
        // Kullanıcının bu randevuya erişim yetkisi var mı kontrol et
        let accessQuery;
        let accessParams;
        
        if (req.user.role === 'customer') {
            accessQuery = 'SELECT id FROM appointments WHERE id = $1 AND customer_id = $2';
            accessParams = [appointmentId, userId];
        } else {
            accessQuery = `
                SELECT a.id FROM appointments a 
                JOIN business_profiles bp ON a.business_id = bp.id 
                WHERE a.id = $1 AND bp.user_id = $2
            `;
            accessParams = [appointmentId, userId];
        }
        
        const accessCheck = await pool.query(accessQuery, accessParams);
        
        if (accessCheck.rows.length === 0) {
            return res.status(403).json({ error: 'Bu randevuya erişim yetkiniz yok' });
        }
        
        // Mesajları getir
        const messagesResult = await pool.query(`
            SELECT 
                m.*,
                u.name as sender_name,
                u.role as sender_role
            FROM messages m
            JOIN users u ON m.sender_id = u.id
            WHERE m.appointment_id = $1
            ORDER BY m.created_at ASC
        `, [appointmentId]);
        
        // Okunmamış mesajları okundu olarak işaretle
        await pool.query(`
            UPDATE messages 
            SET is_read = TRUE 
            WHERE appointment_id = $1 AND receiver_id = $2 AND is_read = FALSE
        `, [appointmentId, userId]);
        
        res.json(messagesResult.rows);
    } catch (error) {
        console.error('Mesajları getirme hatası:', error);
        res.status(500).json({ error: 'Mesajlar getirilemedi' });
    }
});

// Yeni mesaj gönderme endpoint'i
app.post('/api/messages', authenticateToken, async (req, res) => {
    try {
        const { appointmentId, message } = req.body;
        const senderId = req.user.userId;
        
        console.log('Yeni mesaj gönderiliyor:', { appointmentId, senderId, messageLength: message?.length });
        
        if (!appointmentId || !message || message.trim().length === 0) {
            return res.status(400).json({ error: 'Randevu ID ve mesaj içeriği gereklidir' });
        }
        
        // Randevu bilgilerini al ve alıcıyı belirle
        let appointmentQuery;
        if (req.user.role === 'customer') {
            appointmentQuery = `
                SELECT 
                    a.id, 
                    a.customer_id, 
                    bp.user_id as business_owner_id
                FROM appointments a 
                JOIN business_profiles bp ON a.business_id = bp.id 
                WHERE a.id = $1 AND a.customer_id = $2
            `;
        } else {
            appointmentQuery = `
                SELECT 
                    a.id, 
                    a.customer_id, 
                    bp.user_id as business_owner_id
                FROM appointments a 
                JOIN business_profiles bp ON a.business_id = bp.id 
                WHERE a.id = $1 AND bp.user_id = $2
            `;
        }
        
        const appointmentResult = await pool.query(appointmentQuery, [appointmentId, senderId]);
        
        if (appointmentResult.rows.length === 0) {
            return res.status(403).json({ error: 'Bu randevuya mesaj gönderme yetkiniz yok' });
        }
        
        const appointment = appointmentResult.rows[0];
        const receiverId = req.user.role === 'customer' 
            ? appointment.business_owner_id 
            : appointment.customer_id;
        
        // Mesajı kaydet
        const messageResult = await pool.query(`
            INSERT INTO messages (appointment_id, sender_id, receiver_id, message)
            VALUES ($1, $2, $3, $4)
            RETURNING *
        `, [appointmentId, senderId, receiverId, message.trim()]);
        
        // Gönderen bilgileriyle birlikte mesajı döndür
        const messageWithSender = await pool.query(`
            SELECT 
                m.*,
                u.name as sender_name,
                u.role as sender_role
            FROM messages m
            JOIN users u ON m.sender_id = u.id
            WHERE m.id = $1
        `, [messageResult.rows[0].id]);
        
        res.status(201).json(messageWithSender.rows[0]);
    } catch (error) {
        console.error('Mesaj gönderme hatası:', error);
        res.status(500).json({ error: 'Mesaj gönderilemedi' });
    }
});

// Okunmamış mesaj sayısını getirme endpoint'i
app.get('/api/messages/unread/:appointmentId', authenticateToken, async (req, res) => {
    try {
        const { appointmentId } = req.params;
        const userId = req.user.userId;
        
        const unreadCount = await pool.query(`
            SELECT COUNT(*) as count
            FROM messages 
            WHERE appointment_id = $1 AND receiver_id = $2 AND is_read = FALSE
        `, [appointmentId, userId]);
        
        res.json({ unreadCount: parseInt(unreadCount.rows[0].count) });
    } catch (error) {
        console.error('Okunmamış mesaj sayısı hatası:', error);
        res.status(500).json({ error: 'Okunmamış mesaj sayısı alınamadı' });
    }
});

// Son 24 saat içinde onaylanan randevuları getirme endpoint'i
app.get('/api/appointments/recent-approved', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        
        if (req.user.role !== 'customer') {
            return res.status(403).json({ error: 'Bu endpoint sadece müşteriler için' });
        }
        
        const query = `
            SELECT 
                a.id,
                a.appointment_date as date,
                a.status,
                a.updated_at,
                b.business_name as "businessName"
            FROM appointments a
            JOIN business_profiles b ON a.business_id = b.id
            WHERE a.customer_id = $1 
            AND a.status = 'Onaylandı'
            AND a.updated_at >= NOW() - INTERVAL '24 hours'
            ORDER BY a.updated_at DESC
        `;
        
        const result = await pool.query(query, [userId]);
        res.json(result.rows);
    } catch (error) {
        console.error('Son onaylanan randevular hatası:', error);
        res.status(500).json({ error: 'Son onaylanan randevular alınamadı' });
    }
});

// Son 24 saat içinde durum değişen randevuları getirme endpoint'i
app.get('/api/appointments/recent-status-changes', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        
        if (req.user.role !== 'customer') {
            return res.status(403).json({ error: 'Bu endpoint sadece müşteriler için' });
        }
        
        const query = `
            SELECT 
                a.id,
                a.appointment_date as date,
                a.status,
                a.created_at as updated_at,
                b.business_name as "businessName"
            FROM appointments a
            JOIN business_profiles b ON a.business_id = b.id
            WHERE a.customer_id = $1 
            AND a.status IN ('Onaylandı', 'Reddedildi')
            AND a.created_at >= NOW() - INTERVAL '24 hours'
            ORDER BY a.created_at DESC
        `;
        
        const result = await pool.query(query, [userId]);
        res.json(result.rows);
    } catch (error) {
        console.error('Son durum değişen randevular hatası:', error);
        res.status(500).json({ error: 'Son durum değişen randevular alınamadı' });
    }
});

// Mesajları okundu olarak işaretleme endpoint'i
app.post('/api/messages/mark-read/:appointmentId', authenticateToken, async (req, res) => {
    try {
        const { appointmentId } = req.params;
        const userId = req.user.userId;

        // Kullanıcının almış olduğu mesajları okundu olarak işaretle
        await pool.query(
            'UPDATE messages SET is_read = true WHERE appointment_id = $1 AND receiver_id = $2',
            [appointmentId, userId]
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Mesaj okundu işaretleme hatası:', error);
        res.status(500).json({ error: 'Mesajlar okundu olarak işaretlenemedi' });
    }
});

// Port dinleme
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server ${PORT} portunda çalışıyor...`);
});

// Belirli bir tarih ve kaynak için dolu saatleri getiren endpoint
app.get('/api/business/occupied-slots', async (req, res) => {
    try {
        const { businessId, date, resourceId } = req.query;
        
        console.log('Dolu saatler isteniyor:', { businessId, date, resourceId });
        
        if (!businessId || !date) {
            return res.status(400).json({ error: 'İşletme ID ve tarih gereklidir' });
        }
        
        // Seçili tarih için randevuları kontrol et
        let query = `
            SELECT 
                DATE_PART('hour', appointment_date) as hour,
                DATE_PART('minute', appointment_date) as minute,
                TO_CHAR(appointment_date, 'HH24:MI') as time_slot,
                status
            FROM appointments 
            WHERE business_id = $1 
            AND DATE(appointment_date) = $2
            AND status IN ('Beklemede', 'Onaylandı', 'confirmed', 'pending')
        `;
        
        const params = [businessId, date];
        
        // Eğer kaynak belirtildiyse, sadece o kaynağa ait randevuları getir
        if (resourceId) {
            query += ` AND resource_id = $3`;
            params.push(resourceId);
        }
        
        query += ` ORDER BY appointment_date`;
        
        console.log('Dolu saatler sorgusu:', query);
        console.log('Parametreler:', params);
        
        const result = await pool.query(query, params);
        
        console.log(`${result.rows.length} adet dolu saat bulundu:`, result.rows);
        
        // Dolu saatleri sadece saat:dakika formatında döndür
        const occupiedSlots = result.rows.map(row => row.time_slot);
        
        res.json({ occupiedSlots });
    } catch (error) {
        console.error('Dolu saatler getirme hatası:', error);
        res.status(500).json({ error: 'Dolu saatler getirilirken bir hata oluştu' });
    }
});

// Engellenen saatleri getiren endpoint
app.get('/api/business/blocked-slots', authenticateToken, async (req, res) => {
    try {
        const { resourceId, date } = req.query;
        
        console.log('Engellenen saatler isteniyor:', { resourceId, date });
        
        if (!resourceId || !date) {
            return res.status(400).json({ error: 'Kaynak ID ve tarih gereklidir' });
        }
        
        // Kullanıcıya ait işletme ID'sini bul
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [req.user.userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Engellenen saatleri getir
        const result = await pool.query(`
            SELECT TO_CHAR(blocked_time, 'HH24:MI') as time_slot
            FROM blocked_slots 
            WHERE business_id = $1 
            AND resource_id = $2 
            AND blocked_date = $3
            ORDER BY blocked_time
        `, [businessId, resourceId, date]);
        
        console.log(`${result.rows.length} adet engellenen saat bulundu:`, result.rows);
        
        const blockedSlots = result.rows.map(row => row.time_slot);
        
        res.json({ blockedSlots });
    } catch (error) {
        console.error('Engellenen saatler getirme hatası:', error);
        res.status(500).json({ error: 'Engellenen saatler getirilirken bir hata oluştu' });
    }
});

// Engellenen saatleri kaydetme endpoint'i
app.post('/api/business/blocked-slots', authenticateToken, async (req, res) => {
    try {
        const { resourceId, date, blockedSlots } = req.body;
        
        console.log('Engellenen saatler kaydediliyor:', { resourceId, date, blockedSlots });
        
        if (!resourceId || !date || !Array.isArray(blockedSlots)) {
            return res.status(400).json({ error: 'Kaynak ID, tarih ve engellenen saatler listesi gereklidir' });
        }
        
        // Kullanıcıya ait işletme ID'sini bul
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [req.user.userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Kaynağın işletmeye ait olup olmadığını kontrol et
        const resourceCheck = await pool.query(
            'SELECT id FROM business_resources WHERE id = $1 AND business_id = $2',
            [resourceId, businessId]
        );
        
        if (resourceCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Kaynak bulunamadı veya bu işletmeye ait değil' });
        }
        
        // Transaction başlat
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            
            // Önce o tarih için mevcut engellenen saatleri sil
            await client.query(
                'DELETE FROM blocked_slots WHERE business_id = $1 AND resource_id = $2 AND blocked_date = $3',
                [businessId, resourceId, date]
            );
            
            // Yeni engellenen saatleri ekle
            for (const timeSlot of blockedSlots) {
                await client.query(
                    'INSERT INTO blocked_slots (business_id, resource_id, blocked_date, blocked_time) VALUES ($1, $2, $3, $4)',
                    [businessId, resourceId, date, timeSlot]
                );
            }
            
            await client.query('COMMIT');
            
            console.log('Engellenen saatler başarıyla kaydedildi');
            res.json({ message: 'Engellenen saatler başarıyla kaydedildi', blockedSlots });
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
        
    } catch (error) {
        console.error('Engellenen saatler kaydetme hatası:', error);
        res.status(500).json({ error: 'Engellenen saatler kaydedilemedi' });
    }
});

// Müşteri tarafından randevu alırken engellenen saatleri kontrol eden endpoint
app.get('/api/business/blocked-slots/public', async (req, res) => {
    try {
        const { businessId, resourceId, date } = req.query;
        
        console.log('Public engellenen saatler isteniyor:', { businessId, resourceId, date });
        
        if (!businessId || !resourceId || !date) {
            return res.status(400).json({ error: 'İşletme ID, kaynak ID ve tarih gereklidir' });
        }
        
        // Engellenen saatleri getir
        const result = await pool.query(`
            SELECT TO_CHAR(blocked_time, 'HH24:MI') as time_slot
            FROM blocked_slots 
            WHERE business_id = $1 
            AND resource_id = $2 
            AND blocked_date = $3
            ORDER BY blocked_time
        `, [businessId, resourceId, date]);
        
        console.log(`${result.rows.length} adet engellenen saat bulundu:`, result.rows);
        
        const blockedSlots = result.rows.map(row => row.time_slot);
        
        res.json({ blockedSlots });
    } catch (error) {
        console.error('Public engellenen saatler getirme hatası:', error);
        res.status(500).json({ error: 'Engellenen saatler getirilirken bir hata oluştu' });
    }
});

// Kullanıcının yaptığı değerlendirmeleri getiren endpoint
app.get('/api/user/reviews', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        
        const result = await pool.query(`
            SELECT 
                r.id,
                r.rating,
                r.comment,
                r.created_at,
                bp.business_name
            FROM reviews r
            JOIN business_profiles bp ON r.business_id = bp.id
            WHERE r.customer_id = $1
            ORDER BY r.created_at DESC
        `, [userId]);
        
        res.json(result.rows);
    } catch (error) {
        console.error('Kullanıcı değerlendirmeleri getirme hatası:', error);
        res.status(500).json({ error: 'Değerlendirmeler getirilirken bir hata oluştu' });
    }
});

// Değerlendirme güncelleme endpoint'i
app.put('/api/reviews/:reviewId', authenticateToken, async (req, res) => {
    try {
        const { reviewId } = req.params;
        const { rating, comment } = req.body;
        const userId = req.user.userId;

        if (!rating || !comment) {
            return res.status(400).json({ error: 'Puan ve yorum gereklidir' });
        }

        if (rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'Puan 1-5 arasında olmalıdır' });
        }

        // Değerlendirmenin kullanıcıya ait olup olmadığını kontrol et
        const reviewCheck = await pool.query(
            'SELECT id FROM reviews WHERE id = $1 AND customer_id = $2',
            [reviewId, userId]
        );

        if (reviewCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Değerlendirme bulunamadı veya size ait değil' });
        }

        // Değerlendirmeyi güncelle
        const result = await pool.query(
            'UPDATE reviews SET rating = $1, comment = $2 WHERE id = $3 AND customer_id = $4 RETURNING *',
            [rating, comment, reviewId, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Değerlendirme güncellenemedi' });
        }

        res.json({ message: 'Değerlendirme başarıyla güncellendi', review: result.rows[0] });
    } catch (error) {
        console.error('Değerlendirme güncelleme hatası:', error);
        res.status(500).json({ error: 'Değerlendirme güncellenirken bir hata oluştu' });
    }
});

// Değerlendirme silme endpoint'i
app.delete('/api/reviews/:reviewId', authenticateToken, async (req, res) => {
    try {
        const { reviewId } = req.params;
        const userId = req.user.userId;

        // Değerlendirmenin kullanıcıya ait olup olmadığını kontrol et
        const reviewCheck = await pool.query(
            'SELECT id FROM reviews WHERE id = $1 AND customer_id = $2',
            [reviewId, userId]
        );

        if (reviewCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Değerlendirme bulunamadı veya size ait değil' });
        }

        // Değerlendirmeyi sil
        const result = await pool.query(
            'DELETE FROM reviews WHERE id = $1 AND customer_id = $2',
            [reviewId, userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Değerlendirme silinemedi' });
        }

        res.json({ message: 'Değerlendirme başarıyla silindi' });
    } catch (error) {
        console.error('Değerlendirme silme hatası:', error);
        res.status(500).json({ error: 'Değerlendirme silinirken bir hata oluştu' });
    }
});

// İşletme değerlendirmelerini getiren endpoint
app.get('/api/business/reviews', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;
        const ratingFilter = req.query.rating;
        const responseFilter = req.query.response_status;
        const dateFilter = req.query.date;
        
        // İşletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // WHERE koşullarını oluştur
        let whereConditions = ['r.business_id = $1'];
        let queryParams = [businessId];
        let paramIndex = 2;
        
        if (ratingFilter) {
            whereConditions.push(`r.rating = $${paramIndex}`);
            queryParams.push(ratingFilter);
            paramIndex++;
        }
        
        if (responseFilter === 'responded') {
            whereConditions.push('r.business_response IS NOT NULL');
        } else if (responseFilter === 'not_responded') {
            whereConditions.push('r.business_response IS NULL');
        }
        
        if (dateFilter) {
            whereConditions.push(`DATE(r.created_at) = $${paramIndex}`);
            queryParams.push(dateFilter);
            paramIndex++;
        }
        
        const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
        
        // Toplam sayıyı hesapla
        const countQuery = `
            SELECT COUNT(*) as total
            FROM reviews r
            JOIN users u ON r.customer_id = u.id
            ${whereClause}
        `;
        
        const totalResult = await pool.query(countQuery, queryParams);
        const totalCount = parseInt(totalResult.rows[0].total);
        const totalPages = Math.ceil(totalCount / limit);
        
        // Değerlendirmeleri getir
        const reviewsQuery = `
            SELECT 
                r.id,
                r.rating,
                r.comment,
                r.business_response,
                r.is_reported,
                r.created_at,
                u.name as customer_name,
                u.email as customer_email
            FROM reviews r
            JOIN users u ON r.customer_id = u.id
            ${whereClause}
            ORDER BY r.created_at DESC
            LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
        `;
        
        queryParams.push(limit, offset);
        const reviewsResult = await pool.query(reviewsQuery, queryParams);
        
        // İstatistikleri hesapla
        const statsQuery = `
            SELECT 
                COUNT(*) as total,
                AVG(rating) as average,
                COUNT(CASE WHEN business_response IS NOT NULL THEN 1 END) as responded,
                COUNT(CASE WHEN is_reported = true THEN 1 END) as reported
            FROM reviews 
            WHERE business_id = $1
        `;
        
        const statsResult = await pool.query(statsQuery, [businessId]);
        const stats = statsResult.rows[0];
        
        res.json({
            reviews: reviewsResult.rows,
            currentPage: page,
            totalPages: totalPages,
            totalCount: totalCount,
            stats: {
                total: parseInt(stats.total),
                average: parseFloat(stats.average) || 0,
                responded: parseInt(stats.responded),
                reported: parseInt(stats.reported)
            }
        });
        
    } catch (error) {
        console.error('İşletme değerlendirmeleri getirme hatası:', error);
        res.status(500).json({ error: 'Değerlendirmeler getirilirken bir hata oluştu' });
    }
});

// Değerlendirmeye yanıt verme endpoint'i
app.post('/api/business/reviews/:reviewId/response', authenticateToken, async (req, res) => {
    try {
        const { reviewId } = req.params;
        const { response } = req.body;
        const userId = req.user.userId;
        
        if (!response || response.trim() === '') {
            return res.status(400).json({ error: 'Yanıt metni gereklidir' });
        }
        
        // İşletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Değerlendirmenin bu işletmeye ait olup olmadığını kontrol et
        const reviewCheck = await pool.query(
            'SELECT id FROM reviews WHERE id = $1 AND business_id = $2',
            [reviewId, businessId]
        );
        
        if (reviewCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Değerlendirme bulunamadı veya bu işletmeye ait değil' });
        }
        
        // Yanıtı kaydet
        const result = await pool.query(
            'UPDATE reviews SET business_response = $1, response_date = NOW() WHERE id = $2 RETURNING *',
            [response.trim(), reviewId]
        );
        
        res.json({ 
            message: 'Yanıt başarıyla kaydedildi',
            review: result.rows[0]
        });
        
    } catch (error) {
        console.error('Değerlendirme yanıtlama hatası:', error);
        res.status(500).json({ error: 'Yanıt kaydedilirken bir hata oluştu' });
    }
});

// Değerlendirme yanıtını silme endpoint'i
app.delete('/api/business/reviews/:reviewId/response', authenticateToken, async (req, res) => {
    try {
        const { reviewId } = req.params;
        const userId = req.user.userId;
        
        // İşletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Değerlendirmenin bu işletmeye ait olup olmadığını kontrol et
        const reviewCheck = await pool.query(
            'SELECT id FROM reviews WHERE id = $1 AND business_id = $2',
            [reviewId, businessId]
        );
        
        if (reviewCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Değerlendirme bulunamadı veya bu işletmeye ait değil' });
        }
        
        // Yanıtı sil
        const result = await pool.query(
            'UPDATE reviews SET business_response = NULL, response_date = NULL WHERE id = $1 RETURNING *',
            [reviewId]
        );
        
        res.json({ 
            message: 'Yanıt başarıyla silindi',
            review: result.rows[0]
        });
        
    } catch (error) {
        console.error('Değerlendirme yanıtı silme hatası:', error);
        res.status(500).json({ error: 'Yanıt silinirken bir hata oluştu' });
    }
});

// Değerlendirmeyi bildirim endpoint'i
app.post('/api/business/reviews/:reviewId/report', authenticateToken, async (req, res) => {
    try {
        const { reviewId } = req.params;
        const { reason } = req.body;
        const userId = req.user.userId;
        
        // İşletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Değerlendirmenin bu işletmeye ait olup olmadığını kontrol et
        const reviewCheck = await pool.query(
            'SELECT id FROM reviews WHERE id = $1 AND business_id = $2',
            [reviewId, businessId]
        );
        
        if (reviewCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Değerlendirme bulunamadı veya bu işletmeye ait değil' });
        }
        
        // Değerlendirmeyi bildirildi olarak işaretle
        const result = await pool.query(
            'UPDATE reviews SET is_reported = true, report_reason = $1, report_date = NOW() WHERE id = $2 RETURNING *',
            [reason || '', reviewId]
        );
        
        res.json({ 
            message: 'Değerlendirme başarıyla bildirildi',
            review: result.rows[0]
        });
        
    } catch (error) {
        console.error('Değerlendirme bildirme hatası:', error);
        res.status(500).json({ error: 'Bildirim gönderilirken bir hata oluştu' });
    }
});

// Uygun randevu saatlerini getiren endpoint (mobil için)
app.get('/api/business/:businessId/available-times', async (req, res) => {
    try {
        const { businessId } = req.params;
        const { date, resourceId } = req.query;
        
        if (!businessId || !date || !resourceId) {
            return res.status(400).json({ error: 'İşletme ID, tarih ve kaynak ID gereklidir' });
        }
        
        // Tarihi parse et
        const requestedDate = new Date(date);
        console.log('📅 Gelen tarih:', date, 'Parse edildi:', requestedDate);
        
        if (isNaN(requestedDate.getTime())) {
            console.error('❌ Geçersiz tarih formatı:', date);
            return res.status(400).json({ error: 'Geçersiz tarih formatı' });
        }
        
        const dayOfWeek = requestedDate.getDay(); // 0: Pazar, 1: Pazartesi, ... 6: Cumartesi
        // PostgreSQL formatına çevir (0: Pazartesi, 1: Salı, ... 6: Pazar)
        const pgDayOfWeek = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        console.log('📅 Gün hesaplaması - JS dayOfWeek:', dayOfWeek, 'PG dayOfWeek:', pgDayOfWeek);
        
        // İşletmenin o gün çalışıp çalışmadığını kontrol et
        const scheduleResult = await pool.query(
            'SELECT is_working, start_time, end_time FROM business_schedule WHERE business_id = $1 AND day_of_week = $2',
            [businessId, pgDayOfWeek]
        );
        
        console.log('📅 Schedule sorgu sonucu:', scheduleResult.rows);
        
        // Eğer o gün için kayıt yoksa veya çalışmıyorsa
        if (scheduleResult.rows.length === 0) {
            console.log('⚠️ Bu işletme için çalışma saatleri tanımlanmamış, varsayılan saatler kullanılıyor');
            // Varsayılan çalışma saatleri ile kontrol et
            const defaultSchedule = {
                is_working: pgDayOfWeek < 5, // Pazartesi-Cuma çalışıyor
                start_time: '09:00',
                end_time: '17:00'
            };
            
            if (!defaultSchedule.is_working) {
                console.log('📅 Varsayılan programa göre bugün çalışma günü değil');
                return res.json([]);
            }
            
            scheduleResult.rows.push(defaultSchedule);
        }
        
        const schedule = scheduleResult.rows[0];
        if (!schedule.is_working) {
            return res.json([]);
        }
        
        // Çalışma saatleri arasında 1 saat arayla slot'lar oluştur
        const startTime = schedule.start_time;
        const endTime = schedule.end_time;
        
        const timeSlots = [];
        const [startHour, startMinute] = startTime.split(':').map(Number);
        const [endHour, endMinute] = endTime.split(':').map(Number);
        
        let currentHour = startHour;
        
        // Başlangıç dakikası 0 değilse, bir sonraki tam saate yuvarla
        if (startMinute > 0) {
            currentHour++;
        }
        
        while (currentHour < endHour) {
            const timeString = `${currentHour.toString().padStart(2, '0')}:00`;
            
            // Bu saatte randevu var mı kontrol et
            const dateOnly = date.includes('T') ? date.split('T')[0] : date;
            console.log(`🔍 Slot kontrolü - Saat: ${timeString}, Tarih: ${dateOnly}`);
            
            const appointmentCheck = await pool.query(
                'SELECT id FROM appointments WHERE business_id = $1 AND resource_id = $2 AND DATE(appointment_date) = $3 AND TO_CHAR(appointment_date, \'HH24:MI\') = $4 AND status != $5',
                [businessId, resourceId, dateOnly, timeString, 'İptal Edildi']
            );
            
            // Engellenen slot mu kontrol et
            const blockedCheck = await pool.query(
                'SELECT id FROM blocked_slots WHERE business_id = $1 AND resource_id = $2 AND blocked_date = $3 AND blocked_time = $4',
                [businessId, resourceId, dateOnly, timeString]
            );
            
            timeSlots.push({
                time: timeString,
                available: appointmentCheck.rows.length === 0 && blockedCheck.rows.length === 0
            });
            
            // 1 saat ekle
            currentHour++;
        }
        
        res.json(timeSlots);
        
    } catch (error) {
        console.error('Uygun saatler getirme hatası:', error);
        res.status(500).json({ error: 'Uygun saatler getirilirken bir hata oluştu' });
    }
});

// İşletme değerlendirmelerini getiren endpoint (mobil için)
app.get('/api/business/:businessId/reviews-mobile', async (req, res) => {
    try {
        const { businessId } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;
        
        // Değerlendirmeleri getir
        const reviewsResult = await pool.query(
            `SELECT 
                r.id,
                r.rating,
                r.comment,
                r.business_response,
                r.created_at,
                r.response_date,
                u.name as customer_name
            FROM reviews r
            JOIN users u ON r.customer_id = u.id
            WHERE r.business_id = $1
            ORDER BY r.created_at DESC
            LIMIT $2 OFFSET $3`,
            [businessId, limit, offset]
        );
        
        // Toplam sayı ve ortalama puan
        const statsResult = await pool.query(
            `SELECT 
                COUNT(*) as total_reviews,
                AVG(rating) as average_rating,
                COUNT(CASE WHEN rating = 5 THEN 1 END) as five_star,
                COUNT(CASE WHEN rating = 4 THEN 1 END) as four_star,
                COUNT(CASE WHEN rating = 3 THEN 1 END) as three_star,
                COUNT(CASE WHEN rating = 2 THEN 1 END) as two_star,
                COUNT(CASE WHEN rating = 1 THEN 1 END) as one_star
            FROM reviews 
            WHERE business_id = $1`,
            [businessId]
        );
        
        const stats = statsResult.rows[0];
        const totalReviews = parseInt(stats.total_reviews) || 0;
        const totalPages = Math.ceil(totalReviews / limit);
        
        res.json({
            reviews: reviewsResult.rows,
            pagination: {
                currentPage: page,
                totalPages: totalPages,
                totalReviews: totalReviews,
                hasMore: page < totalPages
            },
            statistics: {
                averageRating: parseFloat(stats.average_rating) || 0,
                totalReviews: totalReviews,
                ratingDistribution: {
                    5: parseInt(stats.five_star) || 0,
                    4: parseInt(stats.four_star) || 0,
                    3: parseInt(stats.three_star) || 0,
                    2: parseInt(stats.two_star) || 0,
                    1: parseInt(stats.one_star) || 0
                }
            }
        });
        
    } catch (error) {
        console.error('Mobil değerlendirmeler getirme hatası:', error);
        res.status(500).json({ error: 'Değerlendirmeler getirilirken bir hata oluştu' });
    }
});

// Business Dashboard API Endpoints

// İşletme dashboard verilerini getiren endpoint
app.get('/api/business/dashboard', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        
        // İşletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD formatında bugünün tarihi
        
        console.log('Dashboard stats - Business ID:', businessId, 'Today:', today);
        
        // Bugünkü randevu sayısı
        const todayAppointmentsResult = await pool.query(
            `SELECT COUNT(*) as count 
             FROM appointments 
             WHERE business_id = $1 AND DATE(appointment_date) = $2 AND status != 'İptal Edildi'`,
            [businessId, today]
        );
        
        // Bugünkü gelir
        const todayRevenueResult = await pool.query(
            `SELECT COALESCE(SUM(total_amount), 0) as revenue 
             FROM appointments 
             WHERE business_id = $1 AND DATE(appointment_date) = $2 AND status = 'Tamamlandı'`,
            [businessId, today]
        );
        
        // Bekleyen randevu sayısı
        const pendingAppointmentsResult = await pool.query(
            `SELECT COUNT(*) as count 
             FROM appointments 
             WHERE business_id = $1 AND status = 'Beklemede'`,
            [businessId]
        );
        
        // Aktif kaynak sayısı
        const activeResourcesResult = await pool.query(
            `SELECT COUNT(*) as count 
             FROM business_resources 
             WHERE business_id = $1 AND status = 'active'`,
            [businessId]
        );
        
        const dashboardData = {
            todayAppointments: parseInt(todayAppointmentsResult.rows[0].count),
            todayRevenue: parseFloat(todayRevenueResult.rows[0].revenue),
            pendingAppointments: parseInt(pendingAppointmentsResult.rows[0].count),
            activeResources: parseInt(activeResourcesResult.rows[0].count)
        };
        
        console.log('Dashboard stats result:', dashboardData);
        res.json(dashboardData);
        
    } catch (error) {
        console.error('Dashboard verileri getirme hatası:', error);
        res.status(500).json({ error: 'Dashboard verileri getirilirken bir hata oluştu' });
    }
});

// İşletme kaynaklarını getiren endpoint
app.get('/api/business/resources', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        
        // İşletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        const today = new Date().toISOString().split('T')[0];
        
        console.log('Dashboard resources - Business ID:', businessId, 'Today:', today);
        
        // Kaynakları ve bugünkü randevu bilgilerini getir
        const resourcesResult = await pool.query(
            `SELECT 
                br.id,
                br.name,
                br.resource_type,
                br.status,
                COUNT(a.id) as today_appointments,
                MIN(CASE 
                    WHEN a.appointment_date > NOW() AND a.status != 'İptal Edildi' 
                    THEN a.appointment_date 
                END) as next_appointment
             FROM business_resources br
             LEFT JOIN appointments a ON br.id = a.resource_id 
                AND DATE(a.appointment_date) = $2 
                AND a.status != 'İptal Edildi'
             WHERE br.business_id = $1
             GROUP BY br.id, br.name, br.resource_type, br.status
             ORDER BY br.name`,
            [businessId, today]
        );
        
        console.log('Dashboard resources query result:', resourcesResult.rows);
        
        // Her kaynak için sonraki randevu detaylarını al
        const resources = await Promise.all(resourcesResult.rows.map(async (resource) => {
            let nextAppointmentDetails = null;
            
            if (resource.next_appointment) {
                const nextAppResult = await pool.query(
                    `SELECT 
                        a.appointment_date,
                        u.name as customer_name
                     FROM appointments a
                     JOIN users u ON a.customer_id = u.id
                     WHERE a.resource_id = $1 
                       AND a.appointment_date = $2 
                       AND a.status != 'İptal Edildi'`,
                    [resource.id, resource.next_appointment]
                );
                
                if (nextAppResult.rows.length > 0) {
                    const appointment = nextAppResult.rows[0];
                    const appointmentDate = new Date(appointment.appointment_date);
                    nextAppointmentDetails = {
                        time: appointmentDate.toLocaleTimeString('tr-TR', { 
                            hour: '2-digit', 
                            minute: '2-digit' 
                        }),
                        customerName: appointment.customer_name
                    };
                }
            }
            
            const processedResource = {
                id: resource.id,
                name: resource.name,
                resourceType: resource.resource_type,
                status: resource.status,
                todayAppointments: parseInt(resource.today_appointments),
                nextAppointment: nextAppointmentDetails
            };
            
            console.log('Processed resource:', processedResource);
            return processedResource;
        }));
        
        console.log('Final resources array:', resources);
        res.json(resources);
        
    } catch (error) {
        console.error('Kaynaklar getirme hatası:', error);
        res.status(500).json({ error: 'Kaynaklar getirilirken bir hata oluştu' });
    }
});

// Kaynak durumunu güncelleme endpoint'i
app.put('/api/business/resources/:resourceId/status', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const { resourceId } = req.params;
        const { status } = req.body;
        
        if (!['active', 'inactive'].includes(status)) {
            return res.status(400).json({ error: 'Geçersiz durum. active veya inactive olmalıdır.' });
        }
        
        // İşletme ID'sini al
        const businessResult = await pool.query(
            'SELECT id FROM business_profiles WHERE user_id = $1',
            [userId]
        );
        
        if (businessResult.rows.length === 0) {
            return res.status(404).json({ error: 'İşletme profili bulunamadı' });
        }
        
        const businessId = businessResult.rows[0].id;
        
        // Kaynağın bu işletmeye ait olduğunu kontrol et ve güncelle
        const updateResult = await pool.query(
            `UPDATE business_resources 
             SET status = $1 
             WHERE id = $2 AND business_id = $3 
             RETURNING *`,
            [status, resourceId, businessId]
        );
        
        if (updateResult.rows.length === 0) {
            return res.status(404).json({ error: 'Kaynak bulunamadı veya bu işletmeye ait değil' });
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

