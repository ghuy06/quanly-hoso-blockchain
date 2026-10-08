import { Fragment, useEffect, useState } from 'react';
import axios from 'axios';
import { Shield, ShieldCheck, ShieldAlert, LogOut } from 'lucide-react';

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
  HR_MANAGER: [['profiles', 'Hồ sơ nhân viên trong phòng'], ['workflows', 'Bổ nhiệm - Điều động'], ['inbox', 'Thông báo & việc'], ['proposals', 'Đề nghị của phòng'], ['me', 'Hồ sơ của tôi'], ['account', 'Tài khoản']],
  QUAN_LI: [['profiles', 'Hồ sơ cán bộ'], ['workflows', 'Bổ nhiệm - Điều động'], ['inbox', 'Thông báo & việc'], ['proposals', 'Đề nghị'], ['account', 'Tài khoản']],
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
  const { msg, busy, run } = useAction();
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const { data } = await api.post('/auth/login', form);
      sessionStorage.setItem('token', data.accessToken);
      sessionStorage.setItem('user', JSON.stringify(data.user));
      onLogin(data.user);
    });
  };
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
      </form>
    </main>
  );
}

function Shell({ user, onLogout }) {
  const tabs = TABS[user.role] ?? [];
  const [tab, setTab] = useState(tabs[0]?.[0]);
  const View = { me: MyProfile, profiles: ProfileList, workflows: Workflows, inbox: Inbox, proposals: Proposals, account: Account,
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
const PROFILE_FIELDS = [
  ['date_of_birth', 'Ngày sinh', 'date'],
  ['gender', 'Giới tính', 'select'],
  ['phone_number', 'Số điện thoại', 'tel'],
  ['address', 'Địa chỉ', 'text'],
  ['phong_ban', 'Phòng ban (do quản trị viên phân công)', 'readonly'],
  ['position', 'Chức vụ (chọn từ danh mục)', 'chuc_vu'],
  ['citizen_id', 'Mã hồ sơ điện tử = số CCCD (12 số)', 'text'],
  ['ethnicity', 'Dân tộc', 'text'],
  ['hometown', 'Quê quán', 'text'],
  ['education_level', 'Trình độ chuyên môn', 'text'],
  ['start_date', 'Ngày vào cơ quan', 'date'],
];

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
  return (
    <div className="space-y-2 text-sm">
      <Notice msg={msg} />
      {rows.length === 0 ? <p className="text-slate-500">Chưa có thay đổi nào.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr><th className="py-1 pr-2">Phiên bản</th><th className="pr-2">Trường</th><th className="pr-2">Giá trị cũ</th><th className="pr-2">Giá trị mới</th>
                <th className="pr-2">Loại</th><th className="pr-2">Lý do / căn cứ</th><th className="pr-2">Người cập nhật</th><th className="pr-2">Người duyệt</th><th className="pr-2">Hiệu lực</th><th>Trạng thái</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
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
      )}
    </div>
  );
}

function MyProfile({ user }) {
  const m = useMaster();
  const [p, setP] = useState(null);
  const [form, setForm] = useState({});
  const [docs, setDocs] = useState([]);
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

  if (!p) return <Card title="Hồ sơ của tôi">{msg ? <Notice msg={msg} /> : 'Đang tải…'}</Card>;
  return (
    <>
      <Card title="Hồ sơ của tôi" action={<Badge status={p.status} />}>
        <p className="mb-4 text-sm text-slate-600"><b className="text-slate-900">{p.full_name}</b> · Mã nhân viên {p.employee_code} · {p.email}</p>
        <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
          {PROFILE_FIELDS.map(([k, label, type]) => (
            <Field key={k} label={label}>
              {type === 'readonly' ? (
                <input className={`${inputCls} bg-slate-100`} value={p.phong_ban ?? '—'} disabled />
              ) : type === 'chuc_vu' && p.position ? (
                <input className={`${inputCls} bg-slate-100`} value={`${p.position} (chỉ đổi theo quyết định)`} disabled />
              ) : type === 'chuc_vu' ? (
                <select className={inputCls} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })}>
                  <option value="">— Chọn chức vụ —</option>
                  {m?.chucVu.map((c) => <option key={c.ten}>{c.ten}</option>)}
                </select>
              ) : type === 'select' ? (
                <select className={inputCls} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })}>
                  <option value="">—</option><option>Nam</option><option>Nữ</option><option>Khác</option>
                </select>
              ) : (
                <input className={inputCls} type={type} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
              )}
            </Field>
          ))}
          <Field label="Lý do thay đổi">
            <input className={inputCls} value={form.change_reason} onChange={(e) => setForm({ ...form, change_reason: e.target.value })} />
          </Field>
          <Field label="Căn cứ (giấy tờ đã tải lên, vd. quyết định điều động)">
            <select className={inputCls} value={form.legal_document_id} onChange={(e) => setForm({ ...form, legal_document_id: e.target.value })}>
              <option value="">— Không có —</option>
              {docs.map((d) => <option key={d.id} value={d.id}>{d.doc_type} ({fmtTime(d.created_at)})</option>)}
            </select>
          </Field>
          <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
            <button className={btn.primary} disabled={busy}>Lưu và gửi duyệt</button>
            <Notice msg={msg} />
          </div>
        </form>
      </Card>
      {p.status && (
        <Card title="Hồ sơ điện tử: nhóm 2-15">
          <HoSo16 userId={p.user_id} user={user} onChanged={() => run(fetchMe)} />
        </Card>
      )}
      {p.status && (
        <Card title="Nhóm 16. Tài liệu đính kèm">
          <Documents userId={p.user_id} canUpload onUploaded={() => run(fetchMe)} />
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

// Giấy tờ hồ sơ: tệp được quét mã độc, lưu MÃ HÓA trên máy chủ; SHA-256 bản gốc nằm trong vân tay hồ sơ trên blockchain
const DOC_TYPES = ['Giấy khai sinh', 'Bằng cấp, chứng chỉ', 'Bản chụp CCCD', 'Sơ yếu lý lịch', 'Quyết định tuyển dụng, bổ nhiệm', 'Khác'];

function Documents({ userId, canUpload, onUploaded }) {
  const [docs, setDocs] = useState([]);
  const [type, setType] = useState(DOC_TYPES[0]);
  const [file, setFile] = useState(null);
  const [fileKey, setFileKey] = useState(0); // đổi key để xóa ô chọn tệp sau khi gửi
  const { msg, busy, run } = useAction();
  const fetchDocs = async () => setDocs((await api.get(`/profiles/${userId}/documents`)).data);
  useEffect(() => { run(fetchDocs); }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      if (!file) throw new Error('Chưa chọn tệp');
      if (file.size > 5 * 1024 * 1024) throw new Error('Tệp vượt quá 5MB');
      const fd = new FormData();
      fd.append('doc_type', type);
      fd.append('file', file);
      await api.post('/profiles/me/documents', fd);
      setFile(null);
      setFileKey((k) => k + 1);
      await fetchDocs();
      onUploaded?.();
    }, 'Đã quét mã độc, mã hóa tệp và ghi vân tay hồ sơ lên blockchain. Hồ sơ chờ trưởng phòng duyệt lại.');
  };

  return (
    <div className="space-y-3 text-sm">
      {docs.length === 0 ? <p className="text-slate-500">Chưa có giấy tờ nào.</p> : (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
          {docs.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span><span className="font-mono text-slate-400">#{d.id}</span> <b>{d.doc_type}</b> <span className="text-slate-500">· {fmtTime(d.created_at)}</span></span>
              <span className="flex items-center gap-2">
                <code className="text-xs text-slate-400" title={d.sha256}>SHA-256 {d.sha256.slice(0, 12)}…</code>
                {d.chu_ky_so && <code className="text-xs text-emerald-700" title={d.chu_ky_so}>ký số tx {d.chu_ky_so.slice(0, 10)}…</code>}
                <button className={btn.plain} disabled={busy} onClick={() => run(() => openBlob(`/profiles/${userId}/documents/${d.id}`))}>Mở</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {canUpload && (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <Field label="Loại giấy tờ">
            <select className={inputCls} value={type} onChange={(e) => setType(e.target.value)}>
              {DOC_TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="Tệp (PDF, JPG, PNG, tối đa 5MB)">
            <input key={fileKey} type="file" accept=".pdf,.jpg,.jpeg,.png" className="text-sm" onChange={(e) => setFile(e.target.files[0] ?? null)} />
          </Field>
          <button className={btn.primary} disabled={busy}>{busy ? 'Đang tải lên…' : 'Tải lên'}</button>
        </form>
      )}
      <Notice msg={msg} />
    </div>
  );
}

// Phân trang 50 dòng: mỗi lần tải 1 trang được tính vào bộ lọc truy cập hàng loạt của backend
function ProfileList({ user }) {
  const [rows, setRows] = useState([]);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(null);
  const { msg, busy, run } = useAction();
  const fetchRows = async () => setRows((await api.get('/profiles', { params: { page } })).data);
  useEffect(() => { run(fetchRows); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  const review = (id, status) =>
    run(async () => { await api.put(`/profiles/${id}/review`, { status }); await fetchRows(); },
      status === 'da_duyet' ? 'Đã duyệt hồ sơ (đã ghi lên blockchain)' : 'Đã từ chối hồ sơ (đã ghi lên blockchain)');

  return (
    <Card title={user.role === 'HR_MANAGER' ? 'Hồ sơ nhân viên trong phòng' : 'Hồ sơ cán bộ'} action={
      <div className="flex flex-wrap items-center gap-2">
        <button className={btn.plain} disabled={busy || page === 0} onClick={() => setPage(page - 1)}>Trang trước</button>
        <span className="text-sm text-slate-500">Trang {page + 1}</span>
        <button className={btn.plain} disabled={busy || rows.length < 50} onClick={() => setPage(page + 1)}>Trang sau</button>
        <button className={btn.plain} disabled={busy} onClick={() => run(fetchRows)}>Tải lại</button>
      </div>}>
      <Notice msg={msg} />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-slate-500">
            <tr><th className="py-2 pr-3">Mã</th><th className="pr-3">Họ tên</th><th className="pr-3">Phòng ban</th><th className="pr-3">Chức vụ</th><th className="pr-3">Trạng thái</th><th className="text-right">Thao tác</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.user_id}>
                <tr className="border-b border-slate-100">
                  <td className="py-2 pr-3 font-mono">{r.employee_code}</td>
                  <td className="pr-3">{r.full_name}</td>
                  <td className="pr-3">{r.phong_ban}</td>
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
                        Chi tiết
                      </button>
                    )}
                  </td>
                </tr>
                {open === r.user_id && (
                  <tr>
                    <td colSpan={6} className="space-y-3 py-3">
                      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                        {PROFILE_FIELDS.map(([k, label]) => (
                          <div key={k}><dt className="inline text-slate-500">{label}: </dt><dd className="inline">{r[k] || '—'}</dd></div>
                        ))}
                      </dl>
                      <ReviewInfo p={r} />
                      <HoSo16 userId={r.user_id} user={user} />
                      <Documents userId={r.user_id} />
                      <ChainPanel key={r.status} kind="profiles" id={r.user_id} />
                      <DataHistory userId={r.user_id} reloadKey={r.status} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ========== 16 NHÓM DỮ LIỆU HỒ SƠ (NĐ 27/2026/NĐ-CP) ==========
// Danh mục dùng chung (cấu hình nhóm, chức vụ, phòng ban) tải 1 lần
let masterCache;
const loadMaster = () => (masterCache ??= Promise.all([api.get('/master/nhom'), api.get('/master/chuc-vu'), api.get('/departments')])
  .then(([n, c, d]) => ({ nhom: n.data, chucVu: c.data, donVi: d.data }))
  .catch((e) => { masterCache = null; throw e; }));
function useMaster() {
  const [m, setM] = useState(null);
  useEffect(() => { loadMaster().then(setM, () => {}); }, []);
  return m;
}

// Chức vụ, đơn vị và trường có danh sách là ô CHỌN (không gõ tự do); backend kiểm tra lại
function NhomInput({ type, value, onChange, m }) {
  const opts = Array.isArray(type) ? type : type === 'chuc_vu' ? m.chucVu.map((c) => c.ten) : type === 'don_vi' ? m.donVi.map((d) => d.name) : null;
  if (opts) return (
    <select required className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— Chọn —</option>{opts.map((o) => <option key={o}>{o}</option>)}
    </select>
  );
  return <input required className={inputCls} type={type === 'date' ? 'date' : 'text'} value={value} onChange={(e) => onChange(e.target.value)}
    inputMode={type === 'so' || type === 'cccd' ? 'decimal' : undefined} pattern={type === 'cccd' ? '\\d{12}' : type === 'so' ? '\\d+(\\.\\d+)?' : undefined} />;
}

const NHAP_LABEL = { ca_nhan: 'chủ hồ sơ kê khai', to_chuc: 'trưởng phòng / TCCB cập nhật', he_thong: 'tự động khi ký quyết định' };

function HoSo16({ userId, user, onChanged }) {
  const m = useMaster();
  const [rows, setRows] = useState([]);
  const [openN, setOpenN] = useState(null);
  const [form, setForm] = useState({});
  const { msg, busy, run } = useAction();
  const load = async () => setRows((await api.get(`/profiles/${userId}/nhom`)).data);
  useEffect(() => { run(load); }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!m) return <Notice msg={msg} />;
  const self = userId === user.id;
  const coTheGhi = (nhap) => (nhap === 'ca_nhan' && self && ['CAN_BO', 'HR_MANAGER'].includes(user.role))
    || (nhap === 'to_chuc' && !self && user.role === 'HR_MANAGER');
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
      <p className="text-slate-500">Nhóm 1 (định danh: mã hồ sơ = CCCD, họ tên, ngày sinh, tình trạng hồ sơ) là phần thông tin chung;
        nhóm 16 (tài liệu đính kèm, chữ ký số) là phần giấy tờ.</p>
      {Object.entries(m.nhom).map(([n, [ten, nhap, truong]]) => {
        const ds = rows.filter((r) => r.nhom === Number(n));
        if (n === '13' && !self && user.role !== 'QUAN_LI') return null;
        return (
          <details key={n} className="rounded-md border border-slate-200 bg-white">
            <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span><b>Nhóm {n}. {ten}</b> <span className="text-slate-400">· {ds.filter((r) => !r.huy_luc).length} bản ghi · {NHAP_LABEL[nhap]}</span></span>
              {n === '13' && <span className="text-xs text-rose-700">Bảo mật: chỉ chủ hồ sơ và Lãnh đạo đơn vị xem</span>}
            </summary>
            <div className="space-y-2 border-t border-slate-100 px-3 py-2">
              {ds.length === 0 ? <p className="text-slate-500">Chưa có bản ghi.</p> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-slate-500">
                      <tr>{truong.map(([k, l]) => <th key={k} className="pr-2">{l}</th>)}<th className="pr-2">Ghi bởi</th><th /></tr>
                    </thead>
                    <tbody>
                      {ds.map((r) => (
                        <tr key={r.id} className="border-t border-slate-100">
                          {truong.map(([k]) => <td key={k} className={`py-1 pr-2 ${r.huy_luc ? 'text-slate-400 line-through' : ''}`}>{r.du_lieu?.[k] ?? '—'}</td>)}
                          <td className="pr-2">{r.created_by_code}{r.quy_trinh_id ? ` · theo quy trình #${r.quy_trinh_id}` : ''}</td>
                          <td className="whitespace-nowrap text-right">
                            {r.huy_luc ? <span className="text-slate-400" title={r.ly_do_huy}>Đã hủy hiệu lực</span>
                              : coTheGhi(nhap) && <button className={btn.danger} disabled={busy} onClick={() => huy(r)}>Hủy hiệu lực</button>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {coTheGhi(nhap) && (openN === n ? (
                <form onSubmit={add(n)} className="grid gap-2 sm:grid-cols-3">
                  {truong.map(([k, l, type]) => (
                    <Field key={k} label={l}><NhomInput type={type} m={m} value={form[k] ?? ''} onChange={(v) => setForm({ ...form, [k]: v })} /></Field>
                  ))}
                  <div className="flex items-end gap-2">
                    <button className={btn.primary} disabled={busy}>Lưu bản ghi</button>
                    <button type="button" className={btn.plain} onClick={() => setOpenN(null)}>Đóng</button>
                  </div>
                </form>
              ) : <button className={btn.plain} onClick={() => { setForm({}); setOpenN(n); }}>Thêm bản ghi</button>)}
            </div>
          </details>
        );
      })}
    </div>
  );
}

// ========== QUY TRÌNH BỔ NHIỆM / MIỄN NHIỆM / ĐIỀU ĐỘNG ==========
// Trưởng phòng chỉ đề xuất; TCCB thẩm định, tổng hợp phiếu; tập thể lãnh đạo biểu quyết kín; lãnh đạo có thẩm quyền ký.
// Giao diện chỉ hiện nút theo vai trò; backend kiểm tra lại mọi quyền
const LOAI_QT = { bo_nhiem: 'Bổ nhiệm (thăng chức)', mien_nhiem: 'Miễn nhiệm / giáng chức', dieu_dong: 'Điều động / luân chuyển' };
const BUOC_QT = { bo_nhiem: [1, 2, 3, 4, 5], mien_nhiem: [1, 2, 4, 5], dieu_dong: [1, 2, 4, 5] };
const TEN_BUOC = { 1: 'Xin chủ trương', 2: 'Tập thể lãnh đạo xem xét', 3: 'Lấy ý kiến giới thiệu', 4: 'Thẩm định & biểu quyết', 5: 'Ký quyết định' };
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
  const { msg, busy, run } = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => {
    e.preventDefault();
    run(async () => { await api.post('/quy-trinh', f); setF(empty); onCreated(); }, 'Đã gửi tờ trình xin chủ trương; tập thể lãnh đạo được thông báo để xem xét.');
  };
  return (
    <Card title="Bước 1. Xin chủ trương (tờ trình)">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3">
        <Field label="Loại"><select className={inputCls} value={f.loai} onChange={set('loai')}>
          {Object.entries(LOAI_QT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Mã hồ sơ của cán bộ (số CCCD)">
          <input className={inputCls} required pattern="\d{12}" inputMode="numeric" value={f.cccd} onChange={set('cccd')} /></Field>
        <Field label={f.loai === 'dieu_dong' ? 'Chức vụ mới (để trống = giữ nguyên)' : 'Chức vụ mới'}>
          <select className={inputCls} required={f.loai !== 'dieu_dong'} value={f.chuc_vu_moi} onChange={set('chuc_vu_moi')}>
            <option value="">— Chọn chức vụ —</option>{m?.chucVu.map((c) => <option key={c.ten}>{c.ten}</option>)}</select></Field>
        <Field label={f.loai === 'dieu_dong' ? 'Đơn vị mới' : 'Đơn vị mới (để trống = giữ nguyên)'}>
          <select className={inputCls} required={f.loai === 'dieu_dong'} value={f.don_vi_moi} onChange={set('don_vi_moi')}>
            <option value="">— Chọn phòng ban —</option>{m?.donVi.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
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
      {Object.entries(q.ket_qua_buoc ?? {}).map(([b, k]) => (
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
          {q.phieu.duoc_bo && !q.phieu.toi_da_bo && (q.buoc !== 4 || q.tham_dinh_dat != null) && (
            <>
              <button className={btn.primary} disabled={busy} onClick={() => vote(true)}>Đồng ý</button>
              <button className={btn.danger} disabled={busy} onClick={() => vote(false)}>Không đồng ý</button>
            </>
          )}
          {q.phieu.toi_da_bo && <span className="text-emerald-700">Bạn đã bỏ phiếu.</span>}
          {q.buoc === 4 && q.tham_dinh_dat == null && <span className="text-slate-500">Chờ TCCB thẩm định trước khi biểu quyết.</span>}
        </div>
      )}
      {dang && q.buoc === 3 && user.role === 'HR_MANAGER' && (
        <button className={btn.plain} disabled={busy}
          onClick={() => act(() => api.put(`/quy-trinh/${q.id}/ket-thuc-hoi-nghi`), 'Đã tổng hợp phiếu hội nghị, chuyển sang thẩm định.')}>
          Kết thúc hội nghị, tổng hợp phiếu (TCCB)</button>
      )}
      {dang && q.buoc === 4 && q.tham_dinh_dat == null && user.role === 'HR_MANAGER' && (
        <form className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => { e.preventDefault(); act(() => api.put(`/quy-trinh/${q.id}/tham-dinh`, { dat: td.dat === 'true', nhan_xet: td.nhan_xet }), 'Đã gửi ý kiến thẩm định.'); }}>
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

function Workflows({ user }) {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(null);
  const { msg, busy, run } = useAction();
  const load = async () => setRows((await api.get('/quy-trinh')).data);
  useEffect(() => { run(load); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const act = (fn, ok) => run(async () => { await fn(); await load(); }, ok);
  return (
    <>
      {user.role !== 'CAN_BO' && <NewWorkflow onCreated={() => run(load)} />}
      <Card title="Quy trình bổ nhiệm, miễn nhiệm, điều động" action={<button className={btn.plain} disabled={busy} onClick={() => run(load)}>Tải lại</button>}>
        <Notice msg={msg} />
        {rows.length === 0 ? <p className="text-sm text-slate-500">Không có quy trình nào bạn được xem.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr><th className="py-2 pr-3">Số</th><th className="pr-3">Loại</th><th className="pr-3">Cán bộ</th><th className="pr-3">Chức vụ</th>
                  <th className="pr-3">Đơn vị</th><th className="pr-3">Bước</th><th className="pr-3">Trạng thái</th><th className="text-right">Thao tác</th></tr>
              </thead>
              <tbody>
                {rows.map((q) => (
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
        )}
      </Card>
    </>
  );
}

// ========== THÔNG BÁO, VIỆC BÀN GIAO / TIẾP NHẬN, HÀNG ĐỢI ĐỒNG BỘ ==========
const KENH = { csdlqg: 'CSDL quốc gia CBCCVC', email: 'Email' };
const HD_STATUS = { cho_gui: 'Chờ gửi (chưa cấu hình điểm nhận)', da_gui: 'Đã gửi', loi: 'Lỗi, sẽ thử lại' };

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
  return (
    <>
      <Card title="Thông báo" action={<button className={btn.plain} disabled={busy} onClick={() => run(load)}>Tải lại</button>}>
        <Notice msg={msg} />
        {tb.length === 0 ? <p className="text-sm text-slate-500">Chưa có thông báo.</p> : (
          <ul className="divide-y divide-slate-100 text-sm">
            {tb.map((t) => (
              <li key={t.id} className={`flex flex-wrap items-center justify-between gap-2 py-2 ${t.da_doc ? 'text-slate-500' : ''}`}>
                <span>{t.loai === 'canh_bao' && <b className="mr-1 text-rose-700">Cảnh báo:</b>}{t.noi_dung}
                  <span className="text-slate-400"> · {fmtTime(t.created_at)}</span></span>
                {!t.da_doc && <button className={btn.plain} disabled={busy} onClick={() => act(() => api.put(`/thong-bao/${t.id}/da-doc`))}>Đã đọc</button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {user.role !== 'ADMIN' && (
        <Card title="Việc bàn giao / tiếp nhận được giao">
          {cv.length === 0 ? <p className="text-sm text-slate-500">Không có việc nào.</p> : (
            <ul className="divide-y divide-slate-100 text-sm">
              {cv.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span><b>{c.loai === 'ban_giao' ? 'Bàn giao công việc' : 'Tiếp nhận cán bộ'}</b> · {c.full_name} ({c.employee_code}) theo QĐ {c.so_quyet_dinh}
                    · hạn {fmtDate(c.han)}{c.qua_han && <b className="ml-1 text-rose-700">quá hạn</b>}</span>
                  {c.xong_luc ? <span className="text-emerald-700">Đã xong {fmtTime(c.xong_luc)}</span>
                    : <button className={btn.primary} disabled={busy} onClick={() => act(() => api.put(`/cong-viec/${c.id}/xong`), 'Đã xác nhận hoàn thành.')}>Hoàn thành</button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {user.role === 'ADMIN' && (
        <Card title="Hàng đợi gửi ra ngoài (chỉ trạng thái, không xem nội dung)">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-slate-500"><tr><th className="py-2 pr-3">Số</th><th className="pr-3">Kênh</th><th className="pr-3">Quy trình</th><th className="pr-3">Trạng thái</th><th className="pr-3">Lần gửi</th><th>Lỗi</th></tr></thead>
              <tbody>{hd.map((h) => (
                <tr key={h.id} className="border-b border-slate-100"><td className="py-1 pr-3 font-mono">{h.id}</td><td className="pr-3">{KENH[h.kenh]}</td>
                  <td className="pr-3">#{h.quy_trinh_id}</td><td className="pr-3">{HD_STATUS[h.trang_thai]}</td><td className="pr-3">{h.so_lan}</td><td className="text-rose-700">{h.loi}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </Card>
      )}
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

function Proposals({ user }) {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(null);
  const { msg, busy, run } = useAction();
  const fetchRows = async () => setRows((await api.get('/proposals')).data);
  useEffect(() => { run(fetchRows); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const act = (id, step, status, text) =>
    run(async () => { await api.put(`/proposals/${id}/${step}`, { status }); await fetchRows(); }, text);
  const openAttachment = (id) => run(() => openBlob(`/proposals/${id}/attachment`));
  const showSender = user.role !== 'CAN_BO';

  return (
    <>
      {user.role === 'CAN_BO' && <NewProposal onCreated={() => run(fetchRows)} />}
      <Card title={user.role === 'CAN_BO' ? 'Đề nghị của tôi' : 'Danh sách đề nghị'}
        action={<button className={btn.plain} disabled={busy} onClick={() => run(fetchRows)}>Tải lại</button>}>
        <Notice msg={msg} />
        {rows.length === 0 && <p className="text-sm text-slate-500">Chưa có đề nghị nào.</p>}
        {rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-slate-500">
                <tr>
                  <th className="py-2 pr-3">Số</th>{showSender && <th className="pr-3">Người gửi</th>}
                  <th className="pr-3">Loại</th><th className="pr-3">Tiêu đề</th><th className="pr-3">Ngày gửi</th><th className="pr-3">Trạng thái</th><th className="text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
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
        )}
      </Card>
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

const DEL_STATUS = { cho_xu_ly: 'đang chờ quản trị viên xử lý', da_xoa: 'đã được chấp thuận', tu_choi: 'đã bị từ chối' };

// Nhân viên bấm xóa -> gửi yêu cầu tới quản trị viên; tài khoản chỉ bị xóa khi quản trị viên chấp thuận
function DeletionRequest() {
  const [req, setReq] = useState(null);
  const [reason, setReason] = useState('');
  const { msg, busy, run } = useAction();
  const fetchReq = async () => setReq((await api.get('/account/deletion-request')).data);
  useEffect(() => { run(fetchReq); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = (e) => {
    e.preventDefault();
    if (!window.confirm('Gửi yêu cầu xóa tài khoản tới quản trị viên?')) return;
    run(async () => { await api.post('/account/deletion-request', { reason }); setReason(''); await fetchReq(); },
      'Đã gửi yêu cầu xóa tài khoản. Quản trị viên sẽ xem xét.');
  };
  const pending = req?.status === 'cho_xu_ly';
  return (
    <Card title="Xóa tài khoản">
      <div className="max-w-xl space-y-3 text-sm">
        <p className="text-slate-600">Tài khoản chỉ bị xóa khi quản trị viên chấp thuận. Sau khi xóa bạn không đăng nhập được nữa;
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

// Quản trị viên chỉ thấy những người ĐANG yêu cầu xóa tài khoản, không có danh sách tài khoản
function AdminDeletions() {
  const [rows, setRows] = useState([]);
  const { msg, busy, run } = useAction();
  const fetchRows = async () => setRows((await api.get('/admin/deletion-requests')).data);
  useEffect(() => { run(fetchRows); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const handle = (r, approve) => {
    if (approve && !window.confirm(`Xóa tài khoản ${r.employee_code}? Người này sẽ không đăng nhập được nữa.`)) return;
    run(async () => { await api.put(`/admin/deletion-requests/${r.id}`, { approve }); await fetchRows(); },
      approve ? `Đã xóa tài khoản ${r.employee_code}` : `Đã từ chối yêu cầu của ${r.employee_code}`);
  };
  return (
    <Card title="Yêu cầu xóa tài khoản đang chờ" action={<button className={btn.plain} disabled={busy} onClick={() => run(fetchRows)}>Tải lại</button>}>
      <Notice msg={msg} />
      {rows.length === 0 ? <p className="text-sm text-slate-500">Không có yêu cầu nào.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-slate-500">
              <tr><th className="py-2 pr-3">Ngày gửi</th><th className="pr-3">Mã nhân viên</th><th className="pr-3">Họ tên</th><th className="pr-3">Lý do</th><th className="text-right">Thao tác</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-100">
                  <td className="py-2 pr-3 whitespace-nowrap">{fmtTime(r.created_at)}</td>
                  <td className="pr-3 font-mono">{r.employee_code}</td>
                  <td className="pr-3">{r.full_name}</td>
                  <td className="pr-3">{r.reason || '—'}</td>
                  <td className="space-x-1 whitespace-nowrap text-right">
                    <button className={btn.danger} disabled={busy} onClick={() => handle(r, true)}>Xóa tài khoản</button>
                    <button className={btn.plain} disabled={busy} onClick={() => handle(r, false)}>Từ chối</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
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
