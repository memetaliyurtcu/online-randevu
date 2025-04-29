import axios from 'axios';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Platform'a göre API URL'sini belirle
const API_URL = Platform.OS === 'ios' 
    ? 'http://localhost:3000'
    : 'http://10.0.2.2:3000';

console.log('API_URL:', API_URL, 'Platform:', Platform.OS);

// Axios instance oluştur
const api = axios.create({
    baseURL: API_URL,
    headers: {
        'Content-Type': 'application/json',
    },
    timeout: 10000, // 10 saniye timeout
});

// Request interceptor - her istekte token ekle
api.interceptors.request.use(
    async (config) => {
        try {
            const token = await AsyncStorage.getItem('token');
            if (token) {
                config.headers.Authorization = `Bearer ${token}`;
            }
            return config;
        } catch (error) {
            console.error('Request interceptor error:', error);
            return config;
        }
    },
    (error) => {
        console.error('Request interceptor rejection:', error);
        return Promise.reject(error);
    }
);

// Response interceptor - hata yönetimi
api.interceptors.response.use(
    (response) => response.data,
    (error) => {
        console.error('API Error:', error?.response?.status, error?.response?.data || error.message);
        
        if (error.response?.status === 401) {
            // Token geçersiz veya süresi dolmuş
            AsyncStorage.removeItem('token');
            AsyncStorage.removeItem('userRole');
        }
        
        // Hatayı daha detaylı ele al
        return Promise.reject({
            status: error.response?.status,
            data: error.response?.data,
            message: error.message || 'Bir hata oluştu',
            originalError: error
        });
    }
);

// İşletmeleri getir
export const getBusinesses = async () => {
    try {
        const response = await api.get('/api/businesses');
        // API yanıtı { businesses: [...] } şeklinde olduğu için businesses dizisini alalım
        return response?.businesses || [];
    } catch (error) {
        console.error('API Businesses Error:', error);
        return [];
    }
};

// İşletmeleri türüne göre getir
export const getBusinessesByType = async (type: string) => {
    try {
        const endpoint = type ? `/api/businesses?type=${type}` : '/api/businesses';
        const response = await api.get(endpoint);
        
        // API yanıtı { businesses: [...] } şeklinde olduğu için businesses dizisini alalım
        return response?.businesses || [];
    } catch (error) {
        console.error('API BusinessesByType Error:', error);
        throw error;
    }
}; 