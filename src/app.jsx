const { useState, useEffect, useRef } = React;

// 從重設密碼信的連結回來時，網址會帶 type=recovery；連結失效則帶 error_code
const OPENED_FROM_RESET_LINK = window.location.hash.includes('type=recovery');
const RESET_LINK_EXPIRED = window.location.hash.includes('error_code=');

// Supabase 連線設定（publishable key 本來就是放在網頁裡公開使用的金鑰）
const SUPABASE_URL = 'https://xqwrpedqgndhgkoxvziq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_j_inm_0LgaLkZULSkHx9Kg_odk2hljY';
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY); // 管理員登入用

// 客人不用登入：另開一個不保存登入狀態的連線。
// 手機從銀行 App 切回來時，登入用的連線會先做檢查，客人的預約不必排隊等它。
const publicDb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    storageKey: 'champion-public',
    lock: (name, acquireTimeout, fn) => fn(),
  },
});

// 資料庫回傳的錯誤代碼（見 supabase/schema.sql）對應的提示文字
const ERROR_MESSAGES = {
  SLOT_TAKEN: '你選的時段或場地剛剛被別人訂走了，請重新選擇。',
  OPEN_PLAY: '你選的場地在該時段保留給暢打，請改選其他場地。',
  INVALID_DATE: '只能預約今天起 7 天內的日期。',
  INVALID_SLOT: '選擇的時段或場地無法預約，請重新選擇。',
  INVALID_NAME: '請填寫姓名（30 字以內）。',
  INVALID_PHONE: '請輸入 09 開頭的 10 碼手機號碼。',
  INVALID_CODE: '請輸入 5 位數的匯款後五碼。',
  NOT_ALLOWED: '只有主管理員可以執行這個操作。',
  USER_NOT_FOUND: '找不到這個 Email 的帳號，請先在 Supabase 後台建立帳號。',
  ALREADY_ADMIN: '這個帳號已經是管理員了。',
};
const errorText = (error) => {
  const code = Object.keys(ERROR_MESSAGES).find(k => (error?.message || '').includes(k));
  return code ? ERROR_MESSAGES[code] : '連線發生問題，請稍後再試。';
};

// 店家資訊預設值；資料庫讀到後以資料庫為準（主管理員可在後台「設定」修改）
const DEFAULT_SHOP = { bankCode: '808', bankName: '玉山銀行', accountNumber: '0521979250523', contactPhone: '04-2407-0766' };
const shopFromRow = (r) => ({ bankCode: r.bank_code, bankName: r.bank_name, accountNumber: r.account_number, contactPhone: r.contact_phone });

// 資料庫欄位（底線命名）轉成畫面用的欄位
const fromRow = (r) => ({
  id: r.id, date: r.date, times: r.times, court: r.court, name: r.name,
  userPhone: r.user_phone, transferCode: r.transfer_code,
  isConfirmed: r.is_confirmed, isBulk: r.is_bulk, noShow: r.no_show, createdAt: r.created_at,
});

// Supabase 每次最多回傳 1000 筆，分頁讀完
const fetchAll = async (makeQuery) => {
  let rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await makeQuery().range(from, from + 999);
    if (error) return { error };
    rows = rows.concat(data);
    if (data.length < 1000) return { data: rows };
  }
};

// 自訂羽毛球圖示元件
const BadmintonIcon = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', width: '1em', height: '1em' }}>
    <path d="M7 17l-3 3 3 3 3-3" />
    <path d="M11 13l-4 4" />
    <path d="M12.5 11.5l-3 3" />
    <path d="M14.5 9.5l-2.5 2.5" />
    <path d="M17 7c2 2 3.5 1.5 5-1-2.5-1.5-3-3-1-5-2.5 1.5-3 3-1 5" />
    <path d="M21 2c-3.5 0-6.5 2-8 5.5l-5 5c-1 1-1.5 2.5-1 4s2 2.5 3 2.5 2.5-1 4-1l5-5c3.5-1.5 5.5-4.5 5.5-8z" />
    <path d="M10 18a2 2 0 100-4 2 2 0 000 4z" />
  </svg>
);

function App() {
  const [view, setView] = useState(OPENED_FROM_RESET_LINK ? 'reset-password' : RESET_LINK_EXPIRED ? 'admin-login' : 'booking'); // 'booking', 'done', 'schedule', 'lookup', 'admin-login', 'admin-panel', 'reset-password'

  const [step, setStep] = useState(1);

  // 記住上次填寫的姓名、電話與匯款後五碼，下次預約與查詢自動帶入（只存在這台裝置）
  const loadContact = () => {
    try { return { name: '', phone: '', code: '', ...JSON.parse(localStorage.getItem('champion_contact')) }; }
    catch (e) { return { name: '', phone: '', code: '' }; }
  };
  const saveContact = (contact) => {
    try { localStorage.setItem('champion_contact', JSON.stringify(contact)); } catch (e) {}
  };

  // 記住這台裝置上次登入後台的 Email，之後只需輸入密碼
  const loadAdminEmail = () => {
    try { return localStorage.getItem('champion_admin_email') || ''; } catch (e) { return ''; }
  };
  const saveAdminEmail = (email) => {
    try {
      if (email) localStorage.setItem('champion_admin_email', email);
      else localStorage.removeItem('champion_admin_email');
    } catch (e) {}
  };

  // === 預約與後台狀態 ===
  const emptyBooking = () => {
    const { name, phone } = loadContact();
    return { date: '', times: [], court: [], name, phone, transferCode: '' };
  };
  const [bookingData, setBookingData] = useState(emptyBooking);
  const [lastBooking, setLastBooking] = useState(null);
  const [lookupPhone, setLookupPhone] = useState(() => loadContact().phone);
  const [lookupCode, setLookupCode] = useState(() => loadContact().code);
  const [lookupName, setLookupName] = useState(() => loadContact().name);
  const [lookupResults, setLookupResults] = useState(null); // null = 尚未查詢
  const [lookupBusy, setLookupBusy] = useState(false);
  const [slots, setSlots] = useState([]); // 公開的場地佔用格 { date, time, court }
  const [adminBookings, setAdminBookings] = useState([]); // 管理員才讀得到的完整預約
  const [openPlayOverrides, setOpenPlayOverrides] = useState({}); // { 'YYYY-MM-DD': ['1', '2'] }
  const [dataLoaded, setDataLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [adminEmail, setAdminEmail] = useState(loadAdminEmail);
  const [rememberedEmail, setRememberedEmail] = useState(loadAdminEmail);
  const [adminPassword, setAdminPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [resetMode, setResetMode] = useState(false);
  const [authNotice, setAuthNotice] = useState(RESET_LINK_EXPIRED ? '重設密碼的連結已失效或已使用過，請重新寄送。' : '');
  const [authBusy, setAuthBusy] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [newPassword2, setNewPassword2] = useState('');
  const [pwdNotice, setPwdNotice] = useState('');
  const [admins, setAdmins] = useState([]);
  const [subEmail, setSubEmail] = useState('');
  const [adminTab, setAdminTab] = useState('list'); // 'list', 'calendar', 'customers', 'openplay', 'settings'
  const [listFilter, setListFilter] = useState('all');
  const [customerSearch, setCustomerSearch] = useState('');
  const [expandedPhone, setExpandedPhone] = useState(null);

  const [currentAdmin, setCurrentAdmin] = useState(null); // { role: 'main' | 'sub', email }
  const [shop, setShop] = useState(DEFAULT_SHOP);
  const [shopForm, setShopForm] = useState(DEFAULT_SHOP);
  const [shopNotice, setShopNotice] = useState('');
  const adminRef = useRef(null);
  adminRef.current = currentAdmin;

  // 管理員看完整預約；客人只看得到哪幾格有人訂（不含姓名電話）
  const bookings = currentAdmin
    ? adminBookings
    : slots.map((s, i) => ({ id: `slot-${i}`, date: s.date, times: [s.time], court: [s.court] }));

  const getLocalDateString = (dateObj) => {
    const offset = dateObj.getTimezoneOffset() * 60000;
    return new Date(dateObj.getTime() - offset).toISOString().split('T')[0];
  };
  const today = new Date();
  const todayString = getLocalDateString(today);
  const [scheduleDate, setScheduleDate] = useState(todayString);

  const loadPublic = async () => {
    const [slotRes, opRes] = await Promise.all([
      fetchAll(() => publicDb.from('booking_slots').select('date, time, court').gte('date', todayString).lte('date', maxDateString)),
      fetchAll(() => publicDb.from('open_play_overrides').select('date, courts')),
    ]);
    if (slotRes.error || opRes.error) {
      setLoadError('無法連線到預約系統，請檢查網路後重新整理頁面。');
      return;
    }
    setLoadError('');
    setSlots(slotRes.data);
    setOpenPlayOverrides(Object.fromEntries(opRes.data.map(r => [r.date, r.courts])));
    setDataLoaded(true);
    // 店家資訊讀不到時沿用預設值，不影響預約
    const { data: shopRow } = await publicDb.from('shop_settings').select('*').eq('id', 1).maybeSingle();
    if (shopRow) setShop(shopFromRow(shopRow));
  };

  const loadAdmin = async () => {
    const { data, error } = await fetchAll(() => db.from('bookings').select('*').order('date').order('id'));
    if (!error) setAdminBookings(data.map(fromRow));
  };

  const refreshAll = () => {
    loadPublic();
    if (adminRef.current) loadAdmin();
  };

  // 確認登入的帳號是管理員，才進入後台
  const enterAdmin = async (goToPanel) => {
    const { data: role, error } = await db.rpc('admin_role');
    if (error || !role) {
      await db.auth.signOut();
      return false;
    }
    const { data: { user } } = await db.auth.getUser();
    const admin = { role, email: user?.email || '' };
    adminRef.current = admin;
    setCurrentAdmin(admin);
    loadAdmin();
    if (goToPanel) {
      setView('admin-panel');
      setAdminTab('list');
    }
    return true;
  };

  useEffect(() => {
    loadPublic();
    // 這台裝置之前登入過後台就自動恢復管理員身分（從重設密碼連結回來時另外處理）
    if (!OPENED_FROM_RESET_LINK) {
      db.auth.getSession().then(({ data }) => { if (data.session) enterAdmin(false); });
    }
    const { data: authSub } = db.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setView('reset-password');
    });

    // 有人預約、管理員修改時即時更新；另外每分鐘與切回頁面時再同步一次
    let timer = null;
    const refreshSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(refreshAll, 300);
    };
    const channel = db.channel('booking-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'booking_slots' }, refreshSoon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, refreshSoon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'open_play_overrides' }, refreshSoon)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shop_settings' }, refreshSoon)
      .subscribe();
    const poll = setInterval(refreshSoon, 60000);
    // 手機切到其他 App 再回來時，連線多半已被系統切斷：馬上重新連線並更新場地資料
    const onVisible = () => { if (document.visibilityState === 'visible') refreshSoon(); };
    window.addEventListener('focus', refreshSoon);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      authSub.subscription.unsubscribe();
      db.removeChannel(channel);
      clearInterval(poll);
      clearTimeout(timer);
      window.removeEventListener('focus', refreshSoon);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const [showBulkModal, setShowBulkModal] = useState(false);
  // 後台新增預約：mode 'single' 單次（指定一天）、'bulk' 週期（每週同一時段）
  const emptyAdminBooking = () => ({ mode: 'single', name: '', phone: '', startDate: '', weeks: 4, times: [], courts: [] });
  const [bulkData, setBulkData] = useState(emptyAdminBooking);
  const [bulkConflicts, setBulkConflicts] = useState([]);
  const maxDateObj = new Date(today);
  maxDateObj.setDate(maxDateObj.getDate() + 7);
  const maxDateString = getLocalDateString(maxDateObj);

  const [calendarDate, setCalendarDate] = useState(new Date(today.getFullYear(), today.getMonth(), 1));
  const [selectedGridDate, setSelectedGridDate] = useState(todayString);
  const [opManageDate, setOpManageDate] = useState(todayString);
  const [editingOpCourts, setEditingOpCourts] = useState([]);

  const displayTime = (timeVal) => {
    const h = parseInt(timeVal.split(':')[0], 10);
    return `${h.toString().padStart(2, '0')}:00 - ${(h + 1).toString().padStart(2, '0')}:00`;
  };

  const allTimeSlots = [];
  for (let h = 7; h <= 21; h++) { allTimeSlots.push(`${h.toString().padStart(2, '0')}:00`); }

  const getOpenPlayCourts = (dateString) => {
    if (!dateString) return [];
    // 若有主管理員手動調整的覆蓋紀錄，優先使用 (包含空陣列 []，代表包場模式取消暢打)
    if (openPlayOverrides[dateString] !== undefined) return openPlayOverrides[dateString];

    const day = new Date(dateString).getDay();
    // 平日 (週一~週五) 預設保留第 2 場地
    if (day >= 1 && day <= 5) return ["2"];
    // 假日 (週六、日) 預設保留第 2, 3, 4 場地
    return ["2", "3", "4"];
  };

  const getOpenPlayTimes = (dateString) => {
    const day = new Date(dateString).getDay();
    if (day >= 1 && day <= 5) return ["12:00", "13:00", "14:00", "15:00", "16:00"]; // 平日 12-17
    return ["18:00", "19:00", "20:00", "21:00"]; // 假日 18-22
  };

  const isCourtBlockedByOpenPlay = (dateStr, timeStr, courtStr) => {
    const opTimes = getOpenPlayTimes(dateStr);
    const opCourts = getOpenPlayCourts(dateStr);
    return opTimes.includes(timeStr) && opCourts.includes(courtStr);
  };

  const getAvailableTimes = (dateString) => {
    if (!dateString) return [];
    const date = new Date(dateString);
    const day = date.getDay();
    const isWeekend = day === 0 || day === 6;
    const startHour = isWeekend ? 7 : 9;
    const endHour = 22;

    const times = [];
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const currentHour = now.getHours();

    for (let h = startHour; h < endHour; h++) {
      const timeString = `${h.toString().padStart(2, '0')}:00`;
      const isPast = isToday && h <= currentHour;
      times.push({ label: displayTime(timeString), value: timeString, isPast: isPast });
    }
    return times;
  };

  const isTimeFullyBooked = (timeValue) => {
    let blockedCount = 0;
    [1, 2, 3, 4].forEach(c => {
      if (isCourtBlockedByOpenPlay(bookingData.date, timeValue, c.toString())) {
        blockedCount++;
      }
    });

    const bookedCourtsForTime = [];
    bookings.forEach(b => {
      if (b.date === bookingData.date && b.times.includes(timeValue)) {
        b.court.forEach(c => bookedCourtsForTime.push(c));
      }
    });

    return new Set(bookedCourtsForTime).size + blockedCount >= 4;
  };

  const isCourtAvailable = (courtIndex) => {
    const courtStr = courtIndex.toString();
    // 檢查是否被暢打保留
    for (const t of bookingData.times) {
      if (isCourtBlockedByOpenPlay(bookingData.date, t, courtStr)) return false;
    }
    // 檢查是否被他人預約
    return !bookings.some(b => b.date === bookingData.date && b.court.includes(courtStr) && b.times.some(t => bookingData.times.includes(t)));
  };

  const toggleTime = (timeValue) => {
    const updatedTimes = bookingData.times.includes(timeValue) ? bookingData.times.filter(t => t !== timeValue) : [...bookingData.times, timeValue];
    updatedTimes.sort((a, b) => parseInt(a) - parseInt(b));
    setBookingData({ ...bookingData, times: updatedTimes, court: [] });
  };

  const toggleCourt = (courtIndex) => {
    const courtStr = courtIndex.toString();
    const updatedCourts = bookingData.court.includes(courtStr) ? bookingData.court.filter(c => c !== courtStr) : [...bookingData.court, courtStr];
    updatedCourts.sort((a, b) => parseInt(a) - parseInt(b));
    setBookingData({ ...bookingData, court: updatedCourts });
  };

  const canProceed = () => {
    if (step === 1) return bookingData.date !== '';
    if (step === 2) return bookingData.times.length > 0;
    if (step === 3) return bookingData.court.length > 0;
    return true;
  };

  const isValidPhone = (phone) => /^09\d{8}$/.test(phone);
  const isValidTransferCode = (code) => /^\d{5}$/.test(code);

  const startBooking = () => {
    setBookingData(emptyBooking());
    setStep(1);
    setView('booking');
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    // 網路太慢時最多等 30 秒，避免畫面一直停在「送出中」
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 30000);
    const { data, error } = await publicDb.rpc('create_booking', {
      p_date: bookingData.date,
      p_times: bookingData.times,
      p_courts: bookingData.court,
      p_name: bookingData.name.trim(),
      p_phone: bookingData.phone,
      p_code: bookingData.transferCode,
    }).abortSignal(timeout.signal);
    clearTimeout(timer);
    setSubmitting(false);
    if (timeout.signal.aborted) {
      refreshAll();
      alert('網路回應太慢，系統可能已經收到你的預約。\n請先到「查詢預約」確認，查不到再重新送出。');
      return;
    }
    refreshAll();
    if (error) {
      alert(errorText(error));
      if (/SLOT_TAKEN|OPEN_PLAY|INVALID_SLOT/.test(error.message)) {
        setBookingData({ ...bookingData, court: [] });
        setStep(3);
      }
      return;
    }
    const newBooking = fromRow(data);
    saveContact({ name: newBooking.name, phone: newBooking.userPhone, code: newBooking.transferCode });
    setLookupPhone(newBooking.userPhone);
    setLookupCode(newBooking.transferCode);
    setLookupName(newBooking.name);
    setLookupResults(null);
    setLastBooking(newBooking);
    setView('done');
  };

  const lookupReady = lookupName.trim() !== '' && isValidPhone(lookupPhone) && isValidTransferCode(lookupCode);
  const runLookup = async (e) => {
    if (e) e.preventDefault();
    if (!lookupReady) return;
    setLookupBusy(true);
    const { data, error } = await publicDb.rpc('lookup_bookings', { p_name: lookupName.trim(), p_phone: lookupPhone, p_code: lookupCode });
    setLookupBusy(false);
    if (error) {
      setLookupResults(null);
      alert(errorText(error));
      return;
    }
    setLookupResults(data.map(fromRow));
  };
  // 帶著上次的資料進入查詢頁時自動查一次
  useEffect(() => {
    if (view === 'lookup' && lookupReady && lookupResults === null) runLookup();
  }, [view]);
  // 進入最後一步就先連線並更新場地資料，按送出時不用從頭建立連線
  useEffect(() => {
    if (view === 'booking' && step === 4) loadPublic();
  }, [view, step]);

  const handleAdminLogin = async (e) => {
    e.preventDefault();
    setAuthBusy(true);
    setLoginError('');
    const { error } = await db.auth.signInWithPassword({ email: adminEmail.trim(), password: adminPassword });
    if (error) {
      setAuthBusy(false);
      setLoginError(rememberedEmail ? '密碼錯誤，請重新輸入' : 'Email 或密碼錯誤，請重新輸入');
      return;
    }
    const ok = await enterAdmin(true);
    setAuthBusy(false);
    if (!ok) {
      setLoginError('這個帳號沒有後台權限');
      return;
    }
    setAdminPassword('');
    setAuthNotice('');
    saveAdminEmail(adminEmail.trim());
    setRememberedEmail(adminEmail.trim());
  };

  const switchAdminAccount = () => {
    saveAdminEmail('');
    setRememberedEmail('');
    setAdminEmail('');
    setAdminPassword('');
    setLoginError('');
  };

  const handleResetRequest = async (e) => {
    e.preventDefault();
    setAuthBusy(true);
    const { error } = await db.auth.resetPasswordForEmail(adminEmail.trim(), { redirectTo: window.location.origin + window.location.pathname });
    setAuthBusy(false);
    if (error) {
      setAuthNotice(error.status === 429 ? '寄送太頻繁，請過幾分鐘再試。' : '寄送失敗，請確認 Email 是否正確。');
      return;
    }
    setAuthNotice('如果這個 Email 是管理員帳號，重設密碼信已寄出，請到信箱點連結設定新密碼。');
  };

  const handlePasswordUpdate = async (e) => {
    e.preventDefault();
    if (newPassword.length < 8) { setPwdNotice('新密碼至少要 8 碼'); return; }
    if (newPassword !== newPassword2) { setPwdNotice('兩次輸入的新密碼不一樣'); return; }
    setAuthBusy(true);
    const { error } = await db.auth.updateUser({ password: newPassword });
    setAuthBusy(false);
    if (error) {
      setPwdNotice(/different from the old/i.test(error.message) ? '新密碼不能和舊密碼相同' : '密碼更新失敗，請重新登入後再試');
      return;
    }
    setNewPassword('');
    setNewPassword2('');
    setPwdNotice('密碼已更新，下次登入請用新密碼');
    if (view === 'reset-password') {
      window.history.replaceState(null, '', window.location.pathname);
      const ok = await enterAdmin(true);
      if (!ok) setView('admin-login');
    }
  };

  const handleAdminLogout = async () => {
    await db.auth.signOut();
    adminRef.current = null;
    setCurrentAdmin(null);
    setAdminBookings([]);
    setListFilter('all');
    setView('booking');
  };

  const loadAdmins = async () => {
    const { data, error } = await db.rpc('list_admins');
    if (!error) setAdmins(data);
  };

  const saveShop = async (e) => {
    e.preventDefault();
    const trimmed = Object.fromEntries(Object.entries(shopForm).map(([k, v]) => [k, v.trim()]));
    if (Object.values(trimmed).some(v => v === '')) { setShopNotice('每一欄都要填寫'); return; }
    const { data, error } = await db.from('shop_settings')
      .update({ bank_code: trimmed.bankCode, bank_name: trimmed.bankName, account_number: trimmed.accountNumber, contact_phone: trimmed.contactPhone })
      .eq('id', 1).select().maybeSingle();
    if (error || !data) { setShopNotice('儲存失敗，請確認資料庫已執行 002_shop_settings.sql，並以主管理員登入'); return; }
    setShop(shopFromRow(data));
    setShopNotice('已儲存，客人的預約頁面會立即顯示新資料');
  };

  const grantSubAdmin = async (e) => {
    e.preventDefault();
    const { error } = await db.rpc('grant_sub_admin', { p_email: subEmail.trim() });
    if (error) { alert(errorText(error)); return; }
    setSubEmail('');
    loadAdmins();
  };

  const revokeSubAdmin = async (email) => {
    if (!window.confirm(`確定要移除 ${email} 的副管理員權限嗎？`)) return;
    const { error } = await db.rpc('revoke_sub_admin', { p_email: email });
    if (error) { alert(errorText(error)); return; }
    loadAdmins();
  };

  const deleteBooking = async (id) => {
    if (currentAdmin?.role !== 'main') { alert('只有主管理員可以刪除預約！'); return; }
    if (!window.confirm('確定要刪除這筆預約嗎？刪除後該時段/場地將會釋出。')) return;
    const { error } = await db.from('bookings').delete().eq('id', id);
    if (error) alert(errorText(error));
    refreshAll();
  };

  // 先更新畫面再寫入資料庫，失敗就重新讀取
  const updateBooking = async (id, changes, dbChanges) => {
    setAdminBookings(prev => prev.map(b => b.id === id ? { ...b, ...changes } : b));
    const { error } = await db.from('bookings').update(dbChanges).eq('id', id);
    if (error) {
      alert(errorText(error));
      loadAdmin();
    }
  };

  const toggleConfirmStatus = (id) => {
    const targetBooking = bookings.find(b => b.id === id);
    if (!targetBooking) return;
    updateBooking(id, { isConfirmed: !targetBooking.isConfirmed }, { is_confirmed: !targetBooking.isConfirmed });
  };

  const toggleNoShow = (id) => {
    const targetBooking = bookings.find(b => b.id === id);
    if (!targetBooking) return;
    updateBooking(id, { noShow: !targetBooking.noShow }, { no_show: !targetBooking.noShow });
  };

  const handleBulkSubmit = async () => {
    if (currentAdmin?.role !== 'main') return;
    setBulkConflicts([]);
    const single = bulkData.mode === 'single';
    if (!bulkData.name.trim() || !bulkData.startDate || bulkData.times.length === 0 || bulkData.courts.length === 0) {
      alert(`請填寫完整資訊（包含姓名、${single ? '日期' : '起始日'}、時段與場地）`); return;
    }
    if (single && bulkData.phone.trim() && !/^[0-9-]{8,15}$/.test(bulkData.phone.trim())) {
      alert('電話只能填數字與 -，或留空'); return;
    }
    const generatedDates = [];
    let currentDate = new Date(bulkData.startDate);
    for (let i = 0; i < (single ? 1 : bulkData.weeks); i++) {
      generatedDates.push(getLocalDateString(currentDate));
      currentDate.setDate(currentDate.getDate() + 7);
    }
    const conflicts = [];
    generatedDates.forEach(date => {
      bulkData.times.forEach(time => {
        bulkData.courts.forEach(court => {
          if (bookings.some(b => b.date === date && b.court.includes(court) && b.times.includes(time))) {
            conflicts.push(`${date} (${displayTime(time)}) 第${court}場地`);
          }
          if (isCourtBlockedByOpenPlay(date, time, court)) {
            conflicts.push(`${date} (${displayTime(time)}) 第${court}場地 (暢打保留)`);
          }
        });
      });
    });
    if (conflicts.length > 0) { setBulkConflicts(conflicts); return; }

    const times = [...bulkData.times].sort((a, b) => parseInt(a) - parseInt(b));
    const courts = [...bulkData.courts].sort((a, b) => parseInt(a) - parseInt(b));
    const { error } = single
      ? await db.rpc('create_admin_booking', { p_name: bulkData.name.trim(), p_phone: bulkData.phone.trim(), p_date: generatedDates[0], p_times: times, p_courts: courts })
      : await db.rpc('create_bulk_bookings', { p_name: bulkData.name.trim(), p_dates: generatedDates, p_times: times, p_courts: courts });
    refreshAll();
    if (error) {
      if (/create_admin_booking/.test(error.message)) {
        alert('資料庫還沒有單次預約功能，請先在 Supabase 執行 003_admin_single_booking.sql');
      } else if (/INVALID_DATE/.test(error.message)) {
        alert('不能選擇今天以前的日期');
      } else if (/INVALID_PHONE/.test(error.message)) {
        alert('電話只能填數字與 -，或留空');
      } else {
        alert(errorText(error));
      }
      return;
    }
    alert(single ? `已建立 ${generatedDates[0]} 的預約！` : `成功建立 ${bulkData.weeks} 筆預約！`);
    setShowBulkModal(false);
    setBulkData(emptyAdminBooking());
  };

  const getDaysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();
  const getFirstDayOfMonth = (year, month) => new Date(year, month, 1).getDay();
  const prevMonth = () => setCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() - 1, 1));
  const nextMonth = () => setCalendarDate(new Date(calendarDate.getFullYear(), calendarDate.getMonth() + 1, 1));

  const siteHeader = (active) => (
    <header className="flex flex-col sm:flex-row sm:flex-wrap sm:justify-between sm:items-center gap-3 p-4 sm:px-6 bg-blue-950/80 backdrop-blur-md sticky top-0 z-10 border-b border-blue-800">
      <h1 className="text-xl font-bold text-yellow-400 flex items-center tracking-wide">
        冠軍羽球館 <span className="text-sm font-normal text-blue-200 ml-2">（國光店）</span>
      </h1>
      <nav className="grid grid-cols-4 sm:flex sm:items-center gap-2">
        <button onClick={() => setView('schedule')} className={`flex items-center justify-center gap-1.5 text-xs font-medium px-3 py-2 sm:py-1.5 rounded-full border transition-colors whitespace-nowrap ${active === 'schedule' ? 'bg-yellow-500 border-yellow-400 text-blue-950 font-bold' : 'border-blue-600 bg-blue-800 text-white hover:bg-blue-700'}`}>
          <i className="fas fa-calendar-alt text-[14px]"></i> 場地狀況
        </button>
        <button onClick={startBooking} className={`flex items-center justify-center gap-1.5 text-xs font-medium px-3 py-2 sm:py-1.5 rounded-full border transition-colors whitespace-nowrap ${active === 'booking' ? 'bg-yellow-500 border-yellow-400 text-blue-950 font-bold' : 'border-blue-600 bg-blue-800 text-white hover:bg-blue-700'}`}>
          <i className="fas fa-calendar-day text-[14px]"></i> 預約場地
        </button>
        <button onClick={() => setView('lookup')} className={`flex items-center justify-center gap-1.5 text-xs font-medium px-3 py-2 sm:py-1.5 rounded-full border transition-colors whitespace-nowrap ${active === 'lookup' ? 'bg-yellow-500 border-yellow-400 text-blue-950 font-bold' : 'border-blue-600 bg-blue-800 text-white hover:bg-blue-700'}`}>
          <i className="fas fa-search text-[14px]"></i> 查詢預約
        </button>
        <button onClick={() => setView(currentAdmin ? 'admin-panel' : 'admin-login')} className="text-xs font-medium px-3 py-2 sm:py-1.5 rounded-full border border-blue-700 text-blue-300 hover:text-white hover:bg-blue-800 transition-colors whitespace-nowrap">後台</button>
      </nav>
      {(loadError || !dataLoaded) && (
        <p role="status" className={`sm:basis-full text-xs font-bold px-3 py-2 rounded-lg ${loadError ? 'bg-red-950 text-red-300 border border-red-800' : 'bg-blue-900 text-blue-200'}`}>
          {loadError || '正在讀取最新場地資料…'}
        </p>
      )}
    </header>
  );

  const siteFooter = (
    <footer className="max-w-2xl mx-auto px-4 pb-10 text-center text-sm text-blue-300 space-y-1">
      <p>
        預約問題、改期或取消請來電：
        <a href={`tel:${shop.contactPhone.replace(/[^0-9+]/g, '')}`} className="text-yellow-400 font-bold underline underline-offset-2 whitespace-nowrap">{shop.contactPhone}</a>
      </p>
      <p className="text-xs text-blue-400">冠軍羽球館（國光店）</p>
    </footer>
  );

  const bookingCard = (b) => (
    <div key={b.id} className="bg-blue-950 border border-blue-700 rounded-2xl p-5 shadow-lg relative overflow-hidden">
      <div className={`absolute top-0 right-0 px-3 py-1 text-xs font-bold rounded-bl-xl ${b.isConfirmed ? 'bg-green-500 text-white' : 'bg-yellow-500 text-blue-950'}`}>
        {b.isConfirmed ? '已確認成功' : '等待店家確認'}
      </div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mt-2">
        <div>
          <h4 className="text-white font-bold text-lg mb-1">{b.date} <span className="text-blue-400 text-sm font-normal ml-2">第 {Array.isArray(b.court) ? b.court.join(', ') : b.court} 場地</span></h4>
          <div className="flex flex-wrap gap-2 mt-2">
            {b.times.map(t => <span key={t} className="bg-blue-900 border border-blue-600 text-blue-200 px-2 py-1 rounded text-xs">{displayTime(t)}</span>)}
          </div>
        </div>
        <div className="text-left sm:text-right">
          <p className="text-blue-400 text-xs mb-1">訂單建立時間</p>
          <p className="text-blue-200 text-sm">{new Date(b.createdAt).toLocaleString('zh-TW', { hour12: false })}</p>
        </div>
      </div>
    </div>
  );

  if (view === 'done' && lastBooking) {
    return (
      <div className="min-h-screen">
        {siteHeader('done')}

        <main className="max-w-lg mx-auto p-4 sm:p-6 pb-24">
          <div className="text-center mt-6 mb-6">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-500 flex items-center justify-center shadow-lg">
              <i className="fas fa-check text-white text-[32px]"></i>
            </div>
            <h2 className="text-2xl font-extrabold text-white mb-2">預約已送出</h2>
            <p className="text-blue-300 text-sm">店家核對匯款後會確認您的預約，可隨時到「查詢預約」查看狀態。</p>
          </div>

          <div className="space-y-4">
            {bookingCard(lastBooking)}
            <div className="bg-blue-900/40 p-4 rounded-xl border border-blue-700/50 text-sm text-blue-200 grid grid-cols-2 gap-y-2">
              <div className="text-blue-300">預約人：</div><div className="text-white font-medium text-right">{lastBooking.name}</div>
              <div className="text-blue-300">聯絡電話：</div><div className="text-white font-mono text-right">{lastBooking.userPhone}</div>
              <div className="text-blue-300">匯款後五碼：</div><div className="text-yellow-400 font-mono font-bold text-right tracking-widest">{lastBooking.transferCode}</div>
              <div className="text-blue-300">訂金：</div><div className="text-red-400 font-bold text-right">NT$ {lastBooking.court.length * lastBooking.times.length * 100}</div>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 mt-8">
            <button onClick={startBooking} className="flex-1 flex items-center justify-center px-6 py-3 bg-yellow-500 text-blue-950 font-bold rounded-xl hover:bg-yellow-400 transition-all shadow-lg">
              <i className="fas fa-calendar-day mr-2 text-[18px]"></i> 再預約一筆
            </button>
            <button onClick={() => setView('lookup')} className="flex-1 flex items-center justify-center px-6 py-3 rounded-xl border border-blue-600 text-blue-100 font-bold hover:bg-blue-800 transition-colors">
              <i className="fas fa-search mr-2 text-[16px]"></i> 查詢我的預約
            </button>
          </div>
        </main>
        {siteFooter}
      </div>
    );
  }

  if (view === 'schedule') {
    // 與臨打預約相同範圍：今天起到 7 天後
    const days = [];
    for (let i = 0; i <= 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      days.push(getLocalDateString(d));
    }
    const weekdayNames = ['日', '一', '二', '三', '四', '五', '六'];
    const weekdayOf = (dateStr) => weekdayNames[new Date(dateStr).getDay()];
    const shownDate = days.includes(scheduleDate) ? scheduleDate : days[0];

    // 只顯示空位 / 已預約 / 暢打，不透露預約人資料
    const slotState = (dateStr, slot, courtStr) => {
      if (slot.isPast) return 'past';
      if (isCourtBlockedByOpenPlay(dateStr, slot.value, courtStr)) return 'openplay';
      const taken = bookings.some(b => {
        const courtArray = Array.isArray(b.court) ? b.court : [b.court];
        return b.date === dateStr && b.times.includes(slot.value) && courtArray.includes(courtStr);
      });
      return taken ? 'booked' : 'free';
    };
    const freeCount = (dateStr) => getAvailableTimes(dateStr).reduce((n, slot) => n + ['1', '2', '3', '4'].filter(c => slotState(dateStr, slot, c) === 'free').length, 0);
    const bookSlot = (dateStr, time, courtStr) => {
      setBookingData({ ...emptyBooking(), date: dateStr, times: [time], court: [courtStr] });
      setStep(3);
      setView('booking');
    };
    const slots = getAvailableTimes(shownDate);

    return (
      <div className="min-h-screen">
        {siteHeader('schedule')}

        <main className="max-w-3xl mx-auto p-4 sm:p-6 pb-24">
          <div className="text-center mb-6 mt-4">
            <h2 className="text-3xl font-extrabold text-white mb-2 tracking-wide">一週場地狀況</h2>
            <p className="text-blue-300 text-sm">今天起 7 天內的空位，點「空位」即可直接預約。</p>
          </div>

          <div className="flex gap-2 overflow-x-auto custom-scrollbar pb-2 mb-4" role="tablist" aria-label="選擇日期">
            {days.map(d => {
              const selected = d === shownDate;
              const free = freeCount(d);
              const day = new Date(d).getDay();
              const weekend = day === 0 || day === 6;
              return (
                <button key={d} role="tab" aria-selected={selected} onClick={() => setScheduleDate(d)} className={`flex-shrink-0 w-[4.5rem] flex flex-col items-center py-2 rounded-xl border-2 transition-all ${selected ? 'bg-yellow-500 border-yellow-400 text-blue-950 shadow-md' : 'bg-blue-900/60 border-blue-700 text-white hover:border-yellow-400'}`}>
                  <span className={`text-xs font-bold ${selected ? '' : weekend ? 'text-yellow-400' : 'text-blue-300'}`}>{d === todayString ? '今天' : `週${weekdayOf(d)}`}</span>
                  <span className="text-lg font-extrabold leading-tight">{parseInt(d.slice(5, 7), 10)}/{parseInt(d.slice(8), 10)}</span>
                  <span className={`text-[10px] font-bold ${selected ? 'text-blue-900' : free > 0 ? 'text-green-400' : 'text-red-400'}`}>{free > 0 ? `空位 ${free}` : '已滿'}</span>
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-medium mb-3">
            <span className="flex items-center text-green-300"><span className="w-3 h-3 bg-green-900/50 border border-green-500 rounded mr-1"></span> 空位（可預約）</span>
            <span className="flex items-center text-red-300"><span className="w-3 h-3 bg-red-950/60 border border-red-800 rounded mr-1"></span> 已預約</span>
            <span className="flex items-center text-purple-300"><span className="w-3 h-3 bg-purple-900 border border-purple-500 rounded mr-1"></span> 暢打時段</span>
            <span className="flex items-center text-blue-400"><span className="w-3 h-3 bg-blue-950 border border-blue-800 rounded mr-1"></span> 已過時段</span>
          </div>

          <div className="bg-blue-950 rounded-2xl border border-blue-800 shadow-2xl overflow-hidden">
            <div className="p-3 border-b border-blue-800 bg-blue-900/40 text-sm font-bold text-yellow-400">
              {shownDate}（{weekdayOf(shownDate)}）
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-center border-collapse">
                <thead className="bg-blue-900">
                  <tr>
                    <th className="p-2 text-blue-300 text-xs font-bold border-b border-blue-700 w-[4.5rem]">時間</th>
                    {[1, 2, 3, 4].map(c => <th key={c} className="p-2 text-yellow-500 text-xs font-bold border-b border-blue-700">第 {c} 場</th>)}
                  </tr>
                </thead>
                <tbody>
                  {slots.map(slot => (
                    <tr key={slot.value} className="border-b border-blue-800/50">
                      <td className="p-1.5 text-blue-200 text-xs font-medium whitespace-nowrap tabular-nums">{slot.value}<span className="hidden sm:inline">–{(parseInt(slot.value, 10) + 1).toString().padStart(2, '0')}:00</span></td>
                      {['1', '2', '3', '4'].map(c => {
                        const state = slotState(shownDate, slot, c);
                        const label = { free: '空位', booked: '已預約', openplay: '暢打', past: '—' }[state];
                        const cls = {
                          free: 'bg-green-900/40 border-green-500/60 text-green-300 hover:bg-green-800/60 hover:border-green-400 cursor-pointer',
                          booked: 'bg-red-950/60 border-red-800/70 text-red-300 cursor-not-allowed',
                          openplay: 'bg-purple-900/40 border-purple-500/50 text-purple-300 cursor-not-allowed',
                          past: 'bg-blue-950 border-blue-900 text-blue-700 cursor-not-allowed',
                        }[state];
                        return (
                          <td key={c} className="p-1">
                            <button type="button" disabled={state !== 'free'} onClick={() => bookSlot(shownDate, slot.value, c)} aria-label={`${shownDate} ${displayTime(slot.value)} 第 ${c} 場地：${label}`} className={`w-full h-10 rounded-lg border text-xs font-bold transition-colors ${cls}`}>
                              {label}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-xs text-blue-400 mt-3">平日 9:00～22:00、週末 7:00～22:00 開放；「暢打」為保留給現場暢打的場地，無法線上預約。</p>
        </main>
        {siteFooter}
      </div>
    );
  }

  if (view === 'lookup') {
    const myBookings = lookupResults || [];
    const editLookup = (setter) => (value) => { setter(value); setLookupResults(null); };

    return (
      <div className="min-h-screen">
        {siteHeader('lookup')}

        <main className="max-w-2xl mx-auto p-4 sm:p-6 pb-24">
          <div className="text-center mb-6 mt-4">
            <h2 className="text-3xl font-extrabold text-white mb-2 tracking-wide">查詢我的預約</h2>
            <p className="text-blue-300 text-sm">輸入預約時留下的姓名、手機號碼與匯款後五碼。</p>
          </div>

          <form onSubmit={runLookup} className="bg-blue-950/60 border border-blue-800 rounded-2xl p-4 mb-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label htmlFor="lookup-name" className="block text-sm font-medium text-blue-200 mb-1.5 flex items-center"><i className="fas fa-user mr-1 text-[16px]"></i> 姓名</label>
              <input id="lookup-name" type="text" autoComplete="name" placeholder="預約時填的姓名" value={lookupName} onChange={e => editLookup(setLookupName)(e.target.value)} className="w-full bg-blue-900 border border-blue-700 rounded-xl p-3.5 text-white text-lg focus:outline-none focus:border-yellow-400 transition-all placeholder-blue-500 placeholder:text-base" />
            </div>
            <div>
            <label htmlFor="lookup-phone" className="block text-sm font-medium text-blue-200 mb-1.5 flex items-center"><i className="fas fa-phone mr-1 text-[16px]"></i> 手機號碼</label>
            <input id="lookup-phone" type="tel" inputMode="numeric" placeholder="09xxxxxxxx" value={lookupPhone} onChange={e => editLookup(setLookupPhone)(e.target.value.replace(/\D/g, '').slice(0, 10))} className="w-full bg-blue-900 border border-blue-700 rounded-xl p-3.5 text-white font-mono text-lg focus:outline-none focus:border-yellow-400 transition-all placeholder-blue-500" />
            </div>
            <div>
              <label htmlFor="lookup-code" className="block text-sm font-medium text-blue-200 mb-1.5 flex items-center"><i className="fas fa-money-bill-wave mr-1 text-[16px]"></i> 匯款後五碼</label>
              <input id="lookup-code" type="text" inputMode="numeric" placeholder="5 位數字" value={lookupCode} onChange={e => editLookup(setLookupCode)(e.target.value.replace(/\D/g, '').slice(0, 5))} className="w-full bg-blue-900 border border-blue-700 rounded-xl p-3.5 text-white font-mono text-lg tracking-widest focus:outline-none focus:border-yellow-400 transition-all placeholder-blue-500 placeholder:tracking-normal" />
            </div>
            <button type="submit" disabled={!lookupReady || lookupBusy} className="sm:col-span-3 py-3 bg-yellow-500 text-blue-950 font-bold rounded-xl hover:bg-yellow-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center">
              <i className="fas fa-search mr-2 text-[16px]"></i> {lookupBusy ? '查詢中…' : '查詢'}
            </button>
          </form>

          {lookupResults && (
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-xl font-bold text-yellow-400 flex items-center"><i className="fas fa-history mr-2"></i> 預約紀錄</h3>
              <span className="bg-blue-800 text-blue-200 text-xs px-2 py-1 rounded-full font-bold">共 {myBookings.length} 筆</span>
            </div>
          )}

          <div className="space-y-4">
            {!lookupReady ? (
              <p className="text-blue-400 text-sm text-center">請填寫姓名、10 碼手機號碼與 5 碼匯款後五碼</p>
            ) : !lookupResults ? (
              <p className="text-blue-400 text-sm text-center">{lookupBusy ? '查詢中…' : '按「查詢」查看預約紀錄'}</p>
            ) : myBookings.length === 0 ? (
              <div className="bg-blue-950/60 border border-blue-800 rounded-2xl p-8 text-center backdrop-blur-sm">
                <i className="fas fa-calendar-day mx-auto text-blue-700 mb-4 text-[48px] block text-center"></i>
                <p className="text-blue-300 font-medium">找不到符合的預約，請確認姓名、手機號碼與匯款後五碼都和預約時相同。</p>
              </div>
            ) : myBookings.map(bookingCard)}
          </div>
        </main>
        {siteFooter}
      </div>
    );
  }

  const inputCls = 'w-full bg-blue-900 border border-blue-700 rounded-xl p-3.5 text-white focus:outline-none focus:border-yellow-400 transition-all placeholder-blue-500';

  if (view === 'reset-password') {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="bg-blue-950 p-8 rounded-2xl border border-blue-800 w-full max-w-sm shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-2 bg-yellow-500"></div>
          <h2 className="text-2xl font-bold text-center text-yellow-400 mb-2 flex justify-center items-center">
            <i className="fas fa-key mr-2 text-[22px]"></i> 設定新密碼
          </h2>
          <p className="text-blue-300 text-sm text-center mb-6">請設定新的後台密碼（至少 8 碼）。</p>
          <form onSubmit={handlePasswordUpdate} className="space-y-4">
            <input id="reset-new-password" type="password" autoComplete="new-password" placeholder="新密碼" value={newPassword} onChange={e => { setNewPassword(e.target.value); setPwdNotice(''); }} className={inputCls} />
            <input id="reset-new-password-2" type="password" autoComplete="new-password" placeholder="再輸入一次新密碼" value={newPassword2} onChange={e => { setNewPassword2(e.target.value); setPwdNotice(''); }} className={inputCls} />
            {pwdNotice && <p className="text-yellow-300 text-sm text-center font-medium">{pwdNotice}</p>}
            <button type="submit" disabled={authBusy} className="w-full py-4 bg-yellow-500 text-blue-950 font-bold rounded-xl hover:bg-yellow-400 transition-colors disabled:opacity-50">{authBusy ? '儲存中…' : '儲存新密碼並進入後台'}</button>
          </form>
        </div>
      </div>
    );
  }

  if (view === 'admin-login') {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="bg-blue-950 p-8 rounded-2xl border border-blue-800 w-full max-w-sm shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-2 bg-red-500"></div>
          <h2 className="text-2xl font-bold text-center text-red-400 mb-6 flex justify-center items-center">
            <i className="fas fa-user-shield mr-2 text-[24px]"></i> {resetMode ? '忘記密碼' : '管理員登入'}
          </h2>
          {resetMode ? (
            <form onSubmit={handleResetRequest} className="space-y-4">
              <p className="text-blue-200 text-sm">輸入管理員的 Email，我們會寄一封重設密碼信給你。</p>
              <input id="reset-email" type="email" autoComplete="email" required placeholder="管理員 Email" value={adminEmail} onChange={e => { setAdminEmail(e.target.value); setAuthNotice(''); }} className={inputCls} />
              {authNotice && <p className="text-yellow-300 text-sm font-medium leading-relaxed">{authNotice}</p>}
              <button type="submit" disabled={authBusy} className="w-full py-4 bg-red-500 text-white font-bold rounded-xl hover:bg-red-400 transition-colors disabled:opacity-50">{authBusy ? '寄送中…' : '寄送重設密碼信'}</button>
              <button type="button" onClick={() => { setResetMode(false); setAuthNotice(''); }} className="w-full text-blue-300 text-sm hover:text-white transition-colors">返回登入</button>
            </form>
          ) : (
            <form onSubmit={handleAdminLogin} className="space-y-4">
              {rememberedEmail ? (
                <div className="flex items-center justify-between gap-3 bg-blue-900/60 border border-blue-700 rounded-xl px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-xs text-blue-400">登入帳號</p>
                    <p className="text-white text-sm font-medium break-all">{rememberedEmail}</p>
                  </div>
                  <button type="button" onClick={switchAdminAccount} className="text-xs text-blue-300 hover:text-white underline underline-offset-2 whitespace-nowrap">換帳號</button>
                  {/* 讓瀏覽器的密碼管理知道是哪個帳號 */}
                  <input type="email" autoComplete="username" value={rememberedEmail} readOnly hidden />
                </div>
              ) : (
                <input id="admin-email" type="email" autoComplete="username" required placeholder="管理員 Email" value={adminEmail} onChange={e => { setAdminEmail(e.target.value); setLoginError(''); }} className={inputCls} />
              )}
              <input id="admin-password" type="password" autoComplete="current-password" required autoFocus={!!rememberedEmail} placeholder="密碼" value={adminPassword} onChange={e => { setAdminPassword(e.target.value); setLoginError(''); }} className={inputCls} />
              {loginError && <p className="text-red-400 text-sm text-center font-medium">{loginError}</p>}
              {authNotice && <p className="text-yellow-300 text-sm text-center font-medium">{authNotice}</p>}
              <button type="submit" disabled={authBusy} className="w-full py-4 bg-red-500 text-white font-bold rounded-xl hover:bg-red-400 transition-colors shadow-lg shadow-red-500/20 disabled:opacity-50">{authBusy ? '登入中…' : '登入後台'}</button>
              <div className="flex justify-between items-center px-1">
                <button type="button" onClick={() => { setResetMode(true); setAuthNotice(''); setLoginError(''); }} className="text-blue-400 text-sm hover:text-white transition-colors">忘記密碼？</button>
                <button type="button" onClick={() => { setView('booking'); setAdminPassword(''); setLoginError(''); setAuthNotice(''); }} className="text-blue-300 text-sm hover:text-white transition-colors">返回預約首頁</button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  if (view === 'admin-panel') {
    let sortedBookings = [...bookings].sort((a, b) => new Date(a.date) - new Date(b.date));

    if (listFilter === 'pending') {
      sortedBookings = sortedBookings.filter(b => !b.isConfirmed);
    } else if (listFilter === 'regular') {
      sortedBookings = sortedBookings.filter(b => !b.isBulk);
    } else if (listFilter === 'bulk') {
      sortedBookings = sortedBookings.filter(b => b.isBulk);
    }

    const pendingCount = bookings.filter(b => !b.isConfirmed).length;

    // 客人名單：依電話整理臨打預約（週期預約為後台建立，不列入）
    const customerMap = {};
    bookings.forEach(b => {
      if (b.isBulk || !isValidPhone(b.userPhone || '')) return;
      if (!customerMap[b.userPhone]) customerMap[b.userPhone] = { phone: b.userPhone, bookings: [] };
      customerMap[b.userPhone].bookings.push(b);
    });
    const customers = Object.values(customerMap).map(c => {
      const byDate = [...c.bookings].sort((a, b) => b.date.localeCompare(a.date) || new Date(b.createdAt) - new Date(a.createdAt));
      return { ...c, bookings: byDate, name: byDate[0].name, lastDate: byDate[0].date, noShows: c.bookings.filter(b => b.noShow).length };
    });
    const noShowsByPhone = Object.fromEntries(customers.map(c => [c.phone, c.noShows]));
    const term = customerSearch.trim().toLowerCase();
    const filteredCustomers = customers
      .filter(c => !term || c.name.toLowerCase().includes(term) || c.phone.includes(term))
      .sort((a, b) => b.bookings.length - a.bookings.length || b.lastDate.localeCompare(a.lastDate));

    const year = calendarDate.getFullYear();
    const month = calendarDate.getMonth();
    const daysInMonth = getDaysInMonth(year, month);
    const firstDay = getFirstDayOfMonth(year, month);
    const calendarDays = [];
    for (let i = 0; i < firstDay; i++) calendarDays.push(null);
    for (let i = 1; i <= daysInMonth; i++) {
      const dStr = getLocalDateString(new Date(year, month, i));
      const count = bookings.filter(b => b.date === dStr).length;
      calendarDays.push({ day: i, dateStr: dStr, count });
    }

    return (
      <div className="min-h-screen bg-blue-900 p-4 sm:p-6 font-sans">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center mb-6 gap-4 bg-blue-950 p-4 rounded-xl border border-blue-800 shadow-lg">
            <div>
              <h2 className="text-2xl font-bold text-yellow-400 flex items-center">
                <i className="fas fa-user-shield mr-2 text-[22px]"></i> 預約管理系統
                <span className="text-sm font-normal text-blue-300 ml-3 bg-blue-900 px-2 py-1 rounded border border-blue-700">
                  身分：{currentAdmin?.role === 'main' ? '主管理員' : '副管理員'}
                </span>
              </h2>
            </div>

            <div className="flex flex-wrap gap-3 w-full lg:w-auto">
              <div className="flex bg-blue-900 rounded-lg p-1 border border-blue-700 w-full sm:w-auto overflow-x-auto">
                <button onClick={() => setAdminTab('list')} className={`flex-1 sm:flex-none flex items-center justify-center px-4 py-2 rounded-md text-sm font-bold transition-all whitespace-nowrap ${adminTab === 'list' ? 'bg-yellow-500 text-blue-950 shadow' : 'text-blue-300 hover:text-white'}`}>
                  <i className="fas fa-list text-[16px] mr-2"></i> 預約列表
                </button>
                <button onClick={() => setAdminTab('calendar')} className={`flex-1 sm:flex-none flex items-center justify-center px-4 py-2 rounded-md text-sm font-bold transition-all whitespace-nowrap ${adminTab === 'calendar' ? 'bg-yellow-500 text-blue-950 shadow' : 'text-blue-300 hover:text-white'}`}>
                  <i className="fas fa-calendar-day text-[16px] mr-2"></i> 檔期表
                </button>
                <button onClick={() => setAdminTab('customers')} className={`flex-1 sm:flex-none flex items-center justify-center px-4 py-2 rounded-md text-sm font-bold transition-all whitespace-nowrap ${adminTab === 'customers' ? 'bg-yellow-500 text-blue-950 shadow' : 'text-blue-300 hover:text-white'}`}>
                  <i className="fas fa-users text-[16px] mr-2"></i> 客人名單
                </button>
                {currentAdmin?.role === 'main' && (
                  <button onClick={() => { setAdminTab('openplay'); setEditingOpCourts(getOpenPlayCourts(opManageDate)); }} className={`flex-1 sm:flex-none flex items-center justify-center px-4 py-2 rounded-md text-sm font-bold transition-all whitespace-nowrap ${adminTab === 'openplay' ? 'bg-yellow-500 text-blue-950 shadow' : 'text-blue-300 hover:text-white'}`}>
                    <BadmintonIcon className="text-[16px] mr-2" /> 暢打管理
                  </button>
                )}
                <button onClick={() => { setAdminTab('settings'); setPwdNotice(''); setShopNotice(''); setShopForm(shop); if (currentAdmin?.role === 'main') loadAdmins(); }} className={`flex-1 sm:flex-none flex items-center justify-center px-4 py-2 rounded-md text-sm font-bold transition-all whitespace-nowrap ${adminTab === 'settings' ? 'bg-yellow-500 text-blue-950 shadow' : 'text-blue-300 hover:text-white'}`}>
                  <i className="fas fa-cog text-[16px] mr-2"></i> 設定
                </button>
              </div>

              {currentAdmin?.role === 'main' && adminTab !== 'settings' && adminTab !== 'openplay' && adminTab !== 'customers' && (
                <button onClick={() => { setBulkConflicts([]); setShowBulkModal(true); }} className="flex-1 sm:flex-none flex items-center justify-center px-4 py-2.5 bg-yellow-500 text-blue-950 font-bold rounded-lg hover:bg-yellow-400 transition-colors shadow-lg">
                  <i className="fas fa-plus-circle text-[18px] mr-1"></i> 新增預約
                </button>
              )}
              <button onClick={handleAdminLogout} className="flex items-center justify-center px-4 py-2.5 bg-blue-800 text-blue-100 rounded-lg hover:bg-blue-700 hover:text-white transition-colors border border-blue-700">
                <i className="fas fa-sign-out-alt text-[18px] mr-1"></i> 退出
              </button>
            </div>
          </div>

          {/* 後台 - 預約列表 */}
          {adminTab === 'list' && (
            <div className="bg-blue-950 rounded-2xl border border-blue-800 overflow-hidden shadow-2xl">
              <div className="bg-blue-900/50 p-4 border-b border-blue-800 flex gap-2 overflow-x-auto custom-scrollbar">
                <button onClick={() => setListFilter('all')} className={`px-4 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-colors ${listFilter === 'all' ? 'bg-yellow-500 text-blue-950' : 'bg-blue-900 border border-blue-700 text-blue-300 hover:text-white'}`}>全部預約</button>
                <button onClick={() => setListFilter('pending')} className={`px-4 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-colors flex items-center ${listFilter === 'pending' ? 'bg-yellow-500 text-blue-950' : 'bg-blue-900 border border-blue-700 text-blue-300 hover:text-white'}`}>
                  待確認
                  {pendingCount > 0 && <span className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] ${listFilter === 'pending' ? 'bg-red-500 text-white' : 'bg-red-500 text-white'}`}>{pendingCount}</span>}
                </button>
                <button onClick={() => setListFilter('regular')} className={`px-4 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-colors ${listFilter === 'regular' ? 'bg-yellow-500 text-blue-950' : 'bg-blue-900 border border-blue-700 text-blue-300 hover:text-white'}`}>臨打預約</button>
                <button onClick={() => setListFilter('bulk')} className={`px-4 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-colors ${listFilter === 'bulk' ? 'bg-yellow-500 text-blue-950' : 'bg-blue-900 border border-blue-700 text-blue-300 hover:text-white'}`}>週期預約</button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm text-blue-100 min-w-[1100px]">
                  <thead className="bg-blue-900 text-yellow-500 font-semibold border-b-2 border-blue-800">
                    <tr>
                      <th className="p-4 whitespace-nowrap w-24">狀態</th>
                      <th className="p-4 whitespace-nowrap">類型</th>
                      <th className="p-4 whitespace-nowrap">日期</th>
                      <th className="p-4">預約時段</th>
                      <th className="p-4 whitespace-nowrap">預約場地</th>
                      <th className="p-4 whitespace-nowrap">預約人姓名</th>
                      <th className="p-4 whitespace-nowrap">聯絡電話</th>
                      <th className="p-4 text-center whitespace-nowrap w-32">匯款後五碼</th>
                      {currentAdmin?.role === 'main' && <th className="p-4 text-center whitespace-nowrap w-20">操作</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-blue-800/50">
                    {sortedBookings.length === 0 ? (
                      <tr><td colSpan="9" className="p-12 text-center text-blue-400 text-lg">此分類下目前尚無紀錄</td></tr>
                    ) : (
                      sortedBookings.map(b => (
                        <tr key={b.id} className={`transition-colors ${b.isConfirmed ? 'bg-green-900/10 hover:bg-green-900/20' : 'hover:bg-blue-900/40'}`}>
                          <td className="p-4">
                            <label className="flex items-center cursor-pointer group">
                              <input type="checkbox" checked={b.isConfirmed} onChange={() => toggleConfirmStatus(b.id)} className="hidden" />
                              <div className={`w-6 h-6 rounded flex items-center justify-center border-2 transition-all mr-2 ${b.isConfirmed ? 'bg-green-500 border-green-500' : 'bg-blue-900 border-blue-600 group-hover:border-yellow-400'}`}>
                                {b.isConfirmed && <i className="fas fa-check text-white text-[16px]"></i>}
                              </div>
                              <span className={`text-xs font-bold ${b.isConfirmed ? 'text-green-400' : 'text-yellow-400 animate-pulse'}`}>{b.isConfirmed ? '已完成' : '待確認'}</span>
                            </label>
                          </td>
                          <td className="p-4">
                            <span className={`px-2 py-1 text-[10px] font-bold rounded ${b.isBulk ? 'bg-purple-900 text-purple-300 border border-purple-700' : 'bg-blue-800 text-blue-300 border border-blue-700'}`}>
                              {b.isBulk ? '週期' : '臨打'}
                            </span>
                          </td>
                          <td className="p-4 font-medium text-white">{b.date}</td>
                          <td className="p-4">
                            <div className="flex flex-wrap gap-2">
                              {b.times.map(t => <span key={t} className="bg-blue-800 border border-blue-700 text-yellow-300 px-2 py-1 rounded shadow-sm text-xs whitespace-nowrap">{displayTime(t)}</span>)}
                            </div>
                          </td>
                          <td className="p-4 text-blue-200">第 <span className="text-white font-bold">{Array.isArray(b.court) ? b.court.join(', ') : b.court}</span> 場地</td>
                          <td className="p-4 font-medium">
                            {b.name}
                            {noShowsByPhone[b.userPhone] > 0 && <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-900 text-red-300 border border-red-700 whitespace-nowrap" title="此電話的爽約紀錄">爽約 {noShowsByPhone[b.userPhone]} 次</span>}
                          </td>
                          <td className="p-4 font-mono text-blue-300">{b.userPhone || '無'}</td>
                          <td className="p-4 text-center">
                            {b.transferCode ? (
                              <span className="font-mono font-bold text-yellow-400 bg-blue-900 border border-blue-700 px-3 py-1 rounded tracking-widest">{b.transferCode}</span>
                            ) : <span className="text-blue-600 text-xs bg-blue-900/50 px-2 py-1 rounded">無 (後台建立)</span>}
                          </td>
                          {currentAdmin?.role === 'main' && (
                            <td className="p-4 text-center">
                              <button onClick={() => deleteBooking(b.id)} className="p-2 text-red-400 hover:bg-red-500 hover:text-white rounded-lg transition-all inline-flex items-center shadow-sm" title="刪除"><i className="fas fa-trash-alt text-[18px]"></i></button>
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 後台 - 客人名單 */}
          {adminTab === 'customers' && (
            <div className="bg-blue-950 rounded-2xl border border-blue-800 overflow-hidden shadow-2xl">
              <div className="p-4 border-b border-blue-800 bg-blue-900/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="relative w-full max-w-sm">
                  <i className="fas fa-search absolute left-3 top-3 text-blue-400"></i>
                  <input id="customer-search" type="text" placeholder="輸入姓名或手機號碼搜尋..." value={customerSearch} onChange={e => setCustomerSearch(e.target.value)} className="w-full bg-blue-950 border border-blue-700 rounded-lg pl-10 pr-4 py-2 text-white focus:border-yellow-400 focus:outline-none placeholder-blue-600" />
                </div>
                <p className="text-xs text-blue-300">共 {customers.length} 位客人 · 點一列查看預約並標記爽約</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm text-blue-100 min-w-[720px]">
                  <thead className="bg-blue-900 text-yellow-500 font-semibold border-b-2 border-blue-800">
                    <tr>
                      <th className="p-4 whitespace-nowrap">姓名</th>
                      <th className="p-4 whitespace-nowrap">手機號碼</th>
                      <th className="p-4 text-center whitespace-nowrap">預約次數</th>
                      <th className="p-4 whitespace-nowrap">最近預約日期</th>
                      <th className="p-4 text-center whitespace-nowrap">爽約</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-blue-800/50">
                    {filteredCustomers.length === 0 ? (
                      <tr><td colSpan="5" className="p-12 text-center text-blue-400 text-lg">{customers.length === 0 ? '還沒有客人預約過' : '找不到符合的客人'}</td></tr>
                    ) : filteredCustomers.map(c => (
                      <React.Fragment key={c.phone}>
                        <tr onClick={() => setExpandedPhone(expandedPhone === c.phone ? null : c.phone)} className={`cursor-pointer transition-colors ${expandedPhone === c.phone ? 'bg-blue-900/60' : 'hover:bg-blue-900/40'}`}>
                          <td className="p-4 font-bold text-white">{expandedPhone === c.phone ? <i className="fas fa-chevron-down mr-2 text-blue-400 text-[12px]"></i> : <i className="fas fa-chevron-right mr-2 text-blue-400 text-[12px]"></i>}{c.name}</td>
                          <td className="p-4 font-mono text-blue-200">{c.phone}</td>
                          <td className="p-4 text-center"><span className="bg-blue-800 text-yellow-400 px-3 py-1 rounded-full font-bold text-xs">{c.bookings.length} 次</span></td>
                          <td className="p-4 text-blue-300">{c.lastDate}</td>
                          <td className="p-4 text-center">
                            {c.noShows > 0
                              ? <span className="px-2 py-1 rounded text-xs font-bold bg-red-900 text-red-300 border border-red-700">{c.noShows} 次</span>
                              : <span className="text-blue-600 text-xs">—</span>}
                          </td>
                        </tr>
                        {expandedPhone === c.phone && (
                          <tr className="bg-blue-900/30">
                            <td colSpan="5" className="p-4">
                              <div className="space-y-2">
                                {c.bookings.map(b => {
                                  const canMark = b.date <= todayString;
                                  return (
                                    <div key={b.id} className={`flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg border ${b.noShow ? 'bg-red-950/40 border-red-800' : 'bg-blue-950/60 border-blue-800'}`}>
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-medium text-white">{b.date}</span>
                                        <span className="text-blue-300">第 {b.court.join(', ')} 場地</span>
                                        {b.times.map(t => <span key={t} className="bg-blue-800 border border-blue-700 text-yellow-300 px-2 py-0.5 rounded text-xs whitespace-nowrap">{displayTime(t)}</span>)}
                                        <span className={`text-xs font-bold ${b.isConfirmed ? 'text-green-400' : 'text-yellow-400'}`}>{b.isConfirmed ? '已確認' : '待確認'}</span>
                                        <span className="text-xs font-mono text-blue-400">後五碼 {b.transferCode}</span>
                                      </div>
                                      {canMark ? (
                                        <button onClick={() => toggleNoShow(b.id)} className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${b.noShow ? 'bg-red-500 border-red-400 text-white hover:bg-red-400' : 'bg-blue-900 border-blue-600 text-blue-200 hover:border-red-400 hover:text-red-300'}`}>
                                          {b.noShow ? '已標記爽約（點此取消）' : '標記爽約'}
                                        </button>
                                      ) : <span className="text-xs text-blue-500">尚未到預約日</span>}
                                    </div>
                                  );
                                })}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 後台 - 檔期表 */}
          {adminTab === 'calendar' && (
            <div className="flex flex-col xl:flex-row gap-6 animate-in fade-in">
              <div className="w-full xl:w-1/3 bg-blue-950 rounded-2xl border border-blue-800 p-5 shadow-2xl h-fit">
                <div className="flex justify-between items-center mb-6">
                  <button onClick={prevMonth} className="p-2 bg-blue-900 hover:bg-yellow-500 hover:text-blue-950 text-blue-300 rounded-lg transition-colors"><i className="fas fa-chevron-left text-[20px]"></i></button>
                  <h3 className="text-lg font-bold text-white">{year} 年 {month + 1} 月</h3>
                  <button onClick={nextMonth} className="p-2 bg-blue-900 hover:bg-yellow-500 hover:text-blue-950 text-blue-300 rounded-lg transition-colors"><i className="fas fa-chevron-right text-[20px]"></i></button>
                </div>

                <div className="grid grid-cols-7 gap-2 mb-2 text-center text-xs font-bold text-blue-400">
                  <div>日</div><div>一</div><div>二</div><div>三</div><div>四</div><div>五</div><div>六</div>
                </div>
                <div className="grid grid-cols-7 gap-2">
                  {calendarDays.map((item, idx) => {
                    if (!item) return <div key={`empty-${idx}`} className="p-2"></div>;
                    const isSelected = selectedGridDate === item.dateStr;
                    const isToday = item.dateStr === todayString;
                    return (
                      <button
                        key={item.dateStr} onClick={() => setSelectedGridDate(item.dateStr)}
                        className={`relative aspect-square flex flex-col items-center justify-center rounded-xl border-2 transition-all p-1
                          ${isSelected ? 'bg-yellow-500 border-yellow-400 text-blue-950 shadow-md scale-105 z-10' : 'bg-blue-900/50 border-blue-800/50 text-white hover:border-yellow-500 hover:bg-blue-800'}`}
                      >
                        <span className={`text-sm font-bold ${isToday && !isSelected ? 'text-yellow-400' : ''}`}>{item.day}</span>
                        {item.count > 0 && <span className={`text-[10px] mt-1 px-1.5 rounded-full font-bold ${isSelected ? 'bg-blue-900 text-yellow-400' : 'bg-yellow-500 text-blue-950'}`}>{item.count} 筆</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="w-full xl:w-2/3 bg-blue-950 rounded-2xl border border-blue-800 shadow-2xl overflow-hidden flex flex-col">
                <div className="p-5 border-b border-blue-800 bg-blue-900/40 flex justify-between items-center">
                  <h3 className="text-xl font-bold text-yellow-400 flex items-center">
                    <i className="fas fa-calendar-day mr-2 text-[16px]"></i> {selectedGridDate} 檔期表
                  </h3>
                  <div className="flex gap-4 text-xs font-medium flex-wrap justify-end">
                    <span className="flex items-center text-blue-200"><div className="w-3 h-3 bg-blue-900 border border-blue-700 rounded mr-1"></div> 空閒</span>
                    <span className="flex items-center text-purple-300"><div className="w-3 h-3 bg-purple-900 border border-purple-500 rounded mr-1"></div> 暢打</span>
                    <span className="flex items-center text-yellow-400"><div className="w-3 h-3 bg-yellow-900/50 border border-yellow-600 rounded mr-1"></div> 待確認</span>
                    <span className="flex items-center text-green-400"><div className="w-3 h-3 bg-green-900/50 border border-green-500 rounded mr-1"></div> 已確認</span>
                  </div>
                </div>

                <div className="overflow-x-auto overflow-y-auto max-h-[700px] custom-scrollbar relative">
                  <table className="w-full text-center border-collapse min-w-[600px]">
                    <thead className="bg-blue-900 sticky top-0 z-10 shadow-md">
                      <tr>
                        <th className="p-3 text-blue-300 font-bold border-b-2 border-blue-700 w-24 bg-blue-900">時間</th>
                        {[1, 2, 3, 4].map(c => (
                          <th key={c} className="p-3 text-yellow-500 font-bold border-b-2 border-blue-700 bg-blue-900">第 {c} 場地</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {allTimeSlots.map(time => {
                        return (
                          <tr key={time} className="hover:bg-blue-900/30 transition-colors border-b border-blue-800/50">
                            <td className="p-3 font-medium text-blue-200 bg-blue-900/20 whitespace-nowrap text-sm border-r border-blue-800/50">{displayTime(time)}</td>
                            {[1, 2, 3, 4].map(court => {
                              const courtStr = court.toString();

                              const isBlocked = isCourtBlockedByOpenPlay(selectedGridDate, time, courtStr);
                              const booking = bookings.find(b => {
                                const courtArray = Array.isArray(b.court) ? b.court : [b.court];
                                return b.date === selectedGridDate && b.times.includes(time) && courtArray.includes(courtStr);
                              });

                              return (
                                <td key={`${time}-${court}`} className="p-2 border-r border-blue-800/50 last:border-0 relative h-16">
                                  {isBlocked ? (
                                    <div className="w-full h-full flex flex-col justify-center items-center rounded-lg border bg-purple-900/40 border-purple-500/50 text-purple-300 shadow-sm p-1">
                                      <BadmintonIcon className="text-[16px] mb-1 opacity-80" />
                                      <span className="font-bold text-xs">暢打保留</span>
                                    </div>
                                  ) : booking ? (
                                    <div className={`w-full h-full flex flex-col justify-center items-center rounded-lg border shadow-sm p-1 ${booking.isConfirmed ? 'bg-green-900/30 border-green-500/50 text-green-300' : 'bg-yellow-900/30 border-yellow-600/50 text-yellow-400'}`}>
                                      <span className="font-bold text-sm truncate max-w-[100px]" title={booking.name}>{booking.name}</span>
                                      {booking.isConfirmed ? <i className="fas fa-check mt-1 opacity-70 text-[14px]"></i> : <i className="fas fa-clock mt-1 opacity-70 text-[14px]"></i>}
                                    </div>
                                  ) : (
                                    <div className="w-full h-full rounded-lg border border-transparent flex items-center justify-center"><span className="text-blue-800/50 text-xs font-bold select-none">-</span></div>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* 後台 - 暢打與包場管理 (僅主管理員) */}
          {adminTab === 'openplay' && currentAdmin?.role === 'main' && (
            <div className="bg-blue-950 rounded-2xl border border-blue-800 p-6 shadow-2xl animate-in fade-in space-y-6">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-blue-800 pb-4">
                <div>
                  <h3 className="text-xl font-bold text-yellow-400 flex items-center mb-1">
                    <BadmintonIcon className="text-[22px] mr-2" /> 暢打與包場設定
                  </h3>
                  <p className="text-sm text-blue-300">手動調整每日保留給「暢打」的場地數量。遇到全館包場時，可一鍵取消該日暢打。</p>
                </div>
              </div>

              <div className="bg-blue-900/40 p-5 rounded-xl border border-blue-700/50">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <label className="block text-sm font-bold text-blue-200 mb-2">1. 選擇要調整的日期</label>
                    <input type="date" value={opManageDate} onChange={e => {
                        setOpManageDate(e.target.value);
                        setEditingOpCourts(getOpenPlayCourts(e.target.value));
                    }} className="w-full bg-blue-950 border border-blue-600 rounded-lg p-3 text-white focus:outline-none focus:border-yellow-400 cursor-pointer [color-scheme:dark]" />
                    <div className="mt-3 bg-blue-950/80 p-3 rounded-lg border border-blue-800">
                      <p className="text-sm text-blue-200">
                        <span className="font-bold text-yellow-400">該日暢打時段：</span>
                        {getOpenPlayTimes(opManageDate).map(t => displayTime(t)).join(', ')}
                      </p>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between items-end mb-3">
                      <label className="block text-sm font-bold text-blue-200">2. 勾選當日要保留做「暢打」的場地</label>
                      <button onClick={() => setEditingOpCourts([])} className="px-3 py-1.5 bg-red-950/80 text-red-400 border border-red-800 rounded-lg hover:bg-red-500 hover:text-white transition-colors text-xs font-bold flex items-center shadow-sm">
                        <i className="fas fa-ban mr-1"></i> 全部取消 (包場模式)
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-3 mb-4">
                      {[1, 2, 3, 4].map(court => {
                        const cStr = court.toString();
                        const isSelected = editingOpCourts.includes(cStr);
                        const isBookedByUser = bookings.some(b => b.date === opManageDate && b.court.includes(cStr) && b.times.some(t => getOpenPlayTimes(opManageDate).includes(t)));

                        return (
                          <label key={court} className={`relative flex flex-col items-center justify-center p-4 rounded-xl border-2 cursor-pointer transition-all ${isSelected ? 'bg-purple-900/50 border-purple-400 shadow-md' : 'bg-blue-900/50 border-blue-700 hover:border-purple-400'}`}>
                            <input type="checkbox" checked={isSelected} className="hidden" onChange={() => {
                              if (isSelected) setEditingOpCourts(editingOpCourts.filter(c => c !== cStr));
                              else setEditingOpCourts([...editingOpCourts, cStr].sort());
                            }} />
                            <span className={`text-lg font-bold mb-1 ${isSelected ? 'text-purple-300' : 'text-blue-200'}`}>第 {court} 場地</span>
                            <div className={`w-5 h-5 rounded-md border flex items-center justify-center transition-colors ${isSelected ? 'bg-purple-500 border-purple-400' : 'bg-blue-950 border-blue-600'}`}>
                              {isSelected && <i className="fas fa-check text-white text-xs"></i>}
                            </div>
                            {isBookedByUser && <span className="absolute top-1 right-1 text-[10px] bg-red-900 text-red-300 px-1.5 rounded-full border border-red-800">已被預約</span>}
                          </label>
                        );
                      })}
                    </div>

                    <button onClick={async () => {
                      const { error } = await db.from('open_play_overrides').upsert({ date: opManageDate, courts: [...editingOpCourts].sort() });
                      refreshAll();
                      if (error) { alert(errorText(error)); return; }
                      alert(`${opManageDate} 暢打保留場地設定成功！`);
                    }} className="w-full py-3 bg-yellow-500 text-blue-950 font-bold rounded-xl hover:bg-yellow-400 transition-shadow shadow-lg flex items-center justify-center">
                      <i className="fas fa-save mr-2 text-[18px]"></i> 儲存此日設定
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 後台 - 設定 */}
          {adminTab === 'settings' && (
            <div className="bg-blue-950 rounded-2xl border border-blue-800 p-6 shadow-2xl space-y-6">
              <h3 className="text-xl font-bold text-yellow-400 flex items-center border-b border-blue-800 pb-4">
                <i className="fas fa-cog mr-2 text-[22px]"></i> 設定
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <form onSubmit={handlePasswordUpdate} className="bg-blue-900/40 p-5 rounded-xl border border-blue-700/50 space-y-4">
                  <h4 className="text-white font-bold flex items-center"><i className="fas fa-key text-yellow-500 mr-2"></i> 修改我的密碼</h4>
                  <p className="text-xs text-blue-300 break-all">登入帳號：{currentAdmin?.email}</p>
                  <div>
                    <label htmlFor="settings-new-password" className="block text-sm text-blue-200 mb-1">新密碼（至少 8 碼）</label>
                    <input id="settings-new-password" type="password" autoComplete="new-password" value={newPassword} onChange={e => { setNewPassword(e.target.value); setPwdNotice(''); }} className="w-full bg-blue-950 border border-blue-600 rounded-lg p-3 text-white focus:outline-none focus:border-yellow-400" />
                  </div>
                  <div>
                    <label htmlFor="settings-new-password-2" className="block text-sm text-blue-200 mb-1">再輸入一次新密碼</label>
                    <input id="settings-new-password-2" type="password" autoComplete="new-password" value={newPassword2} onChange={e => { setNewPassword2(e.target.value); setPwdNotice(''); }} className="w-full bg-blue-950 border border-blue-600 rounded-lg p-3 text-white focus:outline-none focus:border-yellow-400" />
                  </div>
                  {pwdNotice && <p className="text-yellow-300 text-sm font-medium">{pwdNotice}</p>}
                  <button type="submit" disabled={authBusy} className="w-full py-2.5 bg-yellow-500 text-blue-950 font-bold rounded-lg hover:bg-yellow-400 disabled:opacity-50">{authBusy ? '儲存中…' : '儲存新密碼'}</button>
                </form>

                {currentAdmin?.role === 'main' && (
                  <div className="bg-blue-900/40 p-5 rounded-xl border border-blue-700/50 space-y-4">
                    <h4 className="text-white font-bold flex items-center"><i className="fas fa-users text-yellow-500 mr-2"></i> 副管理員</h4>
                    <p className="text-xs text-blue-300 leading-relaxed">副管理員可以查看預約、勾選確認與標記爽約，不能刪除預約、建立週期預約或修改暢打設定。<br />新增方式：先到 Supabase 後台「Authentication → Users → Add user」幫員工建立 Email 與密碼，再在下面輸入那個 Email。</p>
                    <ul className="space-y-2">
                      {admins.map(a => (
                        <li key={a.email} className="flex items-center justify-between gap-2 bg-blue-950/60 border border-blue-800 rounded-lg px-3 py-2 text-sm">
                          <span className="text-white break-all">{a.email}</span>
                          {a.role === 'main'
                            ? <span className="text-xs text-yellow-400 font-bold whitespace-nowrap">主管理員</span>
                            : <button onClick={() => revokeSubAdmin(a.email)} className="text-xs px-2 py-1 rounded bg-red-900 text-red-300 border border-red-700 hover:bg-red-700 hover:text-white whitespace-nowrap">移除</button>}
                        </li>
                      ))}
                    </ul>
                    <form onSubmit={grantSubAdmin} className="flex gap-2">
                      <input id="sub-admin-email" type="email" required placeholder="員工的 Email" value={subEmail} onChange={e => setSubEmail(e.target.value)} className="flex-1 min-w-0 bg-blue-950 border border-blue-600 rounded-lg p-2.5 text-white focus:outline-none focus:border-yellow-400" />
                      <button type="submit" className="px-4 py-2 bg-yellow-500 text-blue-950 font-bold rounded-lg hover:bg-yellow-400 whitespace-nowrap">加入</button>
                    </form>
                  </div>
                )}

                {currentAdmin?.role === 'main' && (
                  <form onSubmit={saveShop} className="bg-blue-900/40 p-5 rounded-xl border border-blue-700/50 space-y-4 md:col-span-2">
                    <h4 className="text-white font-bold flex items-center"><i className="fas fa-money-bill-wave text-yellow-500 mr-2"></i> 店家資訊</h4>
                    <p className="text-xs text-blue-300">顯示在客人預約頁的匯款資訊與聯絡電話。更換帳號時改這裡即可。</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                      {[
                        ['bankCode', 'shop-bank-code', '銀行代碼', 'numeric'],
                        ['bankName', 'shop-bank-name', '銀行名稱', 'text'],
                        ['accountNumber', 'shop-account', '轉入帳號', 'numeric'],
                        ['contactPhone', 'shop-phone', '聯絡電話', 'tel'],
                      ].map(([key, id, label, mode]) => (
                        <div key={key}>
                          <label htmlFor={id} className="block text-sm text-blue-200 mb-1">{label}</label>
                          <input id={id} type="text" inputMode={mode} value={shopForm[key]} onChange={e => { setShopForm({ ...shopForm, [key]: e.target.value }); setShopNotice(''); }} className="w-full bg-blue-950 border border-blue-600 rounded-lg p-3 text-white font-mono focus:outline-none focus:border-yellow-400" />
                        </div>
                      ))}
                    </div>
                    {shopNotice && <p className="text-yellow-300 text-sm font-medium">{shopNotice}</p>}
                    <button type="submit" className="w-full sm:w-auto px-6 py-2.5 bg-yellow-500 text-blue-950 font-bold rounded-lg hover:bg-yellow-400">儲存店家資訊</button>
                  </form>
                )}
              </div>
            </div>
          )}

        </div>

        {/* 後台 MODAL: 新增預約（單次 / 週期） */}
        {showBulkModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm custom-scrollbar overflow-y-auto">
            <div className="bg-blue-950 w-full max-w-2xl rounded-2xl border border-blue-700 shadow-2xl my-8 relative">
              <div className="p-5 border-b border-blue-800 flex justify-between items-center bg-blue-900/50 rounded-t-2xl">
                <h3 className="text-xl font-bold text-yellow-400 flex items-center">
                  <i className="fas fa-calendar-alt mr-2 text-[22px]"></i> 新增預約
                </h3>
                <button onClick={() => setShowBulkModal(false)} className="text-blue-300 hover:text-white bg-blue-900 hover:bg-red-500 rounded-full p-1.5 transition-colors"><i className="fas fa-times text-[20px]"></i></button>
              </div>

              <div className="p-6 space-y-5">
                <div className="grid grid-cols-2 gap-2 bg-blue-900 rounded-lg p-1 border border-blue-700" role="radiogroup" aria-label="預約類型">
                  {[['single', '單次（指定一天）'], ['bulk', '週期（月繳、季繳…）']].map(([mode, label]) => (
                    <button key={mode} type="button" role="radio" aria-checked={bulkData.mode === mode} onClick={() => { setBulkData({ ...bulkData, mode }); setBulkConflicts([]); }} className={`py-2.5 rounded-md text-sm font-bold transition-all ${bulkData.mode === mode ? 'bg-yellow-500 text-blue-950 shadow' : 'text-blue-300 hover:text-white'}`}>
                      {label}
                    </button>
                  ))}
                </div>
                {bulkData.mode === 'single' && <p className="text-xs text-blue-300 -mt-2">例如電話預約：不限 7 天內、不需匯款後五碼，建立後直接是「已確認」，在列表中顯示為臨打。</p>}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="admin-booking-name" className="block text-sm font-medium text-blue-200 mb-1.5">預約人姓名 / 標籤</label>
                    <input id="admin-booking-name" type="text" placeholder={bulkData.mode === 'single' ? '例：陳先生' : '例：王先生-季繳'} value={bulkData.name} onChange={e => setBulkData({...bulkData, name: e.target.value})} className="w-full bg-blue-900 border border-blue-700 rounded-lg p-3 text-white focus:border-yellow-400 focus:outline-none" />
                  </div>
                  {bulkData.mode === 'single' ? (
                  <div>
                    <label htmlFor="admin-booking-phone" className="block text-sm font-medium text-blue-200 mb-1.5">電話 <span className="text-blue-400 text-xs">(選填)</span></label>
                    <input id="admin-booking-phone" type="tel" inputMode="tel" placeholder="例：0912345678" value={bulkData.phone} onChange={e => setBulkData({...bulkData, phone: e.target.value})} className="w-full bg-blue-900 border border-blue-700 rounded-lg p-3 text-white font-mono focus:border-yellow-400 focus:outline-none" />
                  </div>
                  ) : (
                  <div>
                    <label className="block text-sm font-medium text-blue-200 mb-1.5">繳費週期</label>
                    <select value={bulkData.weeks} onChange={e => setBulkData({...bulkData, weeks: parseInt(e.target.value)})} className="w-full bg-blue-900 border border-blue-700 rounded-lg p-3 text-white focus:border-yellow-400 focus:outline-none cursor-pointer">
                      <option value={4}>月繳 (4週)</option>
                      <option value={12}>季繳 (12週)</option>
                      <option value={24}>半年繳 (24週)</option>
                      <option value={48}>年繳 (48週)</option>
                    </select>
                  </div>
                  )}
                </div>

                <div>
                  <label htmlFor="admin-booking-date" className="block text-sm font-medium text-blue-200 mb-1.5">{bulkData.mode === 'single' ? '預約日期' : '首次預約日期'}</label>
                  <input id="admin-booking-date" type="date" min={todayString} value={bulkData.startDate} onChange={e => setBulkData({...bulkData, startDate: e.target.value})} className="w-full bg-blue-900 border border-blue-700 rounded-lg p-3 text-white focus:border-yellow-400 focus:outline-none [color-scheme:dark] cursor-pointer" />
                </div>

                <div>
                  <label className="block text-sm font-medium text-blue-200 mb-2">預約時段 (可複選)</label>
                  <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 max-h-48 overflow-y-auto custom-scrollbar pr-2">
                    {allTimeSlots.map(time => {
                      const selected = bulkData.times.includes(time);
                      return (
                        <button key={time} type="button" onClick={() => {
                          const newTimes = selected ? bulkData.times.filter(t => t !== time) : [...bulkData.times, time];
                          setBulkData({...bulkData, times: newTimes});
                        }} className={`py-2 px-1 rounded-lg border text-xs font-medium transition-colors ${selected ? 'bg-yellow-500 border-yellow-400 text-blue-950' : 'bg-blue-900 border-blue-700 text-blue-100 hover:border-yellow-400'}`}>
                          {displayTime(time)}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-blue-200 mb-2">預約場地 (可複選)</label>
                  <div className="flex gap-3">
                    {[1, 2, 3, 4].map(c => {
                      const cStr = c.toString();
                      const selected = bulkData.courts.includes(cStr);
                      return (
                        <button key={c} type="button" onClick={() => {
                          const newCourts = selected ? bulkData.courts.filter(court => court !== cStr) : [...bulkData.courts, cStr];
                          setBulkData({...bulkData, courts: newCourts});
                        }} className={`flex-1 py-3 rounded-lg border-2 font-bold transition-all ${selected ? 'bg-yellow-500 border-yellow-400 text-blue-950' : 'bg-blue-900 border-blue-700 text-white hover:border-yellow-400'}`}>
                          第 {c} 場
                        </button>
                      );
                    })}
                  </div>
                </div>

                {bulkConflicts.length > 0 && (
                  <div className="bg-red-950/50 border border-red-800 rounded-lg p-4">
                    <h4 className="text-red-400 font-bold flex items-center mb-2"><i className="fas fa-exclamation-triangle mr-1 text-[18px]"></i> 建立失敗：發現時段衝突！</h4>
                    <p className="text-sm text-red-200 mb-2">以下日期/場地已被其他人預約(或被設定為暢打)，請手動調整或清理後再試：</p>
                    <ul className="text-xs text-red-300 list-disc list-inside max-h-24 overflow-y-auto custom-scrollbar">
                      {bulkConflicts.map((msg, i) => <li key={i}>{msg}</li>)}
                    </ul>
                  </div>
                )}
              </div>

              <div className="p-5 border-t border-blue-800 flex justify-end gap-3 bg-blue-900/30 rounded-b-2xl">
                <button onClick={() => setShowBulkModal(false)} className="px-5 py-2 rounded-lg text-blue-200 hover:text-white hover:bg-blue-800 transition-colors">取消</button>
                <button onClick={handleBulkSubmit} className="px-6 py-2 bg-yellow-500 text-blue-950 font-bold rounded-lg hover:bg-yellow-400 transition-colors shadow-lg">{bulkData.mode === 'single' ? '建立預約' : `自動產生 ${bulkData.weeks} 筆預約`}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const stepsTitle = ['選擇日期', '選擇時間', '選擇場地', '確認資料'];

  return (
    <div className="min-h-screen bg-blue-900 font-sans selection:bg-yellow-500 selection:text-blue-900">
      {siteHeader('booking')}

      <main className="max-w-lg mx-auto p-4 sm:p-6 pb-24">
        <div>
          <div className="text-center mb-8 mt-4">
            <h2 className="text-3xl font-extrabold text-white mb-2 tracking-wide drop-shadow-md">線上預約系統</h2>
            <p className="text-blue-300 text-sm">請依序完成預約步驟。</p>
          </div>

          <div className="flex justify-between mb-8 relative px-2">
            <div className="absolute top-4 left-6 right-6 h-0.5 bg-blue-800 -z-10"></div>
            <div className="absolute top-4 left-6 h-0.5 bg-yellow-500 transition-all duration-300 -z-10" style={{ width: `${((step - 1) / 3) * 100}%`, maxWidth: 'calc(100% - 3rem)' }}></div>
            {stepsTitle.map((s, i) => (
              <div key={i} className="flex flex-col items-center w-1/4">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shadow-md transition-colors duration-300 ${step > i + 1 || step === i + 1 ? 'bg-yellow-500 text-blue-950 ring-4 ring-blue-900' : 'bg-blue-900 text-blue-400 border-2 border-blue-700'}`}>
                  {step > i + 1 ? <i className="fas fa-check text-[16px]"></i> : i + 1}
                </div>
                <span className={`text-xs mt-2 transition-colors duration-300 ${step === i + 1 ? 'text-yellow-400 font-bold' : 'text-blue-300'}`}>{s}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={`bg-blue-950/60 rounded-3xl shadow-2xl border border-blue-800/60 backdrop-blur-sm p-6 sm:p-8 min-h-[350px]`}>

          {step === 1 && (
            <div className="space-y-6 animate-in fade-in zoom-in-95 duration-300">
              <div className="flex items-center justify-between border-b border-blue-800 pb-3">
                <h3 className="text-xl font-bold text-yellow-400 flex items-center"><i className="fas fa-calendar-alt mr-2 text-[22px]"></i> 選擇預約日期</h3>
              </div>
              <div className="bg-blue-900/50 p-4 rounded-xl border border-blue-800/50">
                <input type="date" min={todayString} max={maxDateString} value={bookingData.date} onChange={(e) => setBookingData({ ...bookingData, date: e.target.value, times: [], court: [] })} className="w-full bg-blue-950 border-2 border-blue-700 rounded-xl p-4 text-xl text-white font-medium focus:outline-none focus:border-yellow-400 cursor-pointer shadow-inner [color-scheme:dark] transition-colors hover:border-blue-500" />
              </div>
              <div className="bg-blue-900/30 rounded-lg p-3 border-l-4 border-yellow-500">
                <p className="text-sm text-blue-200 leading-relaxed">
                  <span className="text-yellow-400 font-bold">• 臨打預約僅開放未來一週內</span><br/>
                  • 周一到周五：9:00～22:00<br/>
                  • 週六、周日：7:00～22:00
                </p>
              </div>
              <button type="button" onClick={() => setView('schedule')} className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-blue-600 text-blue-100 font-bold hover:bg-blue-800 transition-colors">
                <i className="fas fa-calendar-alt text-[16px]"></i> 先看一週場地狀況
              </button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5 animate-in fade-in zoom-in-95 duration-300">
              <div className="flex items-center justify-between border-b border-blue-800 pb-3">
                <h3 className="text-xl font-bold text-yellow-400 flex items-center"><i className="fas fa-clock mr-2 text-[22px]"></i> 選擇時間段</h3>
                <span className="text-sm bg-blue-900 text-blue-300 px-2 py-1 rounded-md">{bookingData.date}</span>
              </div>
              <p className="text-sm font-medium text-yellow-400 text-center bg-yellow-500/10 py-2 rounded-lg border border-yellow-500/20">💡 選擇多個連續時段更方便安排～</p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 max-h-[280px] overflow-y-auto pr-2 custom-scrollbar">
                {getAvailableTimes(bookingData.date).map(t => {
                  const fullyBooked = isTimeFullyBooked(t.value);
                  const disabled = t.isPast || fullyBooked;
                  const selected = bookingData.times.includes(t.value);
                  return (
                    <button key={t.value} disabled={disabled} onClick={() => toggleTime(t.value)} className={`relative py-3 px-1 rounded-xl border-2 text-sm font-medium transition-all ${disabled ? 'bg-blue-950 border-blue-900 text-blue-600 cursor-not-allowed' : selected ? 'bg-yellow-500 border-yellow-400 text-blue-950 shadow-md' : 'bg-blue-900/60 border-blue-700 text-blue-100 hover:border-yellow-400 hover:text-yellow-400'}`}>
                      {t.label}
                      {fullyBooked && <span className="absolute inset-0 bg-blue-950/80 rounded-xl flex items-center justify-center text-xs font-bold text-red-400 border border-red-900/50 backdrop-blur-[1px]">時段已滿</span>}
                      {t.isPast && !fullyBooked && <span className="absolute inset-0 bg-blue-950/80 rounded-xl flex items-center justify-center text-xs font-bold text-blue-500 border border-blue-800 backdrop-blur-[1px]">已過去</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6 animate-in fade-in zoom-in-95 duration-300">
              <div className="flex items-center justify-between border-b border-blue-800 pb-3">
                <h3 className="text-xl font-bold text-yellow-400 flex items-center"><i className="fas fa-map-marker-alt mr-2 text-[22px]"></i> 選擇場地</h3>
                <div className="text-right text-xs text-blue-300"><div>{bookingData.date}</div><div>已選 {bookingData.times.length} 個時段</div></div>
              </div>
              <div className="bg-blue-900/30 rounded-lg p-3 mb-4">
                <p className="text-sm text-blue-200">您可以 <span className="text-yellow-400 font-bold">點選多個場地</span>，被設定為暢打或已有人預約的場地將無法點選。</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                {[1, 2, 3, 4].map(court => {
                  const available = isCourtAvailable(court);
                  const selected = bookingData.court.includes(court.toString());

                  // 檢查這個場地是否因為暢打而被鎖
                  let blockedByOp = false;
                  for (const t of bookingData.times) {
                    if (isCourtBlockedByOpenPlay(bookingData.date, t, court.toString())) blockedByOp = true;
                  }

                  return (
                    <button key={court} disabled={!available} onClick={() => toggleCourt(court)} className={`relative overflow-hidden py-6 rounded-2xl border-2 text-lg font-bold transition-all duration-200 ${!available ? 'bg-blue-950 border-blue-900 text-blue-600 cursor-not-allowed opacity-80' : selected ? 'bg-yellow-500 border-yellow-400 text-blue-950 shadow-[0_0_15px_rgba(234,179,8,0.3)] scale-[1.02]' : 'bg-blue-900/60 border-blue-700 text-white hover:border-yellow-500/50 hover:bg-blue-800'}`}>
                      第 {court} 場地
                      {selected && <i className="fas fa-check-circle absolute top-2 right-2 text-blue-900 text-[18px]"></i>}
                      {!available && (
                        <div className="absolute inset-0 bg-blue-950/80 flex flex-col items-center justify-center border-2 border-red-900/40 backdrop-blur-[2px]">
                          {blockedByOp ? (
                            <span className="text-sm font-bold bg-purple-900/80 text-purple-300 px-3 py-1 rounded-full border border-purple-700 flex items-center">
                              <BadmintonIcon className="text-[14px] mr-1" /> 暢打保留
                            </span>
                          ) : (
                            <span className="text-sm font-bold bg-red-950/80 text-red-400 px-3 py-1 rounded-full border border-red-800">已被預約</span>
                          )}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-5 animate-in fade-in zoom-in-95 duration-300">
              <h3 className="text-xl font-bold text-yellow-400 flex items-center border-b border-blue-800 pb-3"><i className="fas fa-user mr-2 text-[24px]"></i> 確認並填寫資料</h3>

              {/* === 動態計算訂金金額區塊 === */}
              <div className="bg-blue-900/40 p-4 rounded-xl border border-blue-700/50 shadow-inner mb-4">
                <h4 className="text-white font-semibold mb-3 flex items-center text-sm">
                  <i className="fas fa-money-bill-wave text-yellow-500 mr-2"></i> 匯款資訊
                </h4>
                <div className="text-sm text-blue-200 space-y-1.5">
                  <p>銀行代碼：<span className="text-white font-bold text-base ml-1">{shop.bankCode} ({shop.bankName})</span></p>
                  <p>轉入帳號：<span className="text-yellow-400 font-bold tracking-widest text-lg ml-1 break-all">{shop.accountNumber}</span></p>
                  <div className="text-sm text-blue-100 mt-2 border-t border-blue-800/50 pt-2 bg-blue-950/50 p-3 rounded-lg border border-blue-800">
                    <div className="flex justify-between items-center">
                      <span>本次應付訂金：</span>
                      <span className="text-xl font-bold text-red-400">NT$ {bookingData.court.length * bookingData.times.length * 100}</span>
                    </div>
                    <p className="text-xs text-blue-400 mt-1 text-right">
                      (計算方式：{bookingData.court.length} 場地 × {bookingData.times.length} 小時 × 100元)
                    </p>
                  </div>
                  <p className="text-xs text-red-400 mt-1">※ 請先完成匯款後，再填寫匯款帳號後五碼。</p>
                </div>
              </div>

              <div className="bg-blue-900/40 p-4 rounded-xl border border-blue-700/50 shadow-inner">
                <h4 className="text-white font-semibold mb-3 flex items-center text-sm"><span className="w-1.5 h-4 bg-yellow-500 rounded-full mr-2"></span> 預約明細</h4>
                <div className="grid grid-cols-2 gap-y-2 text-sm">
                  <div className="text-blue-300">日期：</div><div className="text-white font-medium text-right">{bookingData.date}</div>
                  <div className="text-blue-300">時段：</div><div className="text-white font-medium text-right">{bookingData.times.length} 小時</div>
                  <div className="text-blue-300">場地：</div><div className="text-white font-medium text-right">第 {bookingData.court.join(', ')} 場地</div>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <label htmlFor="booking-name" className="block text-sm font-medium text-blue-200 mb-1.5">1. 預約人姓名 <span className="text-red-400">*</span></label>
                  <input id="booking-name" type="text" autoComplete="name" placeholder="請輸入姓名" value={bookingData.name} onChange={e => setBookingData({ ...bookingData, name: e.target.value })} className="w-full bg-blue-950 border-2 border-blue-700 rounded-xl p-3.5 text-white font-medium focus:outline-none focus:border-yellow-400 transition-colors placeholder-blue-500" />
                </div>
                <div>
                  <label htmlFor="booking-phone" className="block text-sm font-medium text-blue-200 mb-1.5">2. 手機號碼 <span className="text-red-400">*</span> <span className="text-blue-400 text-xs">(用來查詢預約與店家聯絡)</span></label>
                  <input id="booking-phone" type="tel" inputMode="numeric" autoComplete="tel" placeholder="09xxxxxxxx" value={bookingData.phone} onChange={e => setBookingData({ ...bookingData, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} className="w-full bg-blue-950 border-2 border-blue-700 rounded-xl p-3.5 text-white font-mono font-medium focus:outline-none focus:border-yellow-400 transition-colors placeholder-blue-500" />
                  {bookingData.phone && !isValidPhone(bookingData.phone) && <p className="text-red-400 text-xs mt-1.5">請輸入 09 開頭的 10 碼手機號碼</p>}
                </div>
                <div>
                  <label className="block text-sm font-medium text-blue-200 mb-1.5">3. 匯款帳號後五碼 <span className="text-red-400">*</span></label>
                  <input id="transfer-code" type="text" inputMode="numeric" maxLength={5} placeholder="請輸入 5 位數字" value={bookingData.transferCode} onChange={e => setBookingData({ ...bookingData, transferCode: e.target.value.replace(/\D/g, '').slice(0, 5) })} className="w-full bg-blue-950 border-2 border-blue-700 rounded-xl p-3.5 text-xl text-white font-mono font-bold tracking-[0.5em] text-center focus:outline-none focus:border-yellow-400 transition-colors placeholder:text-base placeholder:tracking-normal placeholder:font-normal placeholder-blue-500" />
                  {bookingData.transferCode && !isValidTransferCode(bookingData.transferCode) && <p className="text-red-400 text-xs mt-1.5">請輸入完整 5 位數字</p>}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-between items-center mt-6">
          {step > 1 ? (
            <button onClick={() => setStep(step - 1)} className="flex items-center px-5 py-3 rounded-xl border border-blue-700 text-blue-300 font-medium hover:bg-blue-800 hover:text-white transition-colors">
              <i className="fas fa-chevron-left text-[20px] mr-1"></i> 上一步
            </button>
          ) : <div></div>}

          {step < 4 ? (
            <button onClick={() => setStep(step + 1)} disabled={!canProceed()} className="flex items-center px-6 py-3 rounded-xl bg-yellow-500 text-blue-950 font-bold hover:bg-yellow-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-yellow-500/20">
              下一步 <i className="fas fa-chevron-right text-[20px] ml-1"></i>
            </button>
          ) : (
            <button onClick={handleSubmit} disabled={submitting || !bookingData.name.trim() || !isValidPhone(bookingData.phone) || !isValidTransferCode(bookingData.transferCode)} className="flex-1 ml-4 py-3 bg-yellow-500 text-blue-950 font-bold rounded-xl text-lg hover:bg-yellow-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-yellow-500/30 flex items-center justify-center">
              {submitting ? '送出中…' : '送出預約表單'} <i className="fas fa-paper-plane ml-2 text-[18px]"></i>
            </button>
          )}
        </div>
      </main>
      {siteFooter}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
