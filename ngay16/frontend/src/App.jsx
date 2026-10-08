import { Fragment, useEffect, useState } from 'react';
import axios from 'axios';
import { Shield, ShieldCheck, ShieldAlert, LogOut, User } from 'lucide-react';

// ========== KẾT NỐI BACKEND ==========
// Token chỉ nằm trong sessionStorage: đóng tab là đăng xuất. Token hết hạn (15 phút) -> tự đăng xuất.
const api = axios.create({ baseURL: '/api' });
api.interceptors.request.use((cfg) => {
  const token = sessionStorage.getItem('token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});
api.interceptors.response.use(null, (err) => {
  if (err.response?.status === 401 && sessionStorage.getItem('token')) {
    sessionStorage.clear();
    window.dispatchEvent(new Event('logout'));
  }
  return Promise.reject(err);
});
const errMsg = (e) => e.response?.data?.error ?? e.message;
// Tải tệp kèm token rồi mở trong tab mới
const openBlob = async (url) => {
  const { data } = await api.get(url, { responseType: 'blob' });
  const href = URL.createObjectURL(data);
  window.open(href, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
};

// Mã vai trò nội bộ giữ nguyên (chaincode dùng); chỉ đổi tên hiển thị
const ROLE_LABEL = { CAN_BO: 'Nhân viên', HR_MANAGER: 'Trưởng phòng', QUAN_LI: 'Lãnh đạo đơn vị', ADMIN: 'Quản trị viên' };
const STATUS = {
  cho_duyet: ['Chờ duyệt', 'bg-amber-100 text-amber-800'],
  da_xac_minh: ['Đã xác minh', 'bg-sky-100 text-sky-800'],
  da_duyet: ['Đã duyệt', 'bg-emerald-100 text-emerald-800'],
  tu_choi: ['Từ chối', 'bg-rose-100 text-rose-800'],
};
// Mỗi vai trò chỉ thấy các tab của mình (backend vẫn kiểm tra quyền lại ở mọi API)
const TABS = {
  CAN_BO: [['me', 'Hồ sơ của tôi'], ['workflows', 'Bổ nhiệm - Điều động'], ['inbox', 'Thông báo & việc'], ['proposals', 'Đề nghị của tôi'], ['account', 'Tài khoản']],
  HR_MANAGER: [['cho', 'Việc chờ duyệt'], ['profiles', 'Hồ sơ nhân viên trong phòng'], ['workflows', 'Bổ nhiệm - Điều động'], ['inbox', 'Thông báo & việc'], ['proposals', 'Đề nghị của phòng'], ['me', 'Hồ sơ của tôi'], ['account', 'Tài khoản']],
  QUAN_LI: [['cho', 'Việc chờ duyệt'], ['profiles', 'Cán bộ theo phòng ban'], ['workflows', 'Bổ nhiệm - Điều động'], ['inbox', 'Thông báo & việc'], ['proposals', 'Đề nghị'], ['account', 'Tài khoản']],
  ADMIN: [['users', 'Cấp phát tài khoản'], ['deletions', 'Yêu cầu xóa tài khoản'], ['inbox', 'Thông báo & đồng bộ'], ['logs', 'Nhật ký hệ thống'], ['account', 'Tài khoản']],
};
const fmtTime = (s) => (s ? new Date(s).toLocaleString('vi-VN') : '');
const fmtDate = (s) => (s ? new Date(s).toLocaleDateString('vi-VN') : '');

// ========== THÀNH PHẦN GIAO DIỆN DÙNG CHUNG ==========
const inputCls = 'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500';
const btn = {
  primary: 'rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50',
  plain: 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50',
  danger: 'rounded-md border border-rose-300 bg-white px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50 disabled:opacity-50',
};

function Field({ label, children }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-slate-600">{label}</span>
      {children}
    </label>
  );
}

function Badge({ status }) {
  const [text, cls] = STATUS[status] ?? ['Chưa khai báo', 'bg-slate-100 text-slate-600'];
  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{text}</span>;
}

function Card({ title, action, children }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

function Notice({ msg }) {
  if (!msg) return null;
  return (
    <p role="status" className={`rounded-md px-3 py-2 text-sm ${msg.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>
      {msg.text}
    </p>
  );
}

// Chạy một thao tác gọi API, tự hiện thông báo thành công/lỗi
// Tách một danh sách thành khung "chờ xử lý" và khung "đã xử lý".
// chiCho: chỉ hiện khung chờ (dùng ở tab Việc chờ duyệt)
function Split({ rows, isCho, render, titles, action, msg, chiCho, empty = 'Không có mục nào.' }) {
  const cho = rows.filter(isCho), xong = rows.filter((r) => !isCho(r));
  const box = (title, list, first) => (
    <Card title={`${title} (${list.length})`} action={first ? action : undefined}>
      {first && <Notice msg={msg} />}
      {list.length ? render(list) : <p className="text-sm text-slate-500">{empty}</p>}
    </Card>
  );
  return <>{box(titles[0], cho, true)}{!chiCho && box(titles[1], xong, false)}</>;
}

function useAction() {
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn, okText) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (okText) setMsg({ ok: true, text: okText });
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };
  return { msg, busy, run };
}

// ========== ỨNG DỤNG ==========
export default function App() {
  const [user, setUser] = useState(() => JSON.parse(sessionStorage.getItem('user') ?? 'null'));
  useEffect(() => {
    const onLogout = () => setUser(null);
    window.addEventListener('logout', onLogout);
    return () => window.removeEventListener('logout', onLogout);
  }, []);
  if (!user) return <Login onLogin={setUser} />;
  return <Shell user={user} onLogout={() => { sessionStorage.clear(); setUser(null); }} />;
}

function Login({ onLogin }) {
  const [form, setForm] = useState({ email: '', password: '' });
  const [demo, setDemo] = useState(null);
  const [chon, setChon] = useState('');
  const { msg, busy, run } = useAction();
  // Backend bật DEMO_LOGIN=on mới có danh sách này; mặc định 404 nên khung đăng nhập nhanh tự ẩn
  useEffect(() => { api.get('/demo/accounts').then(({ data }) => setDemo(data), () => setDemo(null)); }, []);
  const vao = (data) => {
    sessionStorage.setItem('token', data.accessToken);
    sessionStorage.setItem('user', JSON.stringify(data.user));
    onLogin(data.user);
  };
  const submit = (e) => {
    e.preventDefault();
    run(async () => vao((await api.post('/auth/login', form)).data));
  };
  const nhanh = () => run(async () => vao((await api.post('/demo/login', { employee_code: chon })).data));
  const nhom = (a) => (a.role === 'QUAN_LI' ? 'Lãnh đạo đơn vị' : a.role === 'ADMIN' ? 'Quản trị viên' : a.phong_ban ?? 'Chưa phân phòng');
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg bg-white p-6 shadow">
        <div className="flex items-center gap-2">
          <Shield className="h-6 w-6 text-indigo-600" aria-hidden />
          <h1 className="text-lg font-semibold">Quản lý Hồ sơ Cán bộ</h1>
        </div>
        <Field label="Email">
          <input className={inputCls} type="email" autoComplete="username" required
            value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </Field>
        <Field label="Mật khẩu">
          <input className={inputCls} type="password" autoComplete="current-password" required
            value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
        <Notice msg={msg} />
        <button className={`${btn.primary} w-full py-2`} disabled={busy}>{busy ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>
        {demo && (
          <div className="space-y-2 border-t border-dashed border-amber-300 pt-4">
            <p className="text-sm font-semibold text-amber-800">Đăng nhập nhanh (chỉ môi trường thử nghiệm)</p>
            <select className={inputCls} value={chon} onChange={(e) => setChon(e.target.value)} aria-label="Chọn tài khoản thử nghiệm">
              <option value="">— Chọn tài khoản —</option>
              {Object.entries(demo.reduce((g, a) => ((g[nhom(a)] ??= []).push(a), g), {})).map(([ten, ds]) => (
                <optgroup key={ten} label={ten}>
                  {ds.map((a) => <option key={a.employee_code} value={a.employee_code}>
                    {a.employee_code} · {a.full_name} · {ROLE_LABEL[a.role]}{a.la_tccb && a.role === 'HR_MANAGER' ? ' (TCCB)' : ''}</option>)}
                </optgroup>
              ))}
            </select>
            <button type="button" className={`${btn.plain} w-full py-2`} disabled={busy || !chon} onClick={nhanh}>Vào bằng tài khoản này</button>
          </div>
        )}
      </form>
    </main>
  );
}

function Shell({ user, onLogout }) {
  const tabs = TABS[user.role] ?? [];
  const [tab, setTab] = useState(tabs[0]?.[0]);
  const View = { cho: ChoDuyet, me: MyProfile, profiles: ProfileList, workflows: Workflows, inbox: Inbox, proposals: Proposals, account: Account,
    users: AdminUsers, deletions: AdminDeletions, logs: AuditLogs }[tab];
  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-indigo-600" aria-hidden />
          <span className="font-semibold">Quản lý Hồ sơ Cán bộ</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span>{user.full_name} · <b>{ROLE_LABEL[user.role]}</b></span>
          <button className={`${btn.plain} inline-flex items-center gap-1`} onClick={onLogout}>
            <LogOut className="h-4 w-4" aria-hidden /> Đăng xuất
          </button>
        </div>
      </header>
      <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-4" aria-label="Chức năng">
        {tabs.map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} aria-current={tab === key ? 'page' : undefined}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === key ? 'border-indigo-600 font-medium text-indigo-700' : 'border-transparent text-slate-600 hover:text-slate-900'}`}>
            {label}
          </button>
        ))}
      </nav>
      <main className="mx-auto max-w-6xl space-y-4 p-4">{View && <View user={user} />}</main>
    </div>
  );
}

// ========== XÁC THỰC BLOCKCHAIN ==========
// Backend băm lại dữ liệu đang có trong CSDL (và tệp trên ổ đĩa), so với vân tay + trạng thái trên chain
function ChainPanel({ kind, id }) {
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState(null);
  const { msg, busy, run } = useAction();
  const verify = () => run(async () => setResult((await api.get(`/${kind}/${id}/verify`)).data));
  const loadHistory = () => run(async () => setHistory((await api.get(`/${kind}/${id}/history`)).data));
  useEffect(() => { verify(); }, [kind, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const chain = result?.blockchain;
  const problems = result
    ? [
        !chain && 'Không có bản ghi tương ứng trên blockchain',
        chain && !result.nguyenVen && 'Nội dung trong CSDL KHÁC vân tay trên blockchain (đã bị sửa ngoài hệ thống)',
        result.tepKhopDB === false && 'Tệp đính kèm trên máy chủ đã bị thay đổi hoặc bị xóa',
        chain && !result.trangThaiKhop && `Trạng thái trong CSDL KHÁC blockchain (trên chain: ${STATUS[chain.trangThai]?.[0] ?? chain.trangThai})`,
      ].filter(Boolean)
    : [];
  const ok = result && problems.length === 0;

  return (
    <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
      {result && (
        <div className={`flex items-start gap-2 rounded-md p-3 ${ok ? 'bg-emerald-50 text-emerald-900' : 'bg-rose-50 text-rose-900'}`}>
          {ok ? <ShieldCheck className="h-5 w-5 shrink-0" aria-hidden /> : <ShieldAlert className="h-5 w-5 shrink-0" aria-hidden />}
          <div>
            <p className="font-semibold">{ok ? 'Toàn vẹn: dữ liệu khớp với blockchain' : 'CẢNH BÁO: dữ liệu không khớp với blockchain'}</p>
            {problems.map((p) => <p key={p}>• {p}</p>)}
            {chain && (
              <p className="mt-1 text-xs opacity-80">
                Ghi lần cuối trên chain bởi {chain.nguoiThucHien} ({ROLE_LABEL[chain.vaiTro] ?? chain.vaiTro}) lúc {fmtTime(chain.thoiGian)}
              </p>
            )}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button className={btn.plain} disabled={busy} onClick={verify}>Xác thực lại</button>
        <button className={btn.plain} disabled={busy} onClick={loadHistory}>Lịch sử trên blockchain</button>
      </div>
      <Notice msg={msg} />
      {history && (
        <ol className="space-y-1">
          {history.length === 0 && <li className="text-slate-500">Chưa có lịch sử.</li>}
          {history.map((h) => (
            <li key={h.txId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Badge status={h.giaTri?.trangThai} />
              {h.giaTri?.phienBan && <span>Phiên bản {h.giaTri.phienBan}</span>}
              <span>{h.giaTri?.nguoiThucHien} ({ROLE_LABEL[h.giaTri?.vaiTro] ?? h.giaTri?.vaiTro})</span>
              <span className="text-slate-500">{fmtTime(h.giaTri?.thoiGian)}</span>
              <code className="text-xs text-slate-400" title={h.txId}>tx {h.txId.slice(0, 12)}…</code>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ========== HỒ SƠ ==========
// Nhóm 1. Thông tin định danh cá nhân (bảng profiles). Mã CB/CC/VC, họ tên khai sinh, tình trạng, ngày tạo hiển thị riêng
const NHOM1 = [
  ['citizen_id', 'Số định danh cá nhân (mã hồ sơ điện tử)', 'cccd'],
  ['ten_goi_khac', 'Tên gọi khác/bí danh', 'text'],
  ['date_of_birth', 'Ngày tháng năm sinh', 'date'],
  ['gender', 'Giới tính', 'gender'],
  ['noi_dang_ky_khai_sinh', 'Nơi đăng ký khai sinh', 'text'],
  ['hometown', 'Quê quán', 'text'],
  ['ethnicity', 'Dân tộc', 'text'],
  ['quoc_tich', 'Quốc tịch', 'text'],
  ['co_quan_lap', 'Cơ quan lập hồ sơ gốc', 'text'],
];
const LIEN_HE = [
  ['phone_number', 'Số điện thoại', 'tel'],
  ['address', 'Địa chỉ', 'text'],
  ['phong_ban', 'Phòng ban', 'readonly'],
  ['position', 'Chức vụ', 'chuc_vu'],
  ['education_level', 'Trình độ chuyên môn', 'text'],
  ['start_date', 'Ngày vào cơ quan', 'date'],
];
const PROFILE_FIELDS = [...NHOM1, ...LIEN_HE];
// Số căn cước chỉ hiện 4 số cuối khi xem
const maskId = (v) => (v ? `********${String(v).slice(-4)}` : '');

// ========== LỊCH SỬ PHIÊN BẢN VÀ NGƯỜI DUYỆT ==========
const FIELD_LABEL = { ...Object.fromEntries(PROFILE_FIELDS.map(([k, l]) => [k, l])), department: 'Phòng ban' };
const HSTATUS = {
  cho_duyet: ['Chờ duyệt', 'bg-amber-100 text-amber-800'],
  co_hieu_luc: ['Đang có hiệu lực', 'bg-emerald-100 text-emerald-800'],
  bi_thay_the: ['Bị thay thế', 'bg-slate-100 text-slate-600'],
  tu_choi: ['Từ chối', 'bg-rose-100 text-rose-800'],
};
const CHANGE = { tao_moi: 'Tạo mới', sua_doi: 'Sửa đổi', bo_sung: 'Bổ sung', huy_hieu_luc: 'Hủy hiệu lực', khoi_phuc: 'Khôi phục' };

function ReviewInfo({ p }) {
  if (!p.reviewed_by_code) return <p className="text-sm text-slate-500">Hồ sơ chưa được duyệt lần nào.</p>;
  return (
    <p className="text-sm text-slate-600">
      Người duyệt gần nhất: <b className="text-slate-900">{p.reviewed_by_name}</b> ({p.reviewed_by_code}, Trưởng phòng) lúc {fmtTime(p.reviewed_at)}
      {p.review_tx_id && <> · Ký số trên blockchain: <code className="text-xs" title={p.review_tx_id}>tx {p.review_tx_id.slice(0, 12)}…</code></>}
    </p>
  );
}

// Mỗi thay đổi là một phiên bản; không dòng nào bị sửa đè hay xóa
function DataHistory({ userId, reloadKey }) {
  const [rows, setRows] = useState([]);
  const { msg, run } = useAction();
  useEffect(() => { run(async () => setRows((await api.get(`/profiles/${userId}/data-history`)).data)); }, [userId, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const val = (r, v) => {
    if (v && r.field_group === 'giay_to') return `SHA-256 ${v.slice(0, 12)}…`;
    if (v && r.field_group?.startsWith('nhom_')) { try { return Object.values(JSON.parse(v)).join(' · '); } catch { return v; } }
    return v ?? '—';
  };
  const bang = (list) => (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr><th className="py-1 pr-2">Phiên bản</th><th className="pr-2">Trường</th><th className="pr-2">Giá trị cũ</th><th className="pr-2">Giá trị mới</th>
                <th className="pr-2">Loại</th><th className="pr-2">Lý do / căn cứ</th><th className="pr-2">Người cập nhật</th><th className="pr-2">Người duyệt</th><th className="pr-2">Hiệu lực</th><th>Trạng thái</th></tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.history_id} className={`border-b border-slate-100 ${r.hashOk ? '' : 'bg-rose-50'}`}>
                  <td className="py-1 pr-2 font-mono">v{r.version_no}</td>
                  <td className="pr-2">{FIELD_LABEL[r.field_name] ?? r.field_name}</td>
                  <td className="pr-2">{val(r, r.old_value)}</td>
                  <td className="pr-2">{val(r, r.new_value)}</td>
                  <td className="pr-2">{CHANGE[r.change_type]}</td>
                  <td className="pr-2">{[r.reason, r.legal_document && `Căn cứ: ${r.legal_document}`].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="pr-2">{r.updated_by_code}<br /><span className="text-slate-400">{fmtTime(r.created_at)}</span></td>
                  <td className="pr-2">{r.approved_by_code ?? '—'}
                    {r.digital_signature && <><br /><code className="text-slate-400" title={r.digital_signature}>tx {r.digital_signature.slice(0, 10)}…</code></>}</td>
                  <td className="pr-2 whitespace-nowrap">{r.valid_from ? `${fmtTime(r.valid_from)} → ${r.valid_to ? fmtTime(r.valid_to) : 'nay'}` : '—'}</td>
                  <td>
                    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 font-medium ${HSTATUS[r.status]?.[1] ?? ''}`}>{HSTATUS[r.status]?.[0] ?? r.status}</span>
                    {!r.hashOk && <span className="ml-1 font-semibold text-rose-700">Bị sửa trong CSDL!</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
  );
  const cho = rows.filter((r) => r.status === 'cho_duyet'), xong = rows.filter((r) => r.status !== 'cho_duyet');
  return (
    <div className="space-y-2 text-sm">
      <Notice msg={msg} />
      <h4 className="font-semibold">Thay đổi đang chờ duyệt ({cho.length})</h4>
      {cho.length ? bang(cho) : <p className="text-slate-500">Không có thay đổi nào đang chờ duyệt.</p>}
      <h4 className="pt-2 font-semibold">Lịch sử đã xử lý ({xong.length})</h4>
      {xong.length ? bang(xong) : <p className="text-slate-500">Chưa có thay đổi nào được xử lý.</p>}
    </div>
  );
}

// Thông tin không sửa được trên biểu mẫu: mã, họ tên khai sinh, tình trạng, ngày tạo
function DinhDanh({ p, docs, userId, canUpload, onUploaded }) {
  return (
    <div className="flex flex-wrap gap-5">
      <ChanDung docs={docs} userId={userId} canUpload={canUpload} onUploaded={onUploaded} />
      <dl className="grid flex-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div><dt className="text-slate-600">Mã hồ sơ điện tử</dt><dd className="font-mono">{maskId(p.citizen_id) || 'Chưa có'}</dd></div>
        <div><dt className="text-slate-600">Mã CB/CC/VC</dt><dd className="font-mono">{p.employee_code}</dd></div>
        <div><dt className="text-slate-600">Họ và tên khai sinh</dt><dd className="font-medium">{p.full_name}</dd></div>
        <div><dt className="text-slate-600">Tình trạng hồ sơ</dt><dd><Badge status={p.status} /></dd></div>
        <div><dt className="text-slate-600">Ngày tạo</dt><dd>{fmtDate(p.ngay_tao) || 'Chưa có'}</dd></div>
        <div><dt className="text-slate-600">Phòng ban</dt><dd>{p.phong_ban ?? 'Chưa có'}</dd></div>
      </dl>
    </div>
  );
}

// Ảnh chân dung = tài liệu loại "Ảnh chân dung" mới nhất; mỗi lần tải lên là một phiên bản, giữ cả ngày chụp
function ChanDung({ docs, userId, canUpload, onUploaded }) {
  const anh = docs.filter((d) => d.doc_type === 'Ảnh chân dung').at(-1);
  const [src, setSrc] = useState(null);
  const [ngay, setNgay] = useState('');
  const { msg, busy, run } = useAction();
  useEffect(() => {
    if (!anh) return undefined;
    let url;
    api.get(`/profiles/${userId}/documents/${anh.id}`, { responseType: 'blob' })
      .then(({ data }) => setSrc((url = URL.createObjectURL(data)))).catch(() => setSrc(null));
    return () => url && URL.revokeObjectURL(url);
  }, [anh?.id, userId]); // eslint-disable-line react-hooks/exhaustive-deps
  const upload = (file) => run(async () => {
    if (!ngay) throw new Error('Chọn ngày chụp trước khi tải ảnh');
    const fd = new FormData();
    fd.append('doc_type', 'Ảnh chân dung'); fd.append('ngay_chup', ngay); fd.append('file', file);
    await api.post('/profiles/me/documents', fd);
    onUploaded?.();
  }, 'Đã cập nhật ảnh chân dung.');
  return (
    <div className="w-32 space-y-2 text-sm">
      <div className="flex h-40 w-32 items-center justify-center overflow-hidden rounded-md border border-slate-200 bg-slate-50">
        {anh && src ? <img src={src} alt="Ảnh chân dung" className="h-full w-full object-cover" /> : <User className="h-10 w-10 text-slate-300" aria-label="Chưa có ảnh" />}
      </div>
      {anh && <p className="text-xs">Ngày chụp {fmtDate(anh.thong_tin?.ngay_chup) || '?'}</p>}
      {canUpload && (
        <>
          <input className={inputCls} type="date" value={ngay} onChange={(e) => setNgay(e.target.value)} aria-label="Ngày chụp" />
          <label className={`${btn.plain} block cursor-pointer text-center`}>
            {busy ? 'Đang tải…' : 'Tải ảnh'}
            <input type="file" accept=".jpg,.jpeg,.png" className="hidden" disabled={busy}
              onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; if (f) upload(f); }} />
          </label>
        </>
      )}
      <Notice msg={msg} />
    </div>
  );
}

function MyProfile({ user }) {
  const m = useMaster();
  const [p, setP] = useState(null);
  const [form, setForm] = useState({});
  const [docs, setDocs] = useState([]);
  const [hienSo, setHienSo] = useState(false);
  const { msg, busy, run } = useAction();
  const fetchMe = async () => {
    const { data } = await api.get('/profiles/me');
    setP(data);
    setForm({ ...Object.fromEntries(PROFILE_FIELDS.map(([k]) => [k, data[k] ?? ''])), change_reason: '', legal_document_id: '' });
    if (data.status) setDocs((await api.get(`/profiles/${data.user_id}/documents`)).data);
  };
  useEffect(() => { run(fetchMe); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (e) => {
    e.preventDefault();
    run(async () => { await api.put('/profiles/me', form); await fetchMe(); },
      'Đã lưu hồ sơ và ghi vân tay lên blockchain. Hồ sơ đang chờ trưởng phòng duyệt.');
  };
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const input = ([k, , type]) => {
    if (type === 'readonly') return <input className={`${inputCls} bg-slate-100`} value={p.phong_ban ?? ''} disabled />;
    if (type === 'chuc_vu' && p.position) return <input className={`${inputCls} bg-slate-100`} value={p.position} disabled title="Chức vụ chỉ đổi theo quyết định" />;
    if (type === 'chuc_vu') return (
      <select className={inputCls} value={form[k]} onChange={set(k)}>
        <option value="">— Chọn chức vụ —</option>{m?.chucVu.map((c) => <option key={c.ten}>{c.ten}</option>)}
      </select>
    );
    if (type === 'gender') return (
      <select className={inputCls} value={form[k]} onChange={set(k)}>
        <option value="">—</option><option>Nam</option><option>Nữ</option><option>Khác</option>
      </select>
    );
    if (type === 'cccd') return (
      <div className="flex gap-2">
        <input className={inputCls} type={hienSo ? 'text' : 'password'} autoComplete="off" inputMode="numeric" pattern="\d{12}" required
          value={form[k]} onChange={set(k)} />
        <button type="button" className={btn.plain} onClick={() => setHienSo(!hienSo)}>{hienSo ? 'Ẩn' : 'Hiện'}</button>
      </div>
    );
    return <input className={inputCls} type={type} value={form[k]} onChange={set(k)} />;
  };

  if (!p) return <Card title="Hồ sơ cá nhân">{msg ? <Notice msg={msg} /> : 'Đang tải…'}</Card>;
  return (
    <>
      <Card title="Hồ sơ cá nhân">
        <div className="space-y-5">
          <DinhDanh p={p} docs={docs} userId={p.user_id} canUpload={!!p.status} onUploaded={() => run(fetchMe)} />
          <form onSubmit={save} className="space-y-5">
            <fieldset className="grid gap-4 sm:grid-cols-3">
              <legend className="mb-2 font-semibold">Nhóm 1. Thông tin định danh cá nhân</legend>
              {NHOM1.map((f) => <Field key={f[0]} label={f[1]}>{input(f)}</Field>)}
            </fieldset>
            <fieldset className="grid gap-4 sm:grid-cols-3">
              <legend className="mb-2 font-semibold">Liên hệ và công tác hiện tại</legend>
              {LIEN_HE.map((f) => <Field key={f[0]} label={f[1]}>{input(f)}</Field>)}
            </fieldset>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Lý do thay đổi"><input className={inputCls} value={form.change_reason} onChange={set('change_reason')} /></Field>
              <Field label="Căn cứ (tài liệu đã tải lên)">
                <select className={inputCls} value={form.legal_document_id} onChange={set('legal_document_id')}>
                  <option value="">— Không có —</option>
                  {docs.map((d) => <option key={d.id} value={d.id}>#{d.id} {d.thong_tin?.ten || d.doc_type}</option>)}
                </select>
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button className={btn.primary} disabled={busy}>Lưu và gửi duyệt</button>
              <Notice msg={msg} />
            </div>
          </form>
        </div>
      </Card>
      {p.status && (
        <Card title="Hồ sơ điện tử">
          <HoSoDienTu userId={p.user_id} user={user} onChanged={() => run(fetchMe)} />
        </Card>
      )}
      {p.status && (
        <Card title="Xác thực blockchain">
          <ChainPanel key={p.updated_at} kind="profiles" id={p.user_id} />
        </Card>
      )}
      {p.status && (
        <Card title="Người duyệt và lịch sử thay đổi">
          <div className="space-y-3">
            <ReviewInfo p={p} />
            <DataHistory userId={p.user_id} reloadKey={p.updated_at} />
          </div>
        </Card>
      )}
    </>
  );
}

// Trưởng phòng: khung hồ sơ chờ duyệt và khung đã duyệt. Lãnh đạo đơn vị: danh sách cán bộ nhóm theo phòng ban, chỉ xem.
// Phân trang 50 dòng: mỗi lần tải 1 trang được tính vào bộ lọc truy cập hàng loạt của backend
function ProfileList({ user, chiCho }) {
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(null);
  const { msg, busy, run } = useAction();
  const fetchRows = async () => setRows((await api.get('/profiles', { params: { page } })).data);
  useEffect(() => { run(fetchRows); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  const review = (id, status) =>
    run(async () => { await api.put(`/profiles/${id}/review`, { status }); await fetchRows(); },
      status === 'da_duyet' ? 'Đã duyệt hồ sơ (đã ghi lên blockchain)' : 'Đã từ chối hồ sơ (đã ghi lên blockchain)');
  const ql = user.role === 'QUAN_LI';
  const deNghiXoa = (r) => {
    const reason = window.prompt(`Lý do đề nghị xóa tài khoản ${r.employee_code} (${r.full_name}), ví dụ số quyết định nghỉ hưu:`);
    if (reason == null) return;
    run(() => api.post('/deletion-proposals', { employee_code: r.employee_code, reason }),
      `Đã gửi đề nghị xóa ${r.employee_code}; quản trị viên sẽ thực hiện.`);
  };
  const paging = (
    <div className="flex flex-wrap items-center gap-2">
      {!chiCho && <>
        <button className={btn.plain} disabled={busy || page === 0} onClick={() => setPage(page - 1)}>Trang trước</button>
        <span className="text-sm">Trang {page + 1}</span>
        <button className={btn.plain} disabled={busy || rows.length < 50} onClick={() => setPage(page + 1)}>Trang sau</button>
      </>}
      <button className={btn.plain} disabled={busy} onClick={() => run(fetchRows)}>Tải lại</button>
    </div>
  );
  const table = (list) => (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 text-slate-600">
          <tr><th className="py-2 pr-3">Mã</th><th className="pr-3">Họ tên</th>{!ql && <th className="pr-3">Phòng ban</th>}<th className="pr-3">Chức vụ</th><th className="pr-3">Trạng thái</th><th className="text-right">Thao tác</th></tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <Fragment key={r.user_id}>
              <tr className="border-b border-slate-100">
                <td className="py-2 pr-3 font-mono">{r.employee_code}</td>
                <td className="pr-3">{r.full_name}</td>
                {!ql && <td className="pr-3">{r.phong_ban}</td>}
                <td className="pr-3">{r.position}</td>
                <td className="pr-3"><Badge status={r.status} /></td>
                <td className="space-x-1 whitespace-nowrap py-2 text-right">
                  {user.role === 'HR_MANAGER' && r.status === 'cho_duyet' && r.user_id !== user.id && (
                    <>
                      <button className={btn.primary} disabled={busy} onClick={() => review(r.user_id, 'da_duyet')}>Duyệt</button>
                      <button className={btn.danger} disabled={busy} onClick={() => review(r.user_id, 'tu_choi')}>Từ chối</button>
                    </>
                  )}
                  {r.status && (
                    <button className={btn.plain} aria-expanded={open === r.user_id} onClick={() => setOpen(open === r.user_id ? null : r.user_id)}>
                      {ql ? 'Xem hồ sơ' : 'Chi tiết'}
                    </button>
                  )}
                  {(ql || user.la_tccb) && r.user_id !== user.id && r.role !== 'ADMIN' && r.is_active && (
                    <button className={btn.plain} disabled={busy} onClick={() => deNghiXoa(r)}>Đề nghị xóa</button>
                  )}
                </td>
              </tr>
              {open === r.user_id && (
                <tr>
                  <td colSpan={6} className="py-3"><ChiTietHoSo r={r} user={user} /></td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );

  if (ql) {
    const groups = rows.reduce((g, r) => ((g[r.phong_ban ?? 'Chưa phân phòng (Lãnh đạo, Quản trị)'] ??= []).push(r), g), {});
    return (
      <Card title={`Cán bộ theo phòng ban (${rows.length})`} action={paging}>
        <Notice msg={msg} />
        <div className="space-y-3">
          {Object.entries(groups).map(([ten, list]) => (
            <details key={ten} open className="rounded-md border border-slate-200 px-3 py-2">
              <summary className="cursor-pointer font-semibold">{ten} <span className="font-normal text-slate-500">({list.length} người)</span></summary>
              <div className="mt-2">{table(list)}</div>
            </details>
          ))}
        </div>
      </Card>
    );
  }
  const choDuyet = (r) => r.status === 'cho_duyet' && r.user_id !== user.id;
  return (
    <Split rows={rows} isCho={choDuyet} render={table} msg={msg} chiCho={chiCho} action={paging}
      titles={chiCho ? ['Hồ sơ chờ bạn duyệt'] : ['Hồ sơ chờ duyệt', 'Hồ sơ đã duyệt và hồ sơ khác']} empty="Không có hồ sơ nào." />
  );
}

function ChiTietHoSo({ r, user }) {
  const [docs, setDocs] = useState([]);
  useEffect(() => { api.get(`/profiles/${r.user_id}/documents`).then(({ data }) => setDocs(data), () => {}); }, [r.user_id]);
  return (
    <div className="space-y-4">
      <h3 className="font-semibold">Hồ sơ cá nhân</h3>
      <DinhDanh p={r} docs={docs} userId={r.user_id} />
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        {PROFILE_FIELDS.filter(([k]) => k !== 'phong_ban').map(([k, label]) => (
          <div key={k}><dt className="text-slate-600">{label}</dt><dd>{(k === 'citizen_id' ? maskId(r[k]) : r[k]) || '—'}</dd></div>
        ))}
      </dl>
      <ReviewInfo p={r} />
      <h3 className="font-semibold">Hồ sơ điện tử</h3>
      <HoSoDienTu userId={r.user_id} user={user} />
      <ChainPanel key={r.status} kind="profiles" id={r.user_id} />
      <DataHistory userId={r.user_id} reloadKey={r.status} />
    </div>
  );
}

// ========== HỒ SƠ ĐIỆN TỬ: NHÓM 2-14 VÀ NHÓM 15 (QUẢN LÝ TÀI LIỆU) ==========
// Danh mục dùng chung (cấu hình nhóm, tài liệu, chức vụ, phòng ban) tải 1 lần
let masterCache;
const loadMaster = () => (masterCache ??= Promise.all([api.get('/master/nhom'), api.get('/master/chuc-vu'), api.get('/departments'), api.get('/master/tai-lieu')])
  .then(([n, c, d, t]) => ({ nhom: n.data, chucVu: c.data, donVi: d.data, taiLieu: t.data }))
  .catch((e) => { masterCache = null; throw e; }));
function useMaster() {
  const [m, setM] = useState(null);
  useEffect(() => { loadMaster().then(setM, () => {}); }, []);
  return m;
}

// Chức vụ, đơn vị, tài liệu và trường có danh sách là ô CHỌN (không gõ tự do); backend kiểm tra lại
function NhomInput({ type, value, onChange, m, docs, required }) {
  if (type === 'tai_lieu') return (
    <select required={required} className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— Chọn tài liệu —</option>{docs.map((d) => <option key={d.id} value={d.id}>#{d.id} {d.thong_tin?.ten || d.doc_type}</option>)}
    </select>
  );
  const opts = Array.isArray(type) ? type : type === 'chuc_vu' ? m.chucVu.map((c) => c.ten) : type === 'don_vi' ? m.donVi.map((d) => d.name) : null;
  if (opts) return (
    <select required={required} className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— Chọn —</option>{opts.map((o) => <option key={o}>{o}</option>)}
    </select>
  );
  return <input required={required} className={inputCls} type={type === 'date' ? 'date' : 'text'} value={value} onChange={(e) => onChange(e.target.value)}
    inputMode={type === 'so' ? 'decimal' : undefined} pattern={type === 'so' ? '\\d+(\\.\\d+)?' : undefined} />;
}

// Biểu mẫu theo cấu hình trường; trường bắt buộc có dấu *
function TruongForm({ truong, form, setForm, m, docs }) {
  return truong.map(([k, l, type, req]) => (
    <Field key={k} label={req ? `${l} *` : l}>
      <NhomInput type={type} m={m} docs={docs} required={req} value={form[k] ?? ''} onChange={(v) => setForm({ ...form, [k]: v })} />
    </Field>
  ));
}

function HoSoDienTu({ userId, user, onChanged }) {
  const m = useMaster();
  const [rows, setRows] = useState([]);
  const [docs, setDocs] = useState([]);
  const [openN, setOpenN] = useState(null);
  const [form, setForm] = useState({});
  const { msg, busy, run } = useAction();
  const load = async () => {
    setRows((await api.get(`/profiles/${userId}/nhom`)).data);
    setDocs((await api.get(`/profiles/${userId}/documents`)).data);
  };
  useEffect(() => { run(load); }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!m) return <Notice msg={msg} />;
  const self = userId === user.id;
  const coTheGhi = (nhap) => (nhap === 'ca_nhan' && self && ['CAN_BO', 'HR_MANAGER'].includes(user.role))
    || (nhap === 'to_chuc' && !self && user.role === 'HR_MANAGER');
  const docName = (id) => { const d = docs.find((x) => String(x.id) === String(id)); return d ? `#${d.id} ${d.thong_tin?.ten || d.doc_type}` : `#${id}`; };
  const add = (n) => (e) => {
    e.preventDefault();
    run(async () => { await api.post(`/profiles/${userId}/nhom/${n}`, form); setForm({}); setOpenN(null); await load(); onChanged?.(); },
      'Đã thêm bản ghi và ghi vân tay hồ sơ lên blockchain; hồ sơ chờ duyệt lại.');
  };
  const huy = (r) => {
    const ly_do = window.prompt('Lý do hủy hiệu lực bản ghi này? (bản ghi vẫn được lưu, không bị xóa)');
    if (ly_do) run(async () => { await api.put(`/profiles/${userId}/nhom/ban-ghi/${r.id}/huy`, { ly_do }); await load(); onChanged?.(); },
      'Đã hủy hiệu lực bản ghi.');
  };
  return (
    <div className="space-y-2 text-sm">
      <Notice msg={msg} />
      {Object.entries(m.nhom).map(([n, [ten, nhap, truong]]) => {
        if (n === '12' && !self && user.role !== 'QUAN_LI') return null;
        const ds = rows.filter((r) => r.nhom === Number(n));
        return (
          <details key={n} className="rounded-md border border-slate-200 bg-white">
            <summary className="cursor-pointer px-3 py-2 font-semibold">Nhóm {n}. {ten} ({ds.filter((r) => !r.huy_luc).length})</summary>
            <div className="space-y-3 border-t border-slate-100 px-3 py-3">
              {ds.map((r) => (
                <div key={r.id} className={`rounded-md border p-3 ${r.huy_luc ? 'border-slate-200 bg-slate-50 opacity-70' : 'border-slate-200'}`}>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono">#{r.id} · {r.created_by_code} · {fmtDate(r.created_at)}{r.quy_trinh_id ? ` · quy trình #${r.quy_trinh_id}` : ''}</span>
                    {r.huy_luc ? <span className="text-rose-700">Đã hủy hiệu lực: {r.ly_do_huy}</span>
                      : coTheGhi(nhap) && <button className={btn.danger} disabled={busy} onClick={() => huy(r)}>Hủy hiệu lực</button>}
                  </div>
                  <dl className={`grid gap-x-6 gap-y-1 sm:grid-cols-3 ${r.huy_luc ? 'line-through' : ''}`}>
                    {truong.filter(([k]) => r.du_lieu?.[k]).map(([k, l, type]) => (
                      <div key={k}><dt className="text-slate-600">{l}</dt><dd>{type === 'tai_lieu' ? docName(r.du_lieu[k]) : r.du_lieu[k]}</dd></div>
                    ))}
                  </dl>
                </div>
              ))}
              {coTheGhi(nhap) && (openN === n ? (
                <form onSubmit={add(n)} className="grid gap-3 sm:grid-cols-3">
                  <TruongForm truong={truong} form={form} setForm={setForm} m={m} docs={docs} />
                  <div className="flex items-end gap-2 sm:col-span-3">
                    <button className={btn.primary} disabled={busy}>Lưu bản ghi</button>
                    <button type="button" className={btn.plain} onClick={() => setOpenN(null)}>Đóng</button>
                  </div>
                </form>
              ) : <button className={btn.plain} onClick={() => { setForm({}); setOpenN(n); }}>Thêm bản ghi</button>)}
            </div>
          </details>
        );
      })}
      <details className="rounded-md border border-slate-200 bg-white">
        <summary className="cursor-pointer px-3 py-2 font-semibold">Nhóm 15. Quản lý tài liệu ({docs.length})</summary>
        <div className="border-t border-slate-100 px-3 py-3">
          <TaiLieu userId={userId} docs={docs} m={m} canUpload={self && ['CAN_BO', 'HR_MANAGER'].includes(user.role)}
            onUploaded={() => run(async () => { await load(); onChanged?.(); })} />
        </div>
      </details>
    </div>
  );
}

// Nhóm 15: tệp được quét mã độc, lưu MÃ HÓA; SHA-256 bản gốc nằm trong vân tay hồ sơ trên blockchain
function TaiLieu({ userId, docs, m, canUpload, onUploaded }) {
  const [form, setForm] = useState({ doc_type: m.taiLieu.loai[0] });
  const [file, setFile] = useState(null);
  const [fileKey, setFileKey] = useState(0); // đổi key để xóa ô chọn tệp sau khi gửi
  const [mo, setMo] = useState(false);
  const { msg, busy, run } = useAction();
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      if (!file) throw new Error('Chưa chọn tệp');
      if (file.size > 5 * 1024 * 1024) throw new Error('Tệp vượt quá 5MB');
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => v && fd.append(k, v));
      fd.append('file', file);
      await api.post('/profiles/me/documents', fd);
      setFile(null); setFileKey((k) => k + 1); setForm({ doc_type: m.taiLieu.loai[0] }); setMo(false);
      onUploaded?.();
    }, 'Đã quét mã độc, mã hóa tệp và ghi vân tay hồ sơ lên blockchain. Hồ sơ chờ trưởng phòng duyệt lại.');
  };
  const t = (d) => d.thong_tin ?? {};
  return (
    <div className="space-y-3">
      {docs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 text-slate-600">
              <tr><th className="py-1 pr-2">Mã</th><th className="pr-2">Loại</th><th className="pr-2">Tên</th><th className="pr-2">Số ký hiệu</th>
                <th className="pr-2">Ngày ban hành</th><th className="pr-2">Cơ quan/người ký</th><th className="pr-2">Bản</th><th className="pr-2">Mức độ mật</th>
                <th className="pr-2">Lưu trữ</th><th className="pr-2">Tải lên</th><th className="pr-2">Xác thực</th><th className="pr-2">Chữ ký số</th><th /></tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="border-b border-slate-100">
                  <td className="py-1 pr-2 font-mono">#{d.id}</td>
                  <td className="pr-2">{d.doc_type}</td>
                  <td className="pr-2">{t(d).ten}{t(d).su_kien && <><br />{t(d).su_kien}</>}</td>
                  <td className="pr-2">{t(d).so_ky_hieu}</td>
                  <td className="pr-2 whitespace-nowrap">{fmtDate(t(d).ngay_ban_hanh || t(d).ngay_chup)}</td>
                  <td className="pr-2">{t(d).co_quan_ky}</td>
                  <td className="pr-2">{t(d).loai_ban}</td>
                  <td className="pr-2">{t(d).muc_do_mat}</td>
                  <td className="pr-2">{t(d).thoi_han_luu_tru}</td>
                  <td className="pr-2 whitespace-nowrap">{d.uploaded_by_code}<br />{fmtTime(d.created_at)}</td>
                  <td className="pr-2">{d.xac_thuc
                    ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-800">Toàn vẹn</span>
                    : <span className="rounded-full bg-rose-100 px-2 py-0.5 text-rose-800">Bị sửa/mất</span>}</td>
                  <td className="pr-2"><code title={`SHA-256 ${d.sha256}\nGiao dịch ${d.chu_ky_so ?? ''}`}>{d.chu_ky_so ? `tx ${d.chu_ky_so.slice(0, 10)}…` : '—'}</code></td>
                  <td><button className={btn.plain} disabled={busy} onClick={() => run(() => openBlob(`/profiles/${userId}/documents/${d.id}`))}>Mở</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canUpload && (mo ? (
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3">
          <Field label="Loại tài liệu *">
            <select className={inputCls} value={form.doc_type} onChange={(e) => setForm({ ...form, doc_type: e.target.value })}>
              {m.taiLieu.loai.map((x) => <option key={x}>{x}</option>)}
            </select>
          </Field>
          <Field label="Tệp (PDF, JPG, PNG, tối đa 5MB) *">
            <input key={fileKey} type="file" accept=".pdf,.jpg,.jpeg,.png" className="text-sm" onChange={(e) => setFile(e.target.files[0] ?? null)} />
          </Field>
          <TruongForm truong={m.taiLieu.truong} form={form} setForm={setForm} m={m} docs={docs} />
          <div className="flex items-end gap-2 sm:col-span-3">
            <button className={btn.primary} disabled={busy}>{busy ? 'Đang tải lên…' : 'Tải lên'}</button>
            <button type="button" className={btn.plain} onClick={() => setMo(false)}>Đóng</button>
          </div>
        </form>
      ) : <button className={btn.plain} onClick={() => setMo(true)}>Thêm tài liệu</button>)}
      <Notice msg={msg} />
    </div>
  );
}

// ========== QUY TRÌNH BỔ NHIỆM / MIỄN NHIỆM / ĐIỀU ĐỘNG ==========
// Trưởng phòng chỉ đề xuất; TCCB thẩm định, tổng hợp phiếu; tập thể lãnh đạo biểu quyết kín; lãnh đạo có thẩm quyền ký.
// Giao diện chỉ hiện nút theo vai trò; backend kiểm tra lại mọi quyền
const LOAI_QT = { bo_nhiem: 'Bổ nhiệm (thăng chức)', mien_nhiem: 'Miễn nhiệm / giáng chức', dieu_dong: 'Điều động / luân chuyển' };
const BUOC_QT = { bo_nhiem: [1, 2, 3, 4, 5], mien_nhiem: [1, 2, 4, 5], dieu_dong: [1, 2, 4, 5] };
const TEN_BUOC = { 1: 'Xin chủ trương', 2: 'Tập thể lãnh đạo xem xét', 3: 'Lấy ý kiến giới thiệu', 4: 'Thẩm định', 5: 'Ký quyết định' };
const QT_STATUS = {
  dang_xu_ly: ['Đang xử lý', 'bg-amber-100 text-amber-800'],
  da_ban_hanh: ['Đã ban hành', 'bg-emerald-100 text-emerald-800'],
  khong_thong_qua: ['Không thông qua', 'bg-rose-100 text-rose-800'],
};
const txShort = (t) => t && <code className="text-xs" title={t}>tx {t.slice(0, 12)}…</code>;

function Steps({ q }) {
  return (
    <ol className="flex flex-wrap gap-1 text-xs">
      {BUOC_QT[q.loai].map((b) => {
        const done = b < q.buoc || q.trang_thai === 'da_ban_hanh', now = b === q.buoc && q.trang_thai === 'dang_xu_ly';
        const fail = b === q.buoc && q.trang_thai === 'khong_thong_qua';
        return (
          <li key={b} className={`rounded-full px-2 py-0.5 ${fail ? 'bg-rose-100 text-rose-800' : done ? 'bg-emerald-100 text-emerald-800'
            : now ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'}`} aria-current={now ? 'step' : undefined}>
            {b}. {TEN_BUOC[b]}
          </li>
        );
      })}
    </ol>
  );
}

function NewWorkflow({ onCreated }) {
  const m = useMaster();
  const empty = { loai: 'bo_nhiem', cccd: '', chuc_vu_moi: '', don_vi_moi: '', he_so_moi: '', ly_do: '' };
  const [f, setF] = useState(empty);
  const [nv, setNv] = useState(null);
  const { msg, busy, run } = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  // Đủ 12 số CCCD thì tra cán bộ; đơn vị điền sẵn phòng hiện tại (bổ nhiệm, miễn nhiệm giữ nguyên phòng nếu không đổi)
  const setCccd = (e) => {
    const cccd = e.target.value;
    setF({ ...f, cccd });
    setNv(null);
    if (!/^\d{12}$/.test(cccd)) return;
    run(async () => {
      const { data } = await api.get('/quy-trinh/tra-cuu', { params: { cccd } });
      setNv(data);
      setF((x) => ({ ...x, don_vi_moi: x.loai === 'dieu_dong' ? '' : String(data.department_id ?? '') }));
    });
  };
  const setLoai = (e) => {
    const loai = e.target.value;
    setF({ ...f, loai, don_vi_moi: loai === 'dieu_dong' ? '' : String(nv?.department_id ?? '') });
  };
  const submit = (e) => {
    e.preventDefault();
    run(async () => { await api.post('/quy-trinh', f); setF(empty); setNv(null); onCreated(); }, 'Đã gửi tờ trình xin chủ trương; tập thể lãnh đạo được thông báo để xem xét.');
  };
  return (
    <Card title="Bước 1. Xin chủ trương (tờ trình)">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3">
        <Field label="Loại"><select className={inputCls} value={f.loai} onChange={setLoai}>
          {Object.entries(LOAI_QT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Mã hồ sơ của cán bộ (số CCCD)">
          <input className={inputCls} required pattern="\d{12}" inputMode="numeric" value={f.cccd} onChange={setCccd} /></Field>
        <div className="text-sm sm:self-end">
          {nv ? <p><b>{nv.full_name}</b> ({nv.employee_code}) · {nv.position || 'chưa có chức vụ'} · {nv.phong_ban ?? 'Ban lãnh đạo'}</p>
            : <p className="text-slate-500">Nhập đủ 12 số CCCD để tra cán bộ.</p>}
        </div>
        <Field label={f.loai === 'dieu_dong' ? 'Chức vụ mới (để trống = giữ nguyên)' : 'Chức vụ mới'}>
          <select className={inputCls} required={f.loai !== 'dieu_dong'} value={f.chuc_vu_moi} onChange={set('chuc_vu_moi')}>
            <option value="">— Chọn chức vụ —</option>{m?.chucVu.map((c) => <option key={c.ten}>{c.ten}</option>)}</select></Field>
        <Field label={f.loai === 'dieu_dong' ? 'Đơn vị mới' : 'Đơn vị (mặc định: phòng hiện tại)'}>
          <select className={inputCls} required={f.loai === 'dieu_dong'} value={f.don_vi_moi} onChange={set('don_vi_moi')}>
            <option value="">{f.loai === 'dieu_dong' ? '— Chọn phòng ban —' : 'Không thuộc phòng (Ban lãnh đạo)'}</option>
            {m?.donVi.filter((d) => f.loai !== 'dieu_dong' || d.id !== nv?.department_id)
              .map((d) => <option key={d.id} value={d.id}>{d.name}{d.id === nv?.department_id ? ' (hiện tại)' : ''}</option>)}</select></Field>
        <Field label="Hệ số lương mới (nếu có)">
          <input className={inputCls} inputMode="decimal" pattern="\d+(\.\d+)?" value={f.he_so_moi} onChange={set('he_so_moi')} /></Field>
        <Field label="Nội dung tờ trình">
          <textarea className={inputCls} required rows={2} value={f.ly_do} onChange={set('ly_do')} /></Field>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
          <button className={btn.primary} disabled={busy}>Gửi tờ trình</button>
          <Notice msg={msg} />
        </div>
      </form>
    </Card>
  );
}

function WorkflowDetail({ q, user, act, busy }) {
  const [td, setTd] = useState({ dat: 'true', nhan_xet: '' });
  const [qd, setQd] = useState({ so_quyet_dinh: '', ngay_hieu_luc: new Date().toLocaleDateString('sv'), file: null });
  const dang = q.trang_thai === 'dang_xu_ly';
  const vote = (dong_y) => act(() => api.post(`/quy-trinh/${q.id}/phieu`, { dong_y }), 'Đã ghi nhận phiếu kín của bạn.');
  const sign = (e) => {
    e.preventDefault();
    const fd = new FormData();
    fd.append('so_quyet_dinh', qd.so_quyet_dinh); fd.append('ngay_hieu_luc', qd.ngay_hieu_luc); if (qd.file) fd.append('file', qd.file);
    act(() => api.post(`/quy-trinh/${q.id}/quyet-dinh`, fd),
      'Đã ký quyết định. Hệ thống đã cập nhật hồ sơ, phân quyền, tạo việc bàn giao, gửi thông báo và xếp lệnh đồng bộ CSDL quốc gia.');
  };
  return (
    <div className="space-y-3 text-sm">
      <Steps q={q} />
      <p className="whitespace-pre-wrap"><span className="text-slate-500">Tờ trình: </span>{q.ly_do}
        <span className="text-slate-400"> · đề xuất bởi {q.de_xuat_code} lúc {fmtTime(q.created_at)} </span>{txShort(q.tx_tao)}</p>
      {Object.entries(q.ket_qua_buoc ?? {}).filter(([, k]) => k?.tong != null).map(([b, k]) => (
        <p key={b}><span className="text-slate-500">Kết quả bước {b} ({TEN_BUOC[b]}): </span>
          {k.dong_y} đồng ý, {k.khong_dong_y} không đồng ý / {k.tong} người</p>
      ))}
      {q.tham_dinh_dat != null && (
        <p><span className="text-slate-500">Thẩm định của TCCB ({q.tham_dinh_code}): </span>
          <b>{q.tham_dinh_dat ? 'Đạt' : 'Không đạt'}</b> · {q.tham_dinh_nhan_xet}</p>
      )}
      {q.trang_thai === 'da_ban_hanh' && (
        <p className="text-emerald-800">Quyết định số <b>{q.so_quyet_dinh}</b>, hiệu lực {fmtDate(q.ngay_hieu_luc)}, ký bởi {q.ky_code} · chữ ký số {txShort(q.chu_ky_so)}</p>
      )}
      {dang && q.phieu && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-3 py-2">
          <span>Phiếu kín: đã có <b>{q.phieu.da_bo}/{q.phieu.tong}</b> người bỏ phiếu (kết quả chỉ công bố khi kết thúc bước).</span>
          {q.phieu.duoc_bo && !q.phieu.toi_da_bo && (
            <>
              <button className={btn.primary} disabled={busy} onClick={() => vote(true)}>Đồng ý</button>
              <button className={btn.danger} disabled={busy} onClick={() => vote(false)}>Không đồng ý</button>
            </>
          )}
          {q.phieu.toi_da_bo && <span className="text-emerald-700">Bạn đã bỏ phiếu.</span>}
        </div>
      )}
      {dang && q.buoc === 3 && user.la_tccb && (
        <button className={btn.plain} disabled={busy}
          onClick={() => act(() => api.put(`/quy-trinh/${q.id}/ket-thuc-hoi-nghi`), 'Đã tổng hợp phiếu hội nghị, chuyển sang thẩm định.')}>
          Kết thúc hội nghị, tổng hợp phiếu (TCCB)</button>
      )}
      {dang && q.buoc === 4 && q.tham_dinh_dat == null && user.la_tccb && (
        <form className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => { e.preventDefault(); act(() => api.put(`/quy-trinh/${q.id}/tham-dinh`, { dat: td.dat === 'true', nhan_xet: td.nhan_xet }),
            td.dat === 'true' ? 'Thẩm định đạt: quy trình chuyển Lãnh đạo đơn vị ký quyết định.' : 'Thẩm định chưa đạt: quy trình dừng.'); }}>
          <Field label="Kết luận thẩm định (TCCB)">
            <select className={inputCls} value={td.dat} onChange={(e) => setTd({ ...td, dat: e.target.value })}>
              <option value="true">Đủ tiêu chuẩn, điều kiện</option><option value="false">Chưa đủ tiêu chuẩn</option></select></Field>
          <Field label="Nhận xét"><input className={inputCls} required value={td.nhan_xet} onChange={(e) => setTd({ ...td, nhan_xet: e.target.value })} /></Field>
          <button className={btn.primary} disabled={busy}>Gửi thẩm định</button>
        </form>
      )}
      {dang && q.buoc === 5 && user.role === 'QUAN_LI' && q.user_id !== user.id && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={sign}>
          <Field label="Số quyết định"><input className={inputCls} required value={qd.so_quyet_dinh} onChange={(e) => setQd({ ...qd, so_quyet_dinh: e.target.value })} /></Field>
          <Field label="Ngày hiệu lực"><input className={inputCls} type="date" required value={qd.ngay_hieu_luc} onChange={(e) => setQd({ ...qd, ngay_hieu_luc: e.target.value })} /></Field>
          <Field label="Tệp quyết định đã ký (PDF)"><input type="file" accept=".pdf" required className="text-sm" onChange={(e) => setQd({ ...qd, file: e.target.files[0] ?? null })} /></Field>
          <button className={btn.primary} disabled={busy}>Ký và ban hành</button>
        </form>
      )}
    </div>
  );
}

function Workflows({ user, chiCho }) {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(null);
  const { msg, busy, run } = useAction();
  const load = async () => setRows((await api.get('/quy-trinh')).data);
  useEffect(() => { run(load); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const act = (fn, ok) => run(async () => { await fn(); await load(); }, ok);
  // Việc của tôi ở bước hiện tại: bỏ phiếu, TCCB tổng hợp hội nghị / thẩm định, lãnh đạo ký
  const canAct = (q) => q.trang_thai === 'dang_xu_ly' && (
    (q.phieu?.duoc_bo && !q.phieu.toi_da_bo)
    || (user.la_tccb && (q.buoc === 3 || (q.buoc === 4 && q.tham_dinh_dat == null)))
    || (user.role === 'QUAN_LI' && q.buoc === 5 && q.user_id !== user.id));
  const table = (list) => (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 text-slate-500">
          <tr><th className="py-2 pr-3">Số</th><th className="pr-3">Loại</th><th className="pr-3">Cán bộ</th><th className="pr-3">Chức vụ</th>
            <th className="pr-3">Đơn vị</th><th className="pr-3">Bước</th><th className="pr-3">Trạng thái</th><th className="text-right">Thao tác</th></tr>
        </thead>
        <tbody>
          {list.map((q) => (
            <Fragment key={q.id}>
              <tr className="border-b border-slate-100">
                <td className="py-2 pr-3 font-mono">{q.id}</td>
                <td className="pr-3">{LOAI_QT[q.loai]}</td>
                <td className="pr-3">{q.full_name} <span className="text-slate-400">({q.employee_code})</span></td>
                <td className="pr-3">{q.chuc_vu_cu ?? '—'} → {q.chuc_vu_moi ?? q.chuc_vu_cu ?? '—'}</td>
                <td className="pr-3">{q.don_vi_cu_ten ?? '—'}{q.don_vi_moi_ten ? ` → ${q.don_vi_moi_ten}` : ''}</td>
                <td className="pr-3 whitespace-nowrap">{q.buoc}. {TEN_BUOC[q.buoc]}{q.qua_han && <span className="ml-1 font-semibold text-rose-700">quá hạn</span>}</td>
                <td className="pr-3"><span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${QT_STATUS[q.trang_thai][1]}`}>{QT_STATUS[q.trang_thai][0]}</span></td>
                <td className="py-2 text-right"><button className={btn.plain} aria-expanded={open === q.id} onClick={() => setOpen(open === q.id ? null : q.id)}>Chi tiết</button></td>
              </tr>
              {open === q.id && <tr><td colSpan={8} className="py-3"><WorkflowDetail q={q} user={user} act={act} busy={busy} /></td></tr>}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <>
      {user.role !== 'CAN_BO' && !chiCho && <NewWorkflow onCreated={() => run(load)} />}
      <Split rows={rows} isCho={chiCho ? canAct : (q) => q.trang_thai === 'dang_xu_ly'} render={table} msg={msg} chiCho={chiCho}
        titles={chiCho ? ['Quy trình bổ nhiệm, điều động chờ bạn xử lý'] : ['Quy trình đang xử lý', 'Quy trình đã kết thúc']}
        action={<button className={btn.plain} disabled={busy} onClick={() => run(load)}>Tải lại</button>} empty="Không có quy trình nào." />
    </>
  );
}

// ========== THÔNG BÁO, VIỆC BÀN GIAO / TIẾP NHẬN, HÀNG ĐỢI ĐỒNG BỘ ==========
const KENH = { csdlqg: 'CSDL quốc gia CBCCVC', email: 'Email' };
const HD_STATUS = { cho_gui: 'Chờ gửi (chưa cấu hình điểm nhận)', da_gui: 'Đã gửi', loi: 'Lỗi, sẽ thử lại' };

// Lãnh đạo đơn vị và TCCB xác nhận đề nghị xóa tài khoản của quản trị viên (người thứ hai).
// Trưởng phòng không thuộc TCCB nhận 403 nên khung này tự ẩn
function XacNhanXoa({ chiCho }) {
  const [rows, setRows] = useState(null);
  const { msg, busy, run } = useAction();
  const load = async () => {
    try { setRows((await api.get('/deletion-approvals')).data); } catch (e) { if (e.response?.status === 403) setRows(null); else throw e; }
  };
  useEffect(() => { run(load); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!rows) return null;
  const handle = (r, approve) => {
    if (approve && !window.confirm(`Duyệt yêu cầu xóa tài khoản ${r.employee_code} (${r.full_name}) và chuyển quản trị viên thực hiện?`)) return;
    run(async () => { await api.put(`/deletion-approvals/${r.id}`, { approve }); await load(); },
      approve ? `Đã duyệt, chuyển quản trị viên xóa ${r.employee_code}` : `Đã từ chối yêu cầu của ${r.employee_code}`);
  };
  const KQ = { cho_xoa: 'Đã duyệt, chờ quản trị viên xóa', da_xoa: 'Đã xóa', tu_choi: 'Đã từ chối' };
  const list = (items) => (
    <ul className="divide-y divide-slate-100 text-sm">
      {items.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span><b className="font-mono">{r.employee_code}</b> {r.full_name}{r.phong_ban && ` · ${r.phong_ban}`} · lý do: {r.reason || '—'}
            <span className="text-slate-400"> · {r.tu_yeu_cau ? 'cán bộ tự yêu cầu' : `${r.duyet_boi} đề nghị`} {fmtTime(r.created_at)}</span></span>
          {r.status === 'cho_lanh_dao' ? (
            <span className="space-x-1 whitespace-nowrap">
              <button className={btn.danger} disabled={busy} onClick={() => handle(r, true)}>Duyệt, chuyển quản trị viên</button>
              <button className={btn.plain} disabled={busy} onClick={() => handle(r, false)}>Từ chối</button>
            </span>
          ) : <span className={r.status === 'da_xoa' ? 'text-rose-700' : 'text-slate-600'}>{KQ[r.status] ?? r.status}
            {r.status === 'cho_xoa' ? ` (${r.duyet_boi})` : r.xu_ly_boi && ` · ${r.xu_ly_boi} · ${fmtTime(r.handled_at)}`}</span>}
        </li>
      ))}
    </ul>
  );
  return (
    <Split rows={rows} isCho={(r) => r.status === 'cho_lanh_dao'} render={list} msg={msg} chiCho={chiCho}
      titles={['Yêu cầu xóa tài khoản chờ bạn duyệt', 'Yêu cầu xóa tài khoản đã duyệt hoặc từ chối']} empty="Không có yêu cầu nào." />
  );
}

function Inbox({ user }) {
  const [tb, setTb] = useState([]);
  const [cv, setCv] = useState([]);
  const [hd, setHd] = useState([]);
  const { msg, busy, run } = useAction();
  const load = async () => {
    setTb((await api.get('/thong-bao')).data);
    if (user.role === 'ADMIN') setHd((await api.get('/admin/hang-doi')).data);
    else setCv((await api.get('/cong-viec')).data);
  };
  useEffect(() => { run(load); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const act = (fn, ok) => run(async () => { await fn(); await load(); }, ok);
  const thongBao = (items) => (
    <ul className="divide-y divide-slate-100 text-sm">
      {items.map((t) => (
        <li key={t.id} className={`flex flex-wrap items-center justify-between gap-2 py-2 ${t.da_doc ? 'text-slate-500' : ''}`}>
          <span>{t.loai === 'canh_bao' && <b className="mr-1 text-rose-700">Cảnh báo:</b>}{t.noi_dung}
            <span className="text-slate-400"> · {fmtTime(t.created_at)}</span></span>
          {!t.da_doc && <button className={btn.plain} disabled={busy} onClick={() => act(() => api.put(`/thong-bao/${t.id}/da-doc`))}>Đã đọc</button>}
        </li>
      ))}
    </ul>
  );
  const congViec = (items) => (
    <ul className="divide-y divide-slate-100 text-sm">
      {items.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span><b>{c.loai === 'ban_giao' ? 'Bàn giao công việc' : 'Tiếp nhận cán bộ'}</b> · {c.full_name} ({c.employee_code}) theo QĐ {c.so_quyet_dinh}
            · hạn {fmtDate(c.han)}{c.qua_han && !c.xong_luc && <b className="ml-1 text-rose-700">quá hạn</b>}</span>
          {c.xong_luc ? <span className="text-emerald-700">Đã xong {fmtTime(c.xong_luc)}</span>
            : <button className={btn.primary} disabled={busy} onClick={() => act(() => api.put(`/cong-viec/${c.id}/xong`), 'Đã xác nhận hoàn thành.')}>Hoàn thành</button>}
        </li>
      ))}
    </ul>
  );
  const hangDoi = (items) => (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 text-slate-500"><tr><th className="py-2 pr-3">Số</th><th className="pr-3">Kênh</th><th className="pr-3">Quy trình</th><th className="pr-3">Trạng thái</th><th className="pr-3">Lần gửi</th><th>Lỗi</th></tr></thead>
        <tbody>{items.map((h) => (
          <tr key={h.id} className="border-b border-slate-100"><td className="py-1 pr-3 font-mono">{h.id}</td><td className="pr-3">{KENH[h.kenh]}</td>
            <td className="pr-3">#{h.quy_trinh_id}</td><td className="pr-3">{HD_STATUS[h.trang_thai]}</td><td className="pr-3">{h.so_lan}</td><td className="text-rose-700">{h.loi}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
  return (
    <>
      {['QUAN_LI', 'HR_MANAGER'].includes(user.role) && <XacNhanXoa />}
      <Split rows={tb} isCho={(t) => !t.da_doc} render={thongBao} msg={msg} titles={['Thông báo chưa đọc', 'Thông báo đã đọc']}
        action={<button className={btn.plain} disabled={busy} onClick={() => run(load)}>Tải lại</button>} empty="Không có thông báo." />
      {user.role !== 'ADMIN' && (
        <Split rows={cv} isCho={(c) => !c.xong_luc} render={congViec} titles={['Việc bàn giao / tiếp nhận chưa hoàn thành', 'Việc đã hoàn thành']} empty="Không có việc nào." />
      )}
      {user.role === 'ADMIN' && (
        <Split rows={hd} isCho={(h) => h.trang_thai !== 'da_gui'} render={hangDoi}
          titles={['Hàng đợi gửi ra ngoài: chưa gửi (chỉ trạng thái, không xem nội dung)', 'Đã gửi']} empty="Không có mục nào." />
      )}
    </>
  );
}

// Tab Việc chờ duyệt (Lãnh đạo đơn vị, Trưởng phòng): chỉ những việc đang chờ CHÍNH người này xử lý.
// Lịch sử đã xử lý nằm ở các tab tương ứng
function ChoDuyet({ user }) {
  return (
    <>
      {user.role === 'HR_MANAGER' && <ProfileList user={user} chiCho />}
      <Proposals user={user} chiCho />
      <Workflows user={user} chiCho />
      <XacNhanXoa chiCho />
    </>
  );
}

// ========== ĐỀ NGHỊ ==========
function NewProposal({ onCreated }) {
  const empty = { type: 'Nghỉ phép', title: '', reason: '' };
  const [form, setForm] = useState(empty);
  const [file, setFile] = useState(null);
  const [fileKey, setFileKey] = useState(0); // đổi key để xóa ô chọn tệp sau khi gửi
  const { msg, busy, run } = useAction();
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      if (file && file.size > 5 * 1024 * 1024) throw new Error('Tệp đính kèm vượt quá 5MB');
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, v));
      if (file) fd.append('attachment', file);
      await api.post('/proposals', fd);
      setForm(empty);
      setFile(null);
      setFileKey((k) => k + 1);
      onCreated();
    }, 'Đã gửi đề nghị và ghi vân tay (kèm tệp) lên blockchain');
  };
  return (
    <Card title="Tạo đề nghị mới">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Loại đề nghị">
          <select className={inputCls} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            <option>Nghỉ phép</option><option>Đề xuất thiết bị</option><option>Điều chỉnh thông tin</option><option>Khác</option>
          </select>
        </Field>
        <Field label="Tiêu đề">
          <input className={inputCls} required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Nội dung">
            <textarea className={inputCls} rows={3} required value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Tệp đính kèm (PDF, JPG, PNG, tối đa 5MB)">
            <input key={fileKey} type="file" accept=".pdf,.jpg,.jpeg,.png" className="text-sm" onChange={(e) => setFile(e.target.files[0] ?? null)} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <button className={btn.primary} disabled={busy}>{busy ? 'Đang gửi…' : 'Gửi đề nghị'}</button>
          <Notice msg={msg} />
        </div>
      </form>
    </Card>
  );
}

function Proposals({ user, chiCho }) {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(null);
  const { msg, busy, run } = useAction();
  const fetchRows = async () => setRows((await api.get('/proposals')).data);
  useEffect(() => { run(fetchRows); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const act = (id, step, status, text) =>
    run(async () => { await api.put(`/proposals/${id}/${step}`, { status }); await fetchRows(); }, text);
  const openAttachment = (id) => run(() => openBlob(`/proposals/${id}/attachment`));
  const showSender = user.role !== 'CAN_BO';
  const canAct = (r) => (user.role === 'HR_MANAGER' && r.status === 'cho_duyet') || (user.role === 'QUAN_LI' && r.status === 'da_xac_minh');
  const table = (list) => (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 text-slate-500">
          <tr>
            <th className="py-2 pr-3">Số</th>{showSender && <th className="pr-3">Người gửi</th>}
            <th className="pr-3">Loại</th><th className="pr-3">Tiêu đề</th><th className="pr-3">Ngày gửi</th><th className="pr-3">Trạng thái</th><th className="text-right">Thao tác</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <Fragment key={r.id}>
              <tr className="border-b border-slate-100">
                <td className="py-2 pr-3 font-mono">{r.id}</td>
                {showSender && <td className="pr-3">{r.sender_name} <span className="text-slate-400">({r.employee_code})</span></td>}
                <td className="pr-3">{r.type}</td>
                <td className="pr-3">{r.title}</td>
                <td className="pr-3 whitespace-nowrap">{fmtTime(r.created_at)}</td>
                <td className="pr-3"><Badge status={r.status} /></td>
                <td className="space-x-1 whitespace-nowrap py-2 text-right">
                  {user.role === 'HR_MANAGER' && r.status === 'cho_duyet' && (
                    <>
                      <button className={btn.primary} disabled={busy} onClick={() => act(r.id, 'verify', 'da_xac_minh', 'Đã xác minh (đã ghi lên blockchain)')}>Xác minh</button>
                      <button className={btn.danger} disabled={busy} onClick={() => act(r.id, 'verify', 'tu_choi', 'Đã từ chối (đã ghi lên blockchain)')}>Từ chối</button>
                    </>
                  )}
                  {user.role === 'QUAN_LI' && r.status === 'da_xac_minh' && (
                    <>
                      <button className={btn.primary} disabled={busy} onClick={() => act(r.id, 'decide', 'da_duyet', 'Đã phê duyệt (đã ghi lên blockchain)')}>Phê duyệt</button>
                      <button className={btn.danger} disabled={busy} onClick={() => act(r.id, 'decide', 'tu_choi', 'Đã từ chối (đã ghi lên blockchain)')}>Từ chối</button>
                    </>
                  )}
                  <button className={btn.plain} aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>Chi tiết</button>
                </td>
              </tr>
              {open === r.id && (
                <tr>
                  <td colSpan={showSender ? 7 : 6} className="space-y-3 py-3">
                    <p className="whitespace-pre-wrap text-sm"><span className="text-slate-500">Nội dung: </span>{r.reason}</p>
                    {r.attachment_path && (
                      <button className={btn.plain} disabled={busy} onClick={() => openAttachment(r.id)}>Mở tệp đính kèm</button>
                    )}
                    <ChainPanel key={r.status} kind="proposals" id={r.id} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      {user.role === 'CAN_BO' && <NewProposal onCreated={() => run(fetchRows)} />}
      <Split rows={rows} isCho={chiCho ? canAct : (r) => !['da_duyet', 'tu_choi'].includes(r.status)} render={table} msg={msg} chiCho={chiCho}
        titles={chiCho ? ['Đề nghị chờ bạn xử lý'] : ['Đề nghị đang chờ xử lý', 'Đề nghị đã xử lý xong']}
        action={<button className={btn.plain} disabled={busy} onClick={() => run(fetchRows)}>Tải lại</button>} empty="Không có đề nghị nào." />
    </>
  );
}

// ========== TÀI KHOẢN: đổi mật khẩu + yêu cầu xóa tài khoản ==========
function Account({ user }) {
  return (
    <>
      <ChangePassword />
      {user.role !== 'ADMIN' && <DeletionRequest />}
    </>
  );
}

const DEL_STATUS = { cho_lanh_dao: 'đang chờ Lãnh đạo đơn vị duyệt', cho_xoa: 'lãnh đạo đã duyệt, đang chờ quản trị viên thực hiện xóa',
  da_xoa: 'đã được chấp thuận', tu_choi: 'đã bị từ chối' };

// Nhân viên bấm xóa -> Lãnh đạo đơn vị (hoặc TCCB) duyệt -> quản trị viên thực hiện xóa
function DeletionRequest() {
  const [req, setReq] = useState(null);
  const [reason, setReason] = useState('');
  const { msg, busy, run } = useAction();
  const fetchReq = async () => setReq((await api.get('/account/deletion-request')).data);
  useEffect(() => { run(fetchReq); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (e) => {
    e.preventDefault();
    if (!window.confirm('Gửi yêu cầu xóa tài khoản? Lãnh đạo đơn vị duyệt, sau đó quản trị viên thực hiện.')) return;
    run(async () => { await api.post('/account/deletion-request', { reason }); setReason(''); await fetchReq(); },
      'Đã gửi yêu cầu. Lãnh đạo đơn vị duyệt, sau đó quản trị viên thực hiện xóa.');
  };
  const pending = ['cho_lanh_dao', 'cho_xoa'].includes(req?.status);
  return (
    <Card title="Xóa tài khoản">
      <div className="max-w-xl space-y-3 text-sm">
        <p className="text-slate-600">Yêu cầu được Lãnh đạo đơn vị (hoặc phòng Tổ chức cán bộ) duyệt, sau đó quản trị viên thực hiện xóa. Sau khi xóa bạn không đăng nhập được nữa;
          hồ sơ và lịch sử trên blockchain vẫn được lưu trữ theo quy định.</p>
        {req && <p>Yêu cầu gần nhất ({fmtTime(req.created_at)}): <b>{DEL_STATUS[req.status]}</b></p>}
        {!pending && (
          <form onSubmit={submit} className="space-y-3">
            <Field label="Lý do (không bắt buộc)">
              <textarea className={inputCls} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <button className={btn.danger} disabled={busy}>Yêu cầu xóa tài khoản</button>
          </form>
        )}
        <Notice msg={msg} />
      </div>
    </Card>
  );
}

function ChangePassword() {
  const empty = { oldPassword: '', newPassword: '', confirm: '' };
  const [f, setF] = useState(empty);
  const { msg, busy, run } = useAction();
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      if (f.newPassword !== f.confirm) throw new Error('Mật khẩu xác nhận không khớp');
      await api.put('/auth/change-password', { oldPassword: f.oldPassword, newPassword: f.newPassword });
      setF(empty);
    }, 'Đổi mật khẩu thành công');
  };
  return (
    <Card title="Đổi mật khẩu">
      <form onSubmit={submit} className="max-w-sm space-y-4">
        <Field label="Mật khẩu hiện tại">
          <input className={inputCls} type="password" autoComplete="current-password" required value={f.oldPassword} onChange={(e) => setF({ ...f, oldPassword: e.target.value })} />
        </Field>
        <Field label="Mật khẩu mới (ít nhất 8 ký tự)">
          <input className={inputCls} type="password" autoComplete="new-password" minLength={8} required value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} />
        </Field>
        <Field label="Nhập lại mật khẩu mới">
          <input className={inputCls} type="password" autoComplete="new-password" minLength={8} required value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} />
        </Field>
        <Notice msg={msg} />
        <button className={btn.primary} disabled={busy}>Đổi mật khẩu</button>
      </form>
    </Card>
  );
}

// ========== QUẢN TRỊ VIÊN: chỉ cấp phát và khóa/mở khóa, không xem danh sách tài khoản ==========
function AdminUsers() {
  const empty = { employee_code: '', full_name: '', email: '', role: 'CAN_BO', department_id: '', password: '' };
  const [form, setForm] = useState(empty);
  const [code, setCode] = useState('');
  const [deps, setDeps] = useState([]);
  const [moveTo, setMoveTo] = useState('');
  const [newDep, setNewDep] = useState('');
  const create = useAction();
  const lock = useAction();
  const dep = useAction();
  const fetchDeps = async () => setDeps((await api.get('/departments')).data);
  useEffect(() => { dep.run(fetchDeps); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const move = () =>
    lock.run(async () => { await api.patch(`/admin/users/${encodeURIComponent(code.trim())}/department`, { department_id: Number(moveTo) }); },
      `Đã chuyển ${code.trim()} sang ${deps.find((d) => d.id === Number(moveTo))?.name}`);
  const addDep = (e) => {
    e.preventDefault();
    dep.run(async () => { await api.post('/admin/departments', { name: newDep }); setNewDep(''); await fetchDeps(); }, `Đã thêm ${newDep}`);
  };
  const depSelect = (value, onChange, required) => (
    <select className={inputCls} value={value} required={required} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
    </select>
  );
  const submit = (e) => {
    e.preventDefault();
    create.run(async () => { await api.post('/admin/users', form); setForm(empty); }, `Đã cấp tài khoản ${form.employee_code}`);
  };
  const setActive = (is_active) =>
    lock.run(async () => { await api.patch(`/admin/users/${encodeURIComponent(code.trim())}/active`, { is_active }); },
      `${is_active ? 'Đã mở khóa' : 'Đã khóa'} tài khoản ${code.trim()}`);

  return (
    <>
      <Card title="Cấp phát tài khoản">
        <form onSubmit={submit} className="grid gap-4 sm:grid-cols-3">
          <Field label="Mã nhân viên"><input className={inputCls} required value={form.employee_code} onChange={(e) => setForm({ ...form, employee_code: e.target.value })} /></Field>
          <Field label="Họ tên"><input className={inputCls} required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></Field>
          <Field label="Email"><input className={inputCls} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Vai trò">
            <select className={inputCls} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Phòng ban">
            {depSelect(form.department_id, (v) => setForm({ ...form, department_id: v }), ['CAN_BO', 'HR_MANAGER'].includes(form.role))}
          </Field>
          <Field label="Mật khẩu ban đầu (ít nhất 8 ký tự)">
            <input className={inputCls} type="password" autoComplete="new-password" minLength={8} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
          <div className="flex items-end"><button className={btn.primary} disabled={create.busy}>Cấp tài khoản</button></div>
          <div className="sm:col-span-3"><Notice msg={create.msg} /></div>
        </form>
      </Card>
      <Card title="Khóa / mở khóa / chuyển phòng">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Mã nhân viên"><input className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <button className={btn.danger} disabled={lock.busy || !code.trim()} onClick={() => setActive(false)}>Khóa</button>
          <button className={btn.plain} disabled={lock.busy || !code.trim()} onClick={() => setActive(true)}>Mở khóa</button>
          <Field label="Chuyển sang phòng">{depSelect(moveTo, setMoveTo)}</Field>
          <button className={btn.plain} disabled={lock.busy || !code.trim() || !moveTo} onClick={move}>Chuyển phòng</button>
        </div>
        <div className="mt-3"><Notice msg={lock.msg} /></div>
      </Card>
      <Card title="Phòng ban">
        <p className="mb-3 text-sm text-slate-600">{deps.map((d) => d.name).join(' · ') || 'Chưa có phòng ban.'}</p>
        <form onSubmit={addDep} className="flex flex-wrap items-end gap-3">
          <Field label="Tên phòng ban mới"><input className={inputCls} required value={newDep} onChange={(e) => setNewDep(e.target.value)} /></Field>
          <button className={btn.primary} disabled={dep.busy}>Thêm phòng ban</button>
        </form>
        <div className="mt-3"><Notice msg={dep.msg} /></div>
      </Card>
    </>
  );
}

// Quản trị viên chỉ thấy những người ĐANG có yêu cầu xóa, không có danh sách tài khoản. Đồng ý = chuyển đi xác nhận, chưa xóa
function AdminDeletions() {
  const [rows, setRows] = useState([]);
  const { msg, busy, run } = useAction();
  const fetchRows = async () => setRows((await api.get('/admin/deletion-requests')).data);
  useEffect(() => { run(fetchRows); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const handle = (r, approve) => {
    if (approve && !window.confirm(`Xóa tài khoản ${r.employee_code} (${r.full_name})? Người này sẽ không đăng nhập được nữa; hồ sơ vẫn được lưu trữ.`)) return;
    run(async () => { await api.put(`/admin/deletion-requests/${r.id}`, { approve }); await fetchRows(); },
      approve ? `Đã xóa tài khoản ${r.employee_code}` : `Đã từ chối thực hiện yêu cầu của ${r.employee_code}`);
  };
  const KQ = { cho_lanh_dao: ['Chờ Lãnh đạo đơn vị duyệt', 'text-amber-700'], da_xoa: ['Đã xóa', 'text-rose-700'], tu_choi: ['Đã từ chối', 'text-slate-600'] };
  const table = (list) => (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 text-slate-500">
          <tr><th className="py-2 pr-3">Ngày gửi</th><th className="pr-3">Mã nhân viên</th><th className="pr-3">Họ tên</th><th className="pr-3">Nguồn</th><th className="pr-3">Lý do</th><th className="text-right">Thao tác / kết quả</th></tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.id} className="border-b border-slate-100">
              <td className="py-2 pr-3 whitespace-nowrap">{fmtTime(r.created_at)}</td>
              <td className="pr-3 font-mono">{r.employee_code}</td>
              <td className="pr-3">{r.full_name}</td>
              <td className="pr-3">{r.tu_yeu_cau ? `Cán bộ tự yêu cầu${r.duyet_boi ? `, ${r.duyet_boi} duyệt` : ''}` : `${r.duyet_boi} đề nghị`}</td>
              <td className="pr-3">{r.reason || '—'}</td>
              <td className="space-x-1 whitespace-nowrap text-right">
                {r.status === 'cho_xoa' ? <>
                  <button className={btn.danger} disabled={busy} onClick={() => handle(r, true)}>Xóa tài khoản</button>
                  <button className={btn.plain} disabled={busy} onClick={() => handle(r, false)}>Từ chối</button>
                </> : <span className={KQ[r.status]?.[1]}>{KQ[r.status]?.[0] ?? r.status}{r.xu_ly_boi && ` · ${r.xu_ly_boi}`}{r.handled_at && ` · ${fmtTime(r.handled_at)}`}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <Split rows={rows} isCho={(r) => r.status === 'cho_xoa'} render={table} msg={msg}
      titles={['Yêu cầu đã được lãnh đạo duyệt, chờ bạn xóa', 'Yêu cầu khác (chờ lãnh đạo duyệt, đã xóa, đã từ chối)']}
      action={<button className={btn.plain} disabled={busy} onClick={() => run(fetchRows)}>Tải lại</button>} empty="Không có yêu cầu nào." />
  );
}

function AuditLogs() {
  const [rows, setRows] = useState([]);
  const { msg, busy, run } = useAction();
  const fetchRows = async () => setRows((await api.get('/admin/audit-logs')).data);
  useEffect(() => { run(fetchRows); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card title="Nhật ký hệ thống (200 dòng mới nhất)" action={<button className={btn.plain} disabled={busy} onClick={() => run(fetchRows)}>Tải lại</button>}>
      <Notice msg={msg} />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-slate-500">
            <tr><th className="py-2 pr-3">Thời gian</th><th className="pr-3">Mã nhân viên</th><th className="pr-3">Hành động</th><th className="pr-3">Đối tượng</th><th>IP</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-slate-100">
                <td className="py-1.5 pr-3 whitespace-nowrap">{fmtTime(r.created_at)}</td>
                <td className="pr-3 font-mono">{r.employee_code ?? '—'}</td>
                <td className="pr-3 font-mono text-xs">{r.action}</td>
                <td className="pr-3 font-mono text-xs">{r.target ?? ''}</td>
                <td className="font-mono text-xs">{r.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
