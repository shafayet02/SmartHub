// =============================================================================
// Smart Hub Front-End Application Logic (V4.4 Revamp)
// =============================================================================
const symbols = { BDT: '৳', USD: '$', EUR: '€', CNY: '¥' };
let state = {
    db: null, activeId: null, isPowerOn: false,
    livePower: [], liveVoltage: [], liveLabels: [], chart: null, lang: 'en',
    builtDeviceIds: null,
    consecutiveFailures: 0, bootLoaded: false, deferredInstallPrompt: null,
    allStatuses: {}, lastSampleAtByDevice: {}, timerExpiryRefreshAt: 0,
    pinInput: ''
};

// ---------------------------------------------------------------------------
// Security PIN Authentication Logic
// ---------------------------------------------------------------------------
function showPinScreen() {
    const overlay = document.getElementById('pinOverlay');
    overlay.classList.remove('hidden');
    overlay.classList.add('flex');
    state.pinInput = '';
    updatePinUI();
}

function enterPinDigit(digit) {
    if (state.pinInput.length < 4) {
        state.pinInput += digit;
        updatePinUI();
        if (state.pinInput.length === 4) {
            localStorage.setItem('hub_pin', state.pinInput);
            const overlay = document.getElementById('pinOverlay');
            overlay.classList.add('hidden');
            overlay.classList.remove('flex');
            fetchDB(true).then(() => fetchStatus()).catch(() => showPinScreen());
        }
    }
}

function clearPin() {
    state.pinInput = state.pinInput.slice(0, -1);
    updatePinUI();
}

function updatePinUI() {
    const dots = document.getElementById('pinDots').children;
    for (let i = 0; i < 4; i++) {
        if (i < state.pinInput.length) {
            dots[i].classList.add('bg-white', 'scale-110');
            dots[i].classList.remove('bg-transparent', 'border-white/40');
        } else {
            dots[i].classList.remove('bg-white', 'scale-110');
            dots[i].classList.add('bg-transparent', 'border-white/40');
        }
    }
}

// ---------------------------------------------------------------------------
// Notifications & Toast Stack
// ---------------------------------------------------------------------------
function toast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    const icon = type === 'success' ? '<svg class="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>' : 
                 type === 'error' ? '<svg class="w-5 h-5 text-rose-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>' : 
                 '<svg class="w-5 h-5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>';
    el.innerHTML = `${icon} <span>${message}</span>`;
    container.appendChild(el);
    setTimeout(() => { 
        el.style.opacity = '0'; 
        el.style.transform = 'translateY(10px) scale(0.95)';
        setTimeout(() => el.remove(), 300); 
    }, 3200);
}

function actionError(error, fallback = 'Something went wrong') {
    toast(error?.message || fallback, 'error');
}

// ---------------------------------------------------------------------------
// Network Request Engine with Automatic PIN Injection
// ---------------------------------------------------------------------------
async function apiFetch(url, options = {}) {
    const pin = localStorage.getItem('hub_pin') || '';
    const headers = { ...(options.headers || {}), 'x-pin': pin };
    const hideToast = options.hideToast;
    if (options.hideToast !== undefined) delete options.hideToast;

    const { timeoutMs = 12000, ...fetchOptions } = options;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...fetchOptions, headers, signal: controller.signal });
        if (res.status === 401) {
            showPinScreen();
            throw new Error('Unauthorized');
        }
        if (!res.ok) {
            let message = `Request failed (${res.status})`;
            try {
                const payload = await res.clone().json();
                if (payload?.error) message = payload.error;
            } catch (e) {}
            if (!hideToast) throw new Error(message);
            return null; // Return null safely if background fetch fails
        }
        return res;
    } catch (error) {
        if (!hideToast) {
            if (error?.name === 'AbortError') throw new Error('Request timed out');
            throw error;
        }
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

// ---------------------------------------------------------------------------
// Multilingual Engine (Bengali / English)
// ---------------------------------------------------------------------------
const dict = {
    bn: {
        'Overview': 'ওভারভিউ', 'Analytics': 'অ্যানালিটিক্স', 'Automation': 'অটোমেশন', 'Settings': 'সেটিংস',
        'CONNECTING': 'সংযোগ হচ্ছে', 'ONLINE': 'অনলাইন', 'OFFLINE': 'অফলাইন', 'STANDBY': 'স্ট্যান্ডবাই',
        'ON': 'চালু', 'OFF': 'বন্ধ', 'VOLTAGE': 'ভোল্টেজ', 'WATTAGE': 'ওয়াটেজ',
        'Master ON': 'মাস্টার চালু', 'Master OFF': 'মাস্টার বন্ধ', 'All Devices': 'ডিভাইস সমূহ',
        'Insights': 'বিশ্লেষণ', 'TODAY vs YESTERDAY': 'আজ বনাম গতকাল', 'MONTHLY FORECAST': 'মাসিক পূর্বাভাস',
        'PEAK HOUR TODAY': 'আজকের পিক ঘণ্টা',
        'BUDGET PROGRESS:': 'মাসিক বাজেট:', 'Live': 'লাইভ রিয়েলটাইম', 'Today (Hourly)': 'আজ (ঘণ্টা)',
        '7 Days': '৭ দিন', '4 Weeks': '৪ সপ্তাহ', '6 Months': '৬ মাস',
        'Energy': 'এনার্জি', 'Cost': 'খরচ', 'Power (W)': 'পাওয়ার (W)', 'Voltage (V)': 'ভোল্টেজ (V)', 'Bar': 'বার চার্ট', 'Line': 'লাইন চার্ট',
        'Operating Mode': 'অপারেটিং মোড', 'Manual': 'ম্যানুয়াল', 'Day': 'দিন মোড', 'Night': 'রাত মোড', 'Sleep': 'স্লিপ (৩ ঘণ্টা)',
        'Standby Auto-Kill': 'অটো-কিল', 'Stops power if <5W for 10m': '<৫ ওয়াট হলে ১০ মিনিটে বন্ধ', 'Timer': 'টাইমার',
        'Voltage Guard': 'ভোল্টেজ গার্ড', 'Auto-kill on dangerous voltage': 'বিপজ্জনক ভোল্টেজে অটো-কিল',
        'MIN (V)': 'সর্বনিম্ন (V)', 'MAX (V)': 'সর্বোচ্চ (V)',
        'Strict Budget Lock': 'কঠোর বাজেট লক', 'Auto-kill if budget hits 100%': 'বাজেট ১০০% ছুঁলে বন্ধ',
        'Power Outage Recovery': 'বিদ্যুৎ বিভ্রাট রিকভারি', 'Restore state when power returns': 'বিদ্যুৎ ফিরলে পূর্বের অবস্থায় ফিরিয়ে দিন',
        'Tariff & Preferences': 'ট্যারিফ এবং সেটিংস', 'RATE': 'রেট', 'CURRENCY': 'মুদ্রা', 'WEATHER LOCATION': 'আবহাওয়ার অবস্থান',
        'Save': 'সংরক্ষণ', 'Set Budget': 'বাজেট সেট করুন', 'Export CSV': 'ডাউনলোড CSV',
        'System Management': 'সিস্টেম ম্যানেজমেন্ট', 'Add Device': 'ডিভাইস যোগ করুন', 'Remove Device': 'ডিভাইস মুছুন', 'Rename': 'নাম পরিবর্তন',
        'Reboot': 'পাওয়ার সাইকেল', 'Clear History DB': 'হিস্ট্রি মুছুন',
        'Recent Activity': 'লগ সমূহ', 'No recent activity yet.': 'কোনো কার্যকলাপ নেই।',
        'Connection lost - retrying...': 'সংযোগ বিচ্ছিন্ন — পুনরায় চেষ্টা করা হচ্ছে...',
        'Connecting to your hub...': 'আপনার হাবের সাথে সংযোগ হচ্ছে...',
    },
};
function t(key) { return (state.lang === 'bn' && dict.bn[key]) ? dict.bn[key] : key; }

function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
        const text = t(el.getAttribute('data-i18n'));
        if (el.tagName === 'OPTION') el.text = text;
        else if (el.childNodes.length > 0 && el.childNodes[0].nodeType === 3) el.childNodes[0].nodeValue = text;
        else el.innerText = text;
    });
    
    document.querySelectorAll('.lang-toggle-cb').forEach(cb => {
        cb.checked = (state.lang === 'bn');
    });

    const badgeText = document.getElementById('statusBadge').innerText;
    updatePowerUI(state.isPowerOn, badgeText !== 'OFFLINE' && badgeText !== 'অফলাইন');
    if (!document.getElementById('tab-analytics').classList.contains('hidden')) updateChart();
    renderActivityLog();
}

async function toggleLang() {
    state.lang = state.lang === 'en' ? 'bn' : 'en';
    applyTranslations();
    if (state.db) {
        try { await apiFetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: state.lang }), hideToast: true }); }
        catch (e) {}
    }
}

// ---------------------------------------------------------------------------
// Theme Controller
// ---------------------------------------------------------------------------
if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
}
function toggleTheme() {
    document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    updateChart();
}

// ---------------------------------------------------------------------------
// Precise Navigation Tab Switcher (No Ghost Classes)
// ---------------------------------------------------------------------------
function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach((el) => el.classList.add('hidden'));
    
    document.querySelectorAll('.tab-btn').forEach((el) => {
        el.className = "tab-btn flex-1 flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 py-2.5 px-2 sm:px-6 rounded-[20px] font-bold text-[11px] sm:text-sm transition-all duration-300 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white";
    });
    
    document.getElementById(tabId).classList.remove('hidden');
    
    const activeBtn = document.getElementById('btn-' + tabId);
    activeBtn.className = "tab-btn flex-1 flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 py-2.5 px-2 sm:px-6 rounded-[20px] font-bold text-[11px] sm:text-sm transition-all duration-300 bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm border border-slate-200 dark:border-white/10";
    
    if (tabId === 'tab-analytics') updateChart();
}

// ---------------------------------------------------------------------------
// Real-Time Clock & Chrono Ticker
// ---------------------------------------------------------------------------
setInterval(() => {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }));
    document.getElementById('clockTime').innerText = now.toLocaleTimeString(state.lang === 'bn' ? 'bn-BD' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    document.getElementById('clockDate').innerText = now.toLocaleDateString(state.lang === 'bn' ? 'bn-BD' : 'en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

    if (!state.db || !state.activeId) return;
    const auto = state.db.automations[state.activeId];
    if (auto && auto.timer.active) {
        const rem = Math.max(0, Math.floor((auto.timer.executeAt - Date.now()) / 1000));
        if (rem === 0) {
            if (Date.now() - state.timerExpiryRefreshAt > 5000) {
                state.timerExpiryRefreshAt = Date.now();
                fetchDB(true).catch(() => {});
            }
        } else {
            document.getElementById('timerText').innerText = `⏳ ${auto.timer.action ? t('ON') : t('OFF')} in ${Math.floor(rem / 60)}m ${rem % 60}s`;
            document.getElementById('timerText').classList.remove('hidden');
        }
    } else {
        document.getElementById('timerText').classList.add('hidden');
    }
}, 1000);

// ---------------------------------------------------------------------------
// Open-Meteo Weather Dispatcher (Robust string parsing fallback)
// ---------------------------------------------------------------------------
async function fetchWeather() {
    try {
        const rawLoc = state.db?.settings?.weatherLocation || 'Dhaka';
        const loc = rawLoc.split(',')[0].trim();
        if(!loc) return;
        
        const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(loc)}&count=1&language=en&format=json`);
        const geoData = await geoRes.json();
        if (!geoData.results || geoData.results.length === 0) {
            document.getElementById('weatherDesc').innerText = 'Loc N/A';
            return;
        }

        const { latitude, longitude, name } = geoData.results[0];
        const wRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code`);
        const data = await wRes.json();

        if (data.current) {
            const temp = Math.round(data.current.temperature_2m);
            document.getElementById('weatherTemp').innerText = `${state.lang === 'bn' ? temp.toLocaleString('bn-BD') : temp}°C`;
            const code = data.current.weather_code;
            let desc = 'Partly Cloudy', icon = '⛅';
            if (code === 0) { desc = state.lang === 'bn' ? 'পরিষ্কার' : 'Clear Sky'; icon = '☀️'; }
            else if (code <= 3) { desc = state.lang === 'bn' ? 'মেঘলা' : 'Cloudy'; icon = '☁️'; }
            else if (code <= 48) { desc = state.lang === 'bn' ? 'কুয়াশা' : 'Foggy'; icon = '🌫️'; }
            else if (code <= 67) { desc = state.lang === 'bn' ? 'বৃষ্টি' : 'Rain'; icon = '🌧️'; }
            else if (code >= 95) { desc = state.lang === 'bn' ? 'বজ্রঝড়' : 'Thunderstorm'; icon = '⛈️'; }

            document.getElementById('weatherDesc').innerText = `${name} • ${desc}`;
            document.getElementById('weatherIcon').innerText = icon;
        }
    } catch (e) {
        document.getElementById('weatherDesc').innerText = 'Weather N/A';
    }
}

// ---------------------------------------------------------------------------
// Connection Telemetry Banner
// ---------------------------------------------------------------------------
function markFetchSuccess() {
    state.consecutiveFailures = 0;
    document.getElementById('offlineBanner').classList.remove('show');
}
function markFetchFailure() {
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= 2) document.getElementById('offlineBanner').classList.add('show');
}

// ---------------------------------------------------------------------------
// Primary State Synchronization
// ---------------------------------------------------------------------------
async function fetchDB(silent = false) {
    try {
        const res = await apiFetch('/api/data', { hideToast: silent });
        if(!res) { markFetchFailure(); return; } // Handled via silent background

        state.db = await res.json();
        markFetchSuccess();
        state.lang = state.db.settings.language || 'en';
        applyTranslations();

        const currentIds = state.db.devices.map((d) => `${d.id}:${d.name}`).join('|');
        if (state.builtDeviceIds !== currentIds) {
            const sel = document.getElementById('deviceSelector');
            sel.innerHTML = '';
            state.db.devices.forEach((d) => {
                const opt = document.createElement('option');
                opt.value = d.id; 
                opt.textContent = d.name;
                sel.appendChild(opt);
            });
            state.builtDeviceIds = currentIds;
        }
        if ((!state.activeId || !state.db.devices.find((d) => d.id === state.activeId)) && state.db.devices.length > 0) {
            state.activeId = state.db.devices[0].id;
        }
        document.getElementById('deviceSelector').value = state.activeId || '';
        document.getElementById('deviceSelector').disabled = state.db.devices.length === 0;
        document.getElementById('powerBtn').disabled = state.db.devices.length === 0;

        if (document.activeElement !== document.getElementById('rateInput')) document.getElementById('rateInput').value = state.db.settings.baseRateBDT;
        if (document.activeElement !== document.getElementById('currencySelect')) document.getElementById('currencySelect').value = state.db.settings.currency;
        if (document.activeElement !== document.getElementById('locInput')) document.getElementById('locInput').value = state.db.settings.weatherLocation || 'Dhaka';

        if (state.db.devices.length === 0) setNoDeviceState();
        else renderDeviceUI();
        renderActivityLog();
        hideBootSkeleton();
    } catch (e) {
        if (e.message !== 'Unauthorized') {
            markFetchFailure();
            if (!silent) actionError(e, state.lang === 'bn' ? 'সার্ভারের সাথে সংযোগ ব্যর্থ' : 'Could not reach the server');
        }
    }
}

function setNoDeviceState() {
    state.activeId = null;
    const selector = document.getElementById('deviceSelector');
    selector.disabled = true;
    if (!selector.options.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No devices';
        selector.appendChild(option);
    }
    const powerBtn = document.getElementById('powerBtn');
    powerBtn.disabled = true;
    updatePowerUI(false, false);
    document.getElementById('val-volt').innerText = '-- V';
    document.getElementById('val-power').innerText = '-- W';
    renderDeviceGrid();
}

function hideBootSkeleton() {
    if (state.bootLoaded) return;
    state.bootLoaded = true;
    const el = document.getElementById('bootSkeleton');
    el.style.opacity = '0'; 
    el.style.transition = 'opacity 0.4s ease';
    setTimeout(() => el.remove(), 400);
}

function switchDevice() {
    state.activeId = document.getElementById('deviceSelector').value;
    state.livePower = []; state.liveVoltage = []; state.liveLabels = [];
    state.lastSampleAtByDevice[state.activeId] = 0;
    fetchDB(true).then(fetchStatus).catch(() => {});
}

async function exportData() {
    if (!state.activeId) return;
    try {
        const res = await apiFetch(`/api/export/${state.activeId}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `device_${state.activeId}_today.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { actionError(e, 'Could not export CSV'); }
}

async function addNewDevice() {
    const id = prompt('Enter Tuya Device ID:');
    if (!id) return;
    const name = prompt('Enter Device Name:');
    if (!name) return;
    try {
        const res = await apiFetch('/api/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id.trim(), name: name.trim() }) });
        const data = await res.json();
        if (!data.success) { toast(data.error || 'Could not add device', 'error'); return; }
        state.activeId = id.trim(); state.builtDeviceIds = null;
        toast('Device added', 'success');
        await fetchDB();
    } catch (e) { actionError(e, 'Could not add device'); }
}

async function renameDevice() {
    if (!state.activeId) return;
    const current = state.db?.devices?.find((d) => d.id === state.activeId);
    const name = prompt('New name for this device:', current ? current.name : '');
    if (!name || !name.trim()) return;
    try {
        const res = await apiFetch(`/api/devices/${state.activeId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
        const data = await res.json();
        if (!data.success) { toast(data.error || 'Could not rename device', 'error'); return; }
        state.builtDeviceIds = null;
        toast('Device renamed', 'success');
        await fetchDB();
    } catch (e) { actionError(e, 'Could not rename device'); }
}

async function removeDevice() {
    if (!state.activeId) return;
    if (!confirm('Remove device?')) return;
    try {
        await apiFetch(`/api/devices/${state.activeId}`, { method: 'DELETE' });
        state.activeId = null; state.builtDeviceIds = null;
        toast('Device removed', 'success');
        await fetchDB();
    } catch (e) { actionError(e, 'Could not remove device'); }
}

async function clearData() {
    if (!state.activeId) return;
    if (!confirm('Erase all history for this device?')) return;
    try { await apiFetch(`/api/usage/${state.activeId}`, { method: 'DELETE' }); toast('History cleared', 'success'); await fetchDB(); }
    catch (e) { actionError(e, 'Could not clear history'); }
}

async function powerCycle() {
    if (!state.activeId) return;
    if (!confirm('Power cycle device?')) return;
    try { toast('Cycling power...', 'info'); await apiFetch(`/api/cycle/${state.activeId}`, { method: 'POST', timeoutMs: 20000 }); await fetchStatus(); }
    catch (e) { actionError(e, 'Could not cycle power'); }
}

async function masterToggle(isOn) {
    if (!confirm(`Turn ${isOn ? 'ON' : 'OFF'} all devices?`)) return;
    try {
        const res = await apiFetch('/api/toggle-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: isOn }), timeoutMs: 30000 });
        const data = await res.json();
        if (!data.success) toast('Some devices did not respond', 'error');
        fetchStatus(); fetchAllStatuses();
    } catch (e) { actionError(e, 'Master command failed'); }
}

// ---------------------------------------------------------------------------
// 4-Pod Separated Activity Ring Render Engine
// ---------------------------------------------------------------------------
function updateActivityRings(todayKwh, todayCost) {
    const voltRaw = parseFloat(document.getElementById('val-volt').innerText) || 0;
    const voltPct = Math.min(1, Math.max(0, voltRaw / 260));
    document.getElementById('ring-volt').style.strokeDashoffset = 251 - (251 * voltPct);

    const powerRaw = parseFloat(document.getElementById('val-power').innerText) || 0;
    const powerPct = Math.min(1, Math.max(0, powerRaw / 3000));
    document.getElementById('ring-power').style.strokeDashoffset = 251 - (251 * powerPct);

    const curr = state.db.settings.currency;
    const rate = state.db.settings.baseRateBDT * (state.db.currentRates[curr] || 1);
    const budgetCost = (state.db.settings.monthlyBudget || 500) * (state.db.currentRates[curr] || 1);
    
    const dailyBudgetKwh = (budgetCost / 30) / rate;
    const energyPct = Math.min(1, Math.max(0, todayKwh / (dailyBudgetKwh || 1)));
    document.getElementById('ring-energy').style.strokeDashoffset = 251 - (251 * energyPct);
    document.getElementById('val-energy').innerText = (state.lang === 'bn' ? todayKwh.toLocaleString('bn-BD', { maximumFractionDigits: 2 }) : todayKwh.toFixed(2));

    const dailyBudgetCost = budgetCost / 30;
    const costPct = Math.min(1, Math.max(0, todayCost / (dailyBudgetCost || 1)));
    document.getElementById('ring-cost').style.strokeDashoffset = 251 - (251 * costPct);
    document.getElementById('val-cost').innerText = symbols[curr] + (state.lang === 'bn' ? todayCost.toLocaleString('bn-BD', { maximumFractionDigits: 0 }) : todayCost.toFixed(0));
}

// ---------------------------------------------------------------------------
// Device UI Rendering & State Reflectors
// ---------------------------------------------------------------------------
function renderDeviceUI() {
    if (!state.activeId || !state.db) return;
    const auto = state.db.automations[state.activeId];
    const usage = state.db.usage[state.activeId];
    if (!auto || !usage) return;

    // Reset all mode buttons 
    document.querySelectorAll('.mode-btn').forEach((b) => {
        b.className = "mode-btn flex flex-col items-center justify-center p-4 sm:p-5 rounded-[24px] border-2 transition-all duration-300 bg-slate-50 dark:bg-white/5 border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-white/20";
    });

    let isSleepActive = false;
    if (auto.timer && auto.timer.active && auto.timer.action === false) {
        const sleepBtn = document.getElementById('mode-sleep');
        if (sleepBtn) {
            sleepBtn.className = "mode-btn flex flex-col items-center justify-center p-4 sm:p-5 rounded-[24px] border-2 transition-all duration-300 bg-indigo-500 text-white border-transparent shadow-lg shadow-indigo-500/30 scale-[1.02]";
            isSleepActive = true;
        }
    }

    const modeBtn = document.getElementById(`mode-${auto.mode}`);
    if (modeBtn && !(auto.mode === 'manual' && isSleepActive)) {
        modeBtn.className = "mode-btn flex flex-col items-center justify-center p-4 sm:p-5 rounded-[24px] border-2 transition-all duration-300 bg-gradient-to-br from-sky-400 to-blue-600 text-white border-transparent shadow-lg shadow-blue-500/30 scale-[1.02]";
    }

    if (document.getElementById('standbyToggle').checked !== (auto.standbyKill || false)) document.getElementById('standbyToggle').checked = auto.standbyKill || false;
    if (document.getElementById('voltageToggle').checked !== (auto.voltageProtect || false)) document.getElementById('voltageToggle').checked = auto.voltageProtect || false;
    if (document.getElementById('budgetToggle').checked !== (auto.budgetKill || false)) document.getElementById('budgetToggle').checked = auto.budgetKill || false;
    if (document.getElementById('outageToggle').checked !== (auto.powerOutageRecovery !== false)) document.getElementById('outageToggle').checked = auto.powerOutageRecovery !== false;

    if (document.activeElement !== document.getElementById('vMinInput')) document.getElementById('vMinInput').value = auto.voltageMin || 170;
    if (document.activeElement !== document.getElementById('vMaxInput')) document.getElementById('vMaxInput').value = auto.voltageMax || 260;
    if (document.activeElement !== document.getElementById('dayStart')) document.getElementById('dayStart').value = auto.dayStart || '08:00';
    if (document.activeElement !== document.getElementById('dayEnd')) document.getElementById('dayEnd').value = auto.dayEnd || '18:00';
    if (document.activeElement !== document.getElementById('nightStart')) document.getElementById('nightStart').value = auto.nightStart || '22:00';
    if (document.activeElement !== document.getElementById('nightEnd')) document.getElementById('nightEnd').value = auto.nightEnd || '06:00';

    const curr = state.db.settings.currency;
    const rate = state.db.settings.baseRateBDT * (state.db.currentRates[curr] || 1);
    const sym = symbols[curr];

    const todayKwh = usage.daily[usage.daily.length - 1] || 0;
    const yesterdayKwh = usage.daily[usage.daily.length - 2] || 0;
    document.getElementById('todayUsage').innerText = (state.lang === 'bn' ? todayKwh.toLocaleString('bn-BD', { maximumFractionDigits: 2 }) : todayKwh.toFixed(2)) + ' kWh';

    const diffEl = document.getElementById('usageDiff');
    if (yesterdayKwh > 0) {
        const percent = ((todayKwh - yesterdayKwh) / yesterdayKwh) * 100;
        const pStr = state.lang === 'bn' ? percent.toLocaleString('bn-BD', { maximumFractionDigits: 0 }) : percent.toFixed(0);
        diffEl.innerText = percent > 0 ? `+${pStr}%` : `${pStr}%`;
        diffEl.className = percent > 0 ? 'text-xs sm:text-sm font-bold font-mono text-rose-500' : 'text-xs sm:text-sm font-bold font-mono text-emerald-500';
    } else { diffEl.innerText = ''; }

    const mKwh = usage.monthly[usage.monthly.length - 1] || 0;
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }));
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const currentDay = Math.max(1, now.getDate());
    const forecastCost = ((mKwh / currentDay) * daysInMonth) * rate;
    document.getElementById('monthForecast').innerText = `${sym}${state.lang === 'bn' ? forecastCost.toLocaleString('bn-BD', { maximumFractionDigits: 0 }) : forecastCost.toFixed(0)}`;

    const hourly = usage.hourly || [];
    let peakIdx = -1, peakVal = 0;
    hourly.forEach((v, i) => { if (v > peakVal) { peakVal = v; peakIdx = i; } });
    document.getElementById('peakHour').innerText = peakIdx === -1 ? '--' : `${peakIdx.toString().padStart(2, '0')}:00`;

    const budget = (state.db.settings.monthlyBudget || 500) * (state.db.currentRates[curr] || 1);
    document.getElementById('budgetDisplay').innerText = `${sym}${state.lang === 'bn' ? budget.toLocaleString('bn-BD', { maximumFractionDigits: 0 }) : budget.toFixed(0)}`;
    const pct = budget > 0 ? Math.min(100, Math.max(0, ((mKwh * rate) / budget) * 100)) : 0;
    document.getElementById('budgetPercent').innerText = `${state.lang === 'bn' ? pct.toLocaleString('bn-BD', { maximumFractionDigits: 1 }) : pct.toFixed(1)}%`;
    document.getElementById('budgetBar').style.width = `${pct}%`;
    document.getElementById('budgetBar').className = pct > 90 ? 'bg-gradient-to-r from-rose-500 to-red-600 h-full rounded-full transition-all duration-1000 shadow-md' : 'bg-gradient-to-r from-sky-400 to-blue-600 h-full rounded-full transition-all duration-1000 shadow-md';

    updateActivityRings(todayKwh, todayKwh * rate);

    const list = document.getElementById('scheduleList');
    list.innerHTML = '';
    (auto.schedules || []).forEach((s) => {
        const row = document.createElement('div');
        row.className = 'flex justify-between items-center bg-slate-100 dark:bg-slate-800 p-3 rounded-2xl text-xs mb-2';
        const label = document.createElement('span'); 
        label.className = 'font-mono font-bold flex items-center text-slate-800 dark:text-slate-200';
        label.textContent = s.time + ' ';
        const badge = document.createElement('span');
        badge.className = `ml-3 px-2 py-0.5 rounded-md text-[10px] font-black tracking-wider uppercase ${s.action ? 'text-emerald-600 bg-emerald-500/15' : 'text-rose-600 bg-rose-500/15'}`;
        badge.textContent = s.action ? t('ON') : t('OFF');
        label.appendChild(badge);
        const delBtn = document.createElement('button');
        delBtn.className = 'text-slate-400 hover:text-rose-500 font-bold transition px-2 py-1'; 
        delBtn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>';
        delBtn.onclick = () => removeSchedule(s.id);
        row.appendChild(label); 
        row.appendChild(delBtn);
        list.appendChild(row);
    });

    updateChart();
    renderDeviceGrid();
}

// ---------------------------------------------------------------------------
// Multi-Device Grid Synchronizer
// ---------------------------------------------------------------------------
async function fetchAllStatuses() {
    try {
        const res = await apiFetch('/api/status', { hideToast: true });
        if(!res) return;
        const data = await res.json();
        if (data.success) state.allStatuses = data.result;
        renderDeviceGrid();
    } catch (e) {}
}

function renderDeviceGrid() {
    const grid = document.getElementById('deviceGrid');
    if (!state.db || !grid) return;
    grid.innerHTML = '';
    state.db.devices.forEach((d) => {
        const status = (state.allStatuses && state.allStatuses[d.id]) || {};
        const isOn = !!status.isPowerOn, online = !!status.online;
        const isCurrent = d.id === state.activeId;
        
        const card = document.createElement('button');
        card.className = `p-3.5 sm:p-5 rounded-[20px] flex flex-col gap-1.5 text-left transition-all duration-300 border ${
            isCurrent 
                ? 'bg-sky-50 dark:bg-sky-500/10 border-sky-300 dark:border-sky-500/30 shadow-sm' 
                : 'bg-white dark:bg-white/5 border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'
        }`;
        card.onclick = () => { 
            state.activeId = d.id; 
            document.getElementById('deviceSelector').value = d.id; 
            switchDevice(); 
        };

        const topRow = document.createElement('div'); 
        topRow.className = 'flex items-center justify-between gap-2 w-full';
        
        const dot = document.createElement('span');
        dot.className = `w-2 h-2 rounded-full ${!online ? 'bg-slate-300 dark:bg-slate-600' : isOn ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-slate-400'}`;
        
        const name = document.createElement('span'); 
        name.className = `font-bold text-xs sm:text-sm truncate flex-1 ${isCurrent ? 'text-sky-700 dark:text-sky-400' : 'text-slate-800 dark:text-slate-200'}`; 
        name.textContent = d.name;
        
        topRow.appendChild(name);
        topRow.appendChild(dot);

        const bottomRow = document.createElement('div'); 
        bottomRow.className = 'text-[10px] font-bold font-mono tracking-wider uppercase text-slate-500 dark:text-slate-400';
        bottomRow.textContent = !online ? t('OFFLINE') : `${(status.power || 0).toFixed(1)} W`;

        card.appendChild(topRow); 
        card.appendChild(bottomRow);
        grid.appendChild(card);
    });
}

// ---------------------------------------------------------------------------
// Telemetry Audit Logger
// ---------------------------------------------------------------------------
const activityIcons = {
    voltage_guard: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path>',
    budget_kill: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>',
    standby_kill: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>',
    timer: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path>',
    device_added: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path>',
    device_removed: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>',
    device_renamed: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path>',
    manual_toggle: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 11.5V14m0-2.5v-6a1.5 1.5 0 113 0m-3 6a1.5 1.5 0 00-3 0v2a7.5 7.5 0 0015 0v-5a1.5 1.5 0 00-3 0m-6-3V11m0-5.5v-1a1.5 1.5 0 013 0v1m0 0V11m0-5.5a1.5 1.5 0 013 0v3m0 0V11"></path>',
    schedule: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path>',
    mode: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path>',
    history_cleared: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>',
    power_cycle: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>',
    default: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>',
};

function renderActivityLog() {
    const container = document.getElementById('activityLog');
    if (!container) return;
    const items = (state.db && state.db.activityLog) || [];
    if (items.length === 0) {
        container.innerHTML = `<p class="text-xs text-slate-500 dark:text-slate-400 font-medium py-3">${t('No recent activity yet.')}</p>`;
        return;
    }
    container.innerHTML = '';
    items.slice(0, 20).forEach((item) => {
        const row = document.createElement('div'); 
        row.className = 'flex items-center gap-3 py-3 text-xs';
        
        const icon = document.createElement('div'); 
        icon.className = 'w-9 h-9 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-sm shrink-0 border border-slate-200 dark:border-white/5 text-slate-600 dark:text-slate-400';
        icon.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">${activityIcons[item.type] || activityIcons.default}</svg>`;
        
        const content = document.createElement('div'); 
        content.className = 'flex-1 min-w-0';
        
        const line1 = document.createElement('p'); 
        line1.className = 'font-bold truncate text-slate-800 dark:text-slate-200 text-[13px]';
        line1.textContent = item.deviceName || item.deviceId;
        
        const line2 = document.createElement('p'); 
        line2.className = 'text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5';
        line2.textContent = item.message;
        
        const time = document.createElement('span'); 
        time.className = 'text-[9px] font-mono text-slate-400 dark:text-slate-500 shrink-0 font-bold uppercase tracking-widest';
        time.textContent = new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        content.appendChild(line1); 
        content.appendChild(line2);
        row.appendChild(icon); 
        row.appendChild(content);
        row.appendChild(time);
        container.appendChild(row);
    });
}

// ---------------------------------------------------------------------------
// Settings and Actions
// ---------------------------------------------------------------------------
async function saveSettings() {
    const baseRateBDT = parseFloat(document.getElementById('rateInput').value);
    const currency = document.getElementById('currencySelect').value;
    if (!Number.isFinite(baseRateBDT) || baseRateBDT < 0) { toast('Enter a valid rate', 'error'); return; }
    try {
        await apiFetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseRateBDT, currency }) });
        toast('Settings saved', 'success');
        await fetchDB(true);
    } catch (e) { actionError(e, 'Could not save settings'); }
}

async function saveLocation() {
    const loc = document.getElementById('locInput').value.trim();
    if (!loc) return;
    try {
        await apiFetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ weatherLocation: loc }) });
        toast('Location saved', 'success');
        await fetchDB(true);
        fetchWeather();
    } catch (e) { actionError(e, 'Could not save location'); }
}

async function promptBudget() {
    const b = prompt('Enter Monthly Budget (in BDT):', state.db.settings.monthlyBudget || 500);
    if (b && !isNaN(b) && parseFloat(b) > 0) {
        try {
            await apiFetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monthlyBudget: parseFloat(b) }) });
            await fetchDB();
        } catch (e) { actionError(e, 'Could not update budget'); }
    } else if (b !== null) { toast('Budget must be greater than 0', 'error'); }
}

async function setMode(mode) {
    if(!state.activeId) return;
    try { 
        if(mode !== 'manual') {
            await apiFetch(`/api/automations/${state.activeId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timer: { active: false, executeAt: 0, action: false } }) });
        }
        await apiFetch(`/api/automations/${state.activeId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) }); 
        toast('Profile updated', 'success');
        await fetchDB(true);
    } catch (e) { actionError(e, 'Could not change mode'); fetchDB(true); }
}

async function saveDayNightTimes() {
    const payload = {
        dayStart: document.getElementById('dayStart').value,
        dayEnd: document.getElementById('dayEnd').value,
        nightStart: document.getElementById('nightStart').value,
        nightEnd: document.getElementById('nightEnd').value
    };
    try {
        await apiFetch(`/api/automations/${state.activeId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        toast('Schedule saved', 'success');
        await fetchDB(true);
    } catch (e) { actionError(e, 'Could not save schedule'); }
}

async function toggleAutomation(key) {
    const elId = key === 'standbyKill' ? 'standbyToggle' : key === 'voltageProtect' ? 'voltageToggle' : key === 'budgetKill' ? 'budgetToggle' : 'outageToggle';
    const isChecked = document.getElementById(elId).checked;
    const payload = { [key]: isChecked };
    try { await apiFetch(`/api/automations/${state.activeId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
    catch (e) { document.getElementById(elId).checked = !isChecked; actionError(e, 'Could not update automation'); }
}

async function saveVoltageLimits() {
    const vMin = parseFloat(document.getElementById('vMinInput').value) || 170;
    const vMax = parseFloat(document.getElementById('vMaxInput').value) || 260;
    if (vMin >= vMax) { toast('Min must be lower than Max', 'error'); return; }
    try { await apiFetch(`/api/automations/${state.activeId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voltageMin: vMin, voltageMax: vMax }) }); toast('Voltage limits saved', 'success'); }
    catch (e) { actionError(e, 'Could not save voltage limits'); }
}

async function setTimer() {
    const m = parseInt(document.getElementById('timerMins').value, 10);
    const act = (document.getElementById('timerAction').value === 'true');
    if (isNaN(m) || m <= 0) { toast('Enter minutes greater than 0', 'error'); return; }
    try {
        await apiFetch(`/api/automations/${state.activeId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timer: { active: true, executeAt: Date.now() + (m * 60000), action: act } }) });
        await fetchDB();
    } catch (e) { actionError(e, 'Could not set timer'); }
}

function activateSleepMode() { 
    document.getElementById('timerMins').value = 180; 
    document.getElementById('timerAction').value = 'false'; 
    setTimer(); 
    setMode('manual'); 
}

async function addSchedule() {
    const timeVal = document.getElementById('schedTime').value;
    const act = document.getElementById('schedAction').value === 'true';
    if (!timeVal) return;
    const schedules = [...state.db.automations[state.activeId].schedules, { id: Date.now(), time: timeVal, action: act, enabled: true }];
    try { await apiFetch(`/api/automations/${state.activeId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedules }) }); await fetchDB(); }
    catch (e) { actionError(e, 'Could not add schedule'); }
}

async function removeSchedule(id) {
    const schedules = state.db.automations[state.activeId].schedules.filter((s) => s.id !== id);
    try { await apiFetch(`/api/automations/${state.activeId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ schedules }) }); await fetchDB(); }
    catch (e) { actionError(e, 'Could not remove schedule'); }
}

// ---------------------------------------------------------------------------
// Telemetry Status Poller
// ---------------------------------------------------------------------------
async function fetchStatus() {
    if (!state.activeId) return;
    try {
        const res = await apiFetch(`/api/status/${state.activeId}`, { hideToast: true });
        if(!res) return;
        const data = await res.json();
        markFetchSuccess();
        if (data.success && data.result) {
            const status = data.result; 
            updatePowerUI(status.isPowerOn, status.online);
            document.getElementById('val-volt').innerText = (state.lang === 'bn' ? status.voltage.toLocaleString('bn-BD', { maximumFractionDigits: 1 }) : status.voltage.toFixed(1)) + ' V';
            document.getElementById('val-power').innerText = (state.lang === 'bn' ? status.power.toLocaleString('bn-BD', { maximumFractionDigits: 1 }) : status.power.toFixed(1)) + ' W';

            const sampleAt = Number(status.sampledAt) || 0;
            if (status.online && sampleAt && state.lastSampleAtByDevice[state.activeId] !== sampleAt) {
                state.lastSampleAtByDevice[state.activeId] = sampleAt;
                const sampleDate = new Date(sampleAt);
                state.liveLabels.push(`${sampleDate.getHours()}:${sampleDate.getMinutes().toString().padStart(2, '0')}:${sampleDate.getSeconds().toString().padStart(2, '0')}`);
                state.livePower.push(status.power); 
                state.liveVoltage.push(status.voltage);
                if (state.liveLabels.length > 20) { 
                    state.liveLabels.shift(); 
                    state.livePower.shift(); 
                    state.liveVoltage.shift(); 
                }

                if (!document.getElementById('tab-analytics').classList.contains('hidden') && document.getElementById('chartTimeframe').value === 'realtime') updateChart();
            }
        }
    } catch (e) { markFetchFailure(); }
}

async function togglePower() {
    if (!state.activeId) return;
    const btn = document.getElementById('powerBtn');
    const newState = !state.isPowerOn;
    btn.disabled = true;
    updatePowerUI(newState, true);
    setMode('manual');

    try {
        await apiFetch(`/api/toggle/${state.activeId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: newState }) });
        setTimeout(fetchDB, 500);
    } catch (err) { 
        updatePowerUI(!newState, true); 
        actionError(err, 'Power command failed'); 
    } finally { 
        setTimeout(() => { btn.disabled = false; }, 800); 
    }
}

function updatePowerUI(isOn, isOnline = true) {
    state.isPowerOn = isOn;
    const btn = document.getElementById('powerBtn'); 
    const txt = document.getElementById('powerText'); 
    const badge = document.getElementById('statusBadge');
    const dot = document.getElementById('statusDot');
    const aura = document.getElementById('powerAura');

    if (!isOnline) {
        btn.className = 'power-btn bg-slate-200 dark:bg-slate-800 cursor-not-allowed border-4 border-white dark:border-slate-700 text-slate-400 dark:text-slate-600'; 
        txt.innerText = t('OFFLINE'); 
        txt.className = 'text-4xl sm:text-5xl font-black mt-3 tracking-tight font-mono text-slate-400 dark:text-slate-600';
        badge.innerText = t('OFFLINE'); 
        dot.className = 'w-2.5 h-2.5 rounded-full bg-slate-400';
        aura.className = 'power-aura';
        return;
    }
    if (isOn) {
        btn.className = 'power-btn power-on'; 
        txt.innerText = t('ON'); 
        txt.className = 'text-4xl sm:text-5xl font-black mt-3 tracking-tight font-mono text-emerald-500';
        badge.innerText = t('ONLINE'); 
        dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]';
        aura.className = 'power-aura power-aura-active';
    } else {
        btn.className = 'power-btn power-off'; 
        txt.innerText = t('OFF'); 
        txt.className = 'text-4xl sm:text-5xl font-black mt-3 tracking-tight font-mono text-rose-500';
        badge.innerText = t('STANDBY'); 
        dot.className = 'w-2.5 h-2.5 rounded-full bg-rose-500';
        document.getElementById('val-power').innerText = state.lang === 'bn' ? '০.০ W' : '0.0 W';
        aura.className = 'power-aura';
    }
    
    const usage = state.db?.usage[state.activeId];
    if (usage) {
        const todayKwh = usage.daily[usage.daily.length - 1] || 0;
        const curr = state.db.settings.currency;
        const rate = state.db.settings.baseRateBDT * (state.db.currentRates[curr] || 1);
        updateActivityRings(todayKwh, todayKwh * rate);
    }
}

// ---------------------------------------------------------------------------
// Chart.js Graphing Engine
// ---------------------------------------------------------------------------
function getDynamicLabels(type) {
    const now = new Date();
    const labels = [];
    const loc = state.lang === 'bn' ? 'bn-BD' : 'en-US';
    if (type === 'daily') {
        for (let i = 6; i >= 0; i--) {
            const d = new Date(now); d.setDate(d.getDate() - i);
            labels.push(i === 0 ? (state.lang === 'bn' ? 'আজ' : 'Today') : d.toLocaleDateString(loc, { month: 'short', day: 'numeric' }));
        }
    } else if (type === 'monthly') {
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            labels.push(d.toLocaleDateString(loc, { month: 'short', year: '2-digit' }));
        }
    }
    return labels;
}

function handleMetricOptions() {
    const tf = document.getElementById('chartTimeframe').value;
    const selector = document.getElementById('chartDataType');
    const energy = document.getElementById('opt-energy');
    const cost = document.getElementById('opt-cost');
    const power = document.getElementById('opt-power');
    const voltage = document.getElementById('opt-voltage');

    const realtime = tf === 'realtime';
    energy.disabled = realtime;
    cost.disabled = realtime;
    power.disabled = !realtime;
    voltage.disabled = !realtime;

    if (realtime && (selector.value === 'energy' || selector.value === 'cost')) selector.value = 'power';
    if (!realtime && (selector.value === 'power' || selector.value === 'voltage')) selector.value = 'energy';
}

function updateChart() {
    if (typeof Chart === 'undefined') return; 
    if (!state.activeId || !state.db.usage[state.activeId] || document.getElementById('tab-analytics').classList.contains('hidden')) return;
    const tf = document.getElementById('chartTimeframe').value;
    const dt = document.getElementById('chartDataType').value;
    const style = document.getElementById('chartStyle').value;
    const ctx = document.getElementById('usageChart').getContext('2d');

    const isDark = document.documentElement.classList.contains('dark');
    const textColor = isDark ? '#94a3b8' : '#64748b';
    const curr = state.db.settings.currency;
    const rate = state.db.settings.baseRateBDT * (state.db.currentRates[curr] || 1);

    let labels = [], data = [], label = '', color = '';

    if (tf === 'realtime') {
        labels = state.liveLabels;
        if (dt === 'voltage') { data = state.liveVoltage; label = t('Voltage (V)'); color = '#0ea5e9'; }
        else if (dt === 'power') { data = state.livePower; label = t('Power (W)'); color = '#f97316'; }
        else if (dt === 'energy') { 
            let acc = 0; 
            data = state.livePower.map(p => { acc += (p/1000)*(3/3600); return acc; }); 
            label = t('Energy (kWh)'); color = '#10b981';
        }
        else if (dt === 'cost') {
            let acc = 0; 
            data = state.livePower.map(p => { acc += (p/1000)*(3/3600)*rate; return acc; });
            label = t('Cost'); color = '#8b5cf6';
        }
    } else {
        let baseData = state.db.usage[state.activeId][tf] || [];
        const hoursInPeriod = tf === 'hourly' ? 1 : tf === 'daily' ? 24 : tf === 'weekly' ? 168 : 720;
        
        if (dt === 'cost') { data = baseData.map((v) => v * rate); label = t('Cost'); color = '#8b5cf6'; }
        else if (dt === 'energy') { data = baseData; label = t('Energy'); color = '#10b981'; }
        else if (dt === 'power') { data = baseData.map((v) => (v * 1000) / hoursInPeriod); label = t('Avg Power (W)'); color = '#f97316'; }
        else if (dt === 'voltage') { 
            data = baseData.map(v => v > 0 ? 220 + (v % 10) : 0); 
            label = t('Avg Voltage (V)'); color = '#0ea5e9'; 
        }

        if (tf === 'hourly') {
            const m = state.lang === 'bn' ? ['১২', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯', '১০', '১১'] : ['12', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'];
            const am = state.lang === 'bn' ? 'এএম' : 'AM'; const pm = state.lang === 'bn' ? 'পিএম' : 'PM';
            labels = [...m.map((x) => x + am), ...m.map((x) => x + pm)];
        }
        if (tf === 'daily') labels = getDynamicLabels('daily');
        if (tf === 'weekly') labels = state.lang === 'bn' ? ['৩ সপ্তাহ আগে', '২ সপ্তাহ আগে', 'গত সপ্তাহ', 'এই সপ্তাহ'] : ['3 Wks Ago', '2 Wks Ago', 'Last Wk', 'This Wk'];
        if (tf === 'monthly') labels = getDynamicLabels('monthly');
    }

    if (state.chart) state.chart.destroy();
    
    let gradientFill = `${color}20`;
    try {
        const grad = ctx.createLinearGradient(0, 0, 0, 240);
        grad.addColorStop(0, `${color}40`);
        grad.addColorStop(1, `${color}00`);
        gradientFill = grad;
    } catch(e) {}

    state.chart = new Chart(ctx, {
        type: style,
        data: { 
            labels, 
            datasets: [{ 
                label, 
                data, 
                backgroundColor: style === 'line' ? gradientFill : color, 
                borderColor: color, 
                borderWidth: style === 'line' ? 3 : 0, 
                fill: style === 'line', 
                tension: 0.38, 
                borderRadius: style === 'bar' ? 10 : 0, 
                pointRadius: style === 'line' ? 3 : 0,
                pointHoverRadius: 6,
            }] 
        },
        options: {
            responsive: true, 
            maintainAspectRatio: false, 
            animation: { duration: tf === 'realtime' ? 0 : 450 },
            plugins: { 
                legend: { display: false }, 
                tooltip: { 
                    backgroundColor: isDark ? 'rgba(15, 23, 42, 0.9)' : 'rgba(255, 255, 255, 0.95)', 
                    titleColor: isDark ? '#f8fafc' : '#0f172a', 
                    bodyColor: isDark ? '#f8fafc' : '#0f172a', 
                    padding: 12, 
                    cornerRadius: 16, 
                    displayColors: false,
                    borderWidth: 1,
                    borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)',
                    titleFont: { family: 'Plus Jakarta Sans', weight: 'bold' },
                    bodyFont: { family: 'JetBrains Mono', weight: 'bold' }
                } 
            },
            scales: { 
                y: { 
                    grid: { color: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)' }, 
                    ticks: { color: textColor, font: { family: 'JetBrains Mono', size: 10, weight: 'bold' } }, 
                    beginAtZero: dt !== 'voltage' 
                }, 
                x: { 
                    grid: { display: false }, 
                    ticks: { color: textColor, font: { family: 'Plus Jakarta Sans', size: 10, weight: 'bold' } } 
                } 
            },
        },
    });
}

// ---------------------------------------------------------------------------
// PWA Installation & Service Worker Registry
// ---------------------------------------------------------------------------
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    const btn = document.getElementById('installBtn');
    btn.classList.remove('hidden');
    btn.classList.add('flex');
});

async function triggerInstall() {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    document.getElementById('installBtn').classList.add('hidden');
}

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// ---------------------------------------------------------------------------
// Boot Pipeline
// ---------------------------------------------------------------------------
async function boot() {
    try {
        switchTab('tab-overview'); // Enforce pristine active state on startup
        await fetchDB();
        fetchStatus();
        fetchWeather();
        fetchAllStatuses();
    } catch (e) {}
}

boot();
setInterval(() => fetchStatus(), 3000);
setInterval(() => fetchDB(true).catch(() => {}), 30 * 1000);
setInterval(() => fetchWeather(), 30 * 60000);
setInterval(() => fetchAllStatuses(), 8000);
