// =============================================================================
// Smart Hub front-end application logic
// =============================================================================
const symbols = { BDT: '৳', USD: '$', EUR: '€', CNY: '¥' };
let state = {
    db: null, activeId: null, isPowerOn: false,
    livePower: [], liveVoltage: [], liveLabels: [], chart: null, lang: 'en',
    builtDeviceIds: null, // tracks which device IDs/names the <select> was last built from
    consecutiveFailures: 0, bootLoaded: false, deferredInstallPrompt: null,
    allStatuses: {}, lastSampleAtByDevice: {}, timerExpiryRefreshAt: 0,
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
function toast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, 3200);
}

function actionError(error, fallback = 'Something went wrong') {
    toast(error?.message || fallback, 'error');
}

// ---------------------------------------------------------------------------
// API fetch wrapper
// ---------------------------------------------------------------------------
async function apiFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };

    const { timeoutMs = 12000, ...fetchOptions } = options;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...fetchOptions, headers, signal: controller.signal });
        if (!res.ok) {
            let message = `Request failed (${res.status})`;
            try {
                const payload = await res.clone().json();
                if (payload?.error) message = payload.error;
            } catch (e) {
                try {
                    const text = await res.clone().text();
                    if (text) message = text.slice(0, 180);
                } catch (_) {}
            }
            throw new Error(message);
        }
        return res;
    } catch (error) {
        if (error?.name === 'AbortError') throw new Error('Request timed out');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------
const dict = {
    bn: {
        'Overview': 'ওভারভিউ', 'Analytics': 'অ্যানালিটিক্স', 'Automation': 'অটোমেশন', 'Settings': 'সেটিংস',
        'CONNECTING': 'সংযোগ হচ্ছে', 'ONLINE': 'অনলাইন', 'OFFLINE': 'অফলাইন', 'STANDBY': 'স্ট্যান্ডবাই',
        'ON': 'চালু', 'OFF': 'বন্ধ', 'VOLTAGE': 'ভোল্টেজ', 'WATTAGE': 'ওয়াটেজ',
        'Master ON': 'মাস্টার চালু', 'Master OFF': 'মাস্টার বন্ধ', 'All Devices': 'সকল ডিভাইস',
        'Insights': 'বিশ্লেষণ', 'TODAY vs YESTERDAY': 'আজ বনাম গতকাল', 'MONTHLY FORECAST': 'মাসিক পূর্বাভাস',
        'PEAK HOUR TODAY': 'আজকের পিক ঘণ্টা',
        'BUDGET PROGRESS:': 'বাজেট অগ্রগতি:', 'Live': 'লাইভ', 'Today (Hourly)': 'আজ (ঘণ্টা)',
        '7 Days': '৭ দিন', '4 Weeks': '৪ সপ্তাহ', '6 Months': '৬ মাস',
        'Energy': 'এনার্জি', 'Cost': 'খরচ', 'Power (W)': 'পাওয়ার (W)', 'Voltage (V)': 'ভোল্টেজ (V)', 'Bar': 'বার', 'Line': 'লাইন',
        'Operating Mode': 'অপারেটিং মোড', 'Manual': 'ম্যানুয়াল', 'Day': '☀️ দিন', 'Night': '🌙 রাত', 'Sleep (3h)': '💤 স্লিপ (৩ ঘঃ)',
        'Standby Auto-Kill': 'অটো-কিল', 'Stops power if <5W for 10m': '<৫ ওয়াট হলে ১০ মিনিটে বন্ধ', 'Timer': 'টাইমার',
        'Voltage Guard': 'ভোল্টেজ গার্ড', 'Auto-kill on dangerous voltage': 'বিপজ্জনক ভোল্টেজে অটো-কিল',
        'MIN (V)': 'সর্বনিম্ন (V)', 'MAX (V)': 'সর্বোচ্চ (V)',
        'Strict Budget Lock': 'কঠোর বাজেট লক', 'Auto-kill if budget hits 100%': 'বাজেট ১০০% ছুঁলে এসি বন্ধ',
        'Tariff & Preferences': 'ট্যারিফ এবং পছন্দসমূহ', 'RATE': 'রেট', 'CURRENCY': 'মুদ্রা', 'WEATHER LOCATION': 'আবহাওয়ার অবস্থান',
        'Save': 'সংরক্ষণ', 'Set Budget': 'বাজেট সেট করুন', 'Export CSV': '📥 এক্সপোর্ট CSV',
        'System Management': 'সিস্টেম ম্যানেজমেন্ট', 'Add Device': 'ডিভাইস যোগ করুন', 'Remove Device': 'ডিভাইস মুছুন', 'Rename': 'নাম পরিবর্তন',
        'Reboot': '🔌 রিবুট', 'Clear History DB': 'হিস্ট্রি মুছুন',
        'Recent Activity': 'সাম্প্রতিক কার্যকলাপ', 'No recent activity yet.': 'কোনো কার্যকলাপ নেই।',
        'Connection': 'সংযোগ',
        'This access key is stored only in this browser and sent with every request.': 'এই অ্যাক্সেস কী শুধু এই ব্রাউজারে সংরক্ষিত থাকে।',
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
    document.getElementById('langBtn').innerText = state.lang === 'en' ? 'BN' : 'EN';
    const badgeText = document.getElementById('statusBadge').innerText;
    updatePowerUI(state.isPowerOn, badgeText !== 'OFFLINE' && badgeText !== 'অফলাইন');
    if (!document.getElementById('tab-analytics').classList.contains('hidden')) updateChart();
    renderActivityLog();
}

async function toggleLang() {
    state.lang = state.lang === 'en' ? 'bn' : 'en';
    applyTranslations();
    if (state.db) {
        try { await apiFetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: state.lang }) }); }
        catch (e) { /* non-critical here */ }
    }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
}
function toggleTheme() {
    document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    updateChart();
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach((el) => el.classList.add('hidden'));
    document.querySelectorAll('.tab-btn').forEach((el) => el.classList.remove('bg-black/10', 'dark:bg-white/10'));
    document.getElementById(tabId).classList.remove('hidden');
    document.getElementById('btn-' + tabId).classList.add('bg-black/10', 'dark:bg-white/10');
    if (tabId === 'tab-analytics') updateChart();
}

// ---------------------------------------------------------------------------
// Clock + timer ticker
// ---------------------------------------------------------------------------
setInterval(() => {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }));
    document.getElementById('clockTime').innerText = now.toLocaleTimeString(state.lang === 'bn' ? 'bn-BD' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    document.getElementById('clockDate').innerText = now.toLocaleDateString(state.lang === 'bn' ? 'bn-BD' : 'en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });

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
    } else document.getElementById('timerText').classList.add('hidden');
}, 1000);

// ---------------------------------------------------------------------------
// Weather (direct, public, unauthenticated open-meteo APIs)
// ---------------------------------------------------------------------------
async function fetchWeather() {
    try {
        const loc = state.db?.settings?.weatherLocation || 'Dhaka';
        const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(loc)}&count=1&language=en&format=json`);
        const geoData = await geoRes.json();
        if (!geoData.results || geoData.results.length === 0) return;

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
    } catch (e) { /* weather is a non-critical enhancement */ }
}

// ---------------------------------------------------------------------------
// Connection health (offline banner)
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
// Core data fetch
// ---------------------------------------------------------------------------
async function fetchDB(silent = false) {
    try {
        const res = await apiFetch('/api/data');
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
                opt.value = d.id; opt.textContent = d.name; // textContent = safe from injection
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
        markFetchFailure();
        if (!silent) toast(state.lang === 'bn' ? 'সার্ভারের সাথে সংযোগ ব্যর্থ' : 'Could not reach the server', 'error');
        throw e;
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
    document.getElementById('voltage').innerText = '--';
    document.getElementById('power').innerText = '--';
    renderDeviceGrid();
}

function hideBootSkeleton() {
    if (state.bootLoaded) return;
    state.bootLoaded = true;
    const el = document.getElementById('bootSkeleton');
    el.style.opacity = '0'; el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 300);
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
    if (!confirm('Cycle power?')) return;
    try { toast('Cycling power...', 'info'); await apiFetch(`/api/cycle/${state.activeId}`, { method: 'POST', timeoutMs: 20000 }); await fetchStatus(); }
    catch (e) { actionError(e, 'Could not cycle power'); }
}
async function masterToggle(isOn) {
    if (!confirm(`Turn ${isOn ? 'ON' : 'OFF'} all devices?`)) return;
    try {
        const res = await apiFetch('/api/toggle-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: isOn }), timeoutMs: 30000 });
        const data = await res.json();
        if (!data.success) toast('Some devices did not accept the master command', 'error');
        fetchStatus(); fetchAllStatuses();
    } catch (e) { actionError(e, 'Master command failed'); }
}

// ---------------------------------------------------------------------------
// Rendering: device controls / stats
// ---------------------------------------------------------------------------
function renderDeviceUI() {
    if (!state.activeId || !state.db) return;
    const auto = state.db.automations[state.activeId];
    const usage = state.db.usage[state.activeId];
    if (!auto || !usage) return;

    document.querySelectorAll('#mode-manual, #mode-day, #mode-night').forEach((b) => b.classList.remove('mode-active'));
    const modeBtn = document.getElementById(`mode-${auto.mode}`);
    if (modeBtn) modeBtn.classList.add('mode-active');

    if (document.getElementById('standbyToggle').checked !== (auto.standbyKill || false)) document.getElementById('standbyToggle').checked = auto.standbyKill || false;
    if (document.getElementById('voltageToggle').checked !== (auto.voltageProtect || false)) document.getElementById('voltageToggle').checked = auto.voltageProtect || false;
    if (document.getElementById('budgetToggle').checked !== (auto.budgetKill || false)) document.getElementById('budgetToggle').checked = auto.budgetKill || false;

    if (document.activeElement !== document.getElementById('vMinInput')) document.getElementById('vMinInput').value = auto.voltageMin || 170;
    if (document.activeElement !== document.getElementById('vMaxInput')) document.getElementById('vMaxInput').value = auto.voltageMax || 260;

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
        diffEl.className = percent > 0 ? 'text-sm font-bold mb-1 text-red-500' : 'text-sm font-bold mb-1 text-green-500';
    } else { diffEl.innerText = ''; }

    const mKwh = usage.monthly[usage.monthly.length - 1] || 0;
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }));
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const currentDay = Math.max(1, now.getDate());
    const forecastCost = ((mKwh / currentDay) * daysInMonth) * rate;
    document.getElementById('monthForecast').innerText = `${sym}${state.lang === 'bn' ? forecastCost.toLocaleString('bn-BD', { maximumFractionDigits: 0 }) : forecastCost.toFixed(0)}`;

    // Peak hour today
    const hourly = usage.hourly || [];
    let peakIdx = -1, peakVal = 0;
    hourly.forEach((v, i) => { if (v > peakVal) { peakVal = v; peakIdx = i; } });
    document.getElementById('peakHour').innerText = peakIdx === -1 ? '--' : `${peakIdx.toString().padStart(2, '0')}:00`;

    const budget = (state.db.settings.monthlyBudget || 500) * (state.db.currentRates[curr] || 1);
    document.getElementById('budgetDisplay').innerText = `${sym}${state.lang === 'bn' ? budget.toLocaleString('bn-BD', { maximumFractionDigits: 0 }) : budget.toFixed(0)}`;
    const pct = budget > 0 ? Math.min(100, Math.max(0, ((mKwh * rate) / budget) * 100)) : 0;
    document.getElementById('budgetPercent').innerText = `${state.lang === 'bn' ? pct.toLocaleString('bn-BD', { maximumFractionDigits: 1 }) : pct.toFixed(1)}%`;
    document.getElementById('budgetBar').style.width = `${pct}%`;
    document.getElementById('budgetBar').className = pct > 90 ? 'bg-red-500 h-3 rounded-full transition-all duration-1000' : 'bg-blue-500 h-3 rounded-full transition-all duration-1000';

    // Schedule list (built via DOM APIs, not string interpolation, so device/schedule data can't inject markup)
    const list = document.getElementById('scheduleList');
    list.innerHTML = '';
    (auto.schedules || []).forEach((s) => {
        const row = document.createElement('div');
        row.className = 'flex justify-between items-center bg-black/5 dark:bg-white/5 p-3 rounded-xl text-sm mb-2';
        const label = document.createElement('span'); label.className = 'font-mono font-bold';
        label.textContent = s.time + ' ';
        const badge = document.createElement('span');
        badge.className = `ml-3 px-2 py-1 rounded-lg text-xs font-black ${s.action ? 'text-green-500 bg-green-500/10' : 'text-red-500 bg-red-500/10'}`;
        badge.textContent = s.action ? t('ON') : t('OFF');
        label.appendChild(badge);
        const delBtn = document.createElement('button');
        delBtn.className = 'text-gray-400 hover:text-red-500 font-bold transition'; delBtn.textContent = '✕';
        delBtn.onclick = () => removeSchedule(s.id);
        row.appendChild(label); row.appendChild(delBtn);
        list.appendChild(row);
    });

    handleMetricOptions();
    updateChart();
    renderDeviceGrid();
}

// ---------------------------------------------------------------------------
// New: All-devices overview grid
// ---------------------------------------------------------------------------
async function fetchAllStatuses() {
    try {
        const res = await apiFetch('/api/status');
        const data = await res.json();
        if (data.success) state.allStatuses = data.result;
        renderDeviceGrid();
    } catch (e) { /* non-critical; grid just stays stale until next success */ }
}

function renderDeviceGrid() {
    const grid = document.getElementById('deviceGrid');
    if (!state.db || !grid) return;
    grid.innerHTML = '';
    state.db.devices.forEach((d) => {
        const status = (state.allStatuses && state.allStatuses[d.id]) || {};
        const isOn = !!status.isPowerOn, online = !!status.online;
        const card = document.createElement('button');
        card.className = `device-chip bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 ${d.id === state.activeId ? 'active-device' : ''}`;
        card.onclick = () => { state.activeId = d.id; document.getElementById('deviceSelector').value = d.id; switchDevice(); };

        const topRow = document.createElement('div'); topRow.className = 'flex items-center justify-between gap-2';
        const dot = document.createElement('span');
        dot.className = `status-dot ${!online ? 'bg-gray-400' : isOn ? 'bg-green-500' : 'bg-gray-400'}`;
        const name = document.createElement('span'); name.className = 'font-bold text-sm truncate'; name.textContent = d.name;
        topRow.appendChild(dot); topRow.appendChild(name);

        const bottomRow = document.createElement('div'); bottomRow.className = 'apple-sub text-xs font-semibold';
        bottomRow.textContent = !online ? t('OFFLINE') : `${(status.power || 0).toFixed(1)} W`;

        card.appendChild(topRow); card.appendChild(bottomRow);
        grid.appendChild(card);
    });
}

// ---------------------------------------------------------------------------
// New: Activity log
// ---------------------------------------------------------------------------
const activityIcons = {
    voltage_guard: '⚡', budget_kill: '💰', standby_kill: '💤', timer: '⏱️',
    device_added: '➕', device_removed: '➖', device_renamed: '✏️', manual_toggle: '⏻',
    schedule: '🗓️', mode: '🌓', history_cleared: '🧹', power_cycle: '🔌', default: '📋',
};
function renderActivityLog() {
    const container = document.getElementById('activityLog');
    if (!container) return;
    const items = (state.db && state.db.activityLog) || [];
    if (items.length === 0) {
        container.innerHTML = `<p class="apple-sub text-sm">${t('No recent activity yet.')}</p>`;
        return;
    }
    container.innerHTML = '';
    items.slice(0, 20).forEach((item) => {
        const row = document.createElement('div'); row.className = 'activity-row';
        const icon = document.createElement('div'); icon.className = 'activity-icon bg-black/5 dark:bg-white/10';
        icon.textContent = activityIcons[item.type] || activityIcons.default;
        const text = document.createElement('div'); text.className = 'flex-1';
        const line1 = document.createElement('p'); line1.className = 'font-bold';
        line1.textContent = item.deviceName || item.deviceId;
        const line2 = document.createElement('p'); line2.className = 'apple-sub';
        line2.textContent = item.message;
        const time = document.createElement('p'); time.className = 'apple-sub text-[0.7rem] mt-0.5';
        time.textContent = new Date(item.ts).toLocaleString(state.lang === 'bn' ? 'bn-BD' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        text.appendChild(line1); text.appendChild(line2); text.appendChild(time);
        row.appendChild(icon); row.appendChild(text);
        container.appendChild(row);
    });
}

// ---------------------------------------------------------------------------
// Settings / automation actions
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
    try { await apiFetch(`/api/automations/${state.activeId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) }); await fetchDB(); }
    catch (e) { actionError(e, 'Could not change mode'); }
}

async function toggleAutomation(key) {
    const elId = key === 'standbyKill' ? 'standbyToggle' : key === 'voltageProtect' ? 'voltageToggle' : 'budgetToggle';
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
function activateSleepMode() { document.getElementById('timerMins').value = 180; document.getElementById('timerAction').value = 'false'; setTimer(); }

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
// Live status polling
// ---------------------------------------------------------------------------
async function fetchStatus() {
    if (!state.activeId) return;
    try {
        const res = await apiFetch(`/api/status/${state.activeId}`);
        const data = await res.json();
        markFetchSuccess();
        if (data.success && data.result) {
            const status = data.result; updatePowerUI(status.isPowerOn, status.online);
            document.getElementById('voltage').innerText = (state.lang === 'bn' ? status.voltage.toLocaleString('bn-BD', { maximumFractionDigits: 1 }) : status.voltage.toFixed(1)) + ' V';
            document.getElementById('power').innerText = (state.lang === 'bn' ? status.power.toLocaleString('bn-BD', { maximumFractionDigits: 1 }) : status.power.toFixed(1)) + ' W';

            const sampleAt = Number(status.sampledAt) || 0;
            if (status.online && sampleAt && state.lastSampleAtByDevice[state.activeId] !== sampleAt) {
                state.lastSampleAtByDevice[state.activeId] = sampleAt;
                const sampleDate = new Date(sampleAt);
                state.liveLabels.push(`${sampleDate.getHours()}:${sampleDate.getMinutes().toString().padStart(2, '0')}:${sampleDate.getSeconds().toString().padStart(2, '0')}`);
                state.livePower.push(status.power); state.liveVoltage.push(status.voltage);
                if (state.liveLabels.length > 20) { state.liveLabels.shift(); state.livePower.shift(); state.liveVoltage.shift(); }

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
    try {
        await apiFetch(`/api/toggle/${state.activeId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: newState }) });
        setTimeout(fetchDB, 500);
    } catch (err) { updatePowerUI(!newState, true); actionError(err, 'Power command failed'); }
    finally { setTimeout(() => { btn.disabled = false; }, 800); }
}

function updatePowerUI(isOn, isOnline = true) {
    state.isPowerOn = isOn;
    const btn = document.getElementById('powerBtn'); const txt = document.getElementById('powerText'); const badge = document.getElementById('statusBadge');
    if (!isOnline) {
        btn.className = 'power-btn bg-gray-600 cursor-not-allowed'; txt.innerText = t('OFFLINE'); txt.className = 'text-4xl font-black mt-8 text-gray-500 tracking-widest';
        badge.innerText = t('OFFLINE'); badge.className = 'mb-8 px-4 py-1.5 rounded-full bg-red-500/20 text-red-500 text-xs font-extrabold tracking-widest';
        return;
    }
    if (isOn) {
        btn.className = 'power-btn power-on'; txt.innerText = t('ON'); txt.className = 'text-4xl font-black mt-8 text-green-500 tracking-widest transition-colors';
        badge.innerText = t('ONLINE'); badge.className = 'mb-8 px-4 py-1.5 rounded-full bg-green-500/20 text-green-500 text-xs font-extrabold tracking-widest transition-colors';
    } else {
        btn.className = 'power-btn power-off'; txt.innerText = t('OFF'); txt.className = 'text-4xl font-black mt-8 text-red-500 tracking-widest transition-colors';
        badge.innerText = t('STANDBY'); badge.className = 'mb-8 px-4 py-1.5 rounded-full bg-gray-500/20 text-gray-500 text-xs font-extrabold tracking-widest transition-colors';
        document.getElementById('power').innerText = state.lang === 'bn' ? '০.০ W' : '0.0 W';
    }
}

// ---------------------------------------------------------------------------
// Charting
// ---------------------------------------------------------------------------
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

function updateChart() {
    if (!state.activeId || !state.db.usage[state.activeId] || document.getElementById('tab-analytics').classList.contains('hidden')) return;
    const tf = document.getElementById('chartTimeframe').value;
    const dt = document.getElementById('chartDataType').value;
    const style = document.getElementById('chartStyle').value;
    const ctx = document.getElementById('usageChart').getContext('2d');

    const isDark = document.documentElement.classList.contains('dark');
    const textColor = isDark ? '#98989d' : '#8e8e93';
    const curr = state.db.settings.currency;
    const rate = state.db.settings.baseRateBDT * (state.db.currentRates[curr] || 1);

    let labels = [], data = [], label = '', color = '';

    if (tf === 'realtime') {
        labels = state.liveLabels;
        if (dt === 'voltage') { data = state.liveVoltage; label = t('Voltage (V)'); color = '#32ade6'; }
        else { data = state.livePower; label = t('Power (W)'); color = '#ff9500'; }
    } else {
        let baseData = state.db.usage[state.activeId][tf] || [];
        if (dt === 'cost') { data = baseData.map((v) => v * rate); label = t('Cost'); color = '#af52de'; }
        else { data = baseData; label = t('Energy'); color = '#34c759'; }

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
    state.chart = new Chart(ctx, {
        type: style,
        data: { labels, datasets: [{ label, data, backgroundColor: style === 'line' ? `${color}22` : color, borderColor: color, borderWidth: 3, fill: style === 'line', tension: 0.4, borderRadius: style === 'bar' ? 8 : 0, pointRadius: style === 'line' ? 4 : 0 }] },
        options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: tf === 'realtime' ? 0 : 500 },
            plugins: { legend: { display: false }, tooltip: { backgroundColor: isDark ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.9)', titleColor: isDark ? 'white' : 'black', bodyColor: isDark ? 'white' : 'black', padding: 12, cornerRadius: 12, displayColors: false } },
            scales: { y: { grid: { color: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }, ticks: { color: textColor, font: { weight: 'bold' } }, beginAtZero: dt !== 'voltage' }, x: { grid: { display: false }, ticks: { color: textColor, font: { weight: 'bold' } } } },
        },
    });
}

// ---------------------------------------------------------------------------
// PWA install prompt + service worker
// ---------------------------------------------------------------------------
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    document.getElementById('installBtn').classList.remove('hidden');
    document.getElementById('installBtn').classList.add('flex');
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
// Boot
// ---------------------------------------------------------------------------
async function boot() {
    try {
        await fetchDB();
        fetchStatus();
        fetchWeather();
        fetchAllStatuses();
    } catch (e) {
        actionError(e, 'Could not start Smart Hub');
    }
}
boot();
setInterval(() => fetchStatus(), 3000);
setInterval(() => fetchDB(true).catch(() => {}), 30 * 1000);
setInterval(() => fetchWeather(), 30 * 60000);
setInterval(() => fetchAllStatuses(), 8000);
