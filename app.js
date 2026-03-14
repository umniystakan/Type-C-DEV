// Type-C Messenger - Matrix Protocol Integration
// ================================================

class TypeCMessenger {
    constructor() {
        this.client = null;
        this.currentRoomId = null;
        this.rooms = new Map();
        this.currentTab = 'dms';
        this.roomSearchQuery = '';
        this.roomSearchDebounce = null;
        this.discoverySearchDebounce = null;
        this.recentRooms = []; // Last 5 active rooms
        this.summaryInterval = null;
        this.holidays = {}; // Holiday data from ICS
        this.quotes = []; // Daily quotes
        this.currentCalendarMonth = new Date().getMonth();
        this.currentCalendarYear = new Date().getFullYear();

        // Passcode State
        this.passcode = localStorage.getItem('app_passcode') || null;
        this.currentPasscodeInput = '';
        this.isPasscodeSetupMode = false;
        this.passcodeBuffer = '';
        this.passcodeMode = 'unlock'; // 'unlock', 'setup', 'confirm', 'disable'
        this.tempPasscode = ''; // For confirmation during setup

        window.messenger = this;
        window.MessengerDebug = {
            getStatus: () => ({
                secureContext: window.isSecureContext,
                subtleCrypto: !!(window.crypto && window.crypto.subtle),
                olmLoaded: !!window.Olm,
                olmReady: !!window.OlmReady,
                cryptoEnabled: this.client ? this.client.isCryptoEnabled() : 'no-client',
                deviceId: this.client ? this.client.deviceId : 'none'
            })
        };

        // Radio State
        this.radioStations = JSON.parse(localStorage.getItem('radio_stations')) || [];
        this.audioPlayer = new Audio();
        this.currentStation = null;
        this.selectedRadioIndex = "";
        this.metadataPollInterval = null;
        this.isRadioLoading = false;
        this.showRadioStatus = localStorage.getItem('show_radio_status') !== 'false';
        this.miniPlayerEnabled = localStorage.getItem('mini_player_enabled') !== 'false';
        this.isRadioActive = false; // v350/v355: Nuclear state tracking
        this.debugPresence = false; // Disabled for release (v375)
        this.selectedRadioIndex = "";

        // v385: Radio Stats
        this.radioStats = JSON.parse(localStorage.getItem('radio_listening_stats')) || {};
        this._lastStatsUpdate = Date.now();

        this.init();
    }

    async init() {
        // Initialize Olm (E2EE dependency)
        console.group('[CRYPTO DIAGNOSTICS]');
        console.log('Secure Context:', window.isSecureContext);
        console.log('Subtle Crypto:', !!(window.crypto && window.crypto.subtle));
        console.log('IndexedDB:', !!window.indexedDB);
        console.log('Olm library loaded:', !!window.Olm);
        if (window.Olm) {
            console.log('Olm version hint:', typeof window.Olm.init);
        }
        console.groupEnd();

        if (window.Olm && typeof window.Olm.init === 'function') {
            try {
                await window.Olm.init();
                console.log('[CRYPTO] Olm initialized successfully');
                // Global handle for matrix tools
                window.OlmReady = true;
            } catch (e) {
                console.error('[CRYPTO] Olm init failed:', e);
                window.OlmReady = false;
            }
        } else {
            console.warn('[CRYPTO] Olm library not found or invalid! E2EE will be disabled.');
            window.OlmReady = false;
        }

        // Load theme from localStorage
        const savedTheme = localStorage.getItem('matrix_theme') || 'green';
        this.setTheme(savedTheme);

        // Check App Lock on startup
        this.checkAppLock();

        // Initialize Matrix Rain state
        const isRainEnabled = localStorage.getItem('matrix_rain_enabled') !== 'false';
        const rainCanvas = document.getElementById('matrix-rain');
        if (rainCanvas) {
            rainCanvas.style.display = isRainEnabled ? 'block' : 'none';
        }

        // Request notification permission
        this.requestNotificationPermission();

        // Check if Matrix SDK is loaded
        if (typeof window.matrixcs === 'undefined') {
            const errorDiv = document.getElementById('login-error');
            if (errorDiv) {
                errorDiv.textContent = 'Ошибка: SDK Matrix не загружен. Проверьте соединение.';
                errorDiv.classList.add('show');
            }
            console.error('Matrix SDK not loaded. Please check your internet connection.');
            return;
        }

        // Check for existing session
        const accessToken = localStorage.getItem('matrix_access_token');
        const userId = localStorage.getItem('matrix_user_id');
        const homeserver = localStorage.getItem('matrix_homeserver');
        const deviceId = localStorage.getItem('matrix_device_id');

        if (accessToken && userId && homeserver) {
            // v426: If PIN is enabled, delay auto-login until PIN is entered
            if (localStorage.getItem('app_passcode_hash')) {
                console.log('[SECURITY] PIN enabled, delaying auto-login...');
            } else {
                this.autoLogin(homeserver, accessToken, userId, deviceId);
                // Refresh display info after login
                setTimeout(() => this.updateUserDisplay(), 2000);
            }
        } else {
            this.showLoginScreen();
        }

        this.loadHolidays();
        this.loadQuotes();
        this.setupEventListeners();

        // Start periodic connection check
        this.startConnectionCheck();

        // v385: Start Stats Heartbeat
        this._statsInterval = setInterval(() => this.updateListeningStats(), 10000); // Every 10s

        this.initMiniPlayerDraggable();
        this.initMobileGestures();
    }

    setupEventListeners() {
        // Global Keydown (ESC to close modals)
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeAllModals();
            }
        });

        // Radio Listeners
        const addStationBtn = document.getElementById('add-station-btn');
        if (addStationBtn) {
            addStationBtn.addEventListener('click', () => this.addRadioStation());
        }

        const requestLocationBtn = document.getElementById('request-location-btn');
        if (requestLocationBtn) {
            requestLocationBtn.addEventListener('click', () => {
                this.loadWeather(true);
                alert('Запрос местоположения отправлен...');
            });
        }

        const radioPlayBtn = document.getElementById('radio-play-btn');
        if (radioPlayBtn) {
            radioPlayBtn.addEventListener('click', () => this.toggleRadioPlayback());
        }

        const radioHub = document.getElementById('radio-station-hub');
        if (radioHub) {
            radioHub.addEventListener('click', (e) => {
                const icon = e.target.closest('.hub-station-icon');
                if (icon) {
                    this.selectRadioStation(icon.dataset.index);
                }
            });
        }

        const radioShareBtn = document.getElementById('radio-share-btn');
        if (radioShareBtn) {
            radioShareBtn.addEventListener('click', () => this.shareRadioStation());
        }

        const refreshProfileBtn = document.getElementById('refresh-profile-btn');
        if (refreshProfileBtn) {
            refreshProfileBtn.addEventListener('click', () => {
                const modal = document.getElementById('profile-modal');
                if (modal && modal.dataset.userId) {
                    this.openProfileModal(modal.dataset.userId);
                }
            });
        }

        // --- Profile & App Settings ---
        const saveProfileBtn = document.getElementById('save-profile-btn');
        if (saveProfileBtn) {
            saveProfileBtn.addEventListener('click', () => this.handleProfileUpdate());
        }

        const closeProfileModalBtn = document.getElementById('close-profile-modal');
        if (closeProfileModalBtn) {
            closeProfileModalBtn.addEventListener('click', () => this.closeModal('profile-modal'));
        }

        const avatarUpload = document.getElementById('avatar-upload');
        if (avatarUpload) {
            avatarUpload.addEventListener('change', (e) => this.handleAvatarPreview(e));
        }

        const inviteForm = document.getElementById('invite-user-form');
        if (inviteForm) {
            inviteForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.handleInviteUser();
            });
        }

        // Theme Swatches
        document.querySelectorAll('.theme-swatch').forEach(swatch => {
            swatch.addEventListener('click', () => this.setTheme(swatch.dataset.theme));
        });

        // Sidebar Action Buttons Toggle
        const toggleActionsBtn = document.getElementById('toggle-actions-btn');
        if (toggleActionsBtn) {
            toggleActionsBtn.addEventListener('click', () => this.toggleActionButtons());
            // Restore state
            const isCollapsed = localStorage.getItem('sidebar_actions_collapsed') === 'true';
            if (isCollapsed) this.toggleActionButtons(true);
        }

        // PIN Code Listeners
        const lockToggle = document.getElementById('app-lock-toggle');
        if (lockToggle) {
            lockToggle.addEventListener('change', (e) => {
                if (e.target.checked) {
                    this.startPasscodeSetup();
                    e.target.checked = false; // Reset visually until confirmed
                } else {
                    this.disablePasscode();
                    e.target.checked = true; // Reset visually until confirmed
                }
            });
        }

        // --- Room Search ---
        const roomSearchInput = document.getElementById('room-search-input');
        const clearSearchBtn = document.getElementById('clear-search-btn');

        if (roomSearchInput) {
            roomSearchInput.addEventListener('input', (e) => {
                const query = e.target.value;
                this.roomSearchQuery = query; // Store state
                if (clearSearchBtn) {
                    clearSearchBtn.classList.toggle('hidden', !query);
                }

                // Debounce filtering
                if (this.roomSearchDebounce) clearTimeout(this.roomSearchDebounce);
                this.roomSearchDebounce = setTimeout(() => {
                    this.filterRooms(query);
                }, 150);
            });
        }

        if (clearSearchBtn) {
            clearSearchBtn.addEventListener('click', () => {
                if (roomSearchInput) {
                    roomSearchInput.value = '';
                    this.roomSearchQuery = '';
                    roomSearchInput.dispatchEvent(new Event('input'));
                    roomSearchInput.focus();
                }
            });
        }

        const exploreRoomsBtn = document.getElementById('explore-rooms-btn');
        if (exploreRoomsBtn) {
            exploreRoomsBtn.addEventListener('click', () => this.openPublicRoomsModal());
        }

        // --- Public Rooms Modal Listeners ---
        const publicRoomSearch = document.getElementById('public-room-search');
        if (publicRoomSearch) {
            publicRoomSearch.addEventListener('input', (e) => {
                const query = e.target.value;
                if (this.discoverySearchDebounce) clearTimeout(this.discoverySearchDebounce);
                this.discoverySearchDebounce = setTimeout(() => {
                    this.loadPublicRooms(query);
                }, 400); // Slightly longer debounce for server search
            });
        }

        const refreshPublicBtn = document.getElementById('refresh-public-rooms');
        if (refreshPublicBtn) {
            refreshPublicBtn.addEventListener('click', () => {
                const query = publicRoomSearch ? publicRoomSearch.value : '';
                this.loadPublicRooms(query);
            });
        }

        document.querySelectorAll('.key-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const key = btn.dataset.key;
                if (key) this.handlePasscodeInput(key);
            });
        });

        const passcodeDeleteBtn = document.getElementById('passcode-delete');
        if (passcodeDeleteBtn) {
            passcodeDeleteBtn.addEventListener('click', () => this.handlePasscodeDelete());
        }

        const passcodeCancelBtn = document.getElementById('passcode-cancel');
        if (passcodeCancelBtn) {
            passcodeCancelBtn.addEventListener('click', () => this.cancelPasscodeSetup());
        }

        // Mobile Back Button
        const backBtn = document.getElementById('back-to-rooms-btn');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                document.querySelector('.chat-container').classList.remove('chat-active');
                // Optional: Clear selection visually if needed, but keeping state is usually better
            });
        }

        // Privacy Listeners
        const privacyRadioToggle = document.getElementById('privacy-radio-toggle');
        if (privacyRadioToggle) {
            privacyRadioToggle.checked = this.showRadioStatus;
            privacyRadioToggle.addEventListener('change', (e) => {
                this.showRadioStatus = e.target.checked;
                localStorage.setItem('show_radio_status', this.showRadioStatus);
                console.log('[PRIVACY] Show radio status set to:', this.showRadioStatus);

                // If turning off, broadcast "OFF" immediately
                if (!this.showRadioStatus) {
                    this.broadcastRadioStatus(null);
                } else if (this.currentStation) {
                    // If turning on and playing, broadcast current station
                    this.broadcastRadioStatus(this.currentStation);
                }
            });
        }

        // Mini-Player Toggle Listener (v355 fix: Correct ID)
        const mpToggle = document.getElementById('mini-player-enabled-toggle');
        if (mpToggle) {
            mpToggle.checked = this.miniPlayerEnabled;
            mpToggle.addEventListener('change', (e) => {
                this.miniPlayerEnabled = e.target.checked;
                localStorage.setItem('mini_player_enabled', this.miniPlayerEnabled);
                console.log('[SETTINGS] Mini-player enabled:', this.miniPlayerEnabled);

                if (!this.miniPlayerEnabled) {
                    const mp = document.getElementById('radio-mini-player');
                    if (mp) mp.classList.add('hidden');
                } else if (this.currentStation && this.isRadioActive) {
                    this.updateMiniPlayerUI(this.currentStation);
                }
            });
        }

        // Ghost Fix Button
        const resetStatusBtn = document.getElementById('reset-radio-status');
        if (resetStatusBtn) {
            resetStatusBtn.addEventListener('click', async () => {
                if (this.client) {
                    console.log('[NUCLEAR] Emergency status reset triggered');
                    this.isRadioActive = false;
                    this.currentStation = null;

                    try {
                        await this.client.setPresence({ presence: "online", status_msg: "" });
                        await this.client.setAccountData('typec.now_playing', {});
                        alert('Статус успешно сброшен на сервере! (v360)');
                        this.updateHeaderPresence();
                        this.loadRooms();
                    } catch (e) {
                        console.error('Reset failed:', e);
                        alert('Ошибка сброса. Попробуйте еще раз.');
                    }
                }
            });
        }


        // Auth form (Login/Register)
        const authForm = document.getElementById('auth-form');
        if (authForm) {
            authForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.handleAuth();
            });
        }
        // ... rest of start of setupEventListeners ...

        // Auth Tabs
        document.querySelectorAll('.auth-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                this.switchAuthTab(btn.dataset.tab);
            });
        });

        // Logout button
        document.getElementById('logout-btn').addEventListener('click', () => {
            this.handleLogout();
        });

        // Message form
        document.getElementById('message-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleSendMessage();
        });



        // Main Tabs
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.switchTab(btn.dataset.tab);
            });
        });

        // Action buttons
        document.getElementById('new-dm-btn').addEventListener('click', () => {
            this.isSettingUpEncryptedDM = false;
            this.openModal('new-dm-modal');
        });

        document.getElementById('new-encrypted-dm-btn').addEventListener('click', () => {
            this.isSettingUpEncryptedDM = true;
            this.openModal('new-dm-modal');
        });

        document.getElementById('create-room-btn').addEventListener('click', () => {
            this.openModal('create-room-modal');
        });

        // Mobile FAB Actions
        const mobileFabBtn = document.getElementById('mobile-fab-btn');
        const mobileFabMenu = document.getElementById('mobile-fab-menu');

        if (mobileFabBtn && mobileFabMenu) {
            mobileFabBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                mobileFabMenu.classList.toggle('hidden');
                mobileFabBtn.classList.toggle('open');
            });

            document.addEventListener('click', (e) => {
                if (!mobileFabBtn.contains(e.target) && !mobileFabMenu.contains(e.target)) {
                    mobileFabMenu.classList.add('hidden');
                    mobileFabBtn.classList.remove('open');
                }
            });

            document.getElementById('fab-new-dm-btn')?.addEventListener('click', () => {
                mobileFabMenu.classList.add('hidden');
                mobileFabBtn.classList.remove('open');
                this.isSettingUpEncryptedDM = false;
                this.openModal('new-dm-modal');
            });

            document.getElementById('fab-new-encrypted-dm-btn')?.addEventListener('click', () => {
                mobileFabMenu.classList.add('hidden');
                mobileFabBtn.classList.remove('open');
                this.isSettingUpEncryptedDM = true;
                this.openModal('new-dm-modal');
            });

            document.getElementById('fab-create-room-btn')?.addEventListener('click', () => {
                mobileFabMenu.classList.add('hidden');
                mobileFabBtn.classList.remove('open');
                this.openModal('create-room-modal');
            });

            document.getElementById('fab-explore-rooms-btn')?.addEventListener('click', () => {
                mobileFabMenu.classList.add('hidden');
                mobileFabBtn.classList.remove('open');
                this.openPublicRoomsModal();
            });
        }

        // Search removed
        /* 
        document.getElementById('join-room-btn')?.addEventListener('click', () => {
            this.openModal('join-room-modal');
        });
        */

        // Modal close buttons and overlays
        document.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', () => {
                this.closeModal(btn.dataset.modal);
            });
        });

        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', () => {
                this.closeAllModals();
            });
        });

        // User search (for DMs)
        const userSearchInput = document.getElementById('user-search-input');
        if (userSearchInput) {
            userSearchInput.addEventListener('input', (e) => {
                clearTimeout(this.searchDebounceTimer);
                this.searchDebounceTimer = setTimeout(() => {
                    this.searchUsers(e.target.value);
                }, 500);
            });
        }

        // Create room form
        const createRoomForm = document.getElementById('create-room-form');
        if (createRoomForm) {
            createRoomForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.handleCreateRoom();
            });
        }

        // File Attachment
        const fileInput = document.getElementById('file-input');
        const attachBtn = document.getElementById('attach-btn');

        if (attachBtn && fileInput) {
            attachBtn.addEventListener('click', () => {
                fileInput.click();
            });

            fileInput.addEventListener('change', (e) => {
                this.handleFileUpload(e);
            });
        }

        // Room Settings & Actions
        const settingsBtn = document.getElementById('room-settings-btn');
        const settingsMenu = document.getElementById('room-settings-menu');
        const leaveBtn = document.getElementById('leave-room-btn');
        const inviteBtn = document.getElementById('invite-user-btn');

        if (settingsBtn && settingsMenu) {
            settingsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                settingsMenu.classList.toggle('hidden');
            });

            document.addEventListener('click', () => {
                if (!settingsMenu.classList.contains('hidden')) {
                    settingsMenu.classList.add('hidden');
                }
            });
        }

        if (leaveBtn) {
            leaveBtn.addEventListener('click', () => {
                this.leaveCurrentRoom();
            });
        }

        if (inviteBtn) {
            inviteBtn.addEventListener('click', () => {
                this.openModal('invite-user-modal');
            });
        }

        const viewMembersBtn = document.getElementById('view-members-btn');
        if (viewMembersBtn) {
            viewMembersBtn.addEventListener('click', () => {
                this.openMembersModal();
            });
        }

        const memberSearchInput = document.getElementById('member-search-input');
        if (memberSearchInput) {
            memberSearchInput.addEventListener('input', (e) => {
                this.filterMembers(e.target.value);
            });
        }

        // Profile Modal

        const sidebarSettingsBtn = document.getElementById('sidebar-settings-btn');
        if (sidebarSettingsBtn) {
            sidebarSettingsBtn.addEventListener('click', () => {
                this.openAppSettingsModal();
            });
        }

        const profileSettingsBtn = document.getElementById('profile-settings-btn');
        console.log('[DEBUG] Profile button element:', profileSettingsBtn);
        if (profileSettingsBtn) {
            profileSettingsBtn.addEventListener('click', () => {
                console.log('[DEBUG] Profile button clicked!');
                this.openProfileModal();
            });
        }

        // Matrix Rain Button
        const matrixRainBtn = document.getElementById('matrix-rain-btn');
        if (matrixRainBtn) {
            // Initialize button state from localStorage
            const isEnabled = localStorage.getItem('matrix_rain_enabled') !== 'false';
            matrixRainBtn.textContent = isEnabled ? 'ВКЛ' : 'ВЫКЛ';
            matrixRainBtn.classList.toggle('active', isEnabled);

            matrixRainBtn.addEventListener('click', () => {
                const currentlyEnabled = localStorage.getItem('matrix_rain_enabled') !== 'false';
                const newState = !currentlyEnabled;
                this.toggleMatrixRain(newState);
                matrixRainBtn.textContent = newState ? 'ВКЛ' : 'ВЫКЛ';
                matrixRainBtn.classList.toggle('active', newState);
            });
        }

        const summaryBtn = document.getElementById('sidebar-summary-btn');
        const headerSummaryBtn = document.getElementById('header-summary-btn');

        if (summaryBtn) {
            summaryBtn.addEventListener('click', () => {
                this.openSummaryModal();
            });
        }

        if (headerSummaryBtn) {
            headerSummaryBtn.addEventListener('click', () => {
                this.openSummaryModal();
            });
        }

        // Mobile Bottom Nav Listeners
        document.querySelectorAll('.mobile-nav .nav-item[data-tab]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.switchTab(btn.dataset.tab);
            });
        });

        const mobileSummaryBtn = document.getElementById('mobile-summary-btn');
        if (mobileSummaryBtn) {
            mobileSummaryBtn.addEventListener('click', () => {
                this.openSummaryModal();
            });
        }

        const mobileSettingsBtn = document.getElementById('mobile-settings-btn');
        if (mobileSettingsBtn) {
            mobileSettingsBtn.addEventListener('click', () => {
                this.openMobileSettingsPanel();
            });
        }

        // Mobile Settings Panel — Back button
        const mspBackBtn = document.getElementById('mobile-settings-back-btn');
        if (mspBackBtn) {
            mspBackBtn.addEventListener('click', () => this.closeMobileSettingsPanel());
        }

        // Mobile Rain button (mirrors desktop)
        const rainBtnMobile = document.getElementById('matrix-rain-btn-mobile');
        if (rainBtnMobile) {
            const isEnabled = localStorage.getItem('matrix_rain_enabled') !== 'false';
            rainBtnMobile.textContent = isEnabled ? 'ВКЛ' : 'ВЫКЛ';
            rainBtnMobile.classList.toggle('active', isEnabled);
            rainBtnMobile.addEventListener('click', () => {
                const cur = localStorage.getItem('matrix_rain_enabled') !== 'false';
                this.toggleMatrixRain(!cur);
                rainBtnMobile.textContent = !cur ? 'ВКЛ' : 'ВЫКЛ';
                rainBtnMobile.classList.toggle('active', !cur);
                // sync desktop btn
                const dBtn = document.getElementById('matrix-rain-btn');
                if (dBtn) { dBtn.textContent = !cur ? 'ВКЛ' : 'ВЫКЛ'; dBtn.classList.toggle('active', !cur); }
            });
        }

        // Mobile Privacy toggle (mirrors desktop)
        const privMobile = document.getElementById('privacy-radio-toggle-mobile');
        if (privMobile) {
            privMobile.checked = this.showRadioStatus;
            privMobile.addEventListener('change', (e) => {
                this.showRadioStatus = e.target.checked;
                localStorage.setItem('show_radio_status', this.showRadioStatus);
                const dToggle = document.getElementById('privacy-radio-toggle');
                if (dToggle) dToggle.checked = this.showRadioStatus;
                if (!this.showRadioStatus) this.broadcastRadioStatus(null);
                else if (this.currentStation) this.broadcastRadioStatus(this.currentStation);
            });
        }

        // Mobile mini-player toggle
        const mpMobile = document.getElementById('mini-player-enabled-toggle-mobile');
        if (mpMobile) {
            mpMobile.checked = this.miniPlayerEnabled;
            mpMobile.addEventListener('change', (e) => {
                this.miniPlayerEnabled = e.target.checked;
                localStorage.setItem('mini_player_enabled', this.miniPlayerEnabled);
                const dToggle = document.getElementById('mini-player-enabled-toggle');
                if (dToggle) dToggle.checked = this.miniPlayerEnabled;
                if (!this.miniPlayerEnabled) {
                    const mp = document.getElementById('radio-mini-player');
                    if (mp) mp.classList.add('hidden');
                } else if (this.currentStation && this.isRadioActive) {
                    this.updateMiniPlayerUI(this.currentStation);
                }
            });
        }

        // Mobile app-lock toggle
        const lockMobile = document.getElementById('app-lock-toggle-mobile');
        if (lockMobile) {
            lockMobile.checked = !!localStorage.getItem('app_passcode_hash');
            lockMobile.addEventListener('change', (e) => {
                if (e.target.checked) {
                    this.startPasscodeSetup();
                    e.target.checked = false;
                } else {
                    this.disablePasscode();
                    e.target.checked = true;
                }
            });
        }

        // Mobile request location
        const locBtnMobile = document.getElementById('request-location-btn-mobile');
        if (locBtnMobile) {
            locBtnMobile.addEventListener('click', () => {
                this.loadWeather(true);
                this.showNotificationBanner('Запрос местоположения отправлен...');
            });
        }

        // Mobile add station
        const addStationMobile = document.getElementById('add-station-btn-mobile');
        if (addStationMobile) {
            addStationMobile.addEventListener('click', () => {
                const name = document.getElementById('new-station-name-mobile')?.value;
                const url = document.getElementById('new-station-url-mobile')?.value;
                const cover = document.getElementById('new-station-cover-mobile')?.value;
                if (!name || !url) return;
                this.radioStations.push({ name, url, cover });
                localStorage.setItem('radio_stations', JSON.stringify(this.radioStations));
                this.renderRadioStations();
                this.renderRadioStationsMobile();
                document.getElementById('new-station-name-mobile').value = '';
                document.getElementById('new-station-url-mobile').value = '';
                document.getElementById('new-station-cover-mobile').value = '';
            });
        }

        // Mobile reset radio
        const resetMobile = document.getElementById('reset-radio-status-mobile');
        if (resetMobile) {
            resetMobile.addEventListener('click', async () => {
                if (this.client) {
                    this.isRadioActive = false;
                    this.currentStation = null;
                    try {
                        await this.client.setPresence({ presence: 'online', status_msg: '' });
                        await this.client.setAccountData('typec.now_playing', {});
                        this.updateHeaderPresence();
                        this.loadRooms();
                    } catch (e) { console.error('Reset failed:', e); }
                }
            });
        }
    }

    openMobileSettingsPanel() {
        const panel = document.getElementById('mobile-settings-panel');
        if (!panel) { this.openAppSettingsModal(); return; }
        panel.classList.add('active');
        // Sync state when opening
        const privMobile = document.getElementById('privacy-radio-toggle-mobile');
        if (privMobile) privMobile.checked = this.showRadioStatus;
        const mpMobile = document.getElementById('mini-player-enabled-toggle-mobile');
        if (mpMobile) mpMobile.checked = this.miniPlayerEnabled;
        const lockMobile = document.getElementById('app-lock-toggle-mobile');
        if (lockMobile) lockMobile.checked = !!localStorage.getItem('app_passcode_hash');
        const rainBtn = document.getElementById('matrix-rain-btn-mobile');
        if (rainBtn) {
            const on = localStorage.getItem('matrix_rain_enabled') !== 'false';
            rainBtn.textContent = on ? 'ВКЛ' : 'ВЫКЛ';
            rainBtn.classList.toggle('active', on);
        }
        this.renderRadioStationsMobile();
        // Mark active theme swatch
        const curTheme = localStorage.getItem('matrix_theme') || 'green';
        panel.querySelectorAll('.theme-swatch').forEach(s => {
            s.classList.toggle('active', s.dataset.theme === curTheme);
        });
    }

    closeMobileSettingsPanel() {
        const panel = document.getElementById('mobile-settings-panel');
        if (panel) panel.classList.remove('active');
    }

    renderRadioStationsMobile() {
        const list = document.getElementById('radio-stations-list-mobile');
        if (!list) return;
        if (!this.radioStations.length) {
            list.innerHTML = '<p class="empty-text">Станции не добавлены</p>';
            return;
        }
        list.innerHTML = this.radioStations.map((s, i) => `
            <div class="station-item">
                <div class="station-item-info">
                    ${s.cover ? `<img src="${s.cover}" alt="" style="width:28px;height:28px;border-radius:6px;object-fit:cover;">` : ''}
                    <span>${this.escapeHtml(s.name)}</span>
                </div>
                <button class="btn-danger-sm" data-del="${i}" style="background:transparent;border:none;color:#ff5555;font-size:18px;cursor:pointer;">×</button>
            </div>
        `).join('');
        list.querySelectorAll('[data-del]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.radioStations.splice(parseInt(btn.dataset.del), 1);
                localStorage.setItem('radio_stations', JSON.stringify(this.radioStations));
                this.renderRadioStations();
                this.renderRadioStationsMobile();
            });
        });
    }

    // v426: Horizontal swipe to go back on mobile
    initMobileGestures() {
        const chatScreen = document.getElementById('chat-screen');
        const container = document.querySelector('.chat-container');
        if (!chatScreen || !container) return;

        let touchStartX = 0;
        let touchStartY = 0;

        chatScreen.addEventListener('touchstart', (e) => {
            touchStartX = e.changedTouches[0].screenX;
            touchStartY = e.changedTouches[0].screenY;
        }, { passive: true });

        chatScreen.addEventListener('touchend', (e) => {
            const touchEndX = e.changedTouches[0].screenX;
            const touchEndY = e.changedTouches[0].screenY;
            const dx = touchEndX - touchStartX;
            const dy = touchEndY - touchStartY;

            // Swipe Right to go back (horizontal movement > threshold and > vertical)
            if (dx > 80 && Math.abs(dy) < 50) {
                if (container.classList.contains('chat-active')) {
                    container.classList.remove('chat-active');
                    console.log('[MOBILE] Swipe back triggered');
                }
            }
        }, { passive: true });
    }

    toggleActionButtons(forceState) {
        const container = document.getElementById('action-buttons-container');
        const header = document.getElementById('toggle-actions-btn');
        if (!container || !header) return;

        const isCollapsed = forceState !== undefined ? forceState : !container.classList.contains('collapsed');

        container.classList.toggle('collapsed', isCollapsed);
        header.classList.toggle('collapsed', isCollapsed);

        localStorage.setItem('sidebar_actions_collapsed', isCollapsed);
    }

    switchAuthTab(tab) {
        // UI Updates
        document.querySelectorAll('.auth-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });

        const authBtn = document.getElementById('auth-btn');
        const confirmPassGroup = document.getElementById('confirm-password-group');
        const emailGroup = document.getElementById('email-group');

        if (tab === 'register') {
            authBtn.innerHTML = '<span>Зарегистрироваться</span>';
            confirmPassGroup.classList.remove('hidden');
            emailGroup.classList.remove('hidden');
            // Add required attribute for registration
            document.getElementById('confirm-password').setAttribute('required', 'true');
        } else {
            authBtn.innerHTML = '<span>Войти</span>';
            confirmPassGroup.classList.add('hidden');
            emailGroup.classList.add('hidden');
            document.getElementById('confirm-password').removeAttribute('required');
        }

        // Clear errors
        document.getElementById('auth-error').classList.remove('show');
    }

    async handleAuth() {
        const activeTab = document.querySelector('.auth-tab.active').dataset.tab;

        if (activeTab === 'register') {
            await this.handleRegister();
        } else {
            await this.handleLogin();
        }
    }

    async handleRegister() {
        const homeserver = 'https://type-c-kmr.duckdns.org/';
        const usernameInput = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const confirmPassword = document.getElementById('confirm-password').value;
        const email = document.getElementById('email').value.trim();

        const authBtn = document.getElementById('auth-btn');
        const errorDiv = document.getElementById('auth-error');

        // Clear previous errors
        errorDiv.classList.remove('show');
        errorDiv.textContent = '';

        if (password !== confirmPassword) {
            errorDiv.textContent = 'Пароли не совпадают';
            errorDiv.classList.add('show');
            return;
        }

        // Disable button
        authBtn.disabled = true;
        authBtn.innerHTML = '<span>Регистрация...</span>';

        try {
            console.log('Connecting to homeserver:', homeserver);

            // Create client for registration
            const regClient = window.matrixcs.createClient({
                baseUrl: homeserver,
                fetchFn: window.fetch.bind(window)
            });

            // Extract localpart for proper registration
            // The register method expects just the username part if it's not a full ID match flow,
            // but providing just the localpart is safer for generic registration.
            let localpart = usernameInput;
            if (localpart.startsWith('@')) localpart = localpart.substring(1);
            if (localpart.includes(':')) localpart = localpart.split(':')[0];

            console.log('Registering with localpart:', localpart);

            const result = await regClient.register(
                localpart,
                password,
                null, // session
                { type: 'm.login.dummy' }, // auth object - CRITICAL for simple registration
                { email: email || undefined } // bindEmail/extra content
            );

            console.log('Registration successful:', result);

            // Auto-login after registration
            await this.handleLogin(homeserver, result.user_id, result.access_token, result.device_id);

        } catch (error) {
            console.error('Registration error:', error);

            let errorMessage = 'Ошибка регистрации: ';
            if (error.errcode === 'M_USER_IN_USE') {
                errorMessage += 'Пользователь с таким именем уже существует';
            } else if (error.errcode === 'M_WEAK_PASSWORD') {
                errorMessage += 'Пароль слишком простой';
            } else if (error.errcode === 'M_INVALID_USERNAME') {
                errorMessage += 'Недопустимое имя пользователя';
            } else if (error.message) {
                if (error.message.includes('401') || error.message.includes('Unknown message')) {
                    errorMessage += 'Ошибка протокола (401). Возможно сервер требует капчу или подтверждение email, которое пока не поддерживается.';
                } else if (error.message.includes('User ID can only contain')) {
                    errorMessage += 'Имя может содержать только латинские буквы (a-z) и цифры.';
                } else {
                    errorMessage += error.message;
                }
            } else {
                errorMessage += 'Неизвестная ошибка';
            }

            errorDiv.textContent = errorMessage;
            errorDiv.classList.add('show');
            authBtn.disabled = false;
            authBtn.innerHTML = '<span>Зарегистрироваться</span>';
        }
    }

    async handleLogin(forceHomeserver, forceUserId, forceAccessToken, forceDeviceId) {
        const homeserver = forceHomeserver || 'https://type-c-kmr.duckdns.org/';
        const username = forceUserId || document.getElementById('username').value.trim();
        const password = forceAccessToken ? null : document.getElementById('password').value;

        const authBtn = document.getElementById('auth-btn');
        const errorDiv = document.getElementById('auth-error');

        // Clear previous errors
        errorDiv.classList.remove('show');
        errorDiv.textContent = '';

        // Disable button during login
        authBtn.disabled = true;
        authBtn.innerHTML = '<span>Подключение...</span>';

        try {
            console.log('Attempting to connect to homeserver:', homeserver);

            let accessToken = forceAccessToken;
            let userId = forceUserId;
            let response = null;
            let deviceId = forceDeviceId || localStorage.getItem('matrix_device_id');

            if (!accessToken) {
                // Create Matrix client
                this.client = window.matrixcs.createClient({
                    baseUrl: homeserver,
                    fetchFn: window.fetch.bind(window)
                });

                // Login
                response = await this.client.loginWithPassword(username, password);
                console.log('Login successful:', response);

                accessToken = response.access_token;
                userId = response.user_id;

                if (response.device_id) {
                    deviceId = response.device_id;
                    localStorage.setItem('matrix_device_id', deviceId);
                } else {
                    // Fallback to random ID if server didn't provide one (unlikely but safe)
                    deviceId = 'DEVICE_' + Math.random().toString(36).substring(2, 10);
                    localStorage.setItem('matrix_device_id', deviceId);
                }
            }

            if (!deviceId) {
                deviceId = localStorage.getItem('matrix_device_id') || ('DEVICE_' + Math.random().toString(36).substring(2, 10));
                localStorage.setItem('matrix_device_id', deviceId);
            }

            // Store credentials
            localStorage.setItem('matrix_access_token', accessToken);
            localStorage.setItem('matrix_user_id', userId);
            localStorage.setItem('matrix_homeserver', homeserver);

            console.log('%c [AUTH] Reinitializing client for E2EE with DeviceId:', 'color: #00ff00;', deviceId);

            // Reinitialize client with access token and deviceId
            let cryptoStore;
            try {
                cryptoStore = new window.matrixcs.IndexedDBCryptoStore(window.indexedDB, "matrix-js-sdk-crypto");
                console.log('%c [CRYPTO] Using IndexedDBCryptoStore', 'color: #00ffff;');
            } catch (e) {
                console.warn('[CRYPTO] IndexedDB not available, falling back to MemoryStore:', e);
                cryptoStore = new window.matrixcs.MemoryCryptoStore();
            }

            try {
                this.client = window.matrixcs.createClient({
                    baseUrl: homeserver,
                    accessToken: accessToken,
                    userId: userId,
                    deviceId: deviceId,
                    cryptoStore: cryptoStore,
                    fetchFn: window.fetch.bind(window)
                });

                this.showChatScreen();
                await this.startClient();
            } catch (cryptoErr) {
                console.error('[CRYPTO] Failed to start client with encryption:', cryptoErr);
                if (cryptoErr.message && cryptoErr.message.toLowerCase().includes('encryption')) {
                    console.warn('[CRYPTO] Falling back to NON-ENCRYPTED client flow.');

                    this.client = window.matrixcs.createClient({
                        baseUrl: homeserver,
                        accessToken: accessToken,
                        userId: userId,
                        fetchFn: window.fetch.bind(window)
                    });

                    await this.startClient();
                } else {
                    throw cryptoErr; // Rethrow if it's not a crypto-related error
                }
            }

        } catch (error) {
            console.error('Login error:', error);

            // Detailed error message
            let errorMessage = 'Ошибка входа: ';

            if (error.message && error.message.includes('fetch failed')) {
                errorMessage += 'Не удалось подключиться к серверу Type-C. Проверьте:\n' +
                    '• Подключение к интернету\n' +
                    '• Доступность ' + homeserver;
            } else if (error.errcode === 'M_FORBIDDEN') {
                errorMessage += 'Неверное имя пользователя или пароль';
            } else if (error.errcode === 'M_USER_DEACTIVATED') {
                errorMessage += 'Пользователь деактивирован';
            } else if (error.errcode === 'M_LIMIT_EXCEEDED') {
                errorMessage += 'Слишком много попыток входа. Подождите немного.';
            } else if (error.data && error.data.error) {
                errorMessage += error.data.error;
            } else if (error.message) {
                errorMessage += error.message;
            } else {
                errorMessage += 'Неизвестная ошибка';
            }

            errorDiv.textContent = errorMessage;
            errorDiv.classList.add('show');
            authBtn.disabled = false;
            authBtn.innerHTML = '<span>Войти</span>';
        }
    }

    async autoLogin(homeserver, accessToken, userId, deviceId) {
        try {
            // Ensure deviceId exists
            if (!deviceId) {
                deviceId = localStorage.getItem('matrix_device_id') || ('DEVICE_' + Math.random().toString(36).substring(2, 10));
                localStorage.setItem('matrix_device_id', deviceId);
            }

            console.log('%c [AUTH] Auto-login with DeviceId:', 'color: #00ff00;', deviceId);

            let cryptoStore;
            try {
                // Check if IndexedDB is actually supported before trying to use it
                if (window.indexedDB) {
                    cryptoStore = new window.matrixcs.IndexedDBCryptoStore(window.indexedDB, "matrix-js-sdk-crypto");
                    console.log('%c [CRYPTO] Using IndexedDBCryptoStore', 'color: #00ffff;');
                } else {
                    throw new Error("IndexedDB not supported");
                }
            } catch (e) {
                console.warn('[CRYPTO] IndexedDB not available, falling back to MemoryStore:', e);
                cryptoStore = new window.matrixcs.MemoryCryptoStore();
            }

            try {
                this.client = window.matrixcs.createClient({
                    baseUrl: homeserver,
                    accessToken: accessToken,
                    userId: userId,
                    deviceId: deviceId, // Pass the deviceId!
                    cryptoStore: cryptoStore,
                    fetchFn: window.fetch.bind(window)
                });

                await this.startClient();
            } catch (cryptoErr) {
                console.error('[CRYPTO] Auto-login failed with encryption:', cryptoErr);
                if (cryptoErr.message && cryptoErr.message.toLowerCase().includes('encryption')) {
                    console.warn('[CRYPTO] Falling back to NON-ENCRYPTED auto-login flow.');

                    this.client = window.matrixcs.createClient({
                        baseUrl: homeserver,
                        accessToken: accessToken,
                        userId: userId,
                        fetchFn: window.fetch.bind(window)
                    });

                    await this.startClient();
                } else {
                    throw cryptoErr;
                }
            }

        } catch (error) {
            console.error('Auto-login failed:', error);
            this.handleLogout();
        }
    }

    async startClient() {
        // Initialize Crypto (E2EE)
        try {
            // Only attempt crypto if we have a deviceId (Legacy Mode clients don't have it)
            if (this.client.deviceId && typeof this.client.initCrypto === 'function') {
                console.log('%c [CRYPTO] Initializing E2EE...', 'color: #00ffff; font-weight: bold;');

                // Ensure Olm is ready
                if (!window.OlmReady && window.Olm) {
                    console.warn('[CRYPTO] Olm late init...');
                    try { await window.Olm.init(); window.OlmReady = true; } catch (e) { console.error(e); }
                }

                // Set a timeout or catch specific failure to avoid hanging
                try {
                    await this.client.initCrypto();
                } catch (initErr) {
                    console.error('[CRYPTO] initCrypto failed:', initErr);

                    // Specific handling for hard-disabled state
                    const isHardDisabled = initErr.message && (
                        initErr.message.toLowerCase().includes('disabled') ||
                        initErr.message.toLowerCase().includes('olm') ||
                        initErr.message.toLowerCase().includes('crypto')
                    );

                    if (isHardDisabled) {
                        console.warn('[CRYPTO] E2EE is blocked by the SDK. RESTARTING IN LEGACY MODE...');

                        const homeserver = this.client.baseUrl;
                        const accessToken = this.client.getAccessToken();
                        const userId = this.client.getUserId();

                        // Re-create WITHOUT deviceId/cryptoStore to avoid the block
                        this.client = window.matrixcs.createClient({
                            baseUrl: homeserver,
                            accessToken: accessToken,
                            userId: userId,
                            fetchFn: window.fetch.bind(window)
                        });

                        // Set global for debugging
                        window.messenger.client = this.client;

                        return this.startClient();
                    }
                }

                const isEnabled = this.client.isCryptoEnabled();
                console.log('%c [CRYPTO] E2EE Status check. Enabled:',
                    isEnabled ? 'color: #00ff00; font-weight: bold;' : 'color: #ff0000; font-weight: bold;',
                    isEnabled);

                if (isEnabled) {
                    // v1861 fix: Allow sending messages to unverified devices
                    if (this.client.setGlobalErrorOnUnknownDevices) {
                        this.client.setGlobalErrorOnUnknownDevices(false);
                    }
                }
            }
        } catch (e) {
            console.error('[CRYPTO] Fatal error during E2EE setup:', e);
        }

        // Setup event handlers
        // v208: Moving listeners OUTSIDE sync to avoid redundant attachments
        // and using a guard to be absolutely sure
        if (this.client._listenersAttached) {
            console.log('[DEBUG] Listeners already attached to this client instance, skipping.');
        } else {
            console.log('[DEBUG] Attaching Room.timeline and Event.decrypted listeners.');

            // Listen for new messages (both decrypted and encrypted)
            this.client.on('Room.timeline', (event, room, toStartOfTimeline) => {
                if (toStartOfTimeline) return;

                const type = event.getType();
                if (type !== 'm.room.message' && type !== 'm.room.encrypted') return;

                const roomId = event.getRoomId();

                // Audio or Notification
                this.showNotification(event, room);

                // If encrypted and failed to decrypt, request keys
                if (type === 'm.room.encrypted' && event.isDecryptionFailure()) {
                    console.log('%c [CRYPTO] Requesting missing keys for event:', 'color: #ff9900;', event.getId());
                }

                if (roomId === this.currentRoomId) {
                    this.addMessageToTimeline(event);
                    this.markAsRead(roomId);
                }

                // v410: Avoid full reload, just update the badge/snippet for this room softly
                // Debounce the room list update to prevent UI locking on massive incoming message storms
                if (!this._roomListDebounceTimer) {
                    this._roomListDebounceTimer = setTimeout(() => {
                        this.loadRooms();
                        this._roomListDebounceTimer = null;
                    }, 500);
                }
            });

            // Listen for successful decryption
            this.client.on('Event.decrypted', (event) => {
                const roomId = event.getRoomId();
                if (roomId === this.currentRoomId) {
                    // Update only this specific message instead of reloading all
                    this.addMessageToTimeline(event);
                }
            });

            // v410: Debounce presence updates to prevent UI freezing
            let presenceDebounceTimer = null;
            const debouncedPresenceUpdate = () => {
                if (presenceDebounceTimer) clearTimeout(presenceDebounceTimer);
                presenceDebounceTimer = setTimeout(() => {
                    this.loadRooms();
                    const membersModal = document.getElementById('members-modal');
                    if (membersModal && membersModal.classList.contains('active')) {
                        this.renderMembersList();
                    }
                }, 1500); // Only update once every 1.5 seconds max
            };

            // Listen for presence changes (User object)
            this.client.on('User.presence', (event, user) => {
                if (this.debugPresence) console.log('[PRESENCE] User.presence event:', user.userId, user.presenceStatusMsg);
                debouncedPresenceUpdate();
            });

            // Listen for raw presence events (fallback)
            this.client.on('event', (event) => {
                if (event.getType() === 'm.presence') {
                    if (this.debugPresence) console.log('[PRESENCE] Raw m.presence event:', event.getSender());
                    debouncedPresenceUpdate();
                }
            });

            // v419: Listen for message delivery status changes
            // Also handles the post-refresh case where pending messages have no DOM element yet
            this.client.on('Event.status', (event, status) => {
                if (event.getRoomId() !== this.currentRoomId) return;
                const type = event.getType();
                if (type !== 'm.room.message' && type !== 'm.room.encrypted') return;

                const eventId = event.getId();
                const txnId = event.getUnsigned()?.transaction_id || (typeof event.getTxnId === 'function' ? event.getTxnId() : null);

                // Check if this message is already in the DOM
                let msgEl = txnId ? document.querySelector(`[data-txn-id="${txnId}"]`) : null;
                if (!msgEl && eventId) msgEl = document.querySelector(`[data-event-id="${eventId}"]`);

                if (!msgEl && event.getSender() === this.client.getUserId()) {
                    // Message not in DOM at all (e.g. after page refresh, pending events load late)
                    // Render it now so the user sees it immediately with a clock icon
                    console.log('[STATUS] Pending event not in DOM, rendering:', eventId || txnId);
                    this.addMessageToTimeline(event, false);
                } else {
                    this.updateMessageReceiptStatus(event);
                }
            });

            // v419: THE DEFINITIVE FIX — Room.localEchoUpdated fires when the server
            // confirms receipt of our message, providing both the OLD local echo event
            // and the NEW real event. This is the ONLY reliable way to upgrade ⏳ to ✓!
            this.client.on('Room.localEchoUpdated', (event, room, oldEventId) => {
                if (!room || room.roomId !== this.currentRoomId) return;
                const type = event.getType();
                if (type !== 'm.room.message' && type !== 'm.room.encrypted') return;

                const newEventId = event.getId();
                const txnId = event.getUnsigned()?.transaction_id
                    || (typeof event.getTxnId === 'function' ? event.getTxnId() : null);

                console.log('[ECHO] localEchoUpdated:', oldEventId, '->', newEventId, 'status:', event.status);

                // Find the old DOM element by the OLD local echo ID or txnId
                let oldEl = oldEventId ? document.querySelector(`[data-event-id="${oldEventId}"]`) : null;
                if (!oldEl && txnId) oldEl = document.querySelector(`[data-txn-id="${txnId}"]`);

                if (oldEl) {
                    // Found it — re-render in-place with the new event ID and correct status
                    this.addMessageToTimeline(event, false);
                } else if (event.getSender() === this.client.getUserId()) {
                    // Not in DOM (post-refresh case) — add it
                    this.addMessageToTimeline(event, false);
                }
            });

            // v408: Listen for read receipts from other users
            this.client.on('Room.receipt', (event, room) => {
                if (room.roomId === this.currentRoomId) {
                    this.updateRoomReceipts(room);
                }
            });

            this.client._listenersAttached = true;
        }

        this.client.on('sync', (state, prevState, data) => {
            console.log('Sync state:', state);
            this.updateConnectionStatus(state);
            if (state === 'PREPARED') {
                this.onSyncComplete();
                this.showChatScreen();
            }
        });

        // Start syncing
        try {
            await this.client.startClient({ initialSyncLimit: 50 });
            this.setupRedactionListener();
        } catch (e) {
            console.error('Failed to start client:', e);
            this.updateConnectionStatus('ERROR');
        }
    }

    updateConnectionStatus(state) {
        // Debounce status updates to prevent flickering
        if (this._connectionStatusTimer) clearTimeout(this._connectionStatusTimer);

        this._connectionStatusTimer = setTimeout(() => {
            const el = document.getElementById('connection-status');
            if (!el) return;

            const text = el.querySelector('.status-text');
            el.className = 'connection-status'; // reset

            switch (state) {
                case 'PREPARED':
                case 'SYNCING':
                    el.classList.add('online');
                    text.textContent = 'В сети';
                    break;
                case 'RECONNECTING':
                    el.classList.add('connecting');
                    text.textContent = 'Переподключение...';
                    break;
                case 'OFFLINE':
                    el.classList.add('error');
                    text.textContent = 'Не в сети';
                    break;
                case 'ERROR':
                    el.classList.add('error');
                    text.textContent = 'Ошибка сети';
                    break;
                default:
                    el.classList.add('connecting');
                    text.textContent = 'Синхронизация...';
            }
        }, 500); // 500ms delay to smooth out rapid changes
    }

    startConnectionCheck() {
        console.log('[NETWORK] Starting periodic connection monitor (15s interval)');

        // 1. Initial State Check
        if (!navigator.onLine) {
            this.updateConnectionStatus('OFFLINE');
        }

        // 2. Hardware Event Listeners for instant feedback
        window.addEventListener('offline', () => {
            console.log('[NETWORK] Hardware reported OFFLINE');
            this.updateConnectionStatus('OFFLINE');
        });

        window.addEventListener('online', () => {
            console.log('[NETWORK] Hardware reported ONLINE, checking server...');
            this.updateConnectionStatus('RECONNECTING'); // Show reconnecting immediately
            this.pingServer(); // Immediate check

            // Try to restart sync if client exists and strictly not syncing
            const state = this.client.getSyncState();
            if (this.client && (state === 'STOPPED' || state === 'ERROR')) {
                console.log('[NETWORK] Restarting Matrix Client from state:', state);
                this.client.startClient();
            }
        });

        // 3. Periodic Ping (Heartbeat)
        setInterval(() => this.pingServer(), 15000);
    }

    async pingServer() {
        if (!this.client) return;

        // Fast hardware check
        if (!navigator.onLine) {
            this.updateConnectionStatus('OFFLINE');
            return;
        }

        const homeserver = this.client.baseUrl;

        try {
            // Strict 5s timeout using AbortController
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            // Bypass SDK and ping server directly to avoid SDK internal queuing
            const response = await fetch(`${homeserver}/_matrix/client/versions`, {
                method: 'GET',
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (response.ok) {
                // Server is definitely reachable
                const sdkState = this.client.getSyncState();

                // If SDK thinks it's dead/reconnecting but we can reach server, 
                // it usually means it's about to recover or we should show Reconnecting/Syncing
                // rather than Error/Offline.
                if (sdkState === 'ERROR' || !sdkState) {
                    this.updateConnectionStatus('SYNCING');
                } else {
                    this.updateConnectionStatus(sdkState);
                }

                // If SDK stopped syncing but server is up, kick it
                if (sdkState === 'STOPPED' || sdkState === 'ERROR') {
                    console.warn('[NETWORK] Server up but SDK state is:', sdkState, '. Resuming sync...');
                    this.client.startClient();
                }

            } else {
                throw new Error(`Server returned ${response.status}`);
            }

        } catch (e) {
            console.warn('[NETWORK] Server unreachable:', e.name, e.message);

            // Critical check: If SDK is still happy, don't scare the user with OFFLINE
            // The 5s timeout might be too strict for a slow server that is still Long-Polling successfully
            const sdkState = this.client ? this.client.getSyncState() : null;
            if (sdkState === 'SYNCING' || sdkState === 'PREPARED') {
                console.log('[NETWORK] Ping failed but SDK is syncing. Trusting SDK.');
                this.updateConnectionStatus('SYNCING');
            } else {
                // Only show OFFLINE if both Ping failed AND SDK is not happy
                this.updateConnectionStatus('OFFLINE');
            }
        }
    }

    onSyncComplete() {
        console.log('%c [SYNC] Initial sync complete', 'color: #00ff00; font-weight: bold;');

        // v355: Aggressively wipe any zombie radio status from the server upon login
        // v371: Added safety - don't clear if for some reason we already set it to active
        if (!this.isRadioActive && this.client) {
            console.log('[PRESENCE] Force-clearing server-side status on sync...');
            this.client.setPresence({ presence: "online", status_msg: "" })
                .catch(e => console.warn('[PRESENCE] Init clear failed:', e));

            // Also clear account data if it exists
            this.client.setAccountData('typec.now_playing', {})
                .catch(e => console.warn('[PRESENCE] Init data clear failed:', e));
        }

        this.updateUserDisplay();
        this.updateHeaderPresence(); // v345
        this.loadRooms();
    }


    loadRooms() {
        if (!this.client) return;

        // Filter out rooms where user has left or been banned
        const rawRooms = this.client.getRooms();
        if (!rawRooms) return;

        const rooms = rawRooms.filter(r => {
            try {
                const membership = r.getMyMembership();
                return membership === 'join' || membership === 'invite';
            } catch (e) {
                return false;
            }
        });
        const roomsList = document.getElementById('rooms-list');
        if (!roomsList) return;

        roomsList.innerHTML = '';

        // Filter rooms by current tab
        const filteredRooms = rooms.filter(room => {
            if (this.currentTab === 'dms') {
                return this.isDMRoom(room);
            } else {
                return !this.isDMRoom(room);
            }
        });

        if (filteredRooms.length === 0) {
            const message = this.currentTab === 'dms'
                ? 'У вас пока нет личных сообщений'
                : 'У вас пока нет комнат';
            roomsList.innerHTML = `
                <div class="loading-rooms">
                    <p>${message}</p>
                </div>
            `;
            return;
        }

        const fragment = document.createDocumentFragment();
        filteredRooms.forEach(room => {
            try {
                const roomId = room.roomId;
                let roomName = room.name || room.getCanonicalAlias() || 'Безымянная комната';

                const unreadCount = room.getUnreadNotificationCount('total');
                const isInvited = room.getMyMembership() === 'invite';

                if (this.isDMRoom(room) && (!room.name || room.name.trim() === '')) {
                    const members = typeof room.getJoinedMembers === 'function' ? room.getJoinedMembers() : [];
                    const otherMember = members.find(m => m.userId !== this.client.getUserId());
                    if (otherMember) {
                        roomName = otherMember.name || otherMember.userId.split(':')[0].substring(1);
                    }
                }

                const lastMessage = isInvited ? 'Вы приглашены в эту комнату' : this.getLastMessage(room);

                this.rooms.set(roomId, {
                    name: roomName,
                    room: room
                });

                const roomElement = document.createElement('div');
                // Use String comparison to be absolutely sure
                const isActive = String(roomId) === String(this.currentRoomId);
                roomElement.className = `room-item ${isActive ? 'active' : ''} ${unreadCount > 0 ? 'unread' : ''}`;
                roomElement.dataset.roomId = roomId;

                // Don't show badge if it's the current active room
                const shouldShowBadge = unreadCount > 0 && !isActive;

                let radioIndicator = '';
                if (this.isDMRoom(room)) {
                    const members = typeof room.getJoinedMembers === 'function' ? room.getJoinedMembers() : [];
                    const otherMember = members.find(m => m.userId !== this.client.getUserId());
                    if (otherMember) {
                        radioIndicator = this.getRadioStatusHTML(otherMember.userId);
                    }
                }

                roomElement.innerHTML = `
                    <div class="room-item-content">
                        <h4>${this.escapeHtml(roomName)}${radioIndicator}</h4>
                        <p>${this.escapeHtml(lastMessage)}</p>
                    </div>
                    ${shouldShowBadge ? `<span class="unread-badge-sidebar">${unreadCount}</span>` : ''}
                `;

                roomElement.addEventListener('click', () => {
                    this.selectRoom(roomId);
                });

                fragment.appendChild(roomElement);
            } catch (e) {
                console.error('[UI] Failed to render room item:', e);
            }
        });

        roomsList.innerHTML = ''; // Final clear just before append
        roomsList.appendChild(fragment);

        // Re-apply search filter if active
        if (this.roomSearchQuery) {
            this.filterRooms(this.roomSearchQuery);
        }
    }

    getLastMessage(room) {
        const timeline = room.timeline;
        if (!timeline || timeline.length === 0) return 'Нет сообщений';

        for (let i = timeline.length - 1; i >= 0; i--) {
            const event = timeline[i];
            if (event.getType() === 'm.room.message') {
                const content = event.getContent();
                return content.body || 'Сообщение';
            } else if (event.getType() === 'm.room.encrypted') {
                return event.getContent().body || '🔒 [Зашифровано]';
            }
        }

        return 'Нет сообщений';
    }

    selectRoom(roomId) {
        try {
            this.currentRoomId = roomId;
            this.trackRecentRoom(roomId);
            const roomData = this.rooms.get(roomId);

            if (!roomData) return;

            // Update UI
            document.querySelectorAll('.room-item').forEach(item => {
                item.classList.remove('active');
            });
            document.querySelector(`[data-room-id="${roomId}"]`)?.classList.add('active');

            // Mobile: Show chat screen
            document.querySelector('.chat-container').classList.add('chat-active');

            // Update chat header
            const room = roomData.room;
            const isEncrypted = room && room.currentState.getStateEvents('m.room.encryption', '');
            const cryptoEnabled = this.client.isCryptoEnabled();
            const headerName = document.getElementById('current-room-name');

            headerName.textContent = (isEncrypted ? (cryptoEnabled ? '🔒 ' : '❌🔒 ') : '') + roomData.name;
            headerName.title = isEncrypted ? (cryptoEnabled ? 'Зашифровано' : 'Шифрование заблокировано браузером (нужен localhost)') : 'Обычный чат';

            const memberCount = room.getJoinedMemberCount();
            const membersElements = document.getElementById('room-members-count');

            if (this.isDMRoom(room)) {
                // Find the other user
                const myUserId = this.client.getUserId();
                const members = room.getJoinedMembers();
                const otherMember = members.find(m => m.userId !== myUserId);

                if (otherMember) {
                    const user = this.client.getUser(otherMember.userId);
                    const presence = user ? user.presence : 'offline';
                    const statusText = (presence === 'online' ? 'В сети' : 'Не в сети') + (isEncrypted && !cryptoEnabled ? ' • ⚠️ Шифрование недоступно' : '');
                    membersElements.textContent = statusText;
                    membersElements.className = presence === 'online' ? 'status-online' : 'status-offline';
                    membersElements.style.color = presence === 'online' ? 'var(--color-online)' : 'var(--color-text-secondary)';
                } else {
                    membersElements.textContent = (room.getInvitedMemberCount() > 0 ? 'Ожидание...' : 'Только вы') + (isEncrypted && !cryptoEnabled ? ' • ⚠️ Шифрование недоступно' : '');
                    membersElements.style.color = 'var(--color-text-secondary)';
                }
            } else {
                membersElements.textContent = `${memberCount} участников` + (isEncrypted && !cryptoEnabled ? ' • ⚠️ Шифрование недоступно' : '');
                membersElements.style.color = 'var(--color-text-secondary)';
            }

            // UI Elements
            const messageInput = document.getElementById('message-input');
            const sendBtn = document.getElementById('send-btn');
            const attachBtn = document.getElementById('attach-btn');
            const settingsBtn = document.getElementById('room-settings-btn');

            // Enable message input for all rooms (E2EE now supported)
            messageInput.disabled = false;
            messageInput.placeholder = "Написать сообщение...";
            sendBtn.disabled = false;
            attachBtn.disabled = false;
            settingsBtn.style.display = 'flex';

            // Check permissions and room type for management buttons
            try {
                const isDM = this.isDMRoom(room);
                const myUserId = this.client.getUserId();
                const state = room.getLiveTimeline().getState(matrixcs.EventTimeline.FORWARDS);

                // Invite: Only in group rooms + permission
                const canInvite = !isDM && (state && typeof state.canInvite === 'function') ? state.canInvite(myUserId) : false;
                const inviteUserBtn = document.getElementById('invite-user-btn');
                if (inviteUserBtn) {
                    inviteUserBtn.style.display = canInvite ? 'block' : 'none';
                }

                // Members list: Visible in all rooms
                const viewMembersBtn = document.getElementById('view-members-btn');
                if (viewMembersBtn) {
                    viewMembersBtn.style.display = 'block';
                }
            } catch (e) {
                console.warn('Room menu setup failed:', e);
            }

            // Load messages
            this.loadRoomMessages(roomId);

            // Mark as read
            this.markAsRead(roomId);
        } catch (error) {
            console.error('[UI] selectRoom failed:', error);
        }
    }

    loadRoomMessages(roomId) {
        try {
            if (!this.client) return;
            const room = this.client.getRoom(roomId);
            if (!room) {
                console.warn('[UI] loadRoomMessages: room not found', roomId);
                return;
            }

            const messagesContainer = document.getElementById('messages-container');
            if (!messagesContainer) return;

            // Remove existing scroll listener to avoid duplicates
            if (this._scrollHandler) {
                messagesContainer.removeEventListener('scroll', this._scrollHandler);
            }

            messagesContainer.innerHTML = '';

            // Initial Load
            let allEvents = [];
            if (Array.isArray(room.timeline)) {
                allEvents = allEvents.concat(room.timeline);
            }

            // v414: Safely load pending local echoes
            try {
                if (typeof room.getPendingEvents === 'function') {
                    const pending = room.getPendingEvents();
                    if (Array.isArray(pending)) {
                        allEvents = allEvents.concat(pending);
                    }
                }
            } catch (err) {
                console.warn('[DEBUG] Failed to load pending events:', err);
            }

            console.log(`[DEBUG] Loaded total events: ${allEvents.length}`);

            if (allEvents.length) {
                // Ensure events are sorted by timestamp just in case pending events are out of order
                // v414: Extremely safe sort
                allEvents.sort((a, b) => {
                    const tsA = (a && typeof a.getTs === 'function') ? (a.getTs() || Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
                    const tsB = (b && typeof b.getTs === 'function') ? (b.getTs() || Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
                    return tsA - tsB;
                });

                const selfHidden = this.getSelfHiddenEvents();
                allEvents.forEach(event => {
                    try {
                        if (event.getType() === 'm.room.message' || event.getType() === 'm.room.encrypted') {
                            // Skip self-hidden messages
                            const eid = event.getId();
                            if (eid && selfHidden.includes(eid)) return;
                            const el = this.addMessageToTimeline(event, false);
                            if (!el && event.getId()) {
                                // console.warn('[DEBUG] Failed or skipped rendering event:', event.getId());
                            }
                        }
                    } catch (e) {
                        console.error('[DEBUG] Error in loop:', e);
                    }
                });
            }

            // Scroll to bottom after all messages are added
            messagesContainer.scrollTop = messagesContainer.scrollHeight;

            // v408: Init read receipts for this room
            this.updateRoomReceipts(room);

            // Setup Infinite Scroll
            this._scrollHandler = async () => {
                if (messagesContainer.scrollTop === 0) {
                    await this.loadMoreMessages(room);
                }
            };
            messagesContainer.addEventListener('scroll', this._scrollHandler);

        } catch (error) {
            console.error('[UI] loadRoomMessages failed:', error);
        }
    }

    async loadMoreMessages(room) {
        if (this.isLoadingMore) return;
        this.isLoadingMore = true;

        const container = document.getElementById('messages-container');
        const oldHeight = container.scrollHeight;
        const oldTop = container.scrollTop;

        try {
            console.log('[HISTORY] Loading more messages...');

            // Show loading indicator (optional)
            // const loader = document.createElement('div');
            // loader.className = 'history-loader';
            // container.prepend(loader);

            const initialCount = room.timeline.length;
            await this.client.scrollback(room, 50);
            const newCount = room.timeline.length;

            if (newCount > initialCount) {
                console.log(`[HISTORY] Loaded ${newCount - initialCount} old messages`);

                // Get the old messages (the ones we just fetched)
                // They are prepended to room.timeline
                const newMessages = room.timeline.slice(0, newCount - initialCount);

                // Prepend them to UI in reverse order (oldest first) so they appear at top
                // BUT addMessageToTimeline appends to bottom by default.
                // We need a way to prepend.
                // Refactoring update:
                // We will re-render user-visible older messages carefully.
                // Actually, scrollback updates room.timeline.
                // The most robust way for a simple app is to re-render the top part
                // or just prepend the nodes.

                // (Fragment logic removed as createMessageElement is not implemented)

                // This logic is tricky because addMessageToTimeline does specific logic.
                // Let's implement a simpler "prepend" helper or modify addMessageToTimeline.
                // OR: Just iterate and use insertBefore on the first child.

                // Let's iterate backwards through the NEW messages (which are at start of timeline)
                // and prepend them to the container.
                for (let i = newMessages.length - 1; i >= 0; i--) {
                    const event = newMessages[i];
                    if (event.getType() === 'm.room.message' || event.getType() === 'm.room.encrypted') {
                        // We need to render it. reuse logic? 
                        // It's safer to extract logic to 'renderEvent' returning an element.
                        this.addMessageToTimeline(event, false, true); // Add 'prepend' flag
                    }
                }

                // Restore scroll position
                // New scroll position = (new height - old height) + old top (usually 0)
                // We need to wait for DOM update
                requestAnimationFrame(() => {
                    const newHeight = container.scrollHeight;
                    console.log('[DEBUG] Scroll restoration: OldHeight', oldHeight, 'NewHeight', newHeight);
                    if (newHeight > oldHeight) {
                        container.scrollTop = newHeight - oldHeight;
                    }
                });
            } else {
                console.log('[HISTORY] No more messages to load.');
            }

        } catch (err) {
            console.error('[HISTORY] Failed to load more messages:', err);
        } finally {
            this.isLoadingMore = false;
        }
    }

    addMessageToTimeline(event, scrollToBottom = true, prepend = false) {
        try {
            const messagesContainer = document.getElementById('messages-container');
            if (!messagesContainer) {
                console.error('[UI] messages-container not found!');
                return null;
            }

            // Skip redacted events (deleted for everyone) — they have empty content after redaction
            if (typeof event.isRedacted === 'function' && event.isRedacted()) {
                // Also remove the element from DOM if it's somehow still there
                const eid = event.getId();
                if (eid) {
                    const stale = messagesContainer.querySelector(`[data-event-id="${eid}"]`);
                    if (stale) stale.remove();
                }
                return null;
            }

            const eventId = event.getId();
            const transactionId = typeof event.getTxnId === 'function' ? event.getTxnId() : (event.getUnsigned() ? event.getUnsigned().transaction_id : null);

            // v417: Enhanced De-duplication & Update Logic
            let existing = null;

            if (eventId && !eventId.startsWith('~')) {
                existing = messagesContainer.querySelector(`[data-event-id="${eventId}"]`);
            }
            if (!existing && transactionId) {
                existing = messagesContainer.querySelector(`[data-txn-id="${transactionId}"]`);
            }
            if (!existing && eventId && eventId.startsWith('~')) {
                existing = messagesContainer.querySelector(`[data-event-id="${eventId}"]`);
            }

            const sender = event.getSender();
            const isMe = sender === this.client.getUserId();
            const content = event.getContent() || {};
            let messageBody = content.body || '';

            // v417: Bulletproof Fuzzy Match for Remote Events missing transactionId
            // If this is a confirmed remote event of ours, but we couldn't match it via IDs
            if (!existing && isMe && eventId && !eventId.startsWith('~') && messageBody) {
                const pendingMessages = Array.from(messagesContainer.querySelectorAll('.message.sent')).filter(el => {
                    const id = el.getAttribute('data-event-id');
                    return id && id.startsWith('~');
                });
                for (const pending of pendingMessages) {
                    const textEl = pending.querySelector('.message-body');
                    // Simple text match
                    if (textEl && textEl.textContent === messageBody) {
                        existing = pending;
                        break;
                    }
                }
            }

            if (existing) {
                const isPlaceholder = existing.getAttribute('data-placeholder') === 'true';
                const oldId = existing.getAttribute('data-event-id');

                if (oldId === eventId && !isPlaceholder && event.getType() !== 'm.room.encrypted') {
                    return null;
                }

                // CRITICAL FIX: Prevent ghost local echoes from overwriting confirmed remote messages
                // This happens when reloading the page and both stay in cache
                if (oldId && !oldId.startsWith('~') && eventId && eventId.startsWith('~')) {
                    // We already have the confirmed version, drop the duplicate pending version
                    return null;
                }

                existing.remove();
            }

            const timestamp = event.getTs();

            const senderName = this.getSenderName(sender);

            // If message is still encrypted after initCrypto (could happen for old messages or missing keys)
            if (event.getType() === 'm.room.encrypted') {
                const reason = typeof event.getDecryptionError === 'function' ? event.getDecryptionError() : (event.decryptionFailureReason || 'нет ключей');
                messageBody = `🔒 [Зашифровано: ${reason}]`;

                // Add a small hint to user
                console.warn(`[CRYPTO] Event ${event.getId()} failed to decrypt:`, reason);
            }

            const room = this.client.getRoom(event.getRoomId()); // CRITICAL: Use event's room ID, not currentRoomId
            if (!room) {
                console.warn('[UI] Room not found for event:', event.getRoomId());
                // We can still render, but some info will be missing (like power levels)
            }

            const member = room ? room.getMember(sender) : null;

            // ADMIN Logic: Simplify using built-in SDK power level
            // Note: We skip the "ADMIN" badge in 1:1 rooms (DMs) because usually both users have PL 100 there.
            const isGroupRoom = room && room.getJoinedMemberCount() > 2;
            const isAdmin = !!(isGroupRoom && member && member.powerLevel >= 50);

            // Use raw MXC URL from member events (most reliable for others' avatars)
            let mxcAvatarUrl = member?.user?.avatarUrl;
            if (!mxcAvatarUrl && member?.events?.member) {
                mxcAvatarUrl = member.events.member.getContent().avatar_url;
            }

            const avatarUrl = this.getAvatarUrl(mxcAvatarUrl, sender);

            const messageElement = document.createElement('div');
            messageElement.className = `message ${isMe ? 'sent' : 'received'}`;
            messageElement.setAttribute('data-event-id', eventId);
            if (transactionId) messageElement.setAttribute('data-txn-id', transactionId);

            // Mark as placeholder if it's currently encrypted/undecrypted
            if (event.getType() === 'm.room.encrypted' && event.isDecryptionFailure()) {
                messageElement.setAttribute('data-placeholder', 'true');
            }

            if (isAdmin) {
                console.log(`[ADMIN DEBUG] Room Admin detected: ${sender} (PL: ${member?.powerLevel})`);
            }

            let messageHtml = `<div class="message-body">${this.escapeHtml(messageBody)}</div>`;

            // CUSTOM: Shared Radio Station Card
            if (content.msgtype === 'typec.radio_station' && content.station) {
                const s = content.station;
                // Check if already in my hub
                const isAlreadyAdded = this.radioStations.some(rs => rs.url === s.url);

                messageHtml = `
                <div class="shared-station-card">
                    <img src="${s.cover}" class="shared-card-art" alt="Radio">
                    <div class="shared-card-info">
                        <div class="shared-card-type">Радиоволна</div>
                        <div class="shared-card-name">${this.escapeHtml(s.name)}</div>
                    </div>
                    <button class="btn-add-shared ${isAlreadyAdded ? 'added' : ''}" 
                            onclick="window.messenger.addSharedStation('${this.escapeHtml(s.name)}', '${s.url}', '${s.cover}', this)">
                        ${isAlreadyAdded ? 'Добавлено' : 'Добавить'}
                    </button>
                </div>`;
            }

            // Handle attachments
            const isImage = content.msgtype === 'm.image' ||
                (content.info && content.info.mimetype && content.info.mimetype.startsWith('image/')) ||
                (content.body && /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(content.body));

            if (isImage && (content.url || (content.file && content.file.url))) {
                const mxcUrl = content.url || content.file.url;
                messageHtml = `
                <div class="message-attachment">
                    <div class="image-loader" data-mxc="${mxcUrl}" data-body="${this.escapeHtml(content.body)}">
                        <div class="loading-placeholder" style="padding: 20px; border: 1px dashed var(--color-border); border-radius: 8px; text-align: center; font-size: 0.8rem;">
                            Загрузка фото...
                        </div>
                    </div>
                </div>`;

                // Trigger load after render
                setTimeout(() => this.loadAuthenticatedImage(mxcUrl, messageElement), 0);
            } else if (content.msgtype === 'm.file' && content.url) {
                const mxcUrl = content.url;
                messageHtml = `
                <div class="message-attachment">
                    <div class="file-loader" data-mxc="${mxcUrl}" data-body="${this.escapeHtml(content.body)}">
                        <a href="#" class="message-file-link loading" style="opacity: 0.6; pointer-events: none;">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                                <polyline points="13 2 13 9 20 9"></polyline>
                            </svg>
                            ${this.escapeHtml(content.body)} (Загрузка...)
                        </a>
                    </div>
                </div>`;

                // Trigger setup for file link
                setTimeout(() => this.loadAuthenticatedFile(mxcUrl, messageElement), 0);
            }

            const avatarId = `avatar-${Math.random().toString(36).substr(2, 9)}`;

            let badgeHtml = isAdmin ? '<span class="admin-badge">ADMIN</span>' : '';

            // v415: Message Status Indicators (Rock-Solid Cache Handling)
            let statusHtml = '';
            // Show status for OUR messages, even if eventId is temporarily missing or it's a local echo loaded from cache
            if (isMe) {
                const status = event.status; // from Matrix SDK EventStatus
                const isLocalEcho = eventId && eventId.startsWith('~');

                // A message is fully sent if it has no status (or explicitly 'sent') AND is a remote confirmed event ($...)
                const isSent = (!status || status === 'sent') && !isLocalEcho;

                let iconClass = 'status-sent';
                let iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';

                if (status === 'not_sent') {
                    iconClass = 'status-sending text-danger';
                    iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
                } else if (!isSent) { // sending, queued, or local echo
                    iconClass = 'status-sending';
                    iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';
                }

                // Use transactionId for DOM ID fallback if eventId is missing
                const domId = eventId || transactionId || `temp-${Math.random().toString(36).substr(2, 9)}`;
                statusHtml = `<span class="message-status ${iconClass}" id="status-${domId}">${iconSvg}</span>`;
            }

            // Build actions menu (Options Dropdown)
            const canRedact = isMe || isAdmin;
            const safeEventId = eventId && !eventId.startsWith('~') ? eventId : null;

            let actionsHtml = '';
            if (safeEventId) {
                const deleteForAllBtn = canRedact
                    ? `<button class="msg-dropdown-item text-danger" data-action="delete-all">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4h6v2"></path></svg> 
                        Удалить для всех
                       </button>`
                    : '';
                const deleteForMeBtn =
                    `<button class="msg-dropdown-item" data-action="delete-me">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 9l-5 5-5-5"></path></svg> 
                        Удалить у меня
                     </button>`;

                actionsHtml = `
                <div class="msg-actions">
                    <button class="msg-options-toggle" title="Опции">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="5" r="1.5"></circle>
                            <circle cx="12" cy="12" r="1.5"></circle>
                            <circle cx="12" cy="19" r="1.5"></circle>
                        </svg>
                    </button>
                    <div class="msg-options-dropdown hidden">
                        ${deleteForAllBtn}
                        ${deleteForMeBtn}
                    </div>
                </div>`;
            }

            messageElement.innerHTML = `
                <div class="message-avatar" id="${avatarId}">${this.getInitials(senderName)}</div>
                <div class="message-content">
                    <div class="message-header">
                        <span class="message-sender">${this.escapeHtml(senderName)}${badgeHtml}</span>
                        <span class="message-time">${this.formatTime(timestamp)}${statusHtml}</span>
                    </div>
                    ${messageHtml}
                </div>
                ${actionsHtml}
            `;

            // v422: tag each message with sender id for per-user avatar styling
            messageElement.setAttribute('data-sender-id', sender);

            if (mxcAvatarUrl) {
                setTimeout(() => this.loadAuthenticatedAvatar(mxcUrl, avatarId), 0);
            }

            // v422: Async-apply avatar border if sender has one
            this.loadBorderSettings(sender).then(borderData => {
                if (!borderData) return;
                const avatarEl2 = messageElement.querySelector('.message-avatar');
                this.applyAvatarBorder(avatarEl2, borderData);
            }).catch(() => { });

            // v418: Safe Replace In-Place
            // Use replaceWith instead of remove + appendChild to strictly preserve message order 
            // and eliminate visual jumping or duplicate bubbles at the bottom
            let replaced = false;

            if (existing) {
                existing.replaceWith(messageElement);
                replaced = true;
            }

            if (!replaced) {
                if (prepend) {
                    messagesContainer.prepend(messageElement);
                } else {
                    messagesContainer.appendChild(messageElement);
                }
            }

            if (scrollToBottom && !prepend) {
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }

            // Wire up message options dropdown
            const optionsToggle = messageElement.querySelector('.msg-options-toggle');
            const optionsDropdown = messageElement.querySelector('.msg-options-dropdown');

            if (optionsToggle && optionsDropdown) {
                optionsToggle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    // Close any other open dropdowns first
                    document.querySelectorAll('.msg-options-dropdown').forEach(d => {
                        if (d !== optionsDropdown) d.classList.add('hidden');
                    });
                    optionsDropdown.classList.toggle('hidden');
                });
            }

            // Wire up message action buttons inside dropdown
            const actionBtns = messageElement.querySelectorAll('.msg-dropdown-item');
            actionBtns.forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    optionsDropdown?.classList.add('hidden'); // close dropdown

                    const action = btn.dataset.action;
                    const eid = messageElement.getAttribute('data-event-id');
                    if (action === 'delete-all') {
                        this.deleteMessageForEveryone(eid);
                    } else if (action === 'delete-me') {
                        this.deleteMessageForSelf(messageElement, eid);
                    }
                });
            });

            // Close dropdowns when clicking anywhere else
            document.addEventListener('click', () => {
                document.querySelectorAll('.msg-options-dropdown').forEach(d => {
                    d.classList.add('hidden');
                });
            });

            const avatarEl = messageElement.querySelector('.message-avatar');
            const senderEl = messageElement.querySelector('.message-sender');

            if (avatarEl) {
                avatarEl.style.cursor = 'pointer';
                avatarEl.addEventListener('click', () => this.openProfileModal(sender));
            }
            if (senderEl) {
                senderEl.style.cursor = 'pointer';
                senderEl.addEventListener('click', () => this.openProfileModal(sender));
            }

            // v426: Mobile Tap to toggle actions (since hover isn't reliable on touch)
            messageElement.addEventListener('click', () => {
                if (window.innerWidth <= 768) {
                    const wasVisible = messageElement.classList.contains('actions-visible');
                    // Hide all others
                    document.querySelectorAll('.message.actions-visible').forEach(m => m.classList.remove('actions-visible'));
                    // Toggle this one
                    if (!wasVisible) messageElement.classList.add('actions-visible');
                }
            });

            return messageElement;
        } catch (error) {
            console.error('[UI] addMessageToTimeline failed:', error);
        }
    }

    // v412: Update individual message status (Sent/Delivered)
    updateMessageReceiptStatus(event) {
        let eventId = event.getId();

        // Matrix local echo events might have an unsigned transaction ID
        const txnId = event.getUnsigned() ? event.getUnsigned().transaction_id : (typeof event.getTxnId === 'function' ? event.getTxnId() : null);

        let msgEl = null;

        // 1. Try to find the message in the DOM via transaction ID first (most reliable for local echoes)
        if (txnId) msgEl = document.querySelector(`[data-txn-id="${txnId}"]`) || document.getElementById(`status-${txnId}`)?.closest('.message');

        // 2. Fallback to finding by current eventId
        if (!msgEl && eventId) {
            msgEl = document.querySelector(`[data-event-id="${eventId}"]`) || document.getElementById(`status-${eventId}`)?.closest('.message');
        }

        if (!msgEl) return;

        const currentDomId = msgEl.getAttribute('data-event-id');

        // CRITICAL FIX: Upgrade the DOM ID from local echo (~...) to real event ID ($...) when it's confirmed
        if (eventId && (!currentDomId || currentDomId !== eventId) && !eventId.startsWith('~')) {
            msgEl.setAttribute('data-event-id', eventId);
            const statusSpan = msgEl.querySelector('.message-status');
            if (statusSpan) {
                statusSpan.id = `status-${eventId}`;
            }
        }

        const statusEl = msgEl.querySelector('.message-status');
        if (!statusEl) return;

        // v415: If the DOM already has a confirmed remote echo ($...),
        // ignore any late local echo (~...) updates that would downgrade its status back to "sending"
        if (currentDomId && !currentDomId.startsWith('~') && eventId.startsWith('~') && event.status !== 'not_sent') {
            return;
        }

        const status = event.status;

        // ROOT CAUSE FIX (v419):
        // Matrix SDK fires Event.status='sent' on the LOCAL ECHO event (id still starts with ~)
        // when the server has CONFIRMED receipt. This IS sent! We must NOT exclude it.
        // Only clock if: status is 'sending'/'queued' AND we don't yet have server confirmation
        // Checkmark if: status is null (remote echo, confirmed server event) OR status === 'sent'
        // Error if: status === 'not_sent'
        const isSent = !status || status === 'sent';

        let iconClass = 'status-sent';
        let iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>';

        if (status === 'not_sent') {
            iconClass = 'status-sending text-danger';
            iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
        } else if (!isSent) {
            iconClass = 'status-sending';
            iconSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';
        }

        // Only revert from 'read' if it surprisingly failed
        if (!statusEl.classList.contains('status-read') || status === 'not_sent') {
            statusEl.className = `message-status ${iconClass}`;
            statusEl.innerHTML = iconSvg;
        }

        // Trigger a read-receipt check just in case this message is already covered by an existing receipt
        if (isSent) {
            const room = this.client.getRoom(this.currentRoomId);
            if (room) this.updateRoomReceipts(room);
        }
    }

    // v411: Update read receipts for all messages in the room
    updateRoomReceipts(room) {
        if (!room || room.roomId !== this.currentRoomId) return;

        const myUserId = this.client.getUserId();
        const members = room.getJoinedMembers();

        // Skip in "Saved Messages" 1:1 with oneself
        if (members.length === 1 && members[0].userId === myUserId) return;

        const messagesContainer = document.getElementById('messages-container');
        if (!messagesContainer) return;

        // Check all sent messages that aren't marked read yet
        const myMessages = messagesContainer.querySelectorAll('.message.sent:not(.status-read)');

        myMessages.forEach(msgEl => {
            const eventId = msgEl.getAttribute('data-event-id');
            if (!eventId || eventId.startsWith('~')) return; // Skip local echoes that aren't synced

            const statusEl = document.getElementById(`status-${eventId}`);
            if (!statusEl || statusEl.classList.contains('status-read')) return;

            let isRead = false;

            try {
                if (typeof room.hasUserReadEvent === 'function') {
                    let totalOthers = 0;
                    let readCount = 0;
                    for (const member of members) {
                        if (member.userId === myUserId) continue;
                        totalOthers++;

                        // Strict check to ensure we only count real reads
                        if (room.hasUserReadEvent(member.userId, eventId)) {
                            readCount++;
                        }
                    }
                    if (totalOthers > 0 && readCount === totalOthers) {
                        isRead = true; // Mark as read ONLY if EVERYONE else read it
                    }
                }
            } catch (err) {
                console.debug('[RECEIPTS] Error checking read state:', err);
            }

            if (isRead) {
                statusEl.className = 'message-status status-read';
                statusEl.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 6 11 13 8 10"></polyline><polyline points="22 6 15 13 12 10"></polyline></svg>';
            }
        });
    }

    async handleSendMessage() {
        const messageInput = document.getElementById('message-input');
        const message = messageInput.value.trim();

        if (!message || !this.currentRoomId) return;

        this.trackRecentRoom(this.currentRoomId);

        try {
            // Check if room is encrypted
            const room = this.client.getRoom(this.currentRoomId);
            const isEncrypted = room && room.currentState.getStateEvents('m.room.encryption', '');

            if (isEncrypted && !this.client.isCryptoEnabled()) {
                console.error('[CRYPTO] Blocked: Insecure context or missing crypto support.');
                alert('⚠️ ОШИБКА ШИФРОВАНИЯ\n\nЭтот чат защищён (E2EE), но ваш браузер заблокировал функции шифрования.\n\nПРИЧИНА: Браузеры запрещают шифрование при простом открытии файла (file://).\n\nРЕШЕНИЕ: \n1. Запустите мессенджер через локальный сервер (http://localhost).\n2. Или откройте его через любой веб-сервер с поддержкой HTTPS.');
                return;
            }

            // Optimistic UI: Clear input immediately
            messageInput.value = '';
            messageInput.focus(); // Keep focus

            // use sendMessage instead of sendEvent for better E2EE handling in SDK
            await this.client.sendMessage(this.currentRoomId, {
                msgtype: 'm.text',
                body: message
            });

        } catch (error) {
            console.error('Error sending message:', error);

            let extraInfo = '';
            if (error.message && error.message.includes('encryption')) {
                extraInfo = `\n\n[Debug Info]\nCrypto Enabled: ${this.client.isCryptoEnabled()}\nDeviceId: ${this.client.deviceId}\nRoom Id: ${this.currentRoomId}`;
                console.log('%c [CRYPTO-DEBUG] ' + extraInfo, 'color: #ff9900;');
            }

            alert('Ошибка отправки сообщения: ' + error.message + extraInfo);
        }
    }

    // ==========================================
    // Message Deletion
    // ==========================================

    async deleteMessageForEveryone(eventId) {
        if (!eventId || !this.currentRoomId) return;
        if (!confirm('Удалить это сообщение для всех участников чата?')) return;
        try {
            await this.client.redactEvent(this.currentRoomId, eventId);
            // The Room.redaction listener will handle removing it from DOM
        } catch (e) {
            console.error('[DELETE] redactEvent failed:', e);
            alert('Не удалось удалить сообщение: ' + e.message);
        }
    }

    deleteMessageForSelf(msgElement, eventId) {
        if (!eventId) return;
        // Store in localStorage so message stays hidden across refreshes
        const key = `hidden_${this.client.getUserId()}`;
        let hidden = [];
        try { hidden = JSON.parse(localStorage.getItem(key) || '[]'); } catch { }
        if (!hidden.includes(eventId)) hidden.push(eventId);
        localStorage.setItem(key, JSON.stringify(hidden));
        // Animate and remove from DOM
        msgElement.style.transition = 'opacity 0.25s, max-height 0.3s';
        msgElement.style.opacity = '0';
        msgElement.style.maxHeight = '0';
        msgElement.style.overflow = 'hidden';
        setTimeout(() => msgElement.remove(), 320);
    }

    getSelfHiddenEvents() {
        const key = `hidden_${this.client.getUserId()}`;
        try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
    }

    setupRedactionListener() {
        if (this._redactionListenerAttached) return;
        this._redactionListenerAttached = true;

        // Listen for redaction events so messages deleted by anyone disappear immediately
        this.client.on('Room.timeline', (event, room, toStartOfTimeline) => {
            if (event.getType() !== 'm.room.redaction') return;
            if (room.roomId !== this.currentRoomId) return;
            const redactedId = event.getAssociatedId?.() || event.event?.redacts;
            if (!redactedId) return;
            const msgEl = document.querySelector(`[data-event-id="${redactedId}"]`);
            if (msgEl) {
                msgEl.style.transition = 'opacity 0.25s';
                msgEl.style.opacity = '0';
                setTimeout(() => msgEl.remove(), 280);
            }
        });
    }

    filterRooms(query) {
        console.log('[SEARCH] Filtering rooms with query:', query);
        const roomItems = document.querySelectorAll('.room-item, .invite-item');
        const lowerQuery = (query || '').toLowerCase().trim();

        roomItems.forEach(item => {
            const h4 = item.querySelector('h4');
            // Extract text but ignore the radio status indicator if it exists
            let roomName = '';
            if (h4) {
                // Get only direct text nodes if possible, or just the whole text and clean it
                roomName = h4.textContent.toLowerCase();
            }

            if (!lowerQuery || roomName.includes(lowerQuery)) {
                item.style.display = '';
            } else {
                item.style.display = 'none';
            }
        });
    }

    // ==========================================
    // Tabs and UI Management
    // ==========================================

    switchTab(tab) {
        this.currentTab = tab;

        // Update tab buttons (Sidebar & Mobile Nav)
        document.querySelectorAll('.tab-btn, .mobile-nav .nav-item[data-tab]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });

        // Hide all lists/show appropriate one
        const roomsList = document.getElementById('rooms-list');
        const invitesList = document.getElementById('invites-list');

        if (tab === 'invites') {
            roomsList.classList.add('hidden');
            invitesList.classList.remove('hidden');
            this.loadInvites();
        } else {
            roomsList.classList.remove('hidden');
            invitesList.classList.add('hidden');
            this.loadRooms();
        }

        // Show/hide action buttons
        const newDmBtn = document.getElementById('new-dm-btn');
        const newEncryptedDmBtn = document.getElementById('new-encrypted-dm-btn');
        const createRoomBtn = document.getElementById('create-room-btn');
        const exploreRoomsBtn = document.getElementById('explore-rooms-btn');

        if (tab === 'dms') {
            if (newDmBtn) newDmBtn.style.display = '';
            if (newEncryptedDmBtn) newEncryptedDmBtn.style.display = '';
            if (createRoomBtn) createRoomBtn.style.display = 'none';
            if (exploreRoomsBtn) exploreRoomsBtn.style.display = 'none';
        } else if (tab === 'rooms') {
            if (newDmBtn) newDmBtn.style.display = 'none';
            if (newEncryptedDmBtn) newEncryptedDmBtn.style.display = 'none';
            if (createRoomBtn) createRoomBtn.style.display = '';
            if (exploreRoomsBtn) exploreRoomsBtn.style.display = '';
        } else {
            // Invites tab - no header buttons
            if (newDmBtn) newDmBtn.style.display = 'none';
            if (newEncryptedDmBtn) newEncryptedDmBtn.style.display = 'none';
            if (createRoomBtn) createRoomBtn.style.display = 'none';
            if (exploreRoomsBtn) exploreRoomsBtn.style.display = 'none';
        }
    }

    loadInvites() {
        const invitesList = document.getElementById('invites-list');
        const rooms = this.client.getRooms();

        // Filter for invited rooms
        const invitedRooms = rooms.filter(room => {
            return room.getMyMembership() === 'invite';
        });

        if (invitedRooms.length === 0) {
            invitesList.innerHTML = '<div class="empty-state">Нет приглашений</div>';
            return;
        }

        invitesList.innerHTML = '';
        invitedRooms.forEach(room => {
            const item = document.createElement('div');
            item.className = 'invite-item';

            // Try to find reasonable name or inviter
            let roomName = room.name || 'Приглашение в чат';

            // Get inviter
            const memberEvent = room.currentState.getStateEvents('m.room.member', this.client.getUserId());
            const inviterId = memberEvent ? memberEvent.getSender() : 'Неизвестно';

            item.innerHTML = `
                <div class="invite-info">
                    <h4>${this.escapeHtml(roomName)}</h4>
                    <p>От: ${this.escapeHtml(inviterId)}</p>
                </div>
                <div class="invite-actions">
                    <button class="btn-accept" data-room-id="${room.roomId}">Принять</button>
                    <button class="btn-reject" data-room-id="${room.roomId}">Отклонить</button>
                </div>
            `;

            item.querySelector('.btn-accept').addEventListener('click', (e) => {
                e.preventDefault();
                this.handleJoinInvite(room.roomId);
            });

            item.querySelector('.btn-reject').addEventListener('click', (e) => {
                e.preventDefault();
                this.handleRejectInvite(room.roomId);
            });

            invitesList.appendChild(item);
        });
    }

    async handleJoinInvite(roomId) {
        try {
            await this.client.joinRoom(roomId);
            // Refresh will happen automatically via sync, but we can force UI update
            setTimeout(() => this.loadInvites(), 500);
        } catch (error) {
            console.error('Error joining room:', error);
            alert('Ошибка присоединения: ' + error.message);
        }
    }

    async handleRejectInvite(roomId) {
        try {
            await this.client.leave(roomId);
            setTimeout(() => this.loadInvites(), 500);
        } catch (error) {
            console.error('Error rejecting invite:', error);
            alert('Ошибка отклонения: ' + error.message);
        }
    }

    // --- Global Room Discovery ---
    async openPublicRoomsModal() {
        this.openModal('public-rooms-modal');
        await this.loadPublicRooms();
    }

    async loadPublicRooms(filter = '') {
        console.log('[DISCOVERY] loadPublicRooms called with filter:', filter);
        const resultsContainer = document.getElementById('public-rooms-results');
        if (!resultsContainer) return;

        resultsContainer.innerHTML = `
            <div class="loading-state">
                <div class="spinner"></div>
                <p>Загрузка списка комнат...</p>
            </div>
        `;

        try {
            const hs = localStorage.getItem('matrix_homeserver');
            let serverHostname = undefined;
            if (hs) {
                try {
                    // Try to extract hostname if it's a URL
                    if (hs.includes('://')) {
                        serverHostname = new URL(hs).hostname;
                    } else {
                        serverHostname = hs.split(':')[0]; // Just in case it's domain:port
                    }
                } catch (urlErr) {
                    serverHostname = hs;
                }
            }

            const options = {
                limit: 50,
                server: serverHostname
            };

            if (filter && filter.trim()) {
                options.filter = { generic_search_term: filter.trim() };
            }

            console.log('[DISCOVERY] Requesting public rooms from:', serverHostname, 'with options:', options);

            if (!this.client) {
                throw new Error('КЛИЕНТ НЕ ИНИЦИАЛИЗИРОВАН');
            }

            const response = await this.client.publicRooms(options);
            console.log('[DISCOVERY] Received response:', response);
            this.renderPublicRooms(response.chunk || []);
        } catch (e) {
            console.error('[DISCOVERY] Detailed Error:', e);
            resultsContainer.innerHTML = `
                <div class="empty-state">
                    <p>Ошибка загрузки: ${this.escapeHtml(e.message)}</p>
                    <button class="btn-secondary" onclick="messenger.loadPublicRooms()">Повторить</button>
                </div>
            `;
        }
    }

    renderPublicRooms(rooms) {
        const resultsContainer = document.getElementById('public-rooms-results');
        if (!resultsContainer) return;

        if (rooms.length === 0) {
            resultsContainer.innerHTML = '<div class="empty-state">Комнаты не найдены</div>';
            return;
        }

        resultsContainer.innerHTML = '';
        rooms.forEach(room => {
            const item = document.createElement('div');
            item.className = 'discovery-item';

            // Check if already joined
            const joinedRooms = this.client.getRooms();
            const isJoined = joinedRooms.some(r => r.roomId === room.room_id && r.getMyMembership() === 'join');
            if (isJoined) item.classList.add('joined');

            item.innerHTML = `
                <div class="discovery-info">
                    <h4>${this.escapeHtml(room.name || room.room_id)}</h4>
                    <p>${this.escapeHtml(room.topic || 'Нет описания')}</p>
                    <div class="discovery-meta">
                        <span class="member-pill">${room.num_joined_members} участников</span>
                        <span style="font-size: 10px; color: var(--color-text-tertiary)">${this.escapeHtml(room.canonical_alias || room.room_id)}</span>
                    </div>
                </div>
                <div class="discovery-actions">
                    <button class="btn-join" data-room-id="${room.room_id}" ${isJoined ? 'disabled' : ''}>
                        ${isJoined ? 'Вступил' : 'Вступить'}
                    </button>
                </div>
            `;

            // Join handler
            const joinBtn = item.querySelector('.btn-join');
            if (joinBtn) {
                joinBtn.addEventListener('click', () => this.handleJoinPublicRoom(room.room_id, joinBtn));
            }

            resultsContainer.appendChild(item);
        });
    }

    async handleJoinPublicRoom(roomId, btn) {
        try {
            btn.disabled = true;
            btn.textContent = 'Входим...';
            await this.client.joinRoom(roomId);
            btn.textContent = 'Вступил';
            btn.closest('.discovery-item').classList.add('joined');
            this.loadRooms(); // Refresh sidebar
        } catch (e) {
            console.error('[DISCOVERY] Join failed:', e);
            alert('Не удалось вступить в комнату: ' + e.message);
            btn.disabled = false;
            btn.textContent = 'Вступить';
        }
    }

    isDMRoom(room) {
        // 1. Check m.direct account data (Authoritative)
        const dmRooms = this.client.getAccountData('m.direct')?.getContent() || {};
        for (const userId in dmRooms) {
            if (dmRooms[userId].includes(room.roomId)) {
                return true;
            }
        }

        // 2. Heuristics for direct chats (if not in m.direct)
        const joinedMembers = room.getJoinedMemberCount();
        const invitedMembers = room.getInvitedMemberCount();
        const totalMembers = joinedMembers + invitedMembers;

        // DMs usually have 2 members (active) or 1 (if just created/invited)
        // Groups usually have > 2, but small groups can have 2.
        // We rely on empty name or name matching a user pattern.

        if (totalMembers <= 2) {
            // If the room has no explicit name set, it's likely a DM
            // Use room.currentState to safely get state for accurate room naming check
            const nameEvent = room.currentState.getStateEvents('m.room.name', '');

            if (!nameEvent || !nameEvent.getContent().name) {
                return true;
            }
        }

        return false;
    }

    // ==========================================
    // Modal Management
    // ==========================================

    openModal(modalId) {
        document.getElementById(modalId).classList.add('active');
    }

    closeModal(modalId) {
        document.getElementById(modalId).classList.remove('active');

        // Clear search inputs
        if (modalId === 'new-dm-modal') {
            document.getElementById('user-search-input').value = '';
            document.getElementById('user-search-results').innerHTML = '<p class="search-hint">Начните вводить для поиска пользователей</p>';
        } else if (modalId === 'create-room-modal') {
            document.getElementById('create-room-form').reset();
        } else if (modalId === 'invite-user-modal') {
            document.getElementById('invite-user-form').reset();
        } else if (modalId === 'public-rooms-modal') {
            const searchInput = document.getElementById('public-room-search');
            if (searchInput) searchInput.value = '';
            const results = document.getElementById('public-rooms-results');
            if (results) {
                results.innerHTML = `
                    <div class="loading-state">
                        <div class="spinner"></div>
                        <p>Загрузка списка комнат...</p>
                    </div>
                `;
            }
        }
    }

    closeAllModals() {
        document.querySelectorAll('.modal').forEach(modal => {
            modal.classList.remove('active', 'show');
        });
    }

    openMediaPreview(url, title, downloadUrl = null) {
        const modal = document.getElementById('media-preview-modal');
        const img = document.getElementById('media-preview-image');
        const titleEl = document.getElementById('media-preview-title');
        const downloadBtn = document.getElementById('media-preview-download');

        if (!modal || !img) return;

        titleEl.textContent = title || 'Просмотр';
        img.src = url;

        if (downloadBtn) {
            if (downloadUrl) {
                downloadBtn.href = downloadUrl;
                downloadBtn.style.display = 'flex';
            } else {
                downloadBtn.style.display = 'none';
            }
        }

        this.openModal('media-preview-modal');
    }

    // ==========================================
    // User Search and DM Creation
    // ==========================================

    async searchUsers(query) {
        const resultsContainer = document.getElementById('user-search-results');

        if (!query || query.trim().length < 2) {
            resultsContainer.innerHTML = '<p class="search-hint">Начните вводить для поиска пользователей</p>';
            return;
        }

        try {
            const results = await this.client.searchUserDirectory({ term: query, limit: 10 });
            let hasResults = false;

            resultsContainer.innerHTML = '';

            if (results.results.length > 0) {
                hasResults = true;
                results.results.forEach(user => {
                    const userElement = document.createElement('div');
                    userElement.className = 'search-result-item';
                    userElement.innerHTML = `
                        <h4>${this.escapeHtml(user.display_name || user.user_id)}${this.getRadioStatusHTML(user.user_id)}</h4>
                        <p>${this.escapeHtml(user.user_id)}</p>
                    `;

                    userElement.addEventListener('click', () => {
                        this.createDirectMessage(user.user_id, this.isSettingUpEncryptedDM);
                    });

                    resultsContainer.appendChild(userElement);
                });
            }

            // Always offer to start chat with the searched query as a potential username
            // Construct potential full user ID
            let potentialUserId = query.trim();
            if (!potentialUserId.startsWith('@')) potentialUserId = '@' + potentialUserId;
            if (!potentialUserId.includes(':')) potentialUserId = potentialUserId + ':type-c-kmr.duckdns.org';

            // Check if this potential ID is already in the results to avoid duplicates
            const alreadyShown = results.results.some(u => u.user_id === potentialUserId);

            if (!alreadyShown) {
                const manualElement = document.createElement('div');
                manualElement.className = 'search-result-item';
                // Add a visual separator or style if there were other results
                if (hasResults) {
                    manualElement.style.borderTop = '1px solid var(--color-border)';
                }

                manualElement.innerHTML = `
                    <h4 style="color: var(--color-accent-green)">Написать ${this.escapeHtml(potentialUserId)}</h4>
                    <p>Нажмите, чтобы создать чат с этим пользователем</p>
                `;

                manualElement.addEventListener('click', () => {
                    this.createDirectMessage(potentialUserId, this.isSettingUpEncryptedDM);
                });

                resultsContainer.appendChild(manualElement);
                hasResults = true;
            }

            if (!hasResults) {
                resultsContainer.innerHTML = '<p class="search-no-results">Пользователи не найдены</p>';
            }

        } catch (error) {
            console.error('User search error:', error);
            resultsContainer.innerHTML = '<p class="search-no-results">Ошибка поиска пользователей</p>';
        }
    }

    async createDirectMessage(userId, encrypted = false) {
        try {
            // Check if DM already exists
            const existingDM = this.findExistingDM(userId);
            if (existingDM) {
                // If it exists, but we want encrypted and it's not (or vice versa), 
                // we'll still go to it, but warn? Or just create a new one?
                // Standard Matrix behavior is to reuse.
                this.closeModal('new-dm-modal');
                this.selectRoom(existingDM);
                this.switchTab('dms');
                return;
            }

            // Create new DM room
            const roomOptions = {
                visibility: 'private',
                is_direct: true,
                invite: [userId],
                preset: 'trusted_private_chat'
            };

            if (encrypted) {
                roomOptions.initial_state = [
                    {
                        type: 'm.room.encryption',
                        state_key: '',
                        content: {
                            algorithm: 'm.megolm.v1.aes-sha2'
                        }
                    }
                ];
            }

            const result = await this.client.createRoom(roomOptions);

            console.log('DM created:', result.room_id, encrypted ? '(Encrypted)' : '');

            // Mark room as direct
            await this.markRoomAsDirect(result.room_id, userId);

            this.closeModal('new-dm-modal');

            // Wait for sync to get new room
            setTimeout(() => {
                this.loadRooms();
                this.selectRoom(result.room_id);
                this.switchTab('dms');
            }, 1000);

        } catch (error) {
            console.error('Error creating DM:', error);
            alert('Ошибка создания личного сообщения: ' + error.message);
        }
    }

    findExistingDM(userId) {
        const rooms = this.client.getRooms();
        for (const room of rooms) {
            if (this.isDMRoom(room)) {
                const members = room.getJoinedMembers();
                if (members.some(m => m.userId === userId)) {
                    return room.roomId;
                }
            }
        }
        return null;
    }

    async markRoomAsDirect(roomId, userId) {
        try {
            const dmRooms = this.client.getAccountData('m.direct')?.getContent() || {};

            if (!dmRooms[userId]) {
                dmRooms[userId] = [];
            }

            if (!dmRooms[userId].includes(roomId)) {
                dmRooms[userId].push(roomId);
            }

            await this.client.setAccountData('m.direct', dmRooms);
        } catch (error) {
            console.error('Error marking room as direct:', error);
        }
    }

    // ==========================================
    // Room Creation
    // ==========================================

    async handleCreateRoom() {
        const roomName = document.getElementById('room-name').value.trim();
        const roomTopic = document.getElementById('room-topic').value.trim();
        const isPublic = document.getElementById('room-public').checked;

        if (!roomName) {
            alert('Введите название комнаты');
            return;
        }

        try {
            const roomOptions = {
                name: roomName,
                topic: roomTopic,
            };

            if (isPublic) {
                // Public room configuration that other clients can see
                roomOptions.visibility = 'public';
                roomOptions.preset = 'public_chat';
                // Important for visibility in some clients
                roomOptions.initial_state = [
                    {
                        type: 'm.room.join_rules',
                        content: { join_rule: 'public' }
                    },
                    {
                        type: 'm.room.history_visibility',
                        content: { history_visibility: 'world_readable' }
                    }
                ];

                // Set alias based on name (sanitized) to make it findable via alias too
                // This is optional but helpful
                const alias = roomName.toLowerCase().replace(/[^a-z0-9]/g, '');
                if (alias.length > 3) {
                    roomOptions.room_alias_name = alias;
                }
            } else {
                roomOptions.visibility = 'private';
                roomOptions.preset = 'private_chat';
            }

            const result = await this.client.createRoom(roomOptions);

            console.log('Room created:', result.room_id);

            // If public, explicitly ensure it's in the directory (createRoom visibility='public' should do this, but double check)
            if (isPublic) {
                try {
                    await this.client.setRoomDirectoryVisibility(result.room_id, 'public');
                } catch (e) {
                    console.warn('Could not set directory visibility explicitly:', e);
                }
            }

            this.closeModal('create-room-modal');

            // Wait for sync
            setTimeout(() => {
                this.loadRooms();
                this.selectRoom(result.room_id);
                this.switchTab('rooms');
            }, 1000);

        } catch (error) {
            console.error('Error creating room:', error);
            alert('Ошибка создания комнаты: ' + error.message);
        }
    }

    async handleInviteUser() {
        const usernameInput = document.getElementById('invite-username');
        let username = usernameInput.value.trim();

        if (!username) return;

        // Auto-format username
        if (!username.startsWith('@')) username = '@' + username;
        if (!username.includes(':')) username += ':type-c-kmr.duckdns.org';

        if (!this.currentRoomId) return;

        try {
            await this.client.invite(this.currentRoomId, username);
            alert(`Пользователь ${username} приглашен!`);
            this.closeModal('invite-user-modal');
            usernameInput.value = '';
        } catch (error) {
            console.error('Invite error:', error);
            alert('Ошибка приглашения: ' + (error.message || 'Неизвестная ошибка'));
        }
    }

    openMembersModal() {
        if (!this.currentRoomId) return;
        this.openModal('members-modal');
        this.renderMembersList();
    }

    renderMembersList() {
        const room = this.client.getRoom(this.currentRoomId);
        if (!room) return;

        const container = document.getElementById('members-list-container');
        if (!container) return;
        container.innerHTML = '';

        const members = room.getJoinedMembers();
        const myUserId = this.client.getUserId();

        // Get power levels
        const powerLevelsEvent = room.currentState.getStateEvents('m.room.power_levels', '');
        const plContent = powerLevelsEvent ? powerLevelsEvent.getContent() : {};
        const usersPl = plContent.users || {};

        const myPowerLevel = usersPl[myUserId] !== undefined ? usersPl[myUserId] : (plContent.users_default || 0);
        const kickLevel = plContent.kick !== undefined ? plContent.kick : 50;
        const banLevel = plContent.ban !== undefined ? plContent.ban : 50;
        const stateLevel = plContent.state_default !== undefined ? plContent.state_default : 50;

        members.forEach(member => {
            const userPowerLevel = member.powerLevel || 0;
            const role = userPowerLevel >= 100 ? 'Admin' : (userPowerLevel >= 50 ? 'Mod' : 'Member');
            const roleClass = userPowerLevel >= 100 ? 'role-admin' : (userPowerLevel >= 50 ? 'role-mod' : 'role-member');

            const item = document.createElement('div');
            item.className = 'member-item';

            // Actions logic
            let actionsHtml = '';
            if (member.userId !== myUserId) {
                const canKick = myPowerLevel >= kickLevel && myPowerLevel > userPowerLevel;
                const canBan = myPowerLevel >= banLevel && myPowerLevel > userPowerLevel;
                const canPromote = myPowerLevel >= stateLevel && myPowerLevel > userPowerLevel && userPowerLevel < 100;

                if (canKick) {
                    actionsHtml += `<button class="btn-member-action action-danger" data-user-id="${member.userId}" data-action="kick" title="Кикнуть">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>`;
                }
                if (canBan) {
                    actionsHtml += `<button class="btn-member-action action-danger" data-user-id="${member.userId}" data-action="ban" title="Забанить">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
                    </button>`;
                }
                if (canPromote) {
                    actionsHtml += `<button class="btn-member-action" data-user-id="${member.userId}" data-action="promote" title="Сделать администратором">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                    </button>`;
                }
            }

            item.innerHTML = `
                <div class="member-avatar" style="cursor: pointer;">${this.getInitials(member.name)}</div>
                <div class="member-info" style="cursor: pointer;">
                    <div class="member-name-row">
                        <span class="member-name">${this.escapeHtml(member.name)}${this.getRadioStatusHTML(member.userId)}</span>
                        <span class="role-badge ${roleClass}">${role}</span>
                    </div>
                    <div class="member-id">${member.userId}</div>
                </div>
                <div class="member-actions">${actionsHtml}</div>
            `;

            // Add profile click handlers
            const avatar = item.querySelector('.member-avatar');
            const info = item.querySelector('.member-info');
            if (avatar) avatar.addEventListener('click', () => this.openProfileModal(member.userId));
            if (info) info.addEventListener('click', () => this.openProfileModal(member.userId));

            // Add events to buttons
            item.querySelectorAll('.btn-member-action').forEach(btn => {
                btn.addEventListener('click', () => {
                    const userId = btn.dataset.userId;
                    const action = btn.dataset.action;
                    if (action === 'kick') this.handleKickMember(userId);
                    else if (action === 'ban') this.handleBanMember(userId);
                    else if (action === 'promote') this.handlePromoteMember(userId);
                });
            });

            container.appendChild(item);
        });
    }

    filterMembers(query) {
        const lowerQuery = query.toLowerCase();
        document.querySelectorAll('.member-item').forEach(item => {
            const nameElt = item.querySelector('.member-name');
            const idElt = item.querySelector('.member-id');
            const name = nameElt ? nameElt.textContent.toLowerCase() : '';
            const id = idElt ? idElt.textContent.toLowerCase() : '';
            if (name.includes(lowerQuery) || id.includes(lowerQuery)) {
                item.style.display = 'flex';
            } else {
                item.style.display = 'none';
            }
        });
    }

    filterMembers(query) {
        const lowerQuery = query.toLowerCase();
        document.querySelectorAll('.member-item').forEach(item => {
            const nameElt = item.querySelector('.member-name');
            const idElt = item.querySelector('.member-id');
            const name = nameElt ? nameElt.textContent.toLowerCase() : '';
            const id = idElt ? idElt.textContent.toLowerCase() : '';
            if (name.includes(lowerQuery) || id.includes(lowerQuery)) {
                item.style.display = 'flex';
            } else {
                item.style.display = 'none';
            }
        });
    }

    async handleKickMember(userId) {
        if (!confirm(`Вы уверены, что хотите исключить пользователя ${userId}?`)) return;
        try {
            await this.client.kick(this.currentRoomId, userId);
            this.renderMembersList();
        } catch (e) {
            alert('Ошибка: ' + e.message);
        }
    }

    async handleBanMember(userId) {
        if (!confirm(`Вы уверены, что хотите забанить пользователя ${userId}?`)) return;
        try {
            await this.client.ban(this.currentRoomId, userId);
            this.renderMembersList();
        } catch (e) {
            alert('Ошибка: ' + e.message);
        }
    }

    async handlePromoteMember(userId) {
        if (!confirm(`Вы уверены, что хотите выдать права АДМИНИСТРАТОРА пользователю ${userId}?`)) return;
        try {
            await this.client.setPowerLevel(this.currentRoomId, userId, 100);
            this.renderMembersList();
            alert('Пользователь теперь администратор!');
        } catch (e) {
            alert('Ошибка: ' + e.message);
        }
    }

    // ==========================================
    // Public Room Search
    // ==========================================



    async joinPublicRoom(roomIdOrAlias) {
        try {
            const result = await this.client.joinRoom(roomIdOrAlias);

            console.log('Joined room:', result.roomId);

            this.closeModal('join-room-modal');

            // Wait for sync
            setTimeout(() => {
                this.loadRooms();
                this.selectRoom(result.roomId);
                this.switchTab('rooms');
            }, 1000);

        } catch (error) {
            console.error('Error joining room:', error);
            alert('Ошибка присоединения к комнате: ' + error.message);
        }
    }

    handleLogout() {
        if (this.client) {
            this.client.stopClient();
        }

        localStorage.removeItem('matrix_access_token');
        localStorage.removeItem('matrix_user_id');
        localStorage.removeItem('matrix_homeserver');

        this.client = null;
        this.currentRoomId = null;
        this.rooms.clear();

        this.showLoginScreen();

        // Reset form
        const authForm = document.getElementById('auth-form');
        if (authForm) authForm.reset();
    }

    // UI helpers
    showLoginScreen() {
        document.getElementById('login-screen').classList.add('active');
        document.getElementById('chat-screen').classList.remove('active');
    }

    showChatScreen() {
        document.getElementById('login-screen').classList.remove('active');
        document.getElementById('chat-screen').classList.add('active');
    }

    getSenderName(userId) {
        const user = this.client.getUser(userId);
        return user?.displayName || userId.split(':')[0].substring(1);
    }

    getInitials(name) {
        if (!name) return '?';
        const parts = name.split(' ');
        if (parts.length >= 2) {
            return (parts[0][0] + parts[1][0]).toUpperCase();
        }
        return name.substring(0, 2).toUpperCase();
    }

    formatTime(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();

        const isToday = date.toDateString() === now.toDateString();

        if (isToday) {
            return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        } else {
            return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
        }
    }

    async loadAuthenticatedImage(mxcUrl, container) {
        const loader = container.querySelector(`[data-mxc="${mxcUrl}"]`);
        if (!loader) return;
        const body = loader.dataset.body;

        const tryFetch = async (url) => {
            try {
                const response = await fetch(url, {
                    headers: {
                        'Authorization': `Bearer ${this.client.getAccessToken()}`
                    }
                });
                return response.ok ? response : null;
            } catch (e) {
                return null;
            }
        };

        try {
            const baseUrl = this.client.mxcUrlToHttp(mxcUrl).split('?')[0];
            const mxcParts = mxcUrl.split('/');
            const serverName = mxcParts[2];
            const mediaId = mxcParts[3];
            const homeServer = this.client.baseUrl.endsWith('/') ? this.client.baseUrl.slice(0, -1) : this.client.baseUrl;

            const urlsToTry = [
                // 1. Standard Client Media API (Newest)
                `${homeServer}/_matrix/client/v1/media/download/${serverName}/${mediaId}`,
                // 2. Legacy Media API v3
                baseUrl,
                // 3. Legacy Media API r0
                baseUrl.replace('/v3/', '/r0/'),
                // 4. Client Media API v3 (Some servers)
                `${homeServer}/_matrix/client/v3/media/download/${serverName}/${mediaId}`,
                // 5. Thumbnail fallback
                baseUrl.replace('/download/', '/thumbnail/') + '?width=1000&height=1000&method=scale'
            ];

            console.log(`[MEDIA DEBUG] Trying ${urlsToTry.length} endpoints for ${mxcUrl}`, urlsToTry);

            let response = null;
            let successUrl = '';
            for (const url of urlsToTry) {
                console.log(`[MEDIA DEBUG] Checking: ${url}`);
                response = await tryFetch(url);
                if (response) {
                    successUrl = url;
                    break;
                }
            }

            if (!response) {
                // LAST RESORT: Direct img tag with token
                console.log('[MEDIA DEBUG] All fetches failed. Trying direct img tag fallback.');
                const authUrl = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(this.client.getAccessToken());
                loader.innerHTML = `
                    <div class="message-image-clickable fallback" style="cursor: pointer;">
                        <img src="${authUrl}" alt="${body}" 
                             onerror="this.parentElement.parentElement.innerHTML='⚠️ 404: Файл не найден сервером'"
                             style="max-width: 100%; max-height: 300px; border-radius: 8px; border: 1px solid var(--color-border); display: block;">
                    </div>`;

                loader.querySelector('.message-image-clickable').addEventListener('click', (e) => {
                    e.preventDefault();
                    this.openMediaPreview(authUrl, body, authUrl);
                });
                return;
            }

            console.log(`[MEDIA DEBUG] SUCCESS! Loaded from: ${successUrl}`);
            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);

            loader.innerHTML = `
                <div class="message-image-clickable" style="cursor: pointer;">
                    <img src="${objectUrl}" alt="${body}" 
                         style="max-width: 100%; max-height: 300px; border-radius: 8px; border: 1px solid var(--color-border); display: block;">
                </div>`;

            loader.querySelector('.message-image-clickable').addEventListener('click', (e) => {
                e.preventDefault();
                this.openMediaPreview(objectUrl, body, objectUrl);
            });
        } catch (error) {
            console.error('Failed to load image:', error);
            loader.innerHTML = `
                <div class="error-placeholder" style="color: var(--color-danger); padding: 10px; border: 1px dashed var(--color-danger); border-radius: 8px; font-size: 0.7rem;">
                    ⚠️ Ошибка (${error.message})<br>
                    <span style="opacity: 0.5; font-size: 0.6rem;">${mxcUrl}</span>
                </div>`;
        }
    }

    async loadAuthenticatedFile(mxcUrl, container) {
        const loader = container.querySelector(`[data-mxc="${mxcUrl}"]`);
        if (!loader) return;
        const body = loader.dataset.body;

        const tryFetch = async (url) => {
            try {
                const response = await fetch(url, {
                    headers: {
                        'Authorization': `Bearer ${this.client.getAccessToken()}`
                    }
                });
                return response.ok ? response : null;
            } catch (e) {
                return null;
            }
        };

        try {
            const baseUrl = this.client.mxcUrlToHttp(mxcUrl).split('?')[0];
            const mxcParts = mxcUrl.split('/');
            const serverName = mxcParts[2];
            const mediaId = mxcParts[3];
            const homeServer = this.client.baseUrl.endsWith('/') ? this.client.baseUrl.slice(0, -1) : this.client.baseUrl;

            const urlsToTry = [
                `${homeServer}/_matrix/client/v1/media/download/${serverName}/${mediaId}`,
                baseUrl,
                baseUrl.replace('/v3/', '/r0/'),
                `${homeServer}/_matrix/client/v3/media/download/${serverName}/${mediaId}`
            ];

            let response = null;
            let finalUrl = '';
            for (const url of urlsToTry) {
                response = await tryFetch(url);
                if (response) {
                    finalUrl = url;
                    break;
                }
            }

            if (!response) {
                loader.innerHTML = `
                    <div style="color: var(--color-danger); font-size: 0.8rem;">⚠️ Файл не найден (404)</div>
                `;
                return;
            }

            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);

            loader.innerHTML = `
                <a href="${objectUrl}" download="${body}" class="message-file-link">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                        <polyline points="13 2 13 9 20 9"></polyline>
                    </svg>
                    ${this.escapeHtml(body)}
                </a>`;
        } catch (error) {
            console.error('Failed to load file:', error);
            loader.innerHTML = `<div style="color: var(--color-danger); font-size: 0.8rem;">⚠️ Ошибка: ${error.message}</div>`;
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    async handleFileUpload(event) {
        const file = event.target.files[0];
        if (!file || !this.currentRoomId) return;

        try {
            console.log('Uploading file:', file.name);

            // Upload to Matrix Media Repository
            const response = await this.client.uploadContent(file);
            console.log('File uploaded:', response);

            // Determine msgtype
            let msgtype = 'm.file';
            const fileType = file.type || '';
            const fileName = file.name.toLowerCase();

            if (fileType.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp)$/.test(fileName)) {
                msgtype = 'm.image';
            } else if (fileType.startsWith('video/') || /\.(mp4|webm|mov)$/.test(fileName)) {
                msgtype = 'm.video';
            } else if (fileType.startsWith('audio/') || /\.(mp3|wav|ogg)$/.test(fileName)) {
                msgtype = 'm.audio';
            }

            const content = {
                body: file.name,
                msgtype: msgtype,
                url: response.content_uri,
                info: {
                    mimetype: file.type,
                    size: file.size
                }
            };

            await this.client.sendEvent(this.currentRoomId, 'm.room.message', content);

            // Clear input
            event.target.value = '';

        } catch (error) {
            console.error('Error uploading file:', error);
            alert('Ошибка загрузки файла: ' + error.message);
        }
    }

    async leaveCurrentRoom() {
        if (!this.currentRoomId) return;

        if (!confirm('Вы уверены, что хотите выйти из этой комнаты?')) return;

        const roomId = this.currentRoomId;

        try {
            // Optimistically update UI
            const roomElement = document.querySelector(`.room-item[data-room-id="${roomId}"]`);
            if (roomElement) {
                roomElement.remove();

                // Check if list is empty and show placeholder if needed
                if (document.getElementById('rooms-list').children.length === 0) {
                    const message = this.currentTab === 'dms'
                        ? 'У вас пока нет личных сообщений'
                        : 'У вас пока нет комнат';
                    document.getElementById('rooms-list').innerHTML = `
                        <div class="loading-rooms">
                            <p>${message}</p>
                        </div>
                    `;
                }
            }

            // Clear chat area
            document.getElementById('current-room-name').textContent = 'Выберите комнату';
            document.getElementById('room-members-count').textContent = '';
            document.getElementById('messages-container').innerHTML = `
                <div class="welcome-message">
                    <h3>Выберите комнату</h3>
                    <p>чтобы начать общение</p>
                </div>`;
            document.getElementById('room-settings-btn').style.display = 'none';
            document.getElementById('room-settings-menu').classList.add('hidden');
            document.getElementById('message-input').disabled = true;
            document.getElementById('send-btn').disabled = true;
            document.getElementById('attach-btn').disabled = true;

            this.currentRoomId = null;

            // Perform API call
            await this.client.leave(roomId);

            // Reload rooms from SDK to be sure (optional, but good for sync)
            setTimeout(() => this.loadRooms(), 1000);

        } catch (error) {
            console.error('Error leaving room:', error);
            alert('Ошибка выхода из комнаты: ' + error.message);
            // Revert on error would be complex, simplified to just alerting
            this.loadRooms();
        }
    }
    getAvatarUrl(mxcUrl, userId) {
        if (mxcUrl && mxcUrl.startsWith('mxc://')) {
            // Use SDK method to convert MXC to HTTP
            // 50x50 generic size, crop
            return this.client.mxcUrlToHttp(mxcUrl, 50, 50, 'crop');
        }
        // Fallback or no avatar
        return null;
    }

    async loadAuthenticatedAvatar(mxcUrl, containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        if (!mxcUrl || typeof mxcUrl !== 'string' || !mxcUrl.startsWith('mxc://')) {
            console.log('[MEDIA DEBUG] Skipping invalid/non-mxc avatar:', mxcUrl);
            return;
        }

        const tryFetch = async (url) => {
            try {
                const response = await fetch(url, {
                    headers: {
                        'Authorization': `Bearer ${this.client.getAccessToken()}`
                    }
                });
                return response.ok ? response : null;
            } catch (e) {
                return null;
            }
        };

        try {
            const baseUrl = this.client.mxcUrlToHttp(mxcUrl).split('?')[0];
            const mxcParts = mxcUrl.split('/');
            const serverName = mxcParts[2];
            const mediaId = mxcParts[3];
            const homeServer = this.client.baseUrl.endsWith('/') ? this.client.baseUrl.slice(0, -1) : this.client.baseUrl;

            const urlsToTry = [
                `${homeServer}/_matrix/client/v1/media/download/${serverName}/${mediaId}`,
                baseUrl,
                baseUrl.replace('/download/', '/thumbnail/') + '?width=40&height=40&method=scale'
            ];

            let response = null;
            for (const url of urlsToTry) {
                response = await tryFetch(url);
                if (response) break;
            }

            if (!response) {
                // Fallback to initials (already there by default)
                return;
            }

            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);
            container.innerHTML = `<img src="${objectUrl}" alt="Avatar" class="avatar-clickable" style="cursor: pointer; width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">`;

            container.querySelector('.avatar-clickable').addEventListener('click', (e) => {
                e.stopPropagation();
                // Get name from context if possible, or use 'Аватар'
                const nameNode = container.closest('.message')?.querySelector('.message-sender') ||
                    container.closest('.room-item')?.querySelector('.room-name');
                const name = nameNode ? nameNode.textContent : 'Аватар';
                this.openMediaPreview(objectUrl, name, objectUrl);
            });
        } catch (error) {
            console.error('Failed to load avatar:', error);
        }
    }

    async openProfileModal(userId) {
        if (!userId && this.client) {
            userId = this.client.getUserId();
        }

        console.log('[PROFILE DEBUG] openProfileModal called with userId:', userId);
        if (!userId) {
            console.error('[PROFILE DEBUG] userId is undefined!');
            return;
        }

        // Store userId in modal for refresh logic
        const modal = document.getElementById('profile-modal');
        if (modal) modal.dataset.userId = userId;

        const isMe = userId === this.client.getUserId();
        console.log('[PROFILE DEBUG] isMe:', isMe, 'userId:', userId);

        try {
            console.log('[PROFILE DEBUG] Calling getProfileInfo for:', userId);
            const profile = await this.client.getProfileInfo(userId);
            console.log('[PROFILE DEBUG] Profile received:', profile);

            const titleEl = document.getElementById('profile-modal-title');
            const changeAvatarBtn = document.getElementById('change-avatar-btn');
            const saveProfileBtn = document.getElementById('save-profile-btn');
            const displayNameInput = document.getElementById('profile-display-name');
            console.log('[PROFILE DEBUG] DOM elements:', { titleEl: !!titleEl, changeAvatarBtn: !!changeAvatarBtn, saveProfileBtn: !!saveProfileBtn, displayNameInput: !!displayNameInput });

            let nowPlaying = null;
            if (isMe) {
                if (titleEl) titleEl.textContent = 'Настройки профиля';
                if (changeAvatarBtn) changeAvatarBtn.style.display = 'block';
                if (saveProfileBtn) saveProfileBtn.style.display = 'block';
                if (displayNameInput) {
                    displayNameInput.value = profile.displayname || '';
                    displayNameInput.disabled = false;
                }
                nowPlaying = this.currentStation;
            } else {
                if (titleEl) titleEl.textContent = 'Профиль пользователя';
                if (changeAvatarBtn) changeAvatarBtn.style.display = 'none';
                if (saveProfileBtn) saveProfileBtn.style.display = 'none';
                if (displayNameInput) {
                    displayNameInput.value = profile.displayname || userId;
                    displayNameInput.disabled = true;
                }

                // Try to get their "Now Playing" from their presence status
                let user = this.client.getUser(userId);
                const cachedStatus = user && user.presenceStatusMsg ? user.presenceStatusMsg : "";

                const parsed = this.parseUserStatus(cachedStatus);
                nowPlaying = parsed?.radio || null;

                // v248: Always attempt server-side presence fetch for others to be fresh
                if (!isMe) {
                    try {
                        const presence = await this.client.getPresence(userId);

                        // Check all possible fields where status_msg might hide
                        const possibleMsg = presence.status_msg || presence.statusMsg || presence.status || "";

                        if (possibleMsg) {
                            const fresh = this.parseUserStatus(possibleMsg);
                            if (fresh?.radio) {
                                nowPlaying = fresh.radio;
                            }
                        }
                    } catch (e) {
                        console.error(`[PRESENCE] Server fetch failed:`, e);
                    }
                }
            }

            const preview = document.getElementById('profile-avatar-preview');
            if (profile.avatar_url) {
                const mxcUrl = profile.avatar_url;
                preview.innerHTML = this.getInitials(profile.displayname || userId);
                this.loadAuthenticatedAvatar(mxcUrl, 'profile-avatar-preview');
            } else {
                preview.innerHTML = this.getInitials(profile.displayname || userId);
            }

            // Render Now Playing Card
            const npContainer = document.getElementById('profile-now-playing-container');
            const npCard = document.getElementById('profile-now-playing-card');
            if (npContainer && npCard) {
                if (nowPlaying) {
                    npContainer.classList.remove('hidden');
                    const isAlreadyAdded = (this.radioStations || []).some(rs => rs.url === nowPlaying.url);
                    npCard.innerHTML = `
                        <div class="shared-station-card profile-card">
                            <img src="${nowPlaying.cover}" class="shared-card-art" alt="Radio">
                            <div class="shared-card-info">
                                <div class="shared-card-type">Сейчас слушает</div>
                                <div class="shared-card-name">${this.escapeHtml(nowPlaying.name)}</div>
                            </div>
                            ${!isMe ? `
                                <button class="add-station-btn ${isAlreadyAdded ? 'added' : ''}" 
                                        data-station='${JSON.stringify(nowPlaying)}' 
                                        ${isAlreadyAdded ? 'disabled' : ''}>
                                    ${isAlreadyAdded ? 'Добавлено' : 'Добавить'}
                                </button>
                            ` : ''}
                        </div>`;

                    // Attach event listener to the add button if not me
                    if (!isMe && !isAlreadyAdded) {
                        const addBtn = npCard.querySelector('.add-station-btn');
                        if (addBtn) {
                            addBtn.addEventListener('click', (e) => {
                                e.stopPropagation();
                                const stationData = JSON.parse(addBtn.dataset.station);
                                if (!this.radioStations) this.radioStations = [];
                                this.radioStations.push(stationData);
                                localStorage.setItem('radio_stations', JSON.stringify(this.radioStations));
                                if (this.renderRadioStations) this.renderRadioStations();
                                addBtn.textContent = 'Добавлено';
                                addBtn.classList.add('added');
                                addBtn.disabled = true;
                                console.log('[PROFILE] Station added to Hub:', stationData.name);
                            });
                        }
                    }
                } else {
                    npContainer.classList.add('hidden');
                    npCard.innerHTML = '';
                }
            }

            console.log('[PROFILE DEBUG] Opening modal...');

            // v422: Show avatar border controls only for own profile
            const borderSection = document.getElementById('avatar-border-section');
            const borderOptions = document.getElementById('border-options');
            const borderToggle = document.getElementById('border-enabled-toggle');
            const borderColor = document.getElementById('border-color-picker');
            const borderWidth = document.getElementById('border-width-slider');
            const borderWidthLabel = document.getElementById('border-width-label');
            const borderPreview = document.getElementById('border-preview-avatar');

            if (isMe && borderSection) {
                borderSection.style.display = 'block';
                // Load saved border settings
                const saved = await this.loadBorderSettings(userId);
                const enabled = saved?.enabled ?? false;
                const color = saved?.color ?? '#00ffaa';
                const width = saved?.width ?? 2;

                if (borderToggle) borderToggle.checked = enabled;
                if (borderColor) borderColor.value = color;
                if (borderWidth) { borderWidth.value = width; }
                if (borderWidthLabel) borderWidthLabel.textContent = width + 'px';
                if (borderOptions) borderOptions.style.display = enabled ? 'flex' : 'none';

                // Live preview update
                const updatePreview = () => {
                    if (!borderPreview) return;
                    const c = borderColor ? borderColor.value : '#00ffaa';
                    const w = parseInt(borderWidth ? borderWidth.value : 2);
                    if (borderWidthLabel) borderWidthLabel.textContent = w + 'px';

                    if (borderToggle?.checked) {
                        borderPreview.style.boxShadow = [
                            `0 0 0 ${w}px ${c}`,
                            `0 0 ${w * 3}px ${w}px ${c}aa`,
                            `0 0 ${w * 8}px ${w * 2}px ${c}44`
                        ].join(', ');
                        borderPreview.classList.add('avatar-glow-pulse');
                    } else {
                        borderPreview.style.boxShadow = 'none';
                        borderPreview.classList.remove('avatar-glow-pulse');
                    }
                };
                updatePreview();

                borderToggle?.removeEventListener('change', borderToggle._borderHandler);
                borderToggle._borderHandler = () => {
                    if (borderOptions) borderOptions.style.display = borderToggle.checked ? 'flex' : 'none';
                    updatePreview();
                };
                borderToggle?.addEventListener('change', borderToggle._borderHandler);
                borderColor?.addEventListener('input', updatePreview);
                borderWidth?.addEventListener('input', updatePreview);

                // Preset swatches
                document.querySelectorAll('.border-preset').forEach(swatch => {
                    swatch.onclick = () => {
                        if (borderColor) borderColor.value = swatch.dataset.color;
                        updatePreview();
                    };
                });

                // Set preview initials
                if (borderPreview) {
                    const profile2 = await this.client.getProfileInfo(userId).catch(() => ({}));
                    borderPreview.textContent = this.getInitials(profile2.displayname || userId);
                }
            } else if (borderSection) {
                borderSection.style.display = 'none';
            }

            this.openModal('profile-modal');
        } catch (error) {
            console.error('Error fetching profile:', error);
            alert('Не удалось загрузить данные профиля');
        }
    }

    // v422: Save border to Matrix profile (Synapse arbitrary profile field)
    async saveBorderSettings(color, width, enabled) {
        if (!this.client) return;
        const userId = this.client.getUserId();
        const homeserver = this.client.baseUrl.replace(/\/$/, '');
        const token = this.client.getAccessToken();
        const data = { color, width: parseInt(width), enabled };
        try {
            await fetch(
                `${homeserver}/_matrix/client/v3/profile/${encodeURIComponent(userId)}/type_c_border`,
                {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(data)
                }
            );
            // Update local cache
            if (!this._borderCache) this._borderCache = new Map();
            this._borderCache.set(userId, data);
            // Re-apply to all current message avatars for this user
            document.querySelectorAll(`[data-sender-id="${userId}"] .message-avatar`).forEach(el => {
                this.applyAvatarBorder(el, data);
            });
            console.log('[BORDER] Saved border settings:', data);
        } catch (e) {
            console.error('[BORDER] Failed to save border:', e);
            alert('Не удалось сохранить настройки обводки: ' + e.message);
        }
    }

    // v425: Save border locally and broadcast via Presence
    async saveBorderSettings(color, width, enabled) {
        if (!this.client) return;
        const userId = this.client.getUserId();
        const data = { color, width: parseInt(width), enabled };

        // 1. Save to localStorage for persistence across reloads (for current user)
        localStorage.setItem(`border_${userId}`, JSON.stringify(data));
        this._cachedMyBorder = data;

        // 2. Broadcast to others via Presence
        this.broadcastRadioStatus(this.currentStation, this._lastTrackInfo);

        // 3. Update local cache for immediate display
        if (!this._borderCache) this._borderCache = new Map();
        this._borderCache.set(userId, data);

        // 4. Re-apply to all current message avatars for this user
        document.querySelectorAll(`[data-sender-id="${userId}"] .message-avatar`).forEach(el => {
            this.applyAvatarBorder(el, data);
        });
        console.log('[BORDER] Saved border settings locally & triggered broadcast:', data);
    }

    // v425: Load border from unified Presence status
    async loadBorderSettings(userId) {
        if (!this.client || !userId) return null;
        if (!this._borderCache) this._borderCache = new Map();

        const isMe = userId === this.client.getUserId();

        // Check cache first
        if (this._borderCache.has(userId)) return this._borderCache.get(userId);

        // For ME: try localStorage first (most reliable source)
        if (isMe) {
            const local = JSON.parse(localStorage.getItem(`border_${userId}`) || 'null');
            if (local) {
                this._borderCache.set(userId, local);
                this._cachedMyBorder = local;
                return local;
            }
        }

        // For others (and fallback for me): extract from Matrix Presence status
        const user = this.client.getUser(userId);
        const statusStr = user?.presenceStatusMsg || "";
        const parsed = this.parseUserStatus(statusStr);

        if (parsed && parsed.border) {
            this._borderCache.set(userId, parsed.border);
            return parsed.border;
        }

        // v425: Fallback — try fetching presence from server if cache is empty
        if (!isMe) {
            try {
                const presence = await this.client.getPresence(userId);
                const possibleMsg = presence.status_msg || presence.statusMsg || presence.status || "";
                const fresh = this.parseUserStatus(possibleMsg);
                if (fresh && fresh.border) {
                    this._borderCache.set(userId, fresh.border);
                    return fresh.border;
                }
            } catch (e) { }
        }

        this._borderCache.set(userId, null);
        return null;
    }

    // v422: Apply border to an avatar DOM element
    applyAvatarBorder(avatarEl, borderData) {
        if (!avatarEl) return;
        if (borderData?.enabled && borderData.color) {
            const w = borderData.width || 2;
            const c = borderData.color;
            // Multi-layer neon glow:
            // Layer 1: tight ring (the actual border)
            // Layer 2: soft close glow
            // Layer 3: wide diffuse halo
            avatarEl.style.boxShadow = [
                `0 0 0 ${w}px ${c}`,
                `0 0 ${w * 3}px ${w}px ${c}aa`,
                `0 0 ${w * 8}px ${w * 2}px ${c}44`
            ].join(', ');
            avatarEl.style.transition = 'box-shadow 0.3s';
            avatarEl.classList.add('avatar-glow-pulse');
        } else {
            avatarEl.style.boxShadow = '';
            avatarEl.classList.remove('avatar-glow-pulse');
        }
    }

    // v425: Unified parser for user status JSON (Radio + Border)
    parseUserStatus(str) {
        if (!str) return null;
        if (!str.includes('{')) return null;
        try {
            const match = str.match(/(\{.*\})/);
            if (match) {
                const data = JSON.parse(match[1]);
                // Returns object like { radio: {...}, border: {...} } or legacy format
                if (data.url && data.name) return { radio: data }; // legacy
                return data;
            }
        } catch (e) {
            console.warn('[PRESENCE] Parse error for string:', str, e);
        }
        return null;
    }

    getRadioStatusHTML(userId) {
        if (!this.client || !userId) return '';

        const myId = this.client.getUserId();
        if (!myId) return '';

        // v370: Ultra-robust Me check (strips homeserver if needed for comparison, but full match first)
        const cleanId = (id) => String(id).trim().toLowerCase();
        const isMe = cleanId(userId) === cleanId(myId);

        if (this.debugPresence) {
            console.log(`[PRESENCE DEBUG] getRadioStatusHTML for ${userId}, isMe: ${isMe}, active: ${this.isRadioActive}, station: ${!!this.currentStation}`);
        }

        // v350/v355/v370: For the current user, ABSOLUTELY trust only local memory.
        if (isMe) {
            if (this.isRadioActive && this.currentStation) {
                return `
                    <span class="radio-status-indicator" title="Слушаю радио (Вы) [${userId}]">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                        </svg>
                    </span>`;
            }
            return '';
        }

        const user = this.client.getUser(userId);
        const statusStr = user?.presenceStatusMsg || "";
        const parsed = this.parseUserStatus(statusStr);
        const isListening = !!(parsed?.radio);

        if (isListening) {
            return `
                <span class="radio-status-indicator" title="Слушает радио [${userId}]">
                    <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
                    </svg>
                </span>`;
        }
        return '';
    }

    // v425: Includes border data in presence broadcast
    broadcastRadioStatus(station, trackInfo = null) {
        if (!this.client) return;

        this.updateMiniPlayerUI(station);
        this.updateHeaderPresence();

        // v270: Respect privacy setting
        if (!this.showRadioStatus && station !== null) {
            console.log('[PRIVACY] Broadcasting blocked: privacy enabled.');
            return;
        }

        const radioData = station ? {
            name: station.name,
            url: station.url,
            cover: station.cover,
            track: trackInfo
        } : null;

        // v425: Get border data from localStorage/cache
        const borderData = this._cachedMyBorder || JSON.parse(localStorage.getItem(`border_${this.client.getUserId()}`) || 'null');

        const unifiedData = {
            radio: radioData,
            border: borderData
        };

        const jsonStr = JSON.stringify(unifiedData);
        const statusMsg = radioData ? `🎶 ${trackInfo ? trackInfo + ' (' + radioData.name + ')' : radioData.name} ${jsonStr}` : jsonStr;

        // v265: Prevent redundant broadcasts
        if (this._lastBroadcastedMsg === statusMsg) return;

        if (this._broadcastTimer) clearTimeout(this._broadcastTimer);

        const delay = station ? 5000 : 0;

        this._broadcastTimer = setTimeout(() => {
            console.log(`[PRESENCE] Broadcasting unified status:`, unifiedData);

            this.client.setPresence({ presence: "online", status_msg: statusMsg }).then(() => {
                this._lastBroadcastedMsg = statusMsg;
            }).catch(err => {
                console.warn('[PRESENCE] Broadcast failed:', err);
                if (err.errcode === 'M_LIMIT_EXCEEDED' || err.httpStatus === 429) {
                    this._lastBroadcastedMsg = null;
                }
            });

            this.client.setAccountData('typec.now_playing', radioData ? { ...radioData, timestamp: Date.now() } : {})
                .catch(err => console.warn('[PRESENCE] Account data failed:', err));
        }, delay);
    }

    openModal(modalId) {
        console.log('[MODAL DEBUG] Opening modal:', modalId);
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.add('active');
            console.log('[MODAL DEBUG] Modal opened successfully');
        } else {
            console.error('[MODAL DEBUG] Modal not found:', modalId);
        }
    }

    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.remove('active');
        }
    }

    openAppSettingsModal() {
        // Set toggle state based on localStorage
        const isRainEnabled = localStorage.getItem('matrix_rain_enabled') !== 'false'; // Default to true
        const rainToggle = document.getElementById('matrix-rain-toggle');
        if (rainToggle) {
            rainToggle.checked = isRainEnabled;
        }

        // Set lock toggle state
        const lockToggle = document.getElementById('app-lock-toggle');
        if (lockToggle) {
            lockToggle.checked = !!this.passcode;
        }

        this.renderRadioStationsList();
        this.openModal('app-settings-modal');
    }



    toggleMatrixRain(enabled) {
        localStorage.setItem('matrix_rain_enabled', enabled);
        const canvas = document.getElementById('matrix-rain');
        if (canvas) {
            canvas.style.display = enabled ? 'block' : 'none';
            // Trigger a resize to restart/stop animation logic if it relies on visibility
            window.dispatchEvent(new Event('resize'));
        }
    }

    // --- Passcode Logic ---

    startPasscodeSetup() {
        this.isPasscodeSetupMode = true;
        this.tempPasscode = null;
        this.currentPasscodeInput = '';
        this.updatePasscodeUI();
        this.showPasscodeScreen('setup');
        document.getElementById('passcode-title').textContent = 'Придумайте код доступа';
        document.getElementById('passcode-cancel-btn').classList.remove('hidden');

        // Ensure overlay is visible (remove hidden class if present)
        document.getElementById('passcode-overlay').classList.remove('hidden');
    }

    disablePasscode() {
        this.passcode = null;
        localStorage.removeItem('app_passcode');
        alert('Вход по PIN-коду отключен');
    }

    showPasscodeScreen(mode) {
        const overlay = document.getElementById('passcode-overlay');
        overlay.classList.remove('hidden');
        document.getElementById('passcode-cancel-btn').classList.toggle('hidden', mode === 'unlock');

        if (mode === 'unlock') {
            document.getElementById('passcode-title').textContent = 'Введите код доступа';
        }
    }

    hidePasscodeScreen() {
        const overlay = document.getElementById('passcode-overlay');
        overlay.classList.add('hidden');
        this.currentPasscodeInput = '';
        this.updatePasscodeUI();
    }

    cancelPasscodeAction() {
        this.hidePasscodeScreen();
        this.isPasscodeSetupMode = false;
        this.tempPasscode = null;
        this.currentPasscodeInput = '';

        // Revert toggle if in settings
        const lockToggle = document.getElementById('app-lock-toggle');
        if (lockToggle) {
            lockToggle.checked = !!this.passcode;
        }
    }

    handlePasscodeInput(key) {
        if (this.currentPasscodeInput.length >= 4) return;

        this.currentPasscodeInput += key;
        this.updatePasscodeUI();

        if (this.currentPasscodeInput.length === 4) {
            setTimeout(() => this.checkPasscode(), 300);
        }
    }

    handlePasscodeDelete() {
        if (this.currentPasscodeInput.length > 0) {
            this.currentPasscodeInput = this.currentPasscodeInput.slice(0, -1);
            this.updatePasscodeUI();
        }
    }

    updatePasscodeUI() {
        const dots = document.querySelectorAll('.passcode-dots .dot');
        dots.forEach((dot, index) => {
            dot.classList.toggle('filled', index < this.currentPasscodeInput.length);
            dot.classList.remove('error');
        });
    }

    checkPasscode() {
        const input = this.currentPasscodeInput;

        if (this.isPasscodeSetupMode) {
            if (!this.tempPasscode) {
                // First step done, ask for confirmation
                this.tempPasscode = input;
                this.currentPasscodeInput = '';
                this.updatePasscodeUI();
                document.getElementById('passcode-title').textContent = 'Повторите код доступа';
            } else {
                // Confirmation step
                if (input === this.tempPasscode) {
                    // Success
                    this.passcode = input;
                    localStorage.setItem('app_passcode', input);
                    this.isPasscodeSetupMode = false;
                    this.hidePasscodeScreen();

                    // Update toggle
                    const lockToggle = document.getElementById('app-lock-toggle');
                    if (lockToggle) lockToggle.checked = true;

                    alert('PIN-код установлен');
                } else {
                    // Mismatch
                    this.visualError();
                    document.getElementById('passcode-title').textContent = 'Коды не совпадают. Повторите.';
                    this.currentPasscodeInput = '';
                    this.updatePasscodeUI();
                    this.tempPasscode = null;
                    document.getElementById('passcode-title').textContent = 'Придумайте код доступа';
                }
            }
        } else {
            // Unlock Mode
            if (input === this.passcode) {
                this.hidePasscodeScreen();
            } else {
                this.visualError();
                this.currentPasscodeInput = '';
                this.updatePasscodeUI();
            }
        }
    }

    visualError() {
        const dots = document.querySelectorAll('.passcode-dots .dot');
        dots.forEach(dot => dot.classList.add('error'));
        setTimeout(() => {
            dots.forEach(dot => dot.classList.remove('error'));
        }, 400);
    }

    async handleAvatarPreview(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const preview = document.getElementById('profile-avatar-preview');
            preview.innerHTML = `<img src="${event.target.result}" alt="Preview">`;
        };
        reader.readAsDataURL(file);
    }

    async handleProfileUpdate() {
        const displayName = document.getElementById('profile-display-name').value;
        const avatarFile = document.getElementById('avatar-upload').files[0];
        const saveBtn = document.getElementById('save-profile-btn');

        saveBtn.disabled = true;
        saveBtn.textContent = 'Сохранение...';

        try {
            // Update display name
            await this.client.setDisplayName(displayName);

            // Update avatar if file selected
            if (avatarFile) {
                const uploadResult = await this.client.uploadContent(avatarFile);
                await this.client.setAvatarUrl(uploadResult.content_uri);
            }

            // v422: Save border settings
            const borderToggle = document.getElementById('border-enabled-toggle');
            const borderColor = document.getElementById('border-color-picker');
            const borderWidth = document.getElementById('border-width-slider');
            if (borderToggle) {
                await this.saveBorderSettings(
                    borderColor?.value || '#00ffaa',
                    borderWidth?.value || 2,
                    borderToggle.checked
                );
            }

            this.closeModal('profile-modal');
            this.updateUserDisplay();
            alert('Профиль успешно обновлен!');
        } catch (error) {
            console.error('Error updating profile:', error);
            alert('Ошибка при обновлении профиля: ' + error.message);
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Сохранить';
        }
    }

    async updateUserDisplay() {
        const userId = this.client.getUserId();
        try {
            const profile = await this.client.getProfileInfo(userId);
            this._lastProfile = profile; // v345: Cache profile for reactive updates
            this.updateHeaderPresence();
            document.getElementById('user-id').textContent = userId;

            if (profile.avatar_url) {
                this.loadAuthenticatedAvatar(profile.avatar_url, 'user-avatar');
            } else {
                document.getElementById('user-avatar').innerHTML = `${this.getInitials(profile.displayname || userId)}<div class="status-indicator online"></div>`;
            }
        } catch (error) {
            console.error('Error updating user display:', error);
        }
    }

    // v345: Reactive helper for top-left header presence
    // --- Statistics & Misc Helpers ---

    updateListeningStats() {
        const now = Date.now();
        const deltaSec = Math.floor((now - this._lastStatsUpdate) / 1000);
        this._lastStatsUpdate = now;

        if (this.isRadioActive && !this.audioPlayer.paused) {
            const today = new Date().toISOString().split('T')[0];
            this.radioStats[today] = (this.radioStats[today] || 0) + deltaSec;
            localStorage.setItem('radio_listening_stats', JSON.stringify(this.radioStats));

            // Only update UI if summary is open
            const summaryModal = document.getElementById('summary-modal');
            if (summaryModal && summaryModal.classList.contains('active')) {
                this.updateStatsUI();
            }
        }
    }

    updateStatsUI() {
        const statsEl = document.getElementById('radio-stats-today');
        if (!statsEl) return;

        const today = new Date().toISOString().split('T')[0];
        const totalSec = this.radioStats[today] || 0;

        const hours = Math.floor(totalSec / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);

        statsEl.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> Слушал сегодня: ${hours}ч ${mins}м`;
    }

    updateHeaderPresence() {
        const userId = this.client?.getUserId();
        if (!userId) return;

        const nameDisplay = document.getElementById('user-display-name');
        if (nameDisplay) {
            const displayName = this._lastProfile?.displayname || userId;
            nameDisplay.innerHTML = `<span class="name-text">${this.escapeHtml(displayName)}</span>${this.getRadioStatusHTML(userId)}`;
        }
    }

    setTheme(theme) {
        // Save to localStorage
        localStorage.setItem('matrix_theme', theme);

        console.log(`%c [THEME] Applying theme: ${theme}`, 'background: #222; color: #00ff00; font-weight: bold;');

        // Apply to both body and html for maximum compatibility
        document.body.setAttribute('data-theme', theme);
        document.documentElement.setAttribute('data-theme', theme);

        // Final check for accent color to verify variables
        const computedAccent = getComputedStyle(document.body).getPropertyValue('--color-accent-green');
        console.log(`[THEME] Computed accent color: ${computedAccent}`);

        // Update UI swatches
        document.querySelectorAll('.theme-swatch').forEach(swatch => {
            swatch.classList.toggle('active', swatch.dataset.theme === theme);
        });

        console.log(`[THEME] Switched to: ${theme}`);
    }

    async requestNotificationPermission() {
        if ('Notification' in window) {
            if (Notification.permission !== 'granted' && Notification.permission !== 'denied') {
                await Notification.requestPermission();
            }
        }
    }

    showNotification(event, room) {
        const sender = event.sender ? (event.sender.name || event.getSender()) : event.getSender();
        const body = event.getContent().body;
        const myUserId = this.client.getUserId();
        const roomId = event.getRoomId();

        // Don't show notifications for my own messages
        if (event.getSender() === myUserId) return;

        // Don't show if we are already looking at this room AND the window is focused
        if (roomId === this.currentRoomId && document.hasFocus()) return;

        const roomName = room.name || roomId;

        // 1. Browser Notification
        if ('Notification' in window && Notification.permission === 'granted') {
            const n = new Notification(`Type-C: ${sender}`, {
                body: body,
                icon: 'favicon.ico', // You might need a real icon path
                tag: roomId // Group notifications by room
            });
            n.onclick = () => {
                window.focus();
                this.selectRoom(roomId);
                n.close();
            };
        }

        // 2. In-app Toast
        const container = document.getElementById('notification-container');
        if (container) {
            const toast = document.createElement('div');
            toast.className = 'toast-notification';
            toast.innerHTML = `
                <div class="toast-header">
                    <span class="toast-sender">${sender}</span>
                    <span class="toast-room">${roomName}</span>
                </div>
                <div class="toast-body">${body}</div>
            `;

            toast.onclick = () => {
                this.selectRoom(roomId);
                toast.classList.add('hide');
                setTimeout(() => toast.remove(), 300);
            };

            container.appendChild(toast);

            // Auto-hide after 5 seconds
            setTimeout(() => {
                if (toast.parentElement) {
                    toast.classList.add('hide');
                    setTimeout(() => toast.remove(), 300);
                }
            }, 5000);
        }
    }

    async openSummaryModal() {
        this.loadWeather(); // v427: Load weather on open
        const summaryModal = document.getElementById('summary-modal');
        if (!summaryModal) return;

        // 1. Unread Messages
        const unreadList = document.getElementById('summary-unread-list');
        if (unreadList) {
            unreadList.innerHTML = '';
            const rooms = this.client.getRooms();
            const roomsWithUnread = rooms
                .filter(r => r.getMyMembership() === 'join')
                .filter(r => r.getUnreadNotificationCount('total') > 0)
                .sort((a, b) => b.getUnreadNotificationCount('total') - a.getUnreadNotificationCount('total'));

            if (roomsWithUnread.length > 0) {
                roomsWithUnread.forEach(room => {
                    const unreadCount = room.getUnreadNotificationCount('total');
                    const lastEvent = room.timeline[room.timeline.length - 1];
                    const lastMsg = lastEvent ? (lastEvent.getContent().body || 'Новое сообщение') : '...';

                    const item = document.createElement('div');
                    item.className = 'summary-item';
                    const displayMsg = String(lastMsg || '...').substring(0, 30);
                    item.innerHTML = `
                        <div class="summary-item-info">
                            <span class="summary-item-name">${this.escapeHtml(room.name || 'Безымянная')}</span>
                            <span class="summary-item-meta">${this.escapeHtml(displayMsg)}${displayMsg.length >= 30 ? '...' : ''}</span>
                        </div>
                        <span class="unread-badge">${unreadCount}</span>
                    `;
                    item.onclick = () => {
                        this.closeModal('summary-modal');
                        this.selectRoom(room.roomId);
                    };
                    unreadList.appendChild(item);
                });
            } else {
                unreadList.innerHTML = '<p class="empty-text">Все сообщения прочитаны</p>';
            }
        }

        // 2. Recent Activity
        const recentList = document.getElementById('summary-recent-list');
        if (recentList) {
            recentList.innerHTML = '';
            if (this.recentRooms.length > 0) {
                this.recentRooms.forEach(roomId => {
                    const room = this.client.getRoom(roomId);
                    if (room) {
                        const item = document.createElement('div');
                        item.className = 'summary-item';
                        item.innerHTML = `
                            <div class="summary-item-info">
                                <span class="summary-item-name">${this.escapeHtml(room.name)}</span>
                                <span class="summary-item-meta">Недавняя активность</span>
                            </div>
                        `;
                        item.onclick = () => {
                            this.closeModal('summary-modal');
                            this.selectRoom(roomId);
                        };
                        recentList.appendChild(item);
                    }
                });
            } else {
                recentList.innerHTML = '<p class="empty-text">Пока нет недавней активности</p>';
            }
        }

        // 3. Calendar & Time
        // Reset calendar to current month
        const now = new Date();
        this.currentCalendarMonth = now.getMonth();
        this.currentCalendarYear = now.getFullYear();
        this.renderCalendar();
        this.renderQuote();
        this.startSummaryWidgets();

        this.updateRadioHub();
        this.updateRadioDisplay();
        this.updateStatsUI(); // v385

        this.openModal('summary-modal');
    }

    // v427: Real-time Weather Integration (Open-Meteo)
    async loadWeather(force = false) {
        const container = document.getElementById('summary-weather');
        if (!container) return;

        if (!navigator.geolocation) {
            container.innerHTML = '<div class="weather-loading">Геолокация не поддерживается</div>';
            return;
        }

        // Use cached position if available (optional)
        if (!force) {
            const cachedWeather = sessionStorage.getItem('weather_data_v1100');
            const now = Date.now();
            if (cachedWeather) {
                const { timestamp, html, conditionClass } = JSON.parse(cachedWeather);
                if (now - timestamp < 1800000) { // 30 mins cache
                    container.innerHTML = html;
                    const section = container.closest('.weather-section');
                    if (section && conditionClass) {
                        section.className = 'summary-section weather-section full-width ' + conditionClass;
                    }
                    return;
                }
            }
        } else {
            container.innerHTML = '<div class="weather-loading">Запрашиваю местоположение...</div>';
        }

        if (!window.isSecureContext) {
            console.error('[WEATHER] Geolocation requires a secure context (HTTPS or localhost)');
            container.innerHTML = '<div class="weather-loading">Ошибка: Требуется безопасное соединение (HTTPS)</div>';
            return;
        }

        const geoOptions = {
            enableHighAccuracy: false,
            timeout: 10000,
            maximumAge: 0
        };

        navigator.geolocation.getCurrentPosition(async (position) => {
            const { latitude, longitude } = position.coords;
            console.log(`[WEATHER] Location acquired: ${latitude}, ${longitude}`);
            // Added hourly precipitation_probability and current_weather windspeed
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&hourly=precipitation_probability,relativehumidity_2m&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=7`;

            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                const data = await response.json();
                console.log('[WEATHER] Data received:', data);

                if (data.current_weather) {
                    const weather = data.current_weather;
                    const code = weather.weathercode;
                    const temp = Math.round(weather.temperature);
                    const wind = weather.windspeed;
                    // Get current hour rain probability
                    const currentHour = new Date().getHours();
                    const rainProb = data.hourly.precipitation_probability[currentHour] || 0;
                    const humidity = data.hourly.relativehumidity_2m[currentHour] || 0;

                    const info = this.getWeatherInfo(code);

                    // Dynamic background based on condition
                    const section = container.closest('.weather-section');
                    if (section) {
                        section.className = 'summary-section weather-section full-width ' + info.class;
                    }

                    // Process Forecast (Today + Next 6)
                    let forecastHtml = '';
                    if (data.daily && data.daily.weathercode && data.daily.weathercode.length > 0) {
                        for (let i = 0; i < data.daily.weathercode.length; i++) {
                            const fCode = data.daily.weathercode[i];
                            const fMax = Math.round(data.daily.temperature_2m_max[i]);
                            const fMin = Math.round(data.daily.temperature_2m_min[i]);
                            const fProb = data.daily.precipitation_probability_max[i] || 0;
                            const fInfo = this.getWeatherInfo(fCode);
                            const fDay = i === 0 ? 'Сегодня' : this.getForecastDayName(data.daily.time[i]);

                            forecastHtml += `
                                <div class="forecast-item" title="${fInfo.label}">
                                    <div class="forecast-day">${fDay}</div>
                                    <div class="forecast-icon-wrapper">
                                        <div class="forecast-mini-icon">${fInfo.icon.replace('weather-icon', 'forecast-mini-svg')}</div>
                                    </div>
                                    <div class="forecast-details">
                                        <div class="forecast-temp-range">
                                            <span class="f-max">${fMax}°</span>
                                            <span class="f-min">${fMin}°</span>
                                        </div>
                                        <div class="forecast-rain-prob">
                                            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>
                                            ${fProb}%
                                        </div>
                                    </div>
                                </div>
                            `;
                        }
                    } else {
                        forecastHtml = '<div class="forecast-empty">Прогноз недоступен</div>';
                    }

                    const weatherHtml = `
                        <div class="weather-premium-container">
                            <div class="weather-main-display">
                                <div class="weather-hero">
                                    <div class="weather-large-icon">${info.icon}</div>
                                    <div class="weather-primary-data">
                                        <div class="weather-main-temp">${temp}<span>°C</span></div>
                                        <div class="weather-condition-label">${info.label}</div>
                                    </div>
                                </div>
                                <div class="weather-stats-dashboard">
                                    <div class="weather-stat-chip">
                                        <div class="stat-icon rain-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg></div>
                                        <div class="stat-info">
                                            <span class="stat-label">Осадки</span>
                                            <span class="stat-value">${rainProb}%</span>
                                        </div>
                                    </div>
                                    <div class="weather-stat-chip">
                                        <div class="stat-icon wind-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/></svg></div>
                                        <div class="stat-info">
                                            <span class="stat-label">Ветер</span>
                                            <span class="stat-value">${wind} км/ч</span>
                                        </div>
                                    </div>
                                    <div class="weather-stat-chip">
                                        <div class="stat-icon humidity-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M2 12h20"/><path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-5.5c-.5 1.5-2 3.9-4 5.5s-3 3.5-3 5.5a7 7 0 0 0 7 7z"/></svg></div>
                                        <div class="stat-info">
                                            <span class="stat-label">Влажность</span>
                                            <span class="stat-value">${humidity}%</span>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div class="weather-forecast-grid">
                                ${forecastHtml}
                            </div>
                        </div>
                    `;
                    container.innerHTML = weatherHtml;
                    sessionStorage.setItem('weather_data_v1100', JSON.stringify({
                        timestamp: Date.now(),
                        html: weatherHtml,
                        conditionClass: info.class
                    }));
                }
            } catch (e) {
                console.error('[WEATHER] Fetch failed:', e);
                container.innerHTML = '<div class="weather-loading">Ошибка загрузки данных погоды</div>';
            }
        }, (err) => {
            let errorMsg = 'Ошибка геолокации';
            switch (err.code) {
                case err.PERMISSION_DENIED:
                    errorMsg = 'Доступ к геопозиции отклонен. Разрешите его в настройках браузера.';
                    console.warn('[WEATHER] Permission denied');
                    break;
                case err.POSITION_UNAVAILABLE:
                    errorMsg = 'Местоположение недоступно';
                    console.warn('[WEATHER] Position unavailable');
                    break;
                case err.TIMEOUT:
                    errorMsg = 'Время ожидания геопозиции истекло';
                    console.warn('[WEATHER] Timeout');
                    break;
            }
            container.innerHTML = `<div class="weather-loading">${errorMsg}</div>`;
        }, geoOptions);
    }

    getForecastDayName(isoDate) {
        const days = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
        const date = new Date(isoDate);
        return days[date.getDay()];
    }

    getWeatherInfo(code) {
        const codes = {
            0: {
                label: 'Ясно', class: 'weather-sun', icon: `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="sun-icon">
                    <circle cx="12" cy="12" r="5" class="sun-core" fill="rgba(255, 204, 0, 0.4)"/>
                    <g class="sun-rays" stroke="#ffcc00">
                        <line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
                        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                        <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
                        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                    </g>
                </svg>` },
            1: {
                label: 'Пр. ясно', class: 'weather-sun', icon: `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cloud-sun-icon">
                    <g class="sun-segment" stroke="#ffcc00">
                        <path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/>
                        <path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/>
                    </g>
                    <path class="cloud-segment" d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z" fill="rgba(255,255,255,0.1)" stroke="#fff"/>
                </svg>` },
            2: {
                label: 'Облачно', class: 'weather-cloud', icon: `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cloud-icon">
                    <path class="cloud-main" d="M17.5 19a4.5 4.5 0 0 0 0-9 4.5 4.5 0 0 0-8.5 1.5c-1.5 0-3 1.5-3 3s1.5 3 3 3h8.5Z" fill="rgba(255,255,255,0.1)" stroke="#fff"/>
                </svg>` },
            3: {
                label: 'Пасмурно', class: 'weather-cloud', icon: `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="cloud-icon">
                    <path class="cloud-deep" d="M1 12.5a5 5 0 1 1 9.9 0h.1a3 3 0 0 1 0 6h-10a5 5 0 0 1 0-10Z" fill="rgba(255,255,255,0.15)" stroke="#fff"/>
                </svg>` },
            45: {
                label: 'Туман', class: 'weather-fog', icon: `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="fog-icon">
                    <path d="M5 12h14" stroke="#a1c4fd"/><path d="M5 16h14" stroke="#c2e9fb"/><path d="M5 8h14" stroke="#a1c4fd"/><path d="M5 20h14" stroke="#c2e9fb"/>
                </svg>` },
            48: {
                label: 'Туман', class: 'weather-fog', icon: `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="fog-icon">
                    <path d="M5 12h14" stroke="#a1c4fd"/><path d="M5 16h14" stroke="#c2e9fb"/><path d="M5 8h14" stroke="#a1c4fd"/><path d="M5 20h14" stroke="#c2e9fb"/>
                </svg>` },
            61: {
                label: 'Дождь', class: 'weather-rain', icon: `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="rain-icon">
                    <path class="cloud-segment" d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25" stroke="#fff"/>
                    <g class="rain-drops" stroke="#4facfe">
                        <path d="M8 19l-1 2" class="rain-drop"/><path d="M12 21l-1 2" class="rain-drop"/><path d="M16 19l-1 2" class="rain-drop"/>
                    </g>
                </svg>` },
            63: {
                label: 'Дождь', class: 'weather-rain', icon: `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="rain-icon">
                    <path class="cloud-segment" d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25" stroke="#fff"/>
                    <g class="rain-drops" stroke="#4facfe">
                        <path d="M8 19l-1 2" class="rain-drop"/><path d="M12 21l-1 2" class="rain-drop"/><path d="M16 19l-1 2" class="rain-drop"/>
                    </g>
                </svg>` },
            65: {
                label: 'Ливень', class: 'weather-rain', icon: `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" class="rain-icon-heavy">
                    <path class="cloud-segment" d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25" stroke="#fff"/>
                    <g class="rain-drops-fast" stroke="#00d2ff">
                        <path d="M8 19v4" class="rain-drop-fast"/><path d="M12 19v4" class="rain-drop-fast"/><path d="M16 19v4" class="rain-drop-fast"/>
                    </g>
                </svg>` },
            71: {
                label: 'Снег', class: 'weather-snow', icon: `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="snow-icon">
                    <path class="cloud-segment" d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25" stroke="#fff"/>
                    <g class="snow-flakes" stroke="#fff">
                        <path d="M8 19h.01" class="snow-flake"/><path d="M12 21h.01" class="snow-flake"/><path d="M16 19h.01" class="snow-flake"/>
                    </g>
                </svg>` },
            95: {
                label: 'Гроза', class: 'weather-thunder', icon: `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="thunder-icon">
                    <path class="cloud-segment" d="M19 16.9A5 5 0 0 0 18 7h-1.26a8 8 0 1 0-11.62 9" stroke="#fff"/>
                    <polyline points="13 11 11 17 15 17 13 23" class="thunder-bolt" fill="rgba(255,255,0,0.5)" stroke="yellow"/>
                </svg>` },
        };
        return codes[code] || {
            label: 'Погода', class: 'weather-default', icon: `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2v20M2 12h20"/>
            </svg>` };
    }

    trackRecentRoom(roomId) {
        if (!roomId) return;
        this.recentRooms = [roomId, ...this.recentRooms.filter(id => id !== roomId)].slice(0, 5);
    }

    startSummaryWidgets() {
        if (this.summaryInterval) clearInterval(this.summaryInterval);

        const update = () => {
            const timeEl = document.getElementById('summary-time');
            const dateEl = document.getElementById('summary-date');
            const now = new Date();

            if (timeEl) {
                const hours = String(now.getHours()).padStart(2, '0');
                const mins = String(now.getMinutes()).padStart(2, '0');
                const secs = String(now.getSeconds()).padStart(2, '0');
                timeEl.innerHTML = `${hours}<span class="clock-colon">:</span>${mins}<span class="clock-seconds">:${secs}</span>`;
            }
            if (dateEl) {
                try {
                    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
                    let dateStr = now.toLocaleDateString('ru-RU', options);
                    if (dateStr && dateStr.length > 2) {
                        dateStr = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);
                        dateEl.textContent = dateStr;
                    }
                } catch (e) {
                    console.warn('[UI] Localized date failed, using fallback');
                    dateEl.textContent = now.toDateString();
                }
            }
        };

        update();
        this.summaryInterval = setInterval(update, 1000);
    }

    renderCalendar() {
        const calContainer = document.getElementById('calendar-widget');
        const monthYearEl = document.getElementById('calendar-month-year');
        if (!calContainer || !monthYearEl) return;

        const month = this.currentCalendarMonth;
        const year = this.currentCalendarYear;
        const now = new Date();
        const today = (month === now.getMonth() && year === now.getFullYear()) ? now.getDate() : -1;

        const monthNames = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
            "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"
        ];
        monthYearEl.textContent = `${monthNames[month]} ${year}`;

        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();

        // Adjust for Monday start (0: Mon, ..., 6: Sun)
        let startingDay = firstDay === 0 ? 6 : firstDay - 1;

        let html = '<div class="calendar-grid">';
        const labels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
        labels.forEach(l => html += `<div class="calendar-day-label">${l}</div>`);

        for (let i = 0; i < startingDay; i++) {
            html += '<div class="calendar-day empty"></div>';
        }

        for (let i = 1; i <= daysInMonth; i++) {
            const isToday = i === today;
            const m = month + 1;
            const dateStr = `${year}${String(m).padStart(2, '0')}${String(i).padStart(2, '0')}`;
            const mmdd = `${String(m).padStart(2, '0')}${String(i).padStart(2, '0')}`;
            const label = `${i} ${monthNames[month]}`;

            // Collect unique holidays
            const exactHolidays = this.holidays[dateStr] || [];
            const recurringHolidays = this.holidays[mmdd] || [];
            const combinedEvents = [...exactHolidays, ...recurringHolidays];

            const uniqueEvents = [];
            const seen = new Set();
            combinedEvents.forEach(ev => {
                const key = `${ev.summary}|${ev.description}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    uniqueEvents.push(ev);
                }
            });

            const isHoliday = uniqueEvents.length > 0;
            const title = uniqueEvents.map(e => e.summary).join(', ');

            html += `<div class="calendar-day ${isToday ? 'current' : ''} ${isHoliday ? 'holiday' : ''}" 
                        title="${this.escapeHtml(title)}"
                        onclick="window.messenger.showHolidayDetailsForDate('${dateStr}', '${mmdd}', '${this.escapeHtml(label)}')">${i}</div>`;
        }
        html += '</div>';
        html += '<div id="holiday-info" class="holiday-info-box">Нажмите на праздник для описания</div>';
        calContainer.innerHTML = html;
    }

    changeMonth(delta) {
        this.currentCalendarMonth += delta;
        if (this.currentCalendarMonth > 11) {
            this.currentCalendarMonth = 0;
            this.currentCalendarYear++;
        } else if (this.currentCalendarMonth < 0) {
            this.currentCalendarMonth = 11;
            this.currentCalendarYear--;
        }
        this.renderCalendar();
    }

    showHolidayDetailsForDate(fullDate, mmdd, label) {
        const infoBox = document.getElementById('holiday-info');
        if (!infoBox) return;

        const exactHolidays = this.holidays[fullDate] || [];
        const recurringHolidays = this.holidays[mmdd] || [];
        const combinedEvents = [...exactHolidays, ...recurringHolidays];

        const uniqueEvents = [];
        const seen = new Set();
        combinedEvents.forEach(ev => {
            const key = `${ev.summary}|${ev.description}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueEvents.push(ev);
            }
        });

        if (uniqueEvents.length === 0) {
            infoBox.innerHTML = 'Нажмите на праздник для описания';
            infoBox.classList.remove('active');
            return;
        }

        let html = `
            <div class="holiday-info-header">
                <span class="holiday-info-date">${this.escapeHtml(label)}</span>
                <button class="btn-close-small" onclick="this.parentElement.parentElement.classList.remove('active')">&times;</button>
            </div>
        `;
        uniqueEvents.forEach(ev => {
            const desc = (ev.description || 'Описание отсутствует').trim();
            html += `<div class="holiday-detail-item">
                        <strong>${this.escapeHtml(ev.summary)}</strong>
                        <p>${this.escapeHtml(desc).replace(/\n/g, '<br>')}</p>
                     </div>`;
        });
        infoBox.innerHTML = html;
        infoBox.classList.add('active');
        infoBox.scrollTop = 0;
    }

    async loadQuotes() {
        try {
            const response = await fetch('https://raw.githubusercontent.com/umniystakan/Type-C/refs/heads/main/quotes.json');
            if (response.ok) {
                this.quotes = await response.json();
                console.log('[UI] Quotes loaded:', this.quotes.length);

                // If summary modal is already open, render a quote now
                const modal = document.getElementById('summary-modal');
                if (modal && modal.classList.contains('active')) {
                    this.renderQuote();
                }
            }
        } catch (error) {
            console.error('[UI] Failed to load quotes:', error);
        }
    }

    renderQuote() {
        const quoteTextEl = document.getElementById('summary-quote-text');
        const quoteAuthorEl = document.getElementById('summary-quote-author');
        if (!quoteTextEl || !quoteAuthorEl || this.quotes.length === 0) return;

        // Random selection with sequential repeat prevention
        let index;
        const lastIndex = parseInt(localStorage.getItem('typec_last_quote_index') || '-1');

        if (this.quotes.length > 1) {
            do {
                index = Math.floor(Math.random() * this.quotes.length);
            } while (index === lastIndex);
        } else {
            index = 0;
        }

        localStorage.setItem('typec_last_quote_index', index);
        const quote = this.quotes[index];

        quoteTextEl.textContent = `"${quote.text}"`;
        quoteAuthorEl.textContent = `— ${quote.author}`;
    }

    async loadHolidays() {
        const url = 'https://raw.githubusercontent.com/umniystakan/Type-C/refs/heads/main/ical-wholeworld.ics';
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error('Network response was not ok');
            const data = await response.text();
            this.holidays = this.parseICS(data);
            console.log(`[UI] Loaded ${Object.keys(this.holidays).length} holiday dates`);

            // Re-render if summary is open
            const summaryModal = document.getElementById('summary-modal');
            if (summaryModal && summaryModal.classList.contains('active')) {
                this.renderCalendar();
            }
        } catch (error) {
            console.error('[UI] Failed to load holidays:', error);
        }
    }

    parseICS(data) {
        const holidays = {};
        // 1. Unfold content (lines starting with space/tab are continuations)
        const unfolded = data.replace(/\r?\n[ \t]/g, '');
        const lines = unfolded.split(/\r?\n/);

        let currentEvent = null;

        const cleanValue = (val) => {
            if (!val) return "";
            return val
                .replace(/\\n/gi, "\n")
                .replace(/\\,/g, ",")
                .replace(/\\;/g, ";")
                .replace(/\\\\/g, "\\")
                .trim();
        };

        lines.forEach(line => {
            if (line.startsWith('BEGIN:VEVENT')) {
                currentEvent = { summary: '', date: '', description: '', isYearly: false };
            } else if (line.startsWith('END:VEVENT')) {
                if (currentEvent && currentEvent.date && currentEvent.summary) {
                    const eventData = {
                        summary: currentEvent.summary,
                        description: currentEvent.description || ''
                    };

                    const dateKey = currentEvent.date;
                    if (!holidays[dateKey]) holidays[dateKey] = [];
                    holidays[dateKey].push(eventData);

                    if (currentEvent.isYearly) {
                        const mmdd = dateKey.slice(4);
                        if (!holidays[mmdd]) holidays[mmdd] = [];
                        holidays[mmdd].push(eventData);
                    }
                }
                currentEvent = null;
            } else if (currentEvent) {
                const colonIndex = line.indexOf(':');
                if (colonIndex === -1) return;

                const propPart = line.substring(0, colonIndex);
                const valuePart = line.substring(colonIndex + 1);

                if (propPart.startsWith('DTSTART')) {
                    const match = valuePart.match(/(\d{8})/);
                    if (match) currentEvent.date = match[1];
                } else if (propPart.startsWith('RRULE')) {
                    if (valuePart.includes('FREQ=YEARLY')) currentEvent.isYearly = true;
                } else if (propPart.startsWith('SUMMARY')) {
                    currentEvent.summary = cleanValue(valuePart);
                } else if (propPart.startsWith('DESCRIPTION')) {
                    currentEvent.description = cleanValue(valuePart);
                }
            }
        });
        return holidays;
    }

    async markAsRead(roomId) {
        if (!this.client || !roomId) return;
        try {
            const room = this.client.getRoom(roomId);
            if (!room) return;

            // Use LiveTimeline for the most up-to-date end event
            const liveTimeline = room.getLiveTimeline();
            const events = liveTimeline.getEvents();

            if (events && events.length > 0) {
                const lastEvent = events[events.length - 1];
                const eventId = lastEvent.getId();

                console.log(`[UI] Persistent Read: Room ${roomId} up to ${eventId}`);

                // 1. Reset counts locally first for immediate UI snap
                if (typeof room.setUnreadNotificationCount === 'function') {
                    room.setUnreadNotificationCount('total', 0);
                    room.setUnreadNotificationCount('highlight', 0);
                }

                // 2. Send official receipt (m.read) - resets server-side count
                await this.client.sendReadReceipt(lastEvent).catch(e => console.warn('sendReadReceipt failed:', e));

                // 3. Set private markers (fully_read) - used for the "red line" in some apps
                // SDK expects an Event object, not an ID string, hence "i.getId is not a function" error
                await this.client.setRoomReadMarkers(roomId, eventId, lastEvent).catch(e => console.warn('setRoomReadMarkers failed:', e));

                // Update room list UI
                this.loadRooms();

                // Refresh Summary if open
                const summaryModal = document.getElementById('summary-modal');
                if (summaryModal && summaryModal.classList.contains('show')) {
                    this.openSummaryModal();
                }
            }
        } catch (error) {
            console.warn('[UI] Failed to mark room as read:', error);
        }
    }

    escapeHtml(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // ==========================================
    // Matrix Rain Toggle
    // ==========================================
    toggleMatrixRain(enabled) {
        const canvas = document.getElementById('matrix-rain');
        if (canvas) {
            canvas.style.display = enabled ? 'block' : 'none';
        }
        localStorage.setItem('matrix_rain_enabled', enabled ? 'true' : 'false');
        console.log('[SETTINGS] Matrix Rain:', enabled ? 'ON' : 'OFF');
    }

    // ==========================================
    // Passcode Lock System
    // ==========================================

    startPasscodeSetup() {
        this.passcodeMode = 'setup';
        this.passcodeBuffer = '';
        this.tempPasscode = '';

        const overlay = document.getElementById('passcode-overlay');
        const title = document.getElementById('passcode-title');
        const cancelBtn = document.getElementById('passcode-cancel');

        if (overlay) overlay.classList.remove('hidden');
        if (title) title.textContent = 'Создайте PIN-код';
        if (cancelBtn) cancelBtn.classList.remove('hidden');

        this.updatePasscodeDots();
    }

    disablePasscode() {
        this.passcodeMode = 'disable';
        this.passcodeBuffer = '';

        const overlay = document.getElementById('passcode-overlay');
        const title = document.getElementById('passcode-title');
        const cancelBtn = document.getElementById('passcode-cancel');

        if (overlay) overlay.classList.remove('hidden');
        if (title) title.textContent = 'Введите текущий PIN для отключения';
        if (cancelBtn) cancelBtn.classList.remove('hidden');

        this.updatePasscodeDots();
    }

    handlePasscodeInput(digit) {
        if (this.passcodeBuffer.length >= 4) return;

        this.passcodeBuffer += digit;
        this.updatePasscodeDots();

        if (this.passcodeBuffer.length === 4) {
            setTimeout(() => this.checkPasscode(), 200);
        }
    }

    handlePasscodeDelete() {
        if (this.passcodeBuffer.length > 0) {
            this.passcodeBuffer = this.passcodeBuffer.slice(0, -1);
            this.updatePasscodeDots();
        }
    }

    updatePasscodeDots() {
        const dots = document.querySelectorAll('.passcode-dots .dot');
        dots.forEach((dot, i) => {
            dot.classList.toggle('active', i < this.passcodeBuffer.length);
        });
    }

    checkPasscode() {
        const storedHash = localStorage.getItem('app_passcode_hash');
        const inputHash = this.hashPasscode(this.passcodeBuffer);

        if (this.passcodeMode === 'unlock') {
            if (inputHash === storedHash) {
                this.unlockApp();
            } else {
                this.shakePasscode();
            }
        } else if (this.passcodeMode === 'setup') {
            this.tempPasscode = this.passcodeBuffer;
            this.passcodeBuffer = '';
            this.passcodeMode = 'confirm';
            document.getElementById('passcode-title').textContent = 'Подтвердите PIN-код';
            this.updatePasscodeDots();
        } else if (this.passcodeMode === 'confirm') {
            if (this.passcodeBuffer === this.tempPasscode) {
                localStorage.setItem('app_passcode_hash', this.hashPasscode(this.passcodeBuffer));
                document.getElementById('app-lock-toggle').checked = true;
                this.hidePasscodeOverlay();
                console.log('[SECURITY] PIN code set successfully');
            } else {
                this.shakePasscode();
                this.passcodeBuffer = '';
                this.passcodeMode = 'setup';
                document.getElementById('passcode-title').textContent = 'PIN не совпал. Попробуйте снова';
                this.updatePasscodeDots();
            }
        } else if (this.passcodeMode === 'disable') {
            if (inputHash === storedHash) {
                localStorage.removeItem('app_passcode_hash');
                document.getElementById('app-lock-toggle').checked = false;
                this.hidePasscodeOverlay();
                console.log('[SECURITY] PIN code disabled');
            } else {
                this.shakePasscode();
            }
        }
    }

    hashPasscode(pin) {
        // Simple hash for localStorage
        let hash = 0;
        for (let i = 0; i < pin.length; i++) {
            const char = pin.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return 'PIN_' + Math.abs(hash).toString(16);
    }

    unlockApp() {
        this.hidePasscodeOverlay();
        console.log('[SECURITY] App unlocked');

        // v426: Trigger auto-login if session exists but not yet started
        if (!this.client) {
            const accessToken = localStorage.getItem('matrix_access_token');
            const userId = localStorage.getItem('matrix_user_id');
            const homeserver = localStorage.getItem('matrix_homeserver');
            const deviceId = localStorage.getItem('matrix_device_id');

            if (accessToken && userId && homeserver) {
                console.log('[AUTH] PIN entered, starting auto-login...');
                this.showChatScreen(); // Show interface immediately
                this.autoLogin(homeserver, accessToken, userId, deviceId);
                setTimeout(() => this.updateUserDisplay(), 2000);
            } else {
                this.showLoginScreen();
            }
        }
    }

    hidePasscodeOverlay() {
        const overlay = document.getElementById('passcode-overlay');
        if (overlay) overlay.classList.add('hidden');
        this.passcodeBuffer = '';
        this.passcodeMode = 'unlock';
    }

    shakePasscode() {
        const container = document.querySelector('.passcode-container');
        if (container) {
            container.classList.add('shake');
            setTimeout(() => container.classList.remove('shake'), 500);
        }
        this.passcodeBuffer = '';
        this.updatePasscodeDots();
    }

    cancelPasscodeSetup() {
        this.hidePasscodeOverlay();
        // Reset toggle to previous state
        const toggle = document.getElementById('app-lock-toggle');
        if (toggle) {
            toggle.checked = !!localStorage.getItem('app_passcode_hash');
        }
    }

    checkAppLock() {
        const storedHash = localStorage.getItem('app_passcode_hash');
        if (storedHash) {
            this.passcodeMode = 'unlock';
            this.passcodeBuffer = '';
            const overlay = document.getElementById('passcode-overlay');
            const title = document.getElementById('passcode-title');
            const cancelBtn = document.getElementById('passcode-cancel');

            if (overlay) overlay.classList.remove('hidden');
            if (title) title.textContent = 'Введите код доступа';
            if (cancelBtn) cancelBtn.classList.add('hidden');

            this.updatePasscodeDots();

            // Sync toggle state
            const toggle = document.getElementById('app-lock-toggle');
            if (toggle) toggle.checked = true;
        }
    }

    // --- Radio Logic ---

    addRadioStation() {
        const nameInput = document.getElementById('new-station-name');
        const urlInput = document.getElementById('new-station-url');
        const coverInput = document.getElementById('new-station-cover');

        const name = nameInput.value.trim();
        const url = urlInput.value.trim();
        const cover = coverInput.value.trim();

        if (!name || !url) {
            alert('Введите название и URL потока');
            return;
        }

        this.radioStations.push({
            name,
            url,
            cover: cover || 'https://via.placeholder.com/64?text=Radio'
        });

        localStorage.setItem('radio_stations', JSON.stringify(this.radioStations));

        nameInput.value = '';
        urlInput.value = '';
        coverInput.value = '';

        this.renderRadioStationsList();
        this.updateRadioHub();
    }

    deleteRadioStation(index) {
        this.radioStations.splice(index, 1);
        localStorage.setItem('radio_stations', JSON.stringify(this.radioStations));
        this.renderRadioStationsList();
        this.updateRadioHub();

        if (this.selectedRadioIndex === String(index)) {
            this.selectedRadioIndex = "";
            this.stopRadio();
            this.updateRadioDisplay();
        }
    }

    renderRadioStationsList() {
        const list = document.getElementById('radio-stations-list');
        if (!list) return;

        if (this.radioStations.length === 0) {
            list.innerHTML = '<p class="empty-text">Станции не добавлены</p>';
            return;
        }

        list.innerHTML = this.radioStations.map((station, index) => `
            <div class="station-item">
                <img src="${station.cover}" alt="${station.name}" class="station-logo-mini">
                <div class="station-info">
                    <span class="station-name">${this.escapeHtml(station.name)}</span>
                    <span class="station-url">${this.escapeHtml(station.url)}</span>
                </div>
                <button class="btn-delete-station" onclick="window.messenger.deleteRadioStation(${index})">
                    &times;
                </button>
            </div>
        `).join('');
    }

    updateRadioHub() {
        const hub = document.getElementById('radio-station-hub');
        if (!hub) return;

        if (this.radioStations.length === 0) {
            hub.innerHTML = '<p class="empty-text">Станции не добавлены</p>';
            return;
        }

        hub.innerHTML = this.radioStations.map((station, index) => `
            <img src="${station.cover}" 
                 class="hub-station-icon ${this.selectedRadioIndex === String(index) ? 'active' : ''}" 
                 data-index="${index}" 
                 title="${this.escapeHtml(station.name)}"
                 alt="${this.escapeHtml(station.name)}">
        `).join('');
    }

    selectRadioStation(index) {
        const newIndex = String(index);
        if (this.selectedRadioIndex === newIndex) return;

        this.selectedRadioIndex = newIndex;

        // Update hub UI (highlight active)
        document.querySelectorAll('.hub-station-icon').forEach((icon, i) => {
            icon.classList.toggle('active', String(i) === this.selectedRadioIndex);
        });

        this.stopRadio();
        this.updateRadioDisplay();
    }

    async toggleRadioPlayback() {
        if (this.isRadioLoading) return;

        const playBtn = document.getElementById('radio-play-btn');
        if (!playBtn) return;

        if (this.selectedRadioIndex === "") {
            alert('Сначала выберите радиостанцию в Hub');
            return;
        }

        const station = this.radioStations[this.selectedRadioIndex];
        const isPlaying = !this.audioPlayer.paused && this.currentStation?.url === station.url;

        if (isPlaying) {
            this.stopRadio();
            return;
        }

        // --- Start Playback ---
        this.isRadioLoading = true;
        playBtn.style.opacity = '0.5';
        playBtn.classList.add('loading');

        try {
            // Always reload for live streams to ensure fresh connection/live edge
            this.audioPlayer.pause();
            this.audioPlayer.src = station.url;
            await this.audioPlayer.play();
            this.currentStation = station;
            this.isRadioActive = true; // v350
            console.log('[RADIO] Playback started, isRadioActive = true');
            // Removed redundant broadcast call - handled by metadata start or final success

            // Success UI updates
            playBtn.innerHTML = `
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
                </svg>`;

            const indicator = document.querySelector('.deck-status-indicator');
            if (indicator) indicator.classList.add('online');

            const visualizer = document.getElementById('radio-visualizer');
            if (visualizer) visualizer.classList.add('active');

            const radioContainer = document.querySelector('.radio-player-remake');
            if (radioContainer) radioContainer.classList.add('is-playing');

            this.startMetadataPolling();
            this.broadcastRadioStatus(station);
        } catch (err) {
            console.error('Radio playback failed:', err);
            // Ignore AbortError (if pause() was called before play() finished)
            // Ignore NotAllowedError (Chrome autoplay policy, though this is user-triggered)
            if (err.name !== 'AbortError' && err.name !== 'NotAllowedError') {
                alert('Не удалось запустить радио. Проверьте URL.');
            }
        } finally {
            this.isRadioLoading = false;
            playBtn.style.opacity = '1';
            playBtn.classList.remove('loading');
        }
    }

    stopRadio() {
        console.log('[RADIO] stopRadio called');
        this.audioPlayer.pause();
        this.isRadioActive = false; // v350
        this.currentStation = null;  // v350: Explicitly clear
        console.log('[RADIO] Status cleared, isRadioActive = false');

        const playBtn = document.getElementById('radio-play-btn');
        const indicator = document.querySelector('.deck-status-indicator');

        if (playBtn) {
            playBtn.innerHTML = `
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z"/>
                </svg>`;
        }
        if (indicator) indicator.classList.remove('online');

        const visualizer = document.getElementById('radio-visualizer');
        if (visualizer) visualizer.classList.remove('active');

        const radioContainer = document.querySelector('.radio-player-remake');
        if (radioContainer) radioContainer.classList.remove('is-playing');

        this.stopMetadataPolling();
        this.broadcastRadioStatus(null);
    }

    updateRadioDisplay() {
        const stationEl = document.getElementById('radio-current-station');
        const trackEl = document.getElementById('radio-current-track');
        const coverEl = document.getElementById('radio-current-cover');

        if (!stationEl) return;

        if (this.selectedRadioIndex === "") {
            stationEl.textContent = 'Радио не выбрано';
            trackEl.textContent = 'Выберите станцию выше';
            coverEl.src = 'https://via.placeholder.com/64?text=Radio';
            return;
        }

        const station = this.radioStations[this.selectedRadioIndex];
        stationEl.textContent = station.name;
        trackEl.textContent = 'Готов к воспроизведению';
        coverEl.src = station.cover;
    }

    startMetadataPolling() {
        this.stopMetadataPolling();

        // v407: Removed ICY scanning per user request. 
        // We just broadcast the station name and set a static text.
        if (!this.isRadioActive || !this.currentStation) return;

        const trackInfo = "Прямой эфир";
        const trackEl = document.getElementById('radio-current-track');
        if (trackEl) trackEl.textContent = trackInfo;

        this.broadcastRadioStatus(this.currentStation, trackInfo);
    }

    async fetchIcyMetadata(url) {
        // v407: Feature removed. Returns null.
        return null;
    }

    stopMetadataPolling() {
        if (this.metadataPollInterval) {
            clearInterval(this.metadataPollInterval);
            this.metadataPollInterval = null;
        }
        this._lastParsedTrack = null;
    }

    shareRadioStation() {
        if (this.selectedRadioIndex === "") {
            alert('Сначала выберите радиостанцию в Hub');
            return;
        }

        if (!this.currentRoomId) {
            alert('Сначала выберите чат, куда отправить станцию');
            return;
        }

        const station = this.radioStations[this.selectedRadioIndex];
        const content = {
            msgtype: 'typec.radio_station',
            body: `📡 Слушай радио: ${station.name}`,
            station: {
                name: station.name,
                url: station.url,
                cover: station.cover
            }
        };

        this.client.sendMessage(this.currentRoomId, content)
            .then(() => {
                console.log('Station shared successfully');
            })
            .catch(err => {
                console.error('Failed to share station:', err);
                alert('Ошибка при отправке: ' + err.message);
            });
    }

    addSharedStation(name, url, cover, btn) {
        // Prevent duplicates
        if (this.radioStations.some(s => s.url === url)) {
            alert('Эта станция уже есть в вашем списке');
            if (btn) {
                btn.classList.add('added');
                btn.textContent = 'Добавлено';
            }
            return;
        }

        this.radioStations.push({ name, url, cover });
        localStorage.setItem('radio_stations', JSON.stringify(this.radioStations));

        this.renderRadioStationsList();
        this.updateRadioHub();

        if (btn) {
            btn.classList.add('added');
            btn.textContent = 'Добавлено';
        }

        // Small notification
        const toastContainer = document.getElementById('notification-container');
        if (toastContainer) {
            const toast = document.createElement('div');
            toast.className = 'toast-notification';
            toast.innerHTML = `
                <div class="toast-header">
                    <span class="toast-sender">Система</span>
                </div>
                <div class="toast-body">Станция "${name}" добавлена в ваш Hub!</div>
            `;
            toastContainer.appendChild(toast);
            setTimeout(() => toast.remove(), 3000);
        }
    }

    updateMiniPlayerUI(station) {
        const mp = document.getElementById('radio-mini-player');
        if (!mp) return;

        // v300: Respect global enablement
        if (!this.miniPlayerEnabled) {
            mp.classList.add('hidden');
            return;
        }

        if (!station) {
            if (this.audioPlayer && !this.audioPlayer.paused) {
                // Keep showing if playing
            } else {
                mp.classList.add('hidden');
                return;
            }
        }

        if (localStorage.getItem('mini_player_closed') !== 'true' || this.currentStation) {
            mp.classList.remove('hidden');
        }

        const coverEl = document.getElementById('mini-player-cover');
        const nameEl = document.getElementById('mini-player-name');
        const playBtn = document.getElementById('mini-player-play-btn');

        if (station) {
            if (coverEl) coverEl.src = station.cover || 'https://via.placeholder.com/40';
            if (nameEl) nameEl.textContent = station.name;
        }

        if (this.audioPlayer.paused) {
            mp.classList.remove('playing');
            if (playBtn) playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
        } else {
            mp.classList.add('playing');
            if (playBtn) playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
            mp.classList.remove('hidden');
            localStorage.removeItem('mini_player_closed');
        }
    }

    initMiniPlayerDraggable() {
        const mp = document.getElementById('radio-mini-player');
        if (!mp) return;

        let isDragging = false;
        let currentX;
        let currentY;
        let initialX = 0;
        let initialY = 0;
        let xOffset = 0;
        let yOffset = 0;

        const dragStart = (e) => {
            if (e.type === 'touchstart') {
                initialX = e.touches[0].clientX - xOffset;
                initialY = e.touches[0].clientY - yOffset;
            } else {
                initialX = e.clientX - xOffset;
                initialY = e.clientY - yOffset;
            }

            if (e.target.closest('.mini-player-drag-handle') || e.target.closest('.mini-player-avatar')) {
                isDragging = true;
            }
        };

        const dragEnd = () => {
            initialX = currentX;
            initialY = currentY;
            isDragging = false;
        };

        const drag = (e) => {
            if (isDragging) {
                e.preventDefault();

                if (e.type === 'touchmove') {
                    currentX = e.touches[0].clientX - initialX;
                    currentY = e.touches[0].clientY - initialY;
                } else {
                    currentX = e.clientX - initialX;
                    currentY = e.clientY - initialY;
                }

                xOffset = currentX;
                yOffset = currentY;

                setTranslate(currentX, currentY, mp);
            }
        };

        const setTranslate = (xPos, yPos, el) => {
            el.style.transform = `translate3d(${xPos}px, ${yPos}px, 0)`;
        };

        document.addEventListener('touchstart', dragStart, false);
        document.addEventListener('touchend', dragEnd, false);
        document.addEventListener('touchmove', drag, false);

        document.addEventListener('mousedown', dragStart, false);
        document.addEventListener('mouseup', dragEnd, false);
        document.addEventListener('mousemove', drag, false);
    }
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        new TypeCMessenger();
    });
} else {
    new TypeCMessenger();
}