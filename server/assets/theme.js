document.addEventListener('DOMContentLoaded', () => {
    // 1. Initialiser le thème depuis localStorage ou la préférence système
    const savedTheme = localStorage.getItem('theme') || 'dark';
    if (savedTheme === 'light') {
        document.body.classList.add('light-theme');
    }

    // 2. Injecter le bouton de toggle dans le header s'il existe
    const header = document.querySelector('header');
    if (header) {
        // Éviter l'injection multiple
        if (!document.getElementById('theme-toggle')) {
            const toggleContainer = document.createElement('div');
            toggleContainer.className = 'theme-toggle-container';
            toggleContainer.style.display = 'flex';
            toggleContainer.style.alignItems = 'center';
            toggleContainer.style.marginLeft = 'auto';
            toggleContainer.style.marginRight = '15px';

            const toggleBtn = document.createElement('button');
            toggleBtn.id = 'theme-toggle';
            toggleBtn.className = 'theme-toggle-btn';
            toggleBtn.type = 'button';
            
            // Icône initiale selon le thème actif
            updateToggleLabel(toggleBtn, savedTheme);

            toggleBtn.addEventListener('click', () => {
                const isLight = document.body.classList.toggle('light-theme');
                const newTheme = isLight ? 'light' : 'dark';
                localStorage.setItem('theme', newTheme);
                updateToggleLabel(toggleBtn, newTheme);
                window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme: newTheme } }));
            });

            toggleContainer.appendChild(toggleBtn);
            
            // Insérer avant le bouton de déconnexion si présent, sinon à la fin
            const logoutBtn = header.querySelector('button[onclick*="logout"]');
            if (logoutBtn) {
                header.insertBefore(toggleContainer, logoutBtn);
            } else {
                header.appendChild(toggleContainer);
            }
        }
    }
});

function updateToggleLabel(btn, theme) {
    if (theme === 'light') {
        btn.innerHTML = '🌙 Mode Sombre';
    } else {
        btn.innerHTML = '☀️ Mode Clair';
    }
}

// --- INTERCEPTEUR DE SESSION & GESTION DE LA PERTE DE RÉSEAU ---
(function() {
    const originalFetch = window.fetch;

    window.fetch = async function(...args) {
        try {
            const response = await originalFetch(...args);
            
            // Si la session a expiré (401) ou si l'accès est refusé (403)
            if (response.status === 401 || response.status === 403) {
                const isLoginPage = window.location.pathname === '/' || window.location.pathname.endsWith('admin.html');
                const isLoginApi = args[0] && (args[0].includes('/api/login') || args[0].includes('/api/login/verify-2fa'));
                
                if (!isLoginPage && !isLoginApi) {
                    console.warn("[AUTH] Session expirée (HTTP " + response.status + "). Déconnexion...");
                    localStorage.removeItem('pidyn_token');
                    localStorage.removeItem('pidyn_role');
                    localStorage.removeItem('pidyn_username');
                    localStorage.removeItem('pidyn_siteId');
                    window.location.href = '/';
                    return response;
                }
            }
            return response;
        } catch (error) {
            console.error("[NET] Erreur de connexion au serveur :", error);
            showNetworkAlert();
            throw error;
        }
    };

    function showNetworkAlert() {
        if (document.getElementById('network-error-banner')) return;
        
        const banner = document.createElement('div');
        banner.id = 'network-error-banner';
        banner.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            background: #e74c3c;
            color: white;
            text-align: center;
            padding: 10px;
            font-weight: bold;
            z-index: 999999;
            box-shadow: 0 4px 10px rgba(0,0,0,0.3);
            font-family: sans-serif;
        `;
        banner.innerHTML = '⚠️ Connexion perdue avec le serveur OmniSign. Tentative de reconnexion en cours...';
        document.body.appendChild(banner);
        
        // Polling de reconnexion
        const checkInterval = setInterval(async () => {
            try {
                const token = localStorage.getItem('pidyn_token');
                const check = await originalFetch('/api/admin/ping', {
                    headers: token ? { 'Authorization': `Bearer ${token}` } : {}
                });
                if (check.status === 401 || check.status === 403) {
                    clearInterval(checkInterval);
                    localStorage.removeItem('pidyn_token');
                    window.location.href = '/';
                } else if (check.ok) {
                    clearInterval(checkInterval);
                    banner.remove();
                }
            } catch (e) {
                // Toujours hors-ligne
            }
        }, 5000);
    }

    // Ping d'arrière-plan périodique (Heartbeat) toutes les 60 secondes si l'utilisateur est connecté
    setInterval(async () => {
        const token = localStorage.getItem('pidyn_token');
        if (!token) return;
        
        const isLoginPage = window.location.pathname === '/' || window.location.pathname.endsWith('admin.html');
        if (isLoginPage) return; // Pas besoin de heartbeat sur l'overlay de login lui-même

        try {
            const res = await originalFetch('/api/admin/ping', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.status === 401 || res.status === 403) {
                console.warn("[AUTH] Heartbeat: session expirée.");
                localStorage.removeItem('pidyn_token');
                window.location.href = '/';
            }
        } catch (e) {
            // Géré par l'intercepteur en cas d'erreur de connexion globale
        }
    }, 60000);
})();
