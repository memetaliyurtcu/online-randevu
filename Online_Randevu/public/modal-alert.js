// Global Modal Alert System
class ModalAlert {
    constructor() {
        this.overlay = null;
        this.init();
    }

    init() {
        // Modal HTML'ini oluştur
        this.createModalHTML();
        
        // Global alert fonksiyonunu override et
        window.alert = (message, type = 'info', title = null) => {
            this.show(message, type, title);
        };

        // Özel alert fonksiyonları
        window.showSuccess = (message, title = 'Başarılı') => {
            this.show(message, 'success', title);
        };

        window.showError = (message, title = 'Hata') => {
            this.show(message, 'error', title);
        };

        window.showWarning = (message, title = 'Uyarı') => {
            this.show(message, 'warning', title);
        };

        window.showInfo = (message, title = 'Bilgi') => {
            this.show(message, 'info', title);
        };

        // Onay dialogu
        window.showConfirm = (message, title = 'Onay', onConfirm = null, onCancel = null) => {
            this.showConfirm(message, title, onConfirm, onCancel);
        };
    }

    createModalHTML() {
        // Eğer zaten varsa, tekrar oluşturma
        if (document.getElementById('modalAlert')) return;

        const modalHTML = `
            <div id="modalAlert" class="modal-overlay">
                <div class="modal-alert">
                    <div class="modal-icon" id="modalIcon">
                        <span class="material-icons" id="modalIconSymbol">info</span>
                    </div>
                    <h3 class="modal-title" id="modalTitle">Bilgi</h3>
                    <p class="modal-message" id="modalMessage">Mesaj</p>
                    <div class="modal-buttons" id="modalButtons">
                        <button class="modal-btn primary" id="modalOkBtn">Tamam</button>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHTML);
        this.overlay = document.getElementById('modalAlert');
        
        // Event listeners
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Overlay'e tıklandığında kapat
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) {
                this.hide();
            }
        });

        // ESC tuşu ile kapat
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.overlay.classList.contains('show')) {
                this.hide();
            }
        });
    }

    show(message, type = 'info', title = null) {
        const icon = document.getElementById('modalIcon');
        const iconSymbol = document.getElementById('modalIconSymbol');
        const titleElement = document.getElementById('modalTitle');
        const messageElement = document.getElementById('modalMessage');
        const buttonsContainer = document.getElementById('modalButtons');

        // Icon ve renk ayarları
        const iconConfig = {
            success: { icon: 'check_circle', title: title || 'Başarılı' },
            error: { icon: 'error', title: title || 'Hata' },
            warning: { icon: 'warning', title: title || 'Uyarı' },
            info: { icon: 'info', title: title || 'Bilgi' }
        };

        const config = iconConfig[type] || iconConfig.info;

        // Icon'u güncelle
        icon.className = `modal-icon ${type}`;
        iconSymbol.textContent = config.icon;

        // İçeriği güncelle
        titleElement.textContent = config.title;
        messageElement.textContent = message;

        // Butonları ayarla
        buttonsContainer.innerHTML = `
            <button class="modal-btn primary" onclick="modalAlert.hide()">Tamam</button>
        `;

        // Modal'ı göster
        this.overlay.classList.add('show');
        
        // Body scroll'unu engelle
        document.body.style.overflow = 'hidden';
    }

    showConfirm(message, title = 'Onay', onConfirm = null, onCancel = null) {
        const icon = document.getElementById('modalIcon');
        const iconSymbol = document.getElementById('modalIconSymbol');
        const titleElement = document.getElementById('modalTitle');
        const messageElement = document.getElementById('modalMessage');
        const buttonsContainer = document.getElementById('modalButtons');

        // Icon'u güncelle
        icon.className = 'modal-icon warning';
        iconSymbol.textContent = 'help';

        // İçeriği güncelle
        titleElement.textContent = title;
        messageElement.textContent = message;

        // Butonları ayarla
        buttonsContainer.innerHTML = `
            <button class="modal-btn secondary" onclick="modalAlert.handleCancel()">İptal</button>
            <button class="modal-btn primary" onclick="modalAlert.handleConfirm()">Onayla</button>
        `;

        // Callback'leri sakla
        this.onConfirm = onConfirm;
        this.onCancel = onCancel;

        // Modal'ı göster
        this.overlay.classList.add('show');
        
        // Body scroll'unu engelle
        document.body.style.overflow = 'hidden';
    }

    handleConfirm() {
        this.hide();
        if (this.onConfirm && typeof this.onConfirm === 'function') {
            this.onConfirm();
        }
    }

    handleCancel() {
        this.hide();
        if (this.onCancel && typeof this.onCancel === 'function') {
            this.onCancel();
        }
    }

    hide() {
        this.overlay.classList.remove('show');
        
        // Body scroll'unu geri aç
        document.body.style.overflow = '';
        
        // Callback'leri temizle
        this.onConfirm = null;
        this.onCancel = null;
    }
}

// Sayfa yüklendiğinde modal alert sistemini başlat
document.addEventListener('DOMContentLoaded', () => {
    window.modalAlert = new ModalAlert();
});

// Eğer Material Icons yüklü değilse yükle
if (!document.querySelector('link[href*="material-icons"]')) {
    const link = document.createElement('link');
    link.href = 'https://fonts.googleapis.com/icon?family=Material+Icons';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
} 