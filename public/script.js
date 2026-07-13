// ==========================================
// script.js - واجهة منصة المراسلة (كاملة)
// ==========================================

// ===== متغيرات عامة =====
let contacts = [];
let apiConfigured = false;

// ===== بدء التشغيل =====
document.addEventListener('DOMContentLoaded', () => {
    checkStatus();
    // تحقق كل 30 ثانية
    setInterval(checkStatus, 30000);
});

// ===== تسجيل الدخول =====
async function login() {
    const btn = document.getElementById('loginBtn');
    const cookies = document.getElementById('cookiesInput').value.trim();
    const msg = document.getElementById('loginMessage');
    
    if (!cookies) {
        showMessage(msg, 'error', '❌ الرجاء لصق الكوكيز أولاً');
        return;
    }
    
    if (!cookies.includes('=') || !cookies.includes(';')) {
        showMessage(msg, 'error', '❌ صيغة الكوكيز غير صالحة. تأكد من نسخ document.cookie كاملاً');
        return;
    }
    
    btn.disabled = true;
    btn.innerHTML = '<span>⏳</span> جاري تسجيل الدخول...';
    msg.className = 'message-box';
    msg.style.display = 'none';
    
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookies })
        });
        
        const data = await res.json();
        
        if (data.success) {
            showMessage(msg, 'success', `✅ تم تسجيل الدخول بنجاح (${data.data.cookiesCount} كوكيز)`);
            addLog('success', `✅ تم تسجيل الدخول (${data.data.cookiesCount} كوكيز)`);
            
            // تحديث الحالة
            document.getElementById('statusDot').className = 'dot green';
            document.getElementById('statusText').textContent = 'متصل';
            
            // الانتقال للشاشة التالية
            setTimeout(() => {
                switchScreen('contactsScreen');
                fetchContacts();
            }, 1000);
        } else {
            showMessage(msg, 'error', `❌ ${data.error || 'فشل تسجيل الدخول'}`);
            addLog('error', `❌ ${data.error || 'فشل تسجيل الدخول'}`);
        }
    } catch (err) {
        showMessage(msg, 'error', `❌ خطأ في الاتصال: ${err.message}`);
        addLog('error', `❌ خطأ: ${err.message}`);
    }
    
    btn.disabled = false;
    btn.innerHTML = '<span>🔑</span> تسجيل الدخول';
}

// ===== جلب المراسلين =====
async function fetchContacts() {
    const btn = document.getElementById('fetchBtn');
    const loading = document.getElementById('contactsLoading');
    const area = document.getElementById('contactsArea');
    const empty = document.getElementById('emptyState');
    
    btn.disabled = true;
    btn.innerHTML = '⏳ جاري...';
    loading.classList.remove('hidden');
    area.classList.add('hidden');
    empty.classList.add('hidden');
    
    try {
        const res = await fetch(`/api/contacts?limit=50&t=${Date.now()}`);
        const data = await res.json();
        
        loading.classList.add('hidden');
        
        if (data.success) {
            contacts = data.data.contacts || [];
            const source = data.data.source || 'unknown';
            const note = data.data.note || '';
            
            if (contacts.length === 0) {
                empty.classList.remove('hidden');
                addLog('warning', '⚠️ لا يوجد مراسلين');
                btn.disabled = false;
                btn.innerHTML = '📥 تحديث القائمة';
                return;
            }
            
            renderContacts(contacts);
            area.classList.remove('hidden');
            
            // تفعيل شاشة الإرسال
            document.getElementById('sendCard').classList.remove('hidden');
            document.getElementById('sendCard').classList.add('animated');
            
            const sourceText = source === 'graph_api' ? '📡 Graph API' : 
                              source === 'scraped' ? '🕸️ Web Scraping' : '🧪 تجريبي';
            
            addLog('success', `✅ تم جلب ${contacts.length} مراسل عبر ${sourceText}${note ? ' - ' + note : ''}`);
            
            // تحديث العداد
            updateContactsCount();
        } else {
            showMessage(document.getElementById('sendMessage'), 'error', `❌ ${data.error || 'فشل جلب المراسلين'}`);
            addLog('error', `❌ ${data.error || 'فشل جلب المراسلين'}`);
        }
    } catch (err) {
        loading.classList.add('hidden');
        showMessage(document.getElementById('sendMessage'), 'error', `❌ خطأ: ${err.message}`);
        addLog('error', `❌ خطأ: ${err.message}`);
    }
    
    btn.disabled = false;
    btn.innerHTML = '📥 تحديث القائمة';
}

// ===== عرض المراسلين =====
function renderContacts(contactsList) {
    const tbody = document.getElementById('contactsBody');
    
    tbody.innerHTML = contactsList.map((contact, index) => {
        const name = contact.participants?.[0]?.name || contact.name || `مراسل ${index + 1}`;
        const psid = contact.participants?.[0]?.psid || contact.id;
        const lastMsg = contact.lastMessage || '-';
        const msgCount = contact.messageCount || 0;
        
        return `
            <tr>
                <td>
                    <input type="checkbox" class="contact-check" 
                           data-index="${index}" data-psid="${psid}" data-name="${name}" checked>
                </td>
                <td>
                    <div class="contact-name">${name}</div>
                    <div class="contact-id" style="font-size:11px;color:#999;">${psid ? psid.slice(0, 15) + '...' : ''}</div>
                </td>
                <td style="font-size:13px;color:#666;">${escapeHtml(lastMsg).slice(0, 50)}</td>
                <td style="text-align:center;">${msgCount}</td>
            </tr>
        `;
    }).join('');
    
    updateContactsCount();
}

// ===== تحديث عدد المراسلين =====
function updateContactsCount() {
    const count = contacts.length;
    document.getElementById('contactCount').textContent = count;
    document.getElementById('contactsCount').textContent = `${count} مراسل`;
}

// ===== تحديد الكل =====
function toggleAll() {
    const checked = document.getElementById('selectAll').checked;
    document.querySelectorAll('.contact-check').forEach(cb => cb.checked = checked);
}

// ===== بحث =====
function filterContacts() {
    const query = document.getElementById('searchInput').value.trim().toLowerCase();
    const rows = document.querySelectorAll('#contactsBody tr');
    
    rows.forEach(row => {
        const name = row.querySelector('.contact-name')?.textContent?.toLowerCase() || '';
        row.style.display = name.includes(query) ? '' : 'none';
    });
}

// ===== إرسال جماعي =====
async function sendBroadcast() {
    const message = document.getElementById('messageInput').value.trim();
    const btn = document.getElementById('sendBtn');
    const msgBox = document.getElementById('sendMessage');
    const progress = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const results = document.getElementById('resultsArea');
    
    if (!message) {
        showMessage(msgBox, 'error', '❌ الرجاء كتابة نص الرسالة أولاً');
        return;
    }
    
    // جمع المراسلين المحددين
    const selected = [];
    document.querySelectorAll('.contact-check:checked').forEach(cb => {
        selected.push({
            psid: cb.dataset.psid,
            name: cb.dataset.name
        });
    });
    
    if (selected.length === 0) {
        showMessage(msgBox, 'error', '❌ لم يتم تحديد أي مراسل');
        return;
    }
    
    // تأكيد
    if (!confirm(`هل أنت متأكد من إرسال رسالة إلى ${selected.length} مراسل؟`)) {
        return;
    }
    
    btn.disabled = true;
    btn.innerHTML = `<span>⏳</span> جاري الإرسال (0/${selected.length})...`;
    msgBox.className = 'message-box';
    msgBox.style.display = 'none';
    results.classList.add('hidden');
    progress.style.width = '0%';
    progressText.textContent = `جاري التجهيز...`;
    
    try {
        const res = await fetch('/api/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                contacts: selected.map(c => ({ id: c.psid, name: c.name })),
                message: message
            })
        });
        
        const data = await res.json();
        
        if (data.success) {
            const r = data.data;
            
            // شريط التقدم
            progress.style.width = '100%';
            progressText.textContent = `اكتمل: ${r.sent.length} نجاح / ${r.failed.length} فشل`;
            
            // عرض النتائج
            document.getElementById('successCount').textContent = `${r.sent.length} نجاح`;
            document.getElementById('failCount').textContent = `${r.failed.length} فشل`;
            
            const details = document.getElementById('resultsDetails');
            let html = '';
            
            r.sent.forEach(s => {
                html += `<div class="result-item"><span>${s.name || 'مراسل'}</span><span class="sent">✅ OK</span></div>`;
            });
            
            r.failed.forEach(f => {
                html += `<div class="result-item"><span>${f.name || 'مراسل'}</span><span class="failed">❌ ${f.error || 'خطأ'}</span></div>`;
            });
            
            details.innerHTML = html;
            results.classList.remove('hidden');
            
            addLog('success', `✅ تم إرسال ${r.sent.length}/${r.total} رسالة بنجاح`);
            if (r.failed.length > 0) {
                addLog('error', `❌ فشل ${r.failed.length} رسالة`);
            }
            
            // تحديث عداد الإرسال
            const sentDisplay = document.getElementById('sentDisplay');
            sentDisplay.textContent = parseInt(sentDisplay.textContent) + r.sent.length;
            
            showMessage(msgBox, 'success', `✅ اكتمل: ${r.sent.length} نجاح / ${r.failed.length} فشل`);
        } else {
            progress.style.width = '0%';
            progressText.textContent = 'فشل الإرسال';
            showMessage(msgBox, 'error', `❌ ${data.error || 'فشل الإرسال'}`);
            addLog('error', `❌ ${data.error || 'فشل الإرسال'}`);
        }
    } catch (err) {
        progress.style.width = '0%';
        progressText.textContent = 'خطأ';
        showMessage(msgBox, 'error', `❌ خطأ: ${err.message}`);
        addLog('error', `❌ خطأ: ${err.message}`);
    }
    
    btn.disabled = false;
    btn.innerHTML = '<span>🚀</span> إرسال جماعي';
}

// ===== التحقق من الحالة =====
async function checkStatus() {
    try {
        const res = await fetch('/api/status');
        const data = await res.json();
        
        if (data.success) {
            const s = data.data;
            
            // حالة الاتصال
            const dot = document.getElementById('statusDot');
            const text = document.getElementById('statusText');
            
            if (s.authenticated) {
                dot.className = 'dot green';
                text.textContent = 'متصل';
                
                // إذا كنا في شاشة تسجيل الدخول، ننتقل للمراسل
