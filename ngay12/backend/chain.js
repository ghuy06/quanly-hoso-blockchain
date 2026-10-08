const crypto = require('crypto');

// Gọi chaincode hosocc qua ChainLaunch API. Backend không giữ private key:
// ChainLaunch ký giao dịch bằng key trong két, chọn theo key_id của vai trò.
// Chứng chỉ tự ký của ChainLaunch được tin qua NODE_EXTRA_CA_CERTS (xem "npm start").
const { CHAINLAUNCH_URL, CHAINCODE_ID, CHAINLAUNCH_USER, CHAINLAUNCH_PASSWORD } = process.env;
const KEY = {
    ADMIN: process.env.KEY_ADMIN, HR_MANAGER: process.env.KEY_HR_MANAGER,
    CAN_BO: process.env.KEY_CAN_BO, QUAN_LI: process.env.KEY_QUAN_LI,
};
if (!CHAINLAUNCH_URL || !CHAINCODE_ID || !CHAINLAUNCH_PASSWORD || Object.values(KEY).some((k) => !k))
    throw new Error('Thiếu cấu hình CHAINLAUNCH_* hoặc KEY_* trong .env');

const BASE = `${CHAINLAUNCH_URL}/sc/fabric/chaincodes/${CHAINCODE_ID}`;
const AUTH = 'Basic ' + Buffer.from(`${CHAINLAUNCH_USER}:${CHAINLAUNCH_PASSWORD}`).toString('base64');

async function call(kind, role, fn, args) {
    const res = await fetch(`${BASE}/${kind}`, {
        method: 'POST',
        headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ function: fn, args, key_id: KEY[role] }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.status === 'success') return body.result;
    // Lấy câu lỗi của chaincode (nếu có), không lộ địa chỉ nội bộ ra client
    const reason = /chaincode response 500, ([^(]+)/.exec(body.message ?? '')?.[1]?.trim() ?? 'giao dịch bị từ chối';
    console.error('ChainLaunch:', body.message ?? res.status);
    throw Object.assign(new Error(`Blockchain: ${reason}`), { status: 502, notFound: reason.startsWith('không tìm thấy') });
}

// Vân tay = SHA-256 của các trường theo thứ tự cố định. KHÔNG gồm status (trạng thái gốc nằm trên chain)
const sha256 = (arr) => crypto.createHash('sha256').update(JSON.stringify(arr)).digest('hex');
const hashOf = (fields) => (o) => sha256(fields.map((f) => o[f] ?? null));

// Trường mới luôn thêm vào CUỐI; hồ sơ ghi trước khi thêm trường phải lưu lại để ghi vân tay mới
const PROFILE_FIELDS = ['employee_code', 'full_name', 'date_of_birth', 'gender', 'phone_number', 'address', 'department', 'position',
    'citizen_id', 'ethnicity', 'hometown', 'education_level', 'start_date'];

// CHAIN_MODE=off: mô phỏng hệ thống truyền thống (chỉ CSDL) để đo so sánh. Ghi không lên chain,
// xác thực luôn báo "không có bản ghi trên blockchain" vì không còn gì độc lập để đối chiếu
const OFF = process.env.CHAIN_MODE === 'off';
if (OFF) console.warn('⚠️  CHAIN_MODE=off: đang chạy KHÔNG có blockchain (chỉ dùng để đo so sánh)');

module.exports = {
    mode: OFF ? 'off' : 'on',
    invoke: OFF ? async () => ({ transactionId: null, blockNumber: null }) : (role, fn, args) => call('invoke', role, fn, args),
    query: OFF
        ? async () => { throw Object.assign(new Error('Blockchain: đang tắt (mô phỏng hệ thống chỉ có CSDL)'), { status: 502, notFound: true }); }
        : (role, fn, args) => call('query', role, fn, args),
    // Giấy tờ [loại, SHA-256 tệp] và bản ghi nhóm 2-15 (bản rõ) nằm trong vân tay hồ sơ: tráo tệp hay sửa DB đều lệch hash.
    // Chỉ thêm khi có, để hồ sơ cũ giữ nguyên vân tay đã ghi
    hashProfile: (p) => sha256([...PROFILE_FIELDS.map((f) => p[f] ?? null), ...(p.documents?.length ? [p.documents] : []),
        ...(p.nhom?.length ? [{ nhom: p.nhom }] : [])]),
    // attachment_sha256 nằm trong vân tay: tráo tệp hoặc sửa cột này đều làm lệch hash
    hashProposal: hashOf(['id', 'employee_code', 'type', 'title', 'reason', 'attachment_sha256']),
    // Tờ trình xin chủ trương bổ nhiệm/miễn nhiệm/điều động
    hashQuyTrinh: hashOf(['id', 'employee_code', 'loai', 'chuc_vu_cu', 'chuc_vu_moi', 'don_vi_cu', 'don_vi_moi', 'he_so_moi', 'ly_do']),
};
