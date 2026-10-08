require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./config/db');
const secure = require('./secure');
const chain = require('./chain');
const { verifyToken, checkRole } = require('./middlewares/authMiddleware');

if (!process.env.JWT_ACCESS_SECRET) throw new Error('Thiếu JWT_ACCESS_SECRET trong .env');

const app = express();
const PORT = process.env.PORT || 5000;
// Mã vai trò nội bộ (giữ nguyên vì chaincode dùng); tên hiển thị:
// CAN_BO = Nhân viên, HR_MANAGER = Trưởng phòng (quản lý hồ sơ nhân viên trong phòng),
// QUAN_LI = Lãnh đạo đơn vị, ADMIN = Quản trị viên
const ROLES = ['ADMIN', 'HR_MANAGER', 'CAN_BO', 'QUAN_LI'];
const NEED_DEPARTMENT = ['CAN_BO', 'HR_MANAGER'];
const DUMMY_HASH = bcrypt.hashSync('khong-dung', 10); // so sánh giả khi email không tồn tại (chống dò email)

// Lỗi kèm mã HTTP, được bộ xử lý lỗi cuối file trả về cho client
const fail = (status, message) => Object.assign(new Error(message), { status });
// Ô trống từ form -> NULL trong DB
const val = (x) => (x === '' || x === undefined ? null : x);

// Ghi nhật ký để ADMIN giám sát
const audit = (req, action, target = null) =>
    db.query('INSERT INTO audit_logs (user_id, action, target, ip) VALUES ($1, $2, $3, $4)',
        [req.user?.id ?? null, action, target, req.ip]);

// ========== 1. LỚP BẢO VỆ CHUNG ==========
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_ORIGIN }));
app.use(express.json({ limit: '100kb' }));
// Theo IP: chặn khách lạ gửi dồn dập. Giới hạn chính là theo từng tài khoản (authMiddleware)
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: Number(process.env.IP_RATE_MAX ?? 1000) }));

// Tài khoản bị chiếm thường "hút" dữ liệu hàng loạt: đếm số lần xem danh sách hồ sơ / mở giấy tờ
// trong 1 giờ (đếm trong nhật ký). Vượt ngưỡng -> tự khóa tài khoản, chờ quản trị viên xem xét mở lại
const BULK_ACTIONS = ['view_profiles', 'view_document', 'view_attachment'];
const BULK_MAX = Number(process.env.BULK_MAX_PER_HOUR ?? 60);
const guardBulk = async (req, res, next) => {
    const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM audit_logs
         WHERE user_id = $1 AND action = ANY($2) AND created_at > now() - interval '1 hour'`, [req.user.id, BULK_ACTIONS]);
    if (rows[0].n >= BULK_MAX) {
        await db.query('UPDATE users SET is_active = false WHERE id = $1', [req.user.id]);
        await audit(req, 'auto_lock_bulk_read', `user:${req.user.id}`);
        throw fail(423, 'Truy cập dữ liệu bất thường: tài khoản đã bị tạm khóa, hãy liên hệ quản trị viên');
    }
    next();
};

// ========== 2. UPLOAD: chỉ PDF/JPG/PNG, tối đa 5MB; quét mã độc; lưu bản MÃ HÓA với tên ngẫu nhiên ==========
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const ALLOWED = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' };
// Kiểm tra nội dung thật của tệp (magic bytes), không tin mimetype do client khai
const MAGIC = { '.pdf': '25504446', '.jpg': 'ffd8ff', '.png': '89504e470d0a1a0a' };
// Tệp chỉ nằm trong RAM khi kiểm tra, bản rõ không bao giờ ghi xuống đĩa
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) =>
        ALLOWED[file.mimetype] ? cb(null, true) : cb(fail(400, 'Chỉ nhận tệp PDF, JPG hoặc PNG')),
});
const sha256 = (buf) => buf && crypto.createHash('sha256').update(buf).digest('hex');

// Quét mã độc -> kiểm tra định dạng -> mã hóa và ghi. Trả tên tệp và SHA-256 của BẢN GỐC (để băm lên chain)
const saveUpload = async (f) => {
    await secure.scanMalware(f.buffer);
    const ext = ALLOWED[f.mimetype];
    if (!f.buffer.subarray(0, 8).toString('hex').startsWith(MAGIC[ext])) throw fail(400, 'Nội dung tệp không đúng định dạng PDF/JPG/PNG');
    const name = crypto.randomUUID() + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), secure.encFile(f.buffer));
    return { name, sha: sha256(f.buffer) };
};
const removeUpload = (name) => name && fs.rmSync(path.join(UPLOAD_DIR, name), { force: true });
// Đọc và giải mã tệp đã lưu; null nếu tệp mất hoặc bản mã bị sửa
const readUpload = (name) => {
    const f = path.join(UPLOAD_DIR, name);
    return fs.existsSync(f) ? secure.decFile(fs.readFileSync(f)) : null;
};
const sendUpload = (res, name, downloadName) => {
    const buf = readUpload(name);
    if (!buf) throw fail(410, 'Tệp không còn trên máy chủ hoặc đã bị sửa');
    res.attachment(downloadName).send(buf);
};

app.get('/', (req, res) => res.json({ message: 'HRM backend đang chạy', blockchain: chain.mode }));

// ========== 3. XÁC THỰC ==========
app.post('/api/auth/login',
    rateLimit({ windowMs: 15 * 60 * 1000, max: 10, skipSuccessfulRequests: true,
        message: { error: 'Đăng nhập sai quá nhiều lần, thử lại sau 15 phút' } }),
    async (req, res) => {
        const { email, password } = req.body ?? {};
        if (!email || !password) throw fail(400, 'Thiếu email hoặc mật khẩu');
        const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = rows[0];
        const ok = await bcrypt.compare(String(password), user?.password_hash ?? DUMMY_HASH);
        if (!user || !ok) throw fail(401, 'Email hoặc mật khẩu không đúng');
        if (user.deleted_at) throw fail(403, 'Tài khoản đã bị xóa');
        if (!user.is_active) throw fail(403, 'Tài khoản đã bị khóa');
        const accessToken = jwt.sign(
            { id: user.id, role: user.role, employee_code: user.employee_code },
            process.env.JWT_ACCESS_SECRET, { expiresIn: '15m' });
        req.user = user;
        await audit(req, 'login');
        res.json({ accessToken, user: { id: user.id, employee_code: user.employee_code, full_name: user.full_name, role: user.role } });
    });

app.put('/api/auth/change-password', verifyToken, async (req, res) => {
    const { oldPassword, newPassword } = req.body ?? {};
    if (typeof newPassword !== 'string' || newPassword.length < 8) throw fail(400, 'Mật khẩu mới phải có ít nhất 8 ký tự');
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0] || !(await bcrypt.compare(String(oldPassword), rows[0].password_hash))) throw fail(400, 'Mật khẩu cũ không đúng');
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(newPassword, 10), req.user.id]);
    await audit(req, 'change_password');
    res.json({ message: 'Đổi mật khẩu thành công' });
});

// Danh sách phòng ban (chỉ tên, không nhạy cảm)
app.get('/api/departments', verifyToken, async (req, res) => {
    res.json((await db.query('SELECT id, name FROM departments ORDER BY id')).rows);
});

// ========== 4. QUẢN TRỊ VIÊN: cấp phát, khóa/mở, chuyển phòng, xử lý yêu cầu xóa tài khoản ==========
// Quản trị viên KHÔNG xem được danh sách tài khoản hay hồ sơ (quyền tối thiểu)
app.post('/api/admin/departments', verifyToken, checkRole(['ADMIN']), async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw fail(400, 'Cần tên phòng ban');
    const { rows } = await db.query('INSERT INTO departments (name) VALUES ($1) RETURNING id, name', [name]);
    await audit(req, 'create_department', `department:${rows[0].id}`);
    res.status(201).json(rows[0]);
});

app.post('/api/admin/users', verifyToken, checkRole(['ADMIN']), async (req, res) => {
    const { employee_code, full_name, email, password, role, department_id } = req.body ?? {};
    if (!employee_code || !full_name || !email || !ROLES.includes(role) || typeof password !== 'string' || password.length < 8)
        throw fail(400, 'Cần đủ employee_code, full_name, email, role hợp lệ và mật khẩu từ 8 ký tự');
    if (NEED_DEPARTMENT.includes(role) && !department_id) throw fail(400, 'Nhân viên và trưởng phòng phải thuộc một phòng ban');
    const { rows } = await db.query(
        `INSERT INTO users (employee_code, full_name, email, password_hash, role, department_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, employee_code, full_name, email, role, department_id, is_active`,
        [employee_code, full_name, email, await bcrypt.hash(password, 10), role, val(department_id)]);
    await audit(req, 'create_user', `user:${rows[0].id}`);
    res.status(201).json(rows[0]);
});

// Khóa/mở khóa theo mã cán bộ (quản trị viên không có danh sách để tra id). Tài khoản đã xóa không mở lại được
app.patch('/api/admin/users/:code/active', verifyToken, checkRole(['ADMIN']), async (req, res) => {
    const { is_active } = req.body ?? {};
    if (typeof is_active !== 'boolean') throw fail(400, 'is_active phải là true hoặc false');
    if (req.params.code === req.user.employee_code) throw fail(400, 'Không thể tự khóa tài khoản của mình');
    const { rows } = await db.query(
        'UPDATE users SET is_active = $1 WHERE employee_code = $2 AND deleted_at IS NULL RETURNING id, employee_code, is_active',
        [is_active, req.params.code]);
    if (!rows[0]) throw fail(404, 'Không tìm thấy tài khoản (hoặc tài khoản đã bị xóa)');
    await audit(req, is_active ? 'unlock_user' : 'lock_user', `user:${rows[0].id}`);
    res.json(rows[0]);
});

// Điều chuyển phòng ban: phạm vi quản lý của trưởng phòng thay đổi ngay ở request kế tiếp
app.patch('/api/admin/users/:code/department', verifyToken, checkRole(['ADMIN']), async (req, res) => {
    const { department_id } = req.body ?? {};
    if (!department_id) throw fail(400, 'Cần department_id');
    const { rows } = await db.query(
        'UPDATE users SET department_id = $1 WHERE employee_code = $2 AND deleted_at IS NULL RETURNING id, employee_code, department_id',
        [department_id, req.params.code]);
    if (!rows[0]) throw fail(404, 'Không tìm thấy tài khoản (hoặc tài khoản đã bị xóa)');
    await audit(req, 'move_department', `user:${rows[0].id}`);
    res.json(rows[0]);
});

app.get('/api/admin/audit-logs', verifyToken, checkRole(['ADMIN']), async (req, res) => {
    const { rows } = await db.query(
        `SELECT a.id, a.action, a.target, a.ip, a.created_at, u.employee_code
         FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
         ORDER BY a.id DESC LIMIT 200`);
    res.json(rows);
});

// ========== 5. XÓA TÀI KHOẢN: luôn qua hai người ==========
// Bước 1, quản trị viên: kiểm tra yêu cầu của cán bộ rồi chuyển đi, hoặc tự đề nghị (nghỉ hưu, thôi việc...).
// Bước 2, Lãnh đạo đơn vị hoặc TCCB: xác nhận thì mới xóa. Một người (kể cả quản trị viên bị chiếm tài khoản)
// không tự xóa được ai.
// "Xóa" = vô hiệu hóa vĩnh viễn + ẩn khỏi danh sách. Hồ sơ, giấy tờ và lịch sử trên chain vẫn được lưu
// trữ theo quy định (hồ sơ cán bộ phải lưu lâu dài; tài khoản hrm_web cũng không có quyền DELETE)
const CHO = `status IN ('cho_xu_ly', 'cho_xac_nhan')`;
const xacNhanXoaDuoc = async (u) => u.role === 'QUAN_LI' || (await laTCCB(u));
const chiNguoiXacNhan = async (req) => {
    if (!(await xacNhanXoaDuoc(req.user))) throw fail(403, 'Chỉ Lãnh đạo đơn vị hoặc phòng Tổ chức cán bộ xác nhận xóa tài khoản');
};
// Báo Lãnh đạo đơn vị và TCCB có đề nghị cần xác nhận (trừ chính người bị đề nghị)
const baoCanXacNhan = async (c, userId, noiDung) => {
    const ids = (await c.query(`SELECT id FROM users WHERE role = 'QUAN_LI' AND is_active AND deleted_at IS NULL UNION ${IDS_TCCB}`)).rows
        .map((x) => x.id).filter((id) => id !== userId);
    await thongBao(c, ids, noiDung);
};

app.post('/api/account/deletion-request', verifyToken, checkRole(['CAN_BO', 'HR_MANAGER', 'QUAN_LI']), async (req, res) => {
    const { rows } = await db.query(
        `INSERT INTO deletion_requests (user_id, reason) VALUES ($1, $2)
         ON CONFLICT (user_id) WHERE ${CHO} DO NOTHING RETURNING id, status, created_at`,
        [req.user.id, val(req.body?.reason)]);
    if (!rows[0]) throw fail(409, 'Bạn đã có một yêu cầu xóa tài khoản đang chờ xử lý');
    await audit(req, 'request_deletion', `deletion:${rows[0].id}`);
    res.status(201).json(rows[0]);
});

app.get('/api/account/deletion-request', verifyToken, async (req, res) => {
    const { rows } = await db.query(
        'SELECT id, reason, status, created_at, handled_at FROM deletion_requests WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [req.user.id]);
    res.json(rows[0] ?? null);
});

// Quản trị viên chỉ thấy người ĐANG có yêu cầu xóa (mã, tên, lý do), không thấy danh sách tài khoản.
// Yêu cầu đã chuyển sang chờ xác nhận chỉ để theo dõi, quản trị viên không xử lý tiếp được
app.get('/api/admin/deletion-requests', verifyToken, checkRole(['ADMIN']), async (req, res) => {
    const { rows } = await db.query(
        `SELECT r.id, r.reason, r.status, r.tu_yeu_cau, r.created_at, u.employee_code, u.full_name
         FROM deletion_requests r JOIN users u ON u.id = r.user_id
         WHERE r.${CHO} ORDER BY r.id`);
    res.json(rows);
});

// Bước 1 với yêu cầu của cán bộ: đồng ý thì CHUYỂN sang chờ xác nhận (chưa xóa), từ chối thì kết thúc
app.put('/api/admin/deletion-requests/:id', verifyToken, checkRole(['ADMIN']), async (req, res) => {
    const { approve } = req.body ?? {};
    if (typeof approve !== 'boolean') throw fail(400, 'approve phải là true hoặc false');
    const r = await db.tx(async (c) => {
        const { rows } = await c.query(
            `UPDATE deletion_requests r SET status = $1, requested_by = $2,
                    handled_by = $4, handled_at = CASE WHEN $4::int IS NULL THEN NULL ELSE now() END
             FROM users u WHERE r.id = $3 AND r.status = 'cho_xu_ly' AND u.id = r.user_id
             RETURNING r.user_id, r.reason, u.employee_code, u.full_name`,
            [approve ? 'cho_xac_nhan' : 'tu_choi', req.user.id, req.params.id, approve ? null : req.user.id]);
        const x = rows[0];
        if (!x) throw fail(409, 'Yêu cầu không tồn tại hoặc đã được xử lý');
        if (approve) await baoCanXacNhan(c, x.user_id,
            `Cán bộ ${x.employee_code} (${x.full_name}) yêu cầu xóa tài khoản${x.reason ? `, lý do: ${x.reason}` : ''}. Quản trị viên đã kiểm tra, cần bạn xác nhận.`);
        return x;
    });
    await audit(req, approve ? 'forward_deletion' : 'reject_deletion', `user:${r.user_id}`);
    res.json({ status: approve ? 'cho_xac_nhan' : 'tu_choi' });
});

// Quản trị viên chủ động đề nghị xóa: bắt buộc có lý do, sau đó cũng phải chờ xác nhận
app.post('/api/admin/users/:code/deletion', verifyToken, checkRole(['ADMIN']), async (req, res) => {
    const reason = val(req.body?.reason)?.trim();
    if (!reason || reason.length < 5) throw fail(400, 'Cần ghi lý do xóa (ít nhất 5 ký tự), ví dụ số quyết định nghỉ hưu');
    if (req.params.code === req.user.employee_code) throw fail(400, 'Không thể tự xóa tài khoản của mình');
    const r = await db.tx(async (c) => {
        const u = (await c.query('SELECT id, full_name FROM users WHERE employee_code = $1 AND deleted_at IS NULL', [req.params.code])).rows[0];
        if (!u) throw fail(404, 'Không tìm thấy tài khoản (hoặc tài khoản đã bị xóa)');
        const { rows } = await c.query(
            `INSERT INTO deletion_requests (user_id, reason, status, requested_by, tu_yeu_cau) VALUES ($1, $2, 'cho_xac_nhan', $3, false)
             ON CONFLICT (user_id) WHERE ${CHO} DO NOTHING RETURNING id, status, created_at`,
            [u.id, reason, req.user.id]);
        if (!rows[0]) throw fail(409, 'Tài khoản này đã có một yêu cầu xóa đang chờ xử lý');
        await baoCanXacNhan(c, u.id, `Quản trị viên đề nghị xóa tài khoản ${req.params.code} (${u.full_name}). Lý do: ${reason}. Cần bạn xác nhận.`);
        return { ...rows[0], user_id: u.id };
    });
    await audit(req, 'request_delete_user', `user:${r.user_id}`);
    res.status(201).json({ id: r.id, status: r.status, created_at: r.created_at });
});

// Bước 2. Người xác nhận không thấy đề nghị xóa chính mình
app.get('/api/deletion-confirmations', verifyToken, checkRole(['QUAN_LI', 'HR_MANAGER']), async (req, res) => {
    await chiNguoiXacNhan(req);
    const { rows } = await db.query(
        `SELECT r.id, r.reason, r.tu_yeu_cau, r.created_at, u.employee_code, u.full_name, d.name AS phong_ban, a.employee_code AS de_nghi_boi
         FROM deletion_requests r JOIN users u ON u.id = r.user_id JOIN users a ON a.id = r.requested_by
              LEFT JOIN departments d ON d.id = u.department_id
         WHERE r.status = 'cho_xac_nhan' AND r.user_id <> $1 ORDER BY r.id`, [req.user.id]);
    res.json(rows);
});

app.put('/api/deletion-confirmations/:id', verifyToken, checkRole(['QUAN_LI', 'HR_MANAGER']), async (req, res) => {
    await chiNguoiXacNhan(req);
    const { approve } = req.body ?? {};
    if (typeof approve !== 'boolean') throw fail(400, 'approve phải là true hoặc false');
    const r = await db.tx(async (c) => {
        const { rows } = await c.query(
            `UPDATE deletion_requests SET status = $1, handled_by = $2, handled_at = now()
             WHERE id = $3 AND status = 'cho_xac_nhan' AND user_id <> $2 RETURNING user_id, requested_by, tu_yeu_cau`,
            [approve ? 'da_xoa' : 'tu_choi', req.user.id, req.params.id]);
        if (!rows[0]) throw fail(409, 'Đề nghị không tồn tại, đã được xử lý, hoặc là đề nghị xóa chính bạn');
        if (approve) await c.query('UPDATE users SET is_active = false, deleted_at = now() WHERE id = $1', [rows[0].user_id]);
        const ketQua = `Yêu cầu xóa tài khoản #${req.params.id} ${approve ? 'đã được xác nhận, tài khoản đã bị xóa' : 'bị từ chối'} (${req.user.employee_code})`;
        // Cán bộ tự yêu cầu mà bị từ chối thì báo cho cán bộ; đã xóa thì họ không đăng nhập được nữa
        await thongBao(c, [rows[0].requested_by, ...(rows[0].tu_yeu_cau && !approve ? [rows[0].user_id] : [])], ketQua);
        return rows[0];
    });
    await audit(req, approve ? 'confirm_delete_user' : 'reject_deletion', `user:${r.user_id}`);
    res.json({ status: approve ? 'da_xoa' : 'tu_choi' });
});

// ========== 6. HỒ SƠ: nội dung ở PostgreSQL (cột nhạy cảm được mã hóa), vân tay + trạng thái trên blockchain ==========
const PROFILE_SELECT = `
    SELECT u.id AS user_id, u.employee_code, u.full_name, u.email, u.role, u.is_active, d.name AS phong_ban,
           p.date_of_birth, p.gender, p.phone_number, p.address, p.department, p.position,
           p.citizen_id, p.ethnicity, p.hometown, p.education_level, p.start_date, p.status, p.updated_at,
           p.ten_goi_khac, p.noi_dang_ky_khai_sinh, p.quoc_tich, p.co_quan_lap, p.created_at AS ngay_tao,
           p.reviewed_at, p.review_tx_id, rv.employee_code AS reviewed_by_code, rv.full_name AS reviewed_by_name
    FROM users u LEFT JOIN profiles p ON p.user_id = u.id LEFT JOIN departments d ON d.id = u.department_id
         LEFT JOIN users rv ON rv.id = p.reviewed_by`;
const PROFILE_VIEWERS = ['CAN_BO', 'HR_MANAGER', 'QUAN_LI']; // ADMIN không xem hồ sơ (quyền tối thiểu)
const ENCRYPTED = ['citizen_id', 'phone_number', 'address'];
// Giải mã các cột nhạy cảm sau khi đọc; vân tay luôn băm trên BẢN RÕ nên mã hóa không làm đổi hash cũ
const plain = (r) => r && { ...r, ...Object.fromEntries(ENCRYPTED.map((k) => [k, secure.decCol(r[k])])) };
// Lãnh đạo đơn vị chỉ thấy 4 số cuối CCCD; chủ hồ sơ và trưởng phòng thấy đủ
const maskCitizenId = (r) => ({ ...r, citizen_id: r.citizen_id && '********' + r.citizen_id.slice(-4) });

// Phạm vi truy cập: nhân viên chỉ hồ sơ của mình; trưởng phòng chỉ nhân viên CÙNG PHÒNG
// (và hồ sơ các trưởng phòng khác, để duyệt chéo vì chaincode chỉ cho HR_MANAGER duyệt);
// trưởng phòng Tổ chức cán bộ và lãnh đạo xem tất cả
// ponytail: chaincode chưa biết phòng ban nên phạm vi phòng chỉ do backend kiểm tra
const checkScope = async (req, userId) => {
    const me = req.user;
    if (me.role === 'CAN_BO' && Number(userId) !== me.id) throw fail(403, 'Chỉ được xem hồ sơ của chính mình');
    if (me.role !== 'HR_MANAGER' || Number(userId) === me.id || (await laTCCB(me))) return;
    const { rows } = await db.query('SELECT role, department_id FROM users WHERE id = $1', [userId]);
    if (rows[0] && rows[0].department_id !== me.department_id && rows[0].role !== 'HR_MANAGER')
        throw fail(403, 'Chỉ quản lý hồ sơ nhân viên trong phòng của mình');
};

// ========== 15 NHÓM DỮ LIỆU HỒ SƠ CÁN BỘ ==========
// Nhóm 1 (định danh) ở bảng profiles; nhóm 2-14 ở ho_so_nhom (mỗi dòng một bản ghi, JSON mã hóa);
// nhóm 15 (quản lý tài liệu) ở profile_documents.
// [tên nhóm, ai ghi, các trường [khóa, nhãn, kiểu, bắt buộc]]. Kiểu: (trống) văn bản, date, so,
// chuc_vu (chọn từ danh mục chức vụ, không cho gõ), don_vi (chọn phòng ban), tai_lieu (chọn tài liệu nhóm 15 của hồ sơ),
// mảng = chọn trong danh sách. Ai ghi: ca_nhan = chủ hồ sơ; to_chuc = trưởng phòng (trong phòng) hoặc TCCB
const QUAN_HAM = ['Binh nhì', 'Binh nhất', 'Hạ sĩ', 'Trung sĩ', 'Thượng sĩ', 'Thiếu úy', 'Trung úy', 'Thượng úy', 'Đại úy',
    'Thiếu tá', 'Trung tá', 'Thượng tá', 'Đại tá', 'Khác'];
const SO_NGAY_QD = [['so_quyet_dinh', 'Số quyết định'], ['ngay_quyet_dinh', 'Ngày quyết định', 'date']];
const NHOM = {
    2: ['Quan hệ gia đình và nhân thân', 'ca_nhan', [
        ['quan_he', 'Quan hệ', ['Bố', 'Mẹ', 'Vợ', 'Chồng', 'Con', 'Anh/chị/em ruột', 'Bố/mẹ vợ (chồng)', 'Khác'], true],
        ['ho_ten', 'Họ tên người thân', '', true], ['ngay_sinh', 'Ngày sinh', 'date'], ['so_dinh_danh', 'Số định danh/giấy tờ'],
        ['gioi_tinh', 'Giới tính', ['Nam', 'Nữ']], ['dan_toc', 'Dân tộc'], ['quoc_tich', 'Quốc tịch'], ['nghe_nghiep', 'Nghề nghiệp'],
        ['chuc_vu', 'Chức vụ/chức danh', 'chuc_vu'], ['co_quan', 'Cơ quan công tác'], ['noi_cu_tru', 'Nơi cư trú'],
        ['tinh_trang', 'Tình trạng', ['Còn sống', 'Đã mất']], ['trong_ngoai_nuoc', 'Quan hệ', ['Trong nước', 'Ngoài nước']],
        ['tu_ngay', 'Thời điểm bắt đầu', 'date'], ['den_ngay', 'Thời điểm kết thúc', 'date'], ['tai_lieu', 'Tài liệu chứng minh', 'tai_lieu']]],
    3: ['Lý lịch và lịch sử bản thân', 'ca_nhan', [
        ['thanh_phan', 'Thành phần xuất thân'], ['nghe_truoc_tuyen_dung', 'Nghề nghiệp trước tuyển dụng'],
        ['noi_cu_tru_cac_thoi_ky', 'Nơi cư trú các thời kỳ'], ['hoat_dong_xa_hoi', 'Hoạt động xã hội'],
        ['ngay_nhap_ngu', 'Ngày nhập ngũ', 'date'], ['ngay_xuat_ngu', 'Ngày xuất ngũ', 'date'],
        ['quan_ham', 'Quân hàm/chức vụ cao nhất', QUAN_HAM],
        ['nuoc_ngoai_thoi_gian', 'Quan hệ nước ngoài: thời gian'], ['nuoc_ngoai_muc_dich', 'Quan hệ nước ngoài: mục đích'],
        ['phap_ly', 'Tình trạng pháp lý/án tích', ['Không có án tích', 'Đã được xóa án tích', 'Đang bị điều tra, truy tố, xét xử'], true],
        ['hon_nhan', 'Tình trạng hôn nhân', ['Độc thân', 'Đã kết hôn', 'Ly hôn', 'Góa']],
        ['suc_khoe', 'Sức khỏe cơ bản', ['Tốt', 'Khá', 'Trung bình', 'Yếu']], ['phieu_ly_lich_tu_phap', 'Phiếu lý lịch tư pháp', 'tai_lieu']]],
    4: ['Tuyển dụng, bầu cử, tiếp nhận', 'to_chuc', [
        ['loai', 'Loại sự kiện', ['Tuyển dụng', 'Bầu cử', 'Tiếp nhận'], true], ['ngay_quyet_dinh', 'Ngày quyết định', 'date', true],
        ['so_quyet_dinh', 'Số quyết định', '', true], ['co_quan_ban_hanh', 'Cơ quan ban hành'], ['vi_tri', 'Vị trí tuyển dụng'],
        ['hinh_thuc', 'Hình thức', ['Thi tuyển', 'Xét tuyển', 'Tiếp nhận không qua thi', 'Bầu cử']],
        ['ngay_bat_dau', 'Ngày bắt đầu làm việc', 'date', true], ['don_vi', 'Đơn vị tiếp nhận', 'don_vi'],
        ['tap_su', 'Thời gian/kết quả tập sự'], ['tai_lieu', 'Tài liệu đính kèm', 'tai_lieu'], ['nguoi_phe_duyet', 'Người phê duyệt'],
        ['hieu_luc', 'Trạng thái hiệu lực', ['Có hiệu lực', 'Hết hiệu lực']]]],
    5: ['Quá trình công tác', 'to_chuc', [
        ['tu_ngay', 'Từ ngày', 'date', true], ['den_ngay', 'Đến ngày', 'date'], ['co_quan', 'Cơ quan'],
        ['don_vi', 'Đơn vị', 'don_vi', true], ['don_vi_truc_thuoc', 'Đơn vị trực thuộc'], ['vi_tri', 'Vị trí việc làm'],
        ['ngach', 'Chức danh nghề nghiệp/ngạch'], ['chuc_vu', 'Chức vụ lãnh đạo quản lý', 'chuc_vu', true],
        ['nhiem_vu', 'Nhiệm vụ chính'],
        ['hinh_thuc', 'Hình thức thay đổi', ['Tuyển dụng', 'Bổ nhiệm', 'Miễn nhiệm', 'Giáng chức', 'Điều động', 'Luân chuyển', 'Biệt phái', 'Khác']],
        ...SO_NGAY_QD, ['co_quan_ban_hanh', 'Cơ quan ban hành'], ['ly_do', 'Lý do thay đổi'],
        ['trang_thai', 'Trạng thái', ['Đang giữ', 'Đã kết thúc']], ['tai_lieu', 'Tài liệu chứng minh', 'tai_lieu']]],
    6: ['Quy hoạch, bổ nhiệm, quản lý chức vụ', 'to_chuc', [
        ['chuc_danh_quy_hoach', 'Chức danh quy hoạch', 'chuc_vu'], ['thoi_ky_quy_hoach', 'Thời kỳ quy hoạch'],
        ['cap_phe_duyet', 'Cấp phê duyệt', ['Thủ trưởng đơn vị', 'Cấp trên trực tiếp']], ['quyet_dinh_quy_hoach', 'Quyết định quy hoạch'],
        ['chuc_vu_hien_giu', 'Chức vụ hiện giữ', 'chuc_vu'], ['chuc_vu_du_kien', 'Chức vụ dự kiến bổ nhiệm', 'chuc_vu'],
        ['ngay_bo_nhiem', 'Ngày bổ nhiệm', 'date'], ['ngay_bo_nhiem_lai', 'Ngày bổ nhiệm lại', 'date'], ['ngay_het_han', 'Ngày hết hạn', 'date'],
        ['tinh_trang', 'Tình trạng', ['Đang giữ chức vụ', 'Miễn nhiệm', 'Cách chức', 'Từ chức', 'Hết thời hạn']],
        ['ho_so_quy_trinh', 'Hồ sơ quy trình'], ['ket_luan_chinh_tri', 'Kết luận chính trị'], ['y_kien_danh_gia', 'Ý kiến đánh giá'],
        ['ket_qua_kiem_phieu', 'Kết quả kiểm phiếu']]],
    7: ['Đào tạo, bồi dưỡng', 'ca_nhan', [
        ['co_so', 'Cơ sở đào tạo', '', true], ['quoc_gia', 'Quốc gia/địa điểm'], ['chuyen_nganh', 'Chuyên ngành'],
        ['trinh_do', 'Trình độ', ['Sơ cấp', 'Trung cấp', 'Cao đẳng', 'Đại học', 'Thạc sĩ', 'Tiến sĩ', 'Chứng chỉ'], true],
        ['hinh_thuc', 'Hình thức', ['Chính quy', 'Vừa làm vừa học', 'Từ xa', 'Bồi dưỡng ngắn hạn']],
        ['tu_ngay', 'Từ ngày', 'date'], ['den_ngay', 'Đến ngày', 'date'], ['so_van_bang', 'Số văn bằng/chứng chỉ'],
        ['ngay_cap', 'Ngày cấp', 'date'], ['co_quan_cap', 'Cơ quan cấp'], ['ket_qua', 'Kết quả học tập'],
        ['cong_nhan', 'Công nhận văn bằng nước ngoài', ['Không áp dụng', 'Đã công nhận', 'Chưa công nhận']],
        ['loai_khoa', 'Loại khóa bồi dưỡng', ['Không', 'Lý luận chính trị', 'Quản lý nhà nước', 'Chuyên môn nghiệp vụ', 'Ngoại ngữ', 'Tin học']],
        ['tai_lieu', 'Văn bằng đính kèm', 'tai_lieu']]],
    8: ['Ngạch, chức danh nghề nghiệp, tiền lương', 'to_chuc', [
        ['ngach', 'Ngạch/chức danh', '', true], ['ma_ngach', 'Mã ngạch', '', true], ['bac', 'Bậc lương', 'so', true],
        ['he_so', 'Hệ số', 'so', true], ['muc_luong', 'Mức lương (đồng)', 'so'], ['phu_cap', 'Phụ cấp'],
        ['ngay_huong', 'Ngày hưởng', 'date', true], ['ngay_nang_bac_gan_nhat', 'Ngày nâng bậc gần nhất', 'date'],
        ['ngay_nang_bac_tiep_theo', 'Ngày nâng bậc tiếp theo', 'date'], ['quyet_dinh', 'Quyết định xếp/nâng lương'],
        ['keo_dai', 'Thời gian/lý do kéo dài nâng lương']]],
    9: ['Đánh giá, xếp loại', 'to_chuc', [
        ['ky', 'Năm/kỳ đánh giá', '', true], ['ket_qua_nhiem_vu', 'Kết quả nhiệm vụ'], ['san_pham', 'Sản phẩm đầu ra'],
        ['xep_loai', 'Mức xếp loại', ['Hoàn thành xuất sắc nhiệm vụ', 'Hoàn thành tốt nhiệm vụ', 'Hoàn thành nhiệm vụ', 'Không hoàn thành nhiệm vụ'], true],
        ['nhan_xet', 'Nhận xét (quản lý, tập thể)'], ['tu_danh_gia', 'Tự đánh giá'], ['han_che', 'Hạn chế'],
        ['khac_phuc', 'Kế hoạch khắc phục'], ['nguoi_phe_duyet', 'Người đánh giá/phê duyệt'], ['ngay_phe_duyet', 'Ngày phê duyệt', 'date'],
        ['tai_lieu', 'Tài liệu', 'tai_lieu']]],
    10: ['Khen thưởng, danh hiệu', 'to_chuc', [
        ['loai', 'Loại khen thưởng', ['Giấy khen', 'Bằng khen', 'Huân chương', 'Huy chương', 'Danh hiệu thi đua', 'Khác'], true],
        ['danh_hieu', 'Tên danh hiệu'], ['cap', 'Cấp khen thưởng', ['Cơ sở', 'Bộ, ngành, tỉnh', 'Nhà nước']], ['noi_dung', 'Nội dung'],
        ...SO_NGAY_QD, ['co_quan', 'Cơ quan quyết định'],
        ['hinh_thuc', 'Hình thức', ['Hiện vật', 'Tiền thưởng', 'Hiện vật và tiền thưởng', 'Không']], ['tai_lieu', 'Tài liệu', 'tai_lieu']]],
    11: ['Kỷ luật, xử lý vi phạm', 'to_chuc', [
        ['loai_vi_pham', 'Loại vi phạm'],
        ['hinh_thuc', 'Hình thức kỷ luật', ['Khiển trách', 'Cảnh cáo', 'Hạ bậc lương', 'Giáng chức', 'Cách chức', 'Buộc thôi việc'], true],
        ['co_quan', 'Cơ quan quyết định'], ...SO_NGAY_QD, ['tu_ngay', 'Thời hạn từ ngày', 'date'], ['den_ngay', 'Thời hạn đến ngày', 'date'],
        ['noi_dung', 'Nội dung'], ['khieu_nai', 'Kết quả giải quyết khiếu nại'], ['sua_huy', 'Kết quả sửa/hủy'],
        ['ket_luan_thanh_tra', 'Kết luận thanh tra'], ['trang_thai', 'Trạng thái pháp lý', ['Đang thi hành', 'Hết hiệu lực', 'Đã hủy']]]],
    // Bảo mật nghiêm ngặt: chỉ chủ hồ sơ và Lãnh đạo đơn vị xem; trưởng phòng/TCCB không thấy, kể cả trong lịch sử
    12: ['Tài sản, thu nhập', 'ca_nhan', [
        ['loai', 'Loại bản kê khai', ['Lần đầu', 'Hằng năm', 'Phục vụ bổ nhiệm', 'Bổ sung'], true], ['nam', 'Năm kê khai', 'so', true],
        ['nguoi_ke_khai', 'Người kê khai'], ['nha_dat', 'Nhà, đất'], ['phuong_tien', 'Phương tiện'], ['tai_khoan', 'Tài khoản'],
        ['tai_san_lon', 'Tài sản lớn khác'], ['thu_nhap_ban_than', 'Thu nhập bản thân'], ['thu_nhap_vo_chong', 'Thu nhập vợ/chồng'],
        ['thu_nhap_phu_thuoc', 'Thu nhập người phụ thuộc'], ['bien_dong', 'Biến động tài sản'], ['giai_trinh', 'Giải trình'],
        ['ngay_nop', 'Ngày nộp', 'date'], ['nguoi_tiep_nhan', 'Người tiếp nhận'], ['ket_qua_xac_minh', 'Kết quả xác minh']]],
    13: ['Sức khỏe', 'ca_nhan', [
        ['tinh_trang', 'Tình trạng', ['Tốt', 'Khá', 'Trung bình', 'Yếu']], ['chieu_cao', 'Chiều cao (cm)', 'so'], ['can_nang', 'Cân nặng (kg)', 'so'],
        ['loai_giay', 'Loại giấy khám', ['Khám tuyển dụng', 'Khám định kỳ', 'Khám bổ nhiệm', 'Khác']], ['ngay_kham', 'Ngày khám', 'date', true],
        ['co_so_kham', 'Cơ sở khám'], ['ket_luan', 'Kết luận', ['Đủ sức khỏe công tác', 'Không đủ sức khỏe công tác'], true],
        ['thoi_han', 'Thời hạn', 'date'], ['tai_lieu', 'Tài liệu y tế', 'tai_lieu']]],
    14: ['Nghỉ hưu, thôi việc, chấm dứt công tác', 'to_chuc', [
        ['loai', 'Loại chấm dứt', ['Nghỉ hưu', 'Thôi việc', 'Buộc thôi việc', 'Chuyển công tác', 'Từ trần'], true], ...SO_NGAY_QD,
        ['ngay_hieu_luc', 'Ngày hiệu lực', 'date', true], ['ly_do', 'Lý do'], ['che_do', 'Chế độ hưởng'], ['co_quan_ban_hanh', 'Cơ quan ban hành'],
        ['ho_so_ban_giao', 'Hồ sơ bàn giao'], ['luu_tru', 'Tình trạng lưu trữ', ['Đang lưu trữ', 'Đã chuyển lưu trữ lịch sử']]]],
};
const NHOM_MAT = 12;
const NHOM_BAT_BUOC = [3, 4, 7, 8, 13]; // thiếu thì cảnh báo khi ra quyết định

// Nhóm 15. Quản lý tài liệu: tệp mã hóa off-chain trong uploads/, SHA-256 bản gốc nằm trong vân tay hồ sơ trên chain.
// Mã = id, mã hash = sha256, chữ ký số = chu_ky_so, người/thời gian tải lên = uploaded_by/created_at,
// trạng thái xác thực = băm lại tệp trên đĩa khi xem; các thông tin còn lại do người tải lên khai (JSON mã hóa)
const DOC_TYPES = ['Ảnh chân dung', 'Giấy khai sinh', 'Bản chụp CCCD', 'Sơ yếu lý lịch', 'Phiếu lý lịch tư pháp', 'Bằng cấp, chứng chỉ',
    'Quyết định tuyển dụng, bổ nhiệm', 'Quyết định lương', 'Quyết định khen thưởng, kỷ luật', 'Bản kê khai tài sản', 'Giấy khám sức khỏe', 'Khác'];
const DOC_MAT = 'Bản kê khai tài sản'; // xem như nhóm 12
const DOC_FIELDS = [['ten', 'Tên tài liệu'], ['so_ky_hieu', 'Số, ký hiệu'], ['ngay_ban_hanh', 'Ngày ban hành/hiệu lực', 'date'],
    ['co_quan_ky', 'Cơ quan/người ký'], ['ngay_tiep_nhan', 'Ngày tiếp nhận', 'date'],
    ['loai_ban', 'Bản', ['Điện tử gốc', 'Giấy gốc', 'Bản sao', 'Bản số hóa']], ['muc_do_mat', 'Mức độ mật', ['Thường', 'Mật', 'Tối mật']],
    ['thoi_han_luu_tru', 'Thời hạn lưu trữ', ['Vĩnh viễn', '70 năm', '20 năm', '10 năm']], ['su_kien', 'Quan hệ với sự kiện nhân sự'],
    ['ngay_chup', 'Ngày chụp (ảnh chân dung)', 'date']];
const EXT_FIELDS = ['ten_goi_khac', 'noi_dang_ky_khai_sinh', 'quoc_tich', 'co_quan_lap'];
const docNhom = (s) => { try { return JSON.parse(secure.decCol(s)); } catch { return null; } };

// Hồ sơ kèm giấy tờ và bản ghi nhóm 2-15 để băm. fromDisk: giải mã và băm lại tệp ĐANG NẰM TRÊN Ổ ĐĨA (khi xác thực)
// ponytail: xác thực đọc lại mọi tệp (tối đa 5MB/tệp); hồ sơ hàng trăm giấy tờ thì cần cache theo mtime
const loadProfile = async (q, userId, fromDisk = false) => {
    const { rows } = await q.query(`${PROFILE_SELECT} WHERE u.id = $1`, [userId]);
    if (!rows[0]) return null;
    const docs = (await q.query('SELECT doc_type, file_path, sha256 FROM profile_documents WHERE user_id = $1 ORDER BY id', [userId])).rows;
    const documents = docs.map((d) => [d.doc_type, fromDisk ? sha256(readUpload(d.file_path)) : d.sha256]);
    const nhom = (await q.query('SELECT nhom, du_lieu FROM ho_so_nhom WHERE user_id = $1 AND huy_luc IS NULL ORDER BY id', [userId]))
        .rows.map((r) => [r.nhom, docNhom(r.du_lieu)]);
    const ext = Object.fromEntries(EXT_FIELDS.filter((f) => rows[0][f] != null).map((f) => [f, rows[0][f]]));
    return { ...plain(rows[0]), documents, nhom, ext, filesMatchDb: documents.every(([, s], i) => s === docs[i].sha256) };
};

// Bộ phận Tổ chức cán bộ = trưởng phòng của phòng có cờ la_tccb
const laTCCB = async (u) => u.role === 'HR_MANAGER' &&
    (await db.query('SELECT la_tccb FROM departments WHERE id = $1', [u.department_id])).rows[0]?.la_tccb === true;
const chucVu = async (q, ten) => ten ? (await q.query('SELECT * FROM chuc_vu WHERE ten = $1', [ten])).rows[0] : undefined;

// ========== LỊCH SỬ VÀ PHIÊN BẢN: không sửa đè, mỗi thay đổi ghi thêm dòng vào employee_data_history ==========
const HISTORY_FIELDS = {
    date_of_birth: 'ca_nhan', gender: 'ca_nhan', citizen_id: 'ca_nhan', ethnicity: 'ca_nhan', hometown: 'ca_nhan',
    ten_goi_khac: 'ca_nhan', noi_dang_ky_khai_sinh: 'ca_nhan', quoc_tich: 'ca_nhan', co_quan_lap: 'ca_nhan',
    phone_number: 'lien_he', address: 'lien_he',
    department: 'cong_tac', position: 'cong_tac', start_date: 'cong_tac', education_level: 'trinh_do',
};
// Ngày từ pg là Date theo giờ máy -> YYYY-MM-DD; còn lại so sánh dạng chuỗi
const norm = (v) => (v == null ? null : v instanceof Date ? v.toLocaleDateString('sv') : String(v));
// Nội dung được "niêm phong" bằng HMAC (khóa trong DATA_KEY): sửa trực tiếp trong CSDL mà không có khóa thì lộ ngay
const historyVals = (h) => [h.employee_id, h.version_no, h.field_group, h.field_name, h.old_value, h.new_value,
    h.change_type, h.reason, h.legal_document_id, h.updated_by];
const sealHistory = (h) => secure.hmac(JSON.stringify(historyVals(h)));

// So hồ sơ trước/sau, trả các trường đã đổi; trường nhạy cảm lưu bản mã
const diffProfile = (before, after) => Object.entries(HISTORY_FIELDS).flatMap(([field, group]) => {
    const o = norm(before?.[field]), n = norm(after[field]);
    if (o === n) return [];
    const enc = ENCRYPTED.includes(field) ? secure.encCol : (x) => x;
    const type = !before?.status ? 'tao_moi' : o == null ? 'bo_sung' : n == null ? 'huy_hieu_luc' : 'sua_doi';
    return [{ field_group: group, field_name: field, old_value: enc(o), new_value: enc(n), change_type: type }];
});

// Ghi một phiên bản mới (nhiều dòng, cùng version_no), trạng thái cho_duyet
const addHistory = async (c, req, userId, changes, reason = null, legalDocId = null) => {
    if (!changes.length) return null;
    const { rows } = await c.query('SELECT coalesce(max(version_no), 0) + 1 AS v FROM employee_data_history WHERE employee_id = $1', [userId]);
    for (const ch of changes) {
        const h = { employee_id: userId, version_no: rows[0].v, reason, legal_document_id: legalDocId, updated_by: req.user.id, ...ch };
        await c.query(
            `INSERT INTO employee_data_history (employee_id, version_no, field_group, field_name, old_value, new_value,
                 change_type, reason, legal_document_id, updated_by, audit_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [...historyVals(h), sealHistory(h)]);
    }
    return rows[0].v;
};

app.get('/api/profiles/me', verifyToken, async (req, res) => {
    const { rows } = await db.query(`${PROFILE_SELECT} WHERE u.id = $1`, [req.user.id]);
    res.json(plain(rows[0]));
});

// Tự khai báo/cập nhật hồ sơ -> về cho_duyet và ghi vân tay lên chain.
// Chain từ chối thì DB rollback, hai bên luôn khớp. Phòng ban lấy theo phân công của quản trị viên, không cho tự khai.
// ponytail: chaincode chỉ cho CAN_BO/HR_MANAGER ghi hồ sơ; QUAN_LI/ADMIN tự khai thì cần mở rộng chaincode
app.put('/api/profiles/me', verifyToken, checkRole(['CAN_BO', 'HR_MANAGER']), async (req, res) => {
    const b = req.body ?? {};
    if (val(b.citizen_id) && !/^\d{12}$/.test(b.citizen_id)) throw fail(400, 'Số CCCD phải gồm đúng 12 chữ số');
    // Căn cứ thay đổi: một giấy tờ đã tải lên hồ sơ của chính mình (vd. quyết định điều động)
    const legalDocId = val(b.legal_document_id) && Number(b.legal_document_id);
    if (legalDocId && !(await db.query('SELECT 1 FROM profile_documents WHERE id = $1 AND user_id = $2', [legalDocId, req.user.id])).rowCount)
        throw fail(400, 'Tài liệu căn cứ không thuộc hồ sơ của bạn');
    const ma = req.user.employee_code;
    const result = await db.tx(async (c) => {
        const before = await loadProfile(c, req.user.id);
        // CCCD là mã hồ sơ (khóa chính): bắt buộc khi khai lần đầu, không gửi thì giữ nguyên
        const cccd = val(b.citizen_id) ?? before?.citizen_id;
        if (!cccd) throw fail(400, 'Cần số CCCD: đây là mã hồ sơ điện tử');
        // Chức vụ chọn từ danh mục khi khai lần đầu; sau đó chỉ đổi theo quyết định bổ nhiệm/miễn nhiệm/điều động
        const position = val(b.position) ?? before?.position ?? null;
        if (before?.position && position !== before.position)
            throw fail(400, 'Chức vụ chỉ thay đổi theo quyết định (mục Bổ nhiệm - Điều động), không tự sửa');
        if (position && position !== before?.position && !(await chucVu(c, position))) throw fail(400, 'Chức vụ phải chọn trong danh mục');
        await c.query(
            `INSERT INTO profiles (user_id, date_of_birth, gender, phone_number, address, department, position,
                                   citizen_id, ethnicity, hometown, education_level, start_date, citizen_id_hmac,
                                   ten_goi_khac, noi_dang_ky_khai_sinh, quoc_tich, co_quan_lap)
             VALUES ($1, $2, $3, $4, $5, (SELECT name FROM departments WHERE id = $6), $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
             ON CONFLICT (user_id) DO UPDATE SET
                 date_of_birth = EXCLUDED.date_of_birth, gender = EXCLUDED.gender,
                 phone_number = EXCLUDED.phone_number, address = EXCLUDED.address,
                 department = EXCLUDED.department, position = EXCLUDED.position,
                 citizen_id = EXCLUDED.citizen_id, ethnicity = EXCLUDED.ethnicity,
                 hometown = EXCLUDED.hometown, education_level = EXCLUDED.education_level,
                 start_date = EXCLUDED.start_date, citizen_id_hmac = EXCLUDED.citizen_id_hmac,
                 ten_goi_khac = EXCLUDED.ten_goi_khac, noi_dang_ky_khai_sinh = EXCLUDED.noi_dang_ky_khai_sinh,
                 quoc_tich = EXCLUDED.quoc_tich, co_quan_lap = EXCLUDED.co_quan_lap,
                 status = 'cho_duyet', updated_at = now()`,
            [req.user.id, val(b.date_of_birth), val(b.gender), secure.encCol(val(b.phone_number)), secure.encCol(val(b.address)),
             req.user.department_id, position, secure.encCol(cccd), val(b.ethnicity), val(b.hometown),
             val(b.education_level), val(b.start_date), secure.hmac(cccd), ...EXT_FIELDS.map((f) => val(b[f]))]);
        // Băm đúng dữ liệu DB đã lưu (DB có thể chuẩn hóa, vd. ngày tháng)
        const p = await loadProfile(c, req.user.id);
        const version = await addHistory(c, req, req.user.id, diffProfile(before, p), val(b.change_reason), legalDocId || null);
        const { transactionId, blockNumber } = await chain.invoke(req.user.role, 'GhiHoSo', [ma, chain.hashProfile(p), ma]);
        return { profile: p, version, blockchain: { transactionId, blockNumber } };
    });
    await audit(req, 'update_profile', `user:${req.user.id}`);
    res.json(result);
});

// Tải giấy tờ lên hồ sơ của mình -> ghi vân tay hồ sơ mới lên chain, hồ sơ về cho_duyet để duyệt lại
app.post('/api/profiles/me/documents', verifyToken, checkRole(['CAN_BO', 'HR_MANAGER']), upload.single('file'), async (req, res) => {
    const { doc_type } = req.body ?? {};
    if (!req.file) throw fail(400, 'Chưa chọn tệp');
    if (!DOC_TYPES.includes(doc_type)) throw fail(400, 'Loại giấy tờ không hợp lệ');
    const thongTin = await kiemTraTruong(DOC_FIELDS, req.body, req.user.id, false);
    const saved = await saveUpload(req.file);
    try {
        const ma = req.user.employee_code;
        const result = await db.tx(async (c) => {
            const { rowCount } = await c.query(
                `UPDATE profiles SET status = 'cho_duyet', updated_at = now() WHERE user_id = $1`, [req.user.id]);
            if (!rowCount) throw fail(409, 'Hãy khai báo và lưu hồ sơ trước khi đính kèm giấy tờ');
            const { rows } = await c.query(
                `INSERT INTO profile_documents (user_id, doc_type, file_path, sha256, thong_tin, uploaded_by)
                 VALUES ($1, $2, $3, $4, $5, $1) RETURNING id, doc_type, sha256, created_at`,
                [req.user.id, doc_type, saved.name, saved.sha, secure.encCol(JSON.stringify(thongTin))]);
            await addHistory(c, req, req.user.id, [{ field_group: 'giay_to', field_name: doc_type, old_value: null,
                new_value: saved.sha, change_type: 'bo_sung' }], null, rows[0].id);
            const p = await loadProfile(c, req.user.id);
            const { transactionId, blockNumber } = await chain.invoke(req.user.role, 'GhiHoSo', [ma, chain.hashProfile(p), ma]);
            await c.query('UPDATE profile_documents SET chu_ky_so = $1 WHERE id = $2', [transactionId, rows[0].id]);
            return { document: rows[0], blockchain: { transactionId, blockNumber } };
        });
        await audit(req, 'upload_document', `document:${result.document.id}`);
        res.status(201).json(result);
    } catch (e) {
        removeUpload(saved.name); // thất bại thì không để lại tệp mồ côi
        throw e;
    }
});

// Bản kê khai tài sản chỉ chủ hồ sơ và Lãnh đạo đơn vị xem (như nhóm 12)
const xemMat = (req, userId) => Number(userId) === req.user.id || req.user.role === 'QUAN_LI';

// ponytail: mỗi lần xem danh sách băm lại mọi tệp (tối đa 5MB/tệp) để báo trạng thái xác thực; nhiều tệp thì cache theo mtime
app.get('/api/profiles/:userId/documents', verifyToken, checkRole(PROFILE_VIEWERS), async (req, res) => {
    await checkScope(req, req.params.userId);
    const { rows } = await db.query(
        `SELECT d.id, d.doc_type, d.file_path, d.sha256, d.chu_ky_so, d.created_at, d.thong_tin, u.employee_code AS uploaded_by_code
         FROM profile_documents d LEFT JOIN users u ON u.id = d.uploaded_by
         WHERE d.user_id = $1 AND ($2 OR d.doc_type <> $3) ORDER BY d.id`, [req.params.userId, xemMat(req, req.params.userId), DOC_MAT]);
    res.json(rows.map(({ file_path, thong_tin, ...d }) =>
        ({ ...d, thong_tin: docNhom(thong_tin) ?? {}, xac_thuc: sha256(readUpload(file_path)) === d.sha256 })));
});

app.get('/api/profiles/:userId/documents/:docId', verifyToken, checkRole(PROFILE_VIEWERS), guardBulk, async (req, res) => {
    await checkScope(req, req.params.userId);
    const { rows } = await db.query(
        'SELECT doc_type, file_path FROM profile_documents WHERE id = $1 AND user_id = $2', [req.params.docId, req.params.userId]);
    if (!rows[0] || (rows[0].doc_type === DOC_MAT && !xemMat(req, req.params.userId))) throw fail(404, 'Không tìm thấy giấy tờ');
    await audit(req, 'view_document', `document:${req.params.docId}`);
    sendUpload(res, rows[0].file_path, rows[0].doc_type + path.extname(rows[0].file_path));
});

// Danh sách hồ sơ: phân trang 50 dòng, mỗi trang tính 1 lần "xem hàng loạt" (guardBulk)
const PAGE = 50;
app.get('/api/profiles', verifyToken, checkRole(['HR_MANAGER', 'QUAN_LI']), guardBulk, async (req, res) => {
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    const hr = req.user.role === 'HR_MANAGER' && !(await laTCCB(req.user));
    const { rows } = await db.query(
        `${PROFILE_SELECT} WHERE u.deleted_at IS NULL
         ${hr ? `AND (u.department_id = $3 OR u.role = 'HR_MANAGER')` : ''}
         ORDER BY u.id LIMIT $1 OFFSET $2`,
        hr ? [PAGE, page * PAGE, req.user.department_id] : [PAGE, page * PAGE]);
    await audit(req, 'view_profiles', `page:${page}`);
    const list = rows.map(plain);
    res.json(req.user.role === 'HR_MANAGER' ? list : list.map(maskCitizenId));
});

app.put('/api/profiles/:userId/review', verifyToken, checkRole(['HR_MANAGER']), async (req, res) => {
    const { status } = req.body ?? {};
    if (!['da_duyet', 'tu_choi'].includes(status)) throw fail(400, 'Trạng thái phải là da_duyet hoặc tu_choi');
    if (Number(req.params.userId) === req.user.id) throw fail(403, 'Không được tự duyệt hồ sơ của chính mình');
    await checkScope(req, req.params.userId);
    const result = await db.tx(async (c) => {
        const { rows } = await c.query(
            `UPDATE profiles SET status = $1, updated_at = now() WHERE user_id = $2 AND status = 'cho_duyet'
             RETURNING (SELECT employee_code FROM users WHERE id = profiles.user_id) AS employee_code`,
            [status, req.params.userId]);
        if (!rows[0]) throw fail(409, 'Hồ sơ không tồn tại hoặc không ở trạng thái chờ duyệt');
        // Giao dịch DuyetHoSo được ký ECDSA bằng khóa của vai trò; mã giao dịch là "chữ ký số" tra được trên sổ cái
        const { transactionId, blockNumber } = await chain.invoke('HR_MANAGER', 'DuyetHoSo', [rows[0].employee_code, status, req.user.employee_code]);
        const uid = req.params.userId, approve = status === 'da_duyet';
        await c.query('UPDATE profiles SET reviewed_by = $1, reviewed_at = now(), review_tx_id = $2 WHERE user_id = $3',
            [req.user.id, transactionId, uid]);
        // Duyệt: phiên bản đang hiệu lực của các trường vừa đổi chuyển sang bi_thay_the (giữ lại, không xóa)
        if (approve) await c.query(
            `UPDATE employee_data_history SET status = 'bi_thay_the', valid_to = now()
             WHERE employee_id = $1 AND status = 'co_hieu_luc' AND field_name IN
                   (SELECT field_name FROM employee_data_history WHERE employee_id = $1 AND status = 'cho_duyet')`, [uid]);
        // Nhiều phiên bản cùng chờ duyệt một trường: chỉ bản mới nhất có hiệu lực, bản cũ hơn bị thay thế ngay
        if (approve) await c.query(
            `UPDATE employee_data_history h SET status = 'bi_thay_the', approved_by = $2, approved_at = now(),
                    digital_signature = $3, valid_from = now(), valid_to = now()
             WHERE employee_id = $1 AND status = 'cho_duyet' AND EXISTS (SELECT 1 FROM employee_data_history n
                   WHERE n.employee_id = h.employee_id AND n.field_name = h.field_name AND n.status = 'cho_duyet' AND n.version_no > h.version_no)`,
            [uid, req.user.id, transactionId]);
        await c.query(
            `UPDATE employee_data_history SET status = $2, approved_by = $3, approved_at = now(), digital_signature = $4,
                    valid_from = CASE WHEN $5 THEN now() END
             WHERE employee_id = $1 AND status = 'cho_duyet'`,
            [uid, approve ? 'co_hieu_luc' : 'tu_choi', req.user.id, transactionId, approve]);
        return { status, approvedBy: req.user.employee_code, blockchain: { transactionId, blockNumber } };
    });
    await audit(req, `profile_${status}`, `user:${req.params.userId}`);
    res.json(result);
});

// Xác thực: băm lại dữ liệu đang có trong DB rồi so với vân tay và trạng thái trên chain
app.get('/api/profiles/:userId/verify', verifyToken, checkRole(PROFILE_VIEWERS), async (req, res) => {
    await checkScope(req, req.params.userId);
    const p = await loadProfile(db, req.params.userId, true);
    if (!p?.status) throw fail(404, 'Cán bộ chưa khai báo hồ sơ');
    const dbHash = chain.hashProfile(p);
    const onChain = await chain.query(req.user.role, 'XemHoSo', [p.employee_code])
        .then(JSON.parse, (e) => { if (e.notFound) return null; throw e; });
    await audit(req, 'verify_profile', `user:${p.user_id}`);
    res.json({
        nguyenVen: onChain?.hash === dbHash,
        tepKhopDB: p.filesMatchDb,
        trangThaiKhop: onChain?.trangThai === p.status,
        dbHash, blockchain: onChain,
    });
});

// Lịch sử mọi phiên bản trên chain (không sửa, không xóa được)
app.get('/api/profiles/:userId/history', verifyToken, checkRole(PROFILE_VIEWERS), async (req, res) => {
    await checkScope(req, req.params.userId);
    const { rows } = await db.query('SELECT employee_code FROM users WHERE id = $1', [req.params.userId]);
    if (!rows[0]) throw fail(404, 'Không tìm thấy cán bộ');
    res.json(JSON.parse(await chain.query(req.user.role, 'LichSu', [rows[0].employee_code])));
});

// Lịch sử phiên bản trong CSDL: giá trị cũ/mới, người cập nhật, người duyệt, căn cứ, mã giao dịch ký duyệt.
// hashOk = false nghĩa là dòng lịch sử đã bị sửa trực tiếp trong CSDL
app.get('/api/profiles/:userId/data-history', verifyToken, checkRole(PROFILE_VIEWERS), async (req, res) => {
    await checkScope(req, req.params.userId);
    const { rows } = await db.query(
        `SELECT h.*, u.employee_code AS updated_by_code, a.employee_code AS approved_by_code, a.full_name AS approved_by_name,
                d.doc_type AS legal_document
         FROM employee_data_history h JOIN users u ON u.id = h.updated_by
              LEFT JOIN users a ON a.id = h.approved_by LEFT JOIN profile_documents d ON d.id = h.legal_document_id
         WHERE h.employee_id = $1 AND ($2 OR (h.field_name NOT LIKE '${NHOM[NHOM_MAT][0]}%' AND h.field_name <> '${DOC_MAT}'))
         ORDER BY h.version_no DESC, h.history_id`,
        [req.params.userId, Number(req.params.userId) === req.user.id || req.user.role === 'QUAN_LI']);
    const maskCccd = req.user.role === 'QUAN_LI';
    await audit(req, 'view_data_history', `user:${req.params.userId}`);
    res.json(rows.map(({ audit_hash, ...h }) => {
        const show = (v) => {
            const p = secure.decCol(v); // giá trị chưa mã hóa giữ nguyên
            return maskCccd && h.field_name === 'citizen_id' && p ? '********' + p.slice(-4) : p;
        };
        return { ...h, old_value: show(h.old_value), new_value: show(h.new_value), hashOk: audit_hash === sealHistory(h) };
    }));
});

// ========== 7. ĐỀ NGHỊ: nhân viên tạo -> trưởng phòng xác minh -> lãnh đạo quyết định (mỗi bước ghi lên blockchain) ==========
const PROPOSAL_ROLES = ['CAN_BO', 'HR_MANAGER', 'QUAN_LI'];
const PROPOSAL_SELECT = `
    SELECT p.*, u.full_name AS sender_name, u.employee_code
    FROM proposals p JOIN users u ON u.id = p.user_id`;

// Nạp một đề nghị; nhân viên chỉ truy cập đề nghị của mình, trưởng phòng chỉ đề nghị của phòng mình
const loadProposal = async (req) => {
    const { rows } = await db.query(`${PROPOSAL_SELECT} WHERE p.id = $1`, [req.params.id]);
    const p = rows[0];
    if (!p) throw fail(404, 'Không tìm thấy đề nghị');
    await checkScope(req, p.user_id);
    return p;
};

app.post('/api/proposals', verifyToken, checkRole(['CAN_BO']), upload.single('attachment'), async (req, res) => {
    const { type, title, reason } = req.body ?? {};
    if (!type || !title || !reason) throw fail(400, 'Cần đủ loại, tiêu đề và nội dung');
    const saved = req.file ? await saveUpload(req.file) : null;
    try {
        const ma = req.user.employee_code;
        const result = await db.tx(async (c) => {
            const { rows } = await c.query(
                `INSERT INTO proposals (user_id, type, title, reason, attachment_path, attachment_sha256)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [req.user.id, type, title, reason, saved?.name ?? null, saved?.sha ?? null]);
            const hash = chain.hashProposal({ ...rows[0], employee_code: ma });
            const { transactionId, blockNumber } = await chain.invoke('CAN_BO', 'TaoDeNghi', [String(rows[0].id), ma, hash, ma]);
            return { proposal: rows[0], blockchain: { transactionId, blockNumber } };
        });
        await audit(req, 'create_proposal', `proposal:${result.proposal.id}`);
        res.status(201).json(result);
    } catch (e) {
        removeUpload(saved?.name); // tạo thất bại thì không để lại tệp mồ côi
        throw e;
    }
});

// Nhân viên thấy đề nghị của mình; trưởng phòng thấy đề nghị của phòng; lãnh đạo thấy tất cả
app.get('/api/proposals', verifyToken, checkRole(PROPOSAL_ROLES), async (req, res) => {
    const { role, id, department_id } = req.user;
    const [where, params] = role === 'CAN_BO' ? ['WHERE p.user_id = $1', [id]]
        : role === 'HR_MANAGER' ? ['WHERE u.department_id = $1', [department_id]] : ['', []];
    const { rows } = await db.query(`${PROPOSAL_SELECT} ${where} ORDER BY p.created_at DESC`, params);
    res.json(rows);
});

app.get('/api/proposals/:id/attachment', verifyToken, checkRole(PROPOSAL_ROLES), guardBulk, async (req, res) => {
    const p = await loadProposal(req);
    if (!p.attachment_path) throw fail(404, 'Không có tệp đính kèm');
    await audit(req, 'view_attachment', `proposal:${p.id}`);
    sendUpload(res, p.attachment_path, `de-nghi-${p.id}${path.extname(p.attachment_path)}`);
});

// Chuyển trạng thái: đúng vai trò, đúng phạm vi, đúng trạng thái trước; DB và chain cùng thành công hoặc cùng hủy
const transition = (role, from, allowed, byColumn) => [verifyToken, checkRole([role]), async (req, res) => {
    const { status } = req.body ?? {};
    if (!allowed.includes(status)) throw fail(400, `Trạng thái phải là: ${allowed.join(', ')}`);
    await loadProposal(req); // kiểm tra phạm vi phòng ban
    const result = await db.tx(async (c) => {
        const { rows } = await c.query(
            `UPDATE proposals SET status = $1, ${byColumn} = $2, updated_at = now()
             WHERE id = $3 AND status = $4 RETURNING *`,
            [status, req.user.id, req.params.id, from]);
        if (!rows[0]) throw fail(409, `Đề nghị không tồn tại hoặc không ở trạng thái ${from}`);
        const { transactionId, blockNumber } = await chain.invoke(role, 'XuLyDeNghi', [String(rows[0].id), status, req.user.employee_code]);
        return { proposal: rows[0], blockchain: { transactionId, blockNumber } };
    });
    await audit(req, `proposal_${status}`, `proposal:${req.params.id}`);
    res.json(result);
}];
app.put('/api/proposals/:id/verify', ...transition('HR_MANAGER', 'cho_duyet', ['da_xac_minh', 'tu_choi'], 'verified_by'));
app.put('/api/proposals/:id/decide', ...transition('QUAN_LI', 'da_xac_minh', ['da_duyet', 'tu_choi'], 'decided_by'));

// Xác thực: băm lại nội dung trong DB + giải mã và băm lại tệp ĐANG NẰM TRÊN Ổ ĐĨA, so với chain
app.get('/api/proposals/:id/verify', verifyToken, checkRole(PROPOSAL_ROLES), async (req, res) => {
    const p = await loadProposal(req);
    const diskSha = p.attachment_path ? sha256(readUpload(p.attachment_path)) : null;
    const onChain = await chain.query(req.user.role, 'XemDeNghi', [String(p.id)])
        .then(JSON.parse, (e) => { if (e.notFound) return null; throw e; });
    await audit(req, 'verify_proposal', `proposal:${p.id}`);
    res.json({
        nguyenVen: onChain?.hash === chain.hashProposal({ ...p, attachment_sha256: diskSha }),
        tepKhopDB: diskSha === p.attachment_sha256,
        trangThaiKhop: onChain?.trangThai === p.status,
        blockchain: onChain,
    });
});

app.get('/api/proposals/:id/history', verifyToken, checkRole(PROPOSAL_ROLES), async (req, res) => {
    const p = await loadProposal(req);
    res.json(JSON.parse(await chain.query(req.user.role, 'LichSuDeNghi', [String(p.id)])));
});

// ========== 9. DANH MỤC VÀ NHÓM DỮ LIỆU 2-15 ==========
app.get('/api/master/chuc-vu', verifyToken, async (req, res) => {
    res.json((await db.query('SELECT ten, thu_tu, vai_tro, cap_phe_duyet FROM chuc_vu ORDER BY thu_tu')).rows);
});
app.get('/api/master/nhom', verifyToken, (req, res) => res.json(NHOM));

app.get('/api/master/tai-lieu', verifyToken, (req, res) => res.json({ loai: DOC_TYPES, truong: DOC_FIELDS }));

// Kiểm tra dữ liệu theo cấu hình trường: bắt buộc, kiểu; chức vụ phải có trong danh mục (không nhận chữ tự gõ).
// Bỏ trống trường không bắt buộc; cần ít nhất 1 trường có giá trị
const kiemTraTruong = async (truong, body, userId, canIt1 = true) => {
    const out = {};
    for (const [k, label, type, req] of truong) {
        const v = String(body?.[k] ?? '').trim();
        if (!v) { if (req) throw fail(400, `Thiếu: ${label}`); continue; }
        if (v.length > 1000) throw fail(400, `Quá dài: ${label}`);
        if (Array.isArray(type) && !type.includes(v)) throw fail(400, `${label}: phải chọn trong danh sách`);
        if (type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw fail(400, `${label}: ngày dạng YYYY-MM-DD`);
        if (type === 'so' && !/^\d+(\.\d+)?$/.test(v)) throw fail(400, `${label}: phải là số`);
        if (type === 'chuc_vu' && !(await chucVu(db, v))) throw fail(400, `${label}: phải chọn trong danh mục chức vụ`);
        if (type === 'don_vi' && !(await db.query('SELECT 1 FROM departments WHERE name = $1', [v])).rowCount)
            throw fail(400, `${label}: phải chọn trong danh sách phòng ban`);
        if (type === 'tai_lieu' && !(await db.query('SELECT 1 FROM profile_documents WHERE id = $1 AND user_id = $2', [Number(v) || 0, userId])).rowCount)
            throw fail(400, `${label}: phải chọn tài liệu thuộc hồ sơ này`);
        out[k] = v;
    }
    if (canIt1 && !Object.keys(out).length) throw fail(400, 'Cần nhập ít nhất một trường');
    return out;
};

const quyenGhiNhom = async (req, n, userId) => {
    const nhap = NHOM[n][1], self = Number(userId) === req.user.id;
    if (nhap === 'ca_nhan' && !self) throw fail(403, 'Nhóm này do chủ hồ sơ tự kê khai');
    if (nhap === 'to_chuc') {
        if (self || req.user.role !== 'HR_MANAGER') throw fail(403, 'Nhóm này do trưởng phòng hoặc bộ phận tổ chức cán bộ cập nhật');
        if (!(await laTCCB(req.user))) await checkScope(req, userId);
    }
};

// Hồ sơ đổi -> về cho_duyet, ghi vân tay mới lên chain. Chủ hồ sơ ghi bằng khóa vai trò của mình;
// người khác ghi bằng khóa HR_MANAGER (chaincode chỉ cho HR_MANAGER ghi hồ sơ của người khác)
const ghiVanTay = async (c, req, userId) => {
    await c.query(`UPDATE profiles SET status = 'cho_duyet', updated_at = now() WHERE user_id = $1`, [userId]);
    const p = await loadProfile(c, userId);
    const role = Number(userId) === req.user.id ? req.user.role : 'HR_MANAGER';
    return chain.invoke(role, 'GhiHoSo', [p.employee_code, chain.hashProfile(p), req.user.employee_code]);
};

app.get('/api/profiles/:userId/nhom', verifyToken, checkRole(PROFILE_VIEWERS), async (req, res) => {
    await checkScope(req, req.params.userId);
    const self = Number(req.params.userId) === req.user.id, xemMat = self || req.user.role === 'QUAN_LI';
    const { rows } = await db.query(
        `SELECT n.id, n.nhom, n.du_lieu, n.quy_trinh_id, n.created_at, n.huy_luc, n.ly_do_huy, u.employee_code AS created_by_code
         FROM ho_so_nhom n JOIN users u ON u.id = n.created_by
         WHERE n.user_id = $1 AND ($2 OR n.nhom <> $3) ORDER BY n.nhom, n.id`, [req.params.userId, xemMat, NHOM_MAT]);
    if (!self && rows.some((r) => r.nhom === NHOM_MAT)) await audit(req, 'view_tai_san', `user:${req.params.userId}`);
    res.json(rows.map((r) => ({ ...r, du_lieu: docNhom(r.du_lieu) })));
});

// Thêm một bản ghi: ghi lịch sử phiên bản, hồ sơ về chờ duyệt, vân tay mới lên chain
app.post('/api/profiles/:userId/nhom/:nhom', verifyToken, checkRole(['CAN_BO', 'HR_MANAGER']), async (req, res) => {
    const n = Number(req.params.nhom), uid = Number(req.params.userId);
    if (!NHOM[n]) throw fail(400, 'Nhóm dữ liệu không hợp lệ (2-14; nhóm 15 là tài liệu)');
    await quyenGhiNhom(req, n, uid);
    const duLieu = await kiemTraTruong(NHOM[n][2], req.body, uid);
    const enc = secure.encCol(JSON.stringify(duLieu));
    const result = await db.tx(async (c) => {
        if (!(await c.query('SELECT 1 FROM profiles WHERE user_id = $1', [uid])).rowCount) throw fail(409, 'Cán bộ chưa khai báo hồ sơ (nhóm 1)');
        const { rows } = await c.query(
            'INSERT INTO ho_so_nhom (user_id, nhom, du_lieu, created_by) VALUES ($1, $2, $3, $4) RETURNING id, nhom, created_at',
            [uid, n, enc, req.user.id]);
        const version = await addHistory(c, req, uid, [{ field_group: `nhom_${n}`, field_name: `${NHOM[n][0]} #${rows[0].id}`,
            old_value: null, new_value: enc, change_type: 'bo_sung' }], val(req.body?.ly_do));
        const { transactionId, blockNumber } = await ghiVanTay(c, req, uid);
        return { ban_ghi: rows[0], version, blockchain: { transactionId, blockNumber } };
    });
    await audit(req, 'them_ban_ghi_nhom', `user:${uid}:nhom:${n}`);
    res.status(201).json(result);
});

// Hủy hiệu lực (không xóa): bản ghi vẫn còn, có người hủy, lý do; muốn sửa thì hủy rồi thêm bản mới
app.put('/api/profiles/:userId/nhom/ban-ghi/:id/huy', verifyToken, checkRole(['CAN_BO', 'HR_MANAGER']), async (req, res) => {
    const uid = Number(req.params.userId), lyDo = String(req.body?.ly_do ?? '').trim();
    if (!lyDo) throw fail(400, 'Cần lý do hủy hiệu lực');
    const { rows: [r] } = await db.query('SELECT nhom FROM ho_so_nhom WHERE id = $1 AND user_id = $2 AND huy_luc IS NULL', [req.params.id, uid]);
    if (!r) throw fail(404, 'Không có bản ghi đang hiệu lực');
    await quyenGhiNhom(req, r.nhom, uid);
    const result = await db.tx(async (c) => {
        const { rows } = await c.query(
            `UPDATE ho_so_nhom SET huy_luc = now(), huy_boi = $3, ly_do_huy = $4
             WHERE id = $1 AND user_id = $2 AND huy_luc IS NULL RETURNING du_lieu`, [req.params.id, uid, req.user.id, lyDo]);
        if (!rows[0]) throw fail(409, 'Bản ghi vừa bị hủy');
        await addHistory(c, req, uid, [{ field_group: `nhom_${r.nhom}`, field_name: `${NHOM[r.nhom][0]} #${req.params.id}`,
            old_value: rows[0].du_lieu, new_value: null, change_type: 'huy_hieu_luc' }], lyDo);
        const { transactionId, blockNumber } = await ghiVanTay(c, req, uid);
        return { blockchain: { transactionId, blockNumber } };
    });
    await audit(req, 'huy_ban_ghi_nhom', `user:${uid}:ban_ghi:${req.params.id}`);
    res.json(result);
});

// ========== 10. QUY TRÌNH BỔ NHIỆM / MIỄN NHIỆM (GIÁNG CHỨC) / ĐIỀU ĐỘNG (LUÂN CHUYỂN) ==========
// 1 Xin chủ trương (tạo tờ trình) -> 2 Tập thể lãnh đạo xem xét -> 3 Lấy ý kiến giới thiệu (hội nghị, phiếu kín)
// -> 4 Bộ phận TCCB thẩm định, tập thể biểu quyết kín -> 5 Người có thẩm quyền ký quyết định.
// Nguyên tắc: trưởng phòng chỉ đề xuất; TCCB chỉ thẩm định, tổng hợp phiếu; KHÔNG ai trong hai nhóm này biểu quyết hay ký.
// Tập thể lãnh đạo = các Lãnh đạo đơn vị đang hoạt động; thông qua khi số phiếu đồng ý > 50% TỔNG SỐ thành viên.
// Nút ký chỉ mở sau khi tập thể đã thông qua, người ký không được là người được đề xuất.
const LOAI_QT = { bo_nhiem: 'Bổ nhiệm', mien_nhiem: 'Miễn nhiệm / giáng chức', dieu_dong: 'Điều động / luân chuyển' };
const BUOC_QT = { bo_nhiem: [2, 3, 4, 5], mien_nhiem: [2, 4, 5], dieu_dong: [2, 4, 5] }; // lấy ý kiến giới thiệu chỉ khi bổ nhiệm
const TEN_BUOC = { 2: 'Tập thể lãnh đạo xem xét', 3: 'Lấy ý kiến giới thiệu', 4: 'Thẩm định và biểu quyết', 5: 'Ra quyết định' };
const HAN_NGAY = Number(process.env.HAN_BUOC_NGAY ?? 7);
const IDS_TCCB = `SELECT u.id FROM users u JOIN departments d ON d.id = u.department_id
                  WHERE d.la_tccb AND u.role = 'HR_MANAGER' AND u.is_active AND u.deleted_at IS NULL`;

// Người được bỏ phiếu ở bước: 2 và 4 = tập thể lãnh đạo; 3 = hội nghị (cán bộ đơn vị nơi bổ nhiệm + tập thể lãnh đạo).
// Người được đề xuất không bỏ phiếu cho chính mình
const cuTri = async (q, qt, buoc) => (await q.query(buoc === 3
    ? `SELECT id FROM users WHERE is_active AND deleted_at IS NULL AND id <> $1 AND role <> 'ADMIN'
           AND (role = 'QUAN_LI' OR department_id = $2) ORDER BY id`
    : `SELECT id FROM users WHERE is_active AND deleted_at IS NULL AND id <> $1 AND role = 'QUAN_LI' ORDER BY id`,
    buoc === 3 ? [qt.user_id, qt.don_vi_moi ?? qt.don_vi_cu] : [qt.user_id])).rows.map((r) => r.id);
const kiemPhieu = async (q, id, buoc) => (await q.query(
    `SELECT count(*) FILTER (WHERE dong_y)::int AS dong_y, count(*) FILTER (WHERE NOT dong_y)::int AS khong_dong_y
     FROM phieu_bau WHERE quy_trinh_id = $1 AND buoc = $2`, [id, buoc])).rows[0];

const thongBao = async (q, userIds, noiDung, loai = 'thong_bao') => {
    for (const id of new Set(userIds)) await q.query('INSERT INTO thong_bao (user_id, loai, noi_dung) VALUES ($1, $2, $3)', [id, loai, noiDung]);
};
// Báo cho người cần làm ở bước mới
const baoBuoc = async (q, qt) => {
    const ai = qt.buoc === 4 ? (await q.query(IDS_TCCB)).rows.map((r) => r.id) : await cuTri(q, qt, qt.buoc === 5 ? 2 : qt.buoc);
    await thongBao(q, ai, `Quy trình #${qt.id} (${LOAI_QT[qt.loai]}) chuyển sang bước ${qt.buoc}: ${TEN_BUOC[qt.buoc]}`);
};

const loadQT = async (q, id, lock = false) => {
    const { rows } = await q.query(`SELECT * FROM quy_trinh WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    if (!rows[0]) throw fail(404, 'Không tìm thấy quy trình');
    return rows[0];
};

// Kết thúc bước hiện tại: lưu số phiếu, sang bước kế tiếp với hạn mới
const sangBuoc = async (c, qt, ketQua) => {
    const sau = BUOC_QT[qt.loai][BUOC_QT[qt.loai].indexOf(qt.buoc) + 1];
    const { rows } = await c.query(
        `UPDATE quy_trinh SET buoc = $2, han_xu_ly = now() + make_interval(days => $3), canh_bao_luc = NULL,
                ket_qua_buoc = ket_qua_buoc || jsonb_build_object($4::text, $5::jsonb)
         WHERE id = $1 RETURNING *`, [qt.id, sau, HAN_NGAY, String(qt.buoc), JSON.stringify(ketQua)]);
    await baoBuoc(c, rows[0]);
    return rows[0];
};

// Bước 1: Xin chủ trương. Cán bộ tra theo MÃ HỒ SƠ = số CCCD (so khớp HMAC, không giải mã)
app.post('/api/quy-trinh', verifyToken, checkRole(['HR_MANAGER', 'QUAN_LI']), async (req, res) => {
    const b = req.body ?? {};
    if (!LOAI_QT[b.loai]) throw fail(400, 'Loại phải là bo_nhiem, mien_nhiem hoặc dieu_dong');
    if (!/^\d{12}$/.test(String(b.cccd ?? ''))) throw fail(400, 'Nhập mã hồ sơ (số CCCD 12 chữ số) của cán bộ');
    const lyDo = String(b.ly_do ?? '').trim();
    if (!lyDo) throw fail(400, 'Cần nội dung tờ trình');
    const heSo = val(b.he_so_moi);
    if (heSo != null && !(Number(heSo) > 0 && Number(heSo) < 100)) throw fail(400, 'Hệ số lương không hợp lệ');
    const { rows: [nv] } = await db.query(
        `SELECT u.id, u.employee_code, u.department_id, p.position FROM profiles p JOIN users u ON u.id = p.user_id
         WHERE p.citizen_id_hmac = $1 AND u.deleted_at IS NULL`, [secure.hmac(b.cccd)]);
    if (!nv) throw fail(404, 'Không có hồ sơ với mã hồ sơ (CCCD) này');
    if (nv.id === req.user.id) throw fail(403, 'Không được tự đề xuất cho chính mình');
    if (req.user.role === 'HR_MANAGER' && nv.department_id !== req.user.department_id && !(await laTCCB(req.user)))
        throw fail(403, 'Trưởng phòng chỉ đề xuất cán bộ trong phòng mình');
    const cu = await chucVu(db, nv.position), moi = await chucVu(db, val(b.chuc_vu_moi));
    const dvMoi = val(b.don_vi_moi) && Number(b.don_vi_moi);
    if (val(b.chuc_vu_moi) && !moi) throw fail(400, 'Chức vụ mới phải chọn trong danh mục');
    if (b.loai === 'bo_nhiem' && !(moi && moi.thu_tu > (cu?.thu_tu ?? 0)))
        throw fail(400, 'Bổ nhiệm: chức vụ mới phải cao hơn chức vụ hiện tại');
    if (b.loai === 'mien_nhiem' && !(moi && cu && moi.thu_tu < cu.thu_tu))
        throw fail(400, 'Miễn nhiệm / giáng chức: chức vụ mới phải thấp hơn chức vụ hiện tại');
    if (b.loai === 'dieu_dong' && (!dvMoi || dvMoi === nv.department_id)) throw fail(400, 'Điều động: chọn đơn vị mới khác đơn vị hiện tại');
    if ((await db.query(`SELECT 1 FROM quy_trinh WHERE user_id = $1 AND trang_thai = 'dang_xu_ly'`, [nv.id])).rowCount)
        throw fail(409, 'Cán bộ này đang có một quy trình chưa kết thúc');
    const result = await db.tx(async (c) => {
        const { rows: [qt] } = await c.query(
            `INSERT INTO quy_trinh (loai, user_id, chuc_vu_cu, chuc_vu_moi, don_vi_cu, don_vi_moi, he_so_moi, ly_do, han_xu_ly, de_xuat_boi)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(days => $9), $10) RETURNING *`,
            [b.loai, nv.id, nv.position, moi?.ten ?? null, nv.department_id, dvMoi || null, heSo, lyDo, HAN_NGAY, req.user.id]);
        // Neo tờ trình lên chain bằng TaoDeNghi của chaincode 1.1 (hàm này yêu cầu khóa CAN_BO, người thực hiện = cán bộ được đề xuất)
        // ponytail: người đề xuất thật nằm trong CSDL và nhật ký; nâng chaincode (thêm TaoQuyTrinh) nếu cần ghi đúng trên chain
        const { transactionId } = await chain.invoke('CAN_BO', 'TaoDeNghi',
            [`QT-${qt.id}`, nv.employee_code, chain.hashQuyTrinh({ ...qt, employee_code: nv.employee_code }), nv.employee_code]);
        await c.query('UPDATE quy_trinh SET tx_tao = $1 WHERE id = $2', [transactionId, qt.id]);
        await baoBuoc(c, qt);
        return { ...qt, tx_tao: transactionId };
    });
    await audit(req, 'qt_xin_chu_truong', `quy_trinh:${result.id}`);
    res.status(201).json(result);
});

// Danh sách: lãnh đạo và TCCB thấy tất cả; trưởng phòng thấy quy trình của phòng mình; người đề xuất thấy của mình;
// hội nghị (bước 3) thấy để bỏ phiếu; người được đề xuất chỉ thấy khi đã có kết quả.
// Khi đang bỏ phiếu chỉ hiện SỐ NGƯỜI đã bỏ phiếu, không hiện số đồng ý/không đồng ý (tránh ảnh hưởng người bỏ sau)
app.get('/api/quy-trinh', verifyToken, checkRole(['CAN_BO', 'HR_MANAGER', 'QUAN_LI']), async (req, res) => {
    const me = req.user, tatCa = me.role === 'QUAN_LI' || (await laTCCB(me));
    const { rows } = await db.query(
        `SELECT q.*, u.employee_code, u.full_name, dx.employee_code AS de_xuat_code, ky.employee_code AS ky_code,
                td.employee_code AS tham_dinh_code, dc.name AS don_vi_cu_ten, dm.name AS don_vi_moi_ten,
                (q.trang_thai = 'dang_xu_ly' AND q.han_xu_ly < now()) AS qua_han
         FROM quy_trinh q JOIN users u ON u.id = q.user_id JOIN users dx ON dx.id = q.de_xuat_boi
              LEFT JOIN users ky ON ky.id = q.ky_boi LEFT JOIN users td ON td.id = q.tham_dinh_boi
              LEFT JOIN departments dc ON dc.id = q.don_vi_cu LEFT JOIN departments dm ON dm.id = q.don_vi_moi
         WHERE $1 OR q.de_xuat_boi = $2 OR (q.user_id = $2 AND q.trang_thai <> 'dang_xu_ly')
            OR ($3 = 'HR_MANAGER' AND $4 IN (q.don_vi_cu, q.don_vi_moi))
            OR (q.buoc = 3 AND q.trang_thai = 'dang_xu_ly' AND $4 = coalesce(q.don_vi_moi, q.don_vi_cu))
         ORDER BY q.id DESC LIMIT 100`, [tatCa, me.id, me.role, me.department_id]);
    // ponytail: mỗi quy trình đang bỏ phiếu thêm 3 truy vấn; hàng nghìn quy trình mở cùng lúc thì gộp thành 1 truy vấn
    for (const q of rows) {
        if (q.trang_thai !== 'dang_xu_ly' || ![2, 3, 4].includes(q.buoc)) continue;
        const ids = await cuTri(db, q, q.buoc), k = await kiemPhieu(db, q.id, q.buoc);
        q.phieu = { da_bo: k.dong_y + k.khong_dong_y, tong: ids.length, duoc_bo: ids.includes(me.id),
            toi_da_bo: (await db.query('SELECT 1 FROM da_bo_phieu WHERE quy_trinh_id = $1 AND buoc = $2 AND user_id = $3',
                [q.id, q.buoc, me.id])).rowCount > 0 };
    }
    res.json(rows);
});

// Bỏ phiếu kín ở bước 2, 3, 4. Phiếu không gắn người bỏ; bước 2 và 4 tự kết thúc khi đã đủ > 50% đồng ý
// hoặc chắc chắn không thể đạt
app.post('/api/quy-trinh/:id/phieu', verifyToken, checkRole(['CAN_BO', 'HR_MANAGER', 'QUAN_LI']), async (req, res) => {
    const dongY = req.body?.dong_y;
    if (typeof dongY !== 'boolean') throw fail(400, 'dong_y phải là true hoặc false');
    let buoc;
    const result = await db.tx(async (c) => {
        const qt = await loadQT(c, req.params.id, true); // khóa dòng: bỏ phiếu và kiểm phiếu lần lượt
        buoc = qt.buoc;
        if (qt.trang_thai !== 'dang_xu_ly' || ![2, 3, 4].includes(qt.buoc)) throw fail(409, 'Quy trình không ở bước bỏ phiếu');
        if (qt.buoc === 4 && qt.tham_dinh_dat == null) throw fail(409, 'Chờ bộ phận tổ chức cán bộ thẩm định trước khi biểu quyết');
        const ids = await cuTri(c, qt, qt.buoc);
        if (!ids.includes(req.user.id))
            throw fail(403, qt.buoc === 3 ? 'Bạn không thuộc hội nghị lấy ý kiến' : 'Chỉ thành viên tập thể lãnh đạo được biểu quyết');
        const { rowCount } = await c.query('INSERT INTO da_bo_phieu VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [qt.id, qt.buoc, req.user.id]);
        if (!rowCount) throw fail(409, 'Bạn đã bỏ phiếu ở bước này');
        await c.query('INSERT INTO phieu_bau (quy_trinh_id, buoc, dong_y) VALUES ($1, $2, $3)', [qt.id, qt.buoc, dongY]);
        const kq = { ...(await kiemPhieu(c, qt.id, qt.buoc)), tong: ids.length };
        if (qt.buoc === 3) return { buoc: 3, trang_thai: qt.trang_thai }; // hội nghị: TCCB tổng hợp và kết thúc
        if (kq.dong_y * 2 > kq.tong) {
            // Bước 4 thông qua = hồ sơ đã qua thẩm định và tập thể -> ghi da_xac_minh lên chain (khóa HR_MANAGER theo chaincode 1.1)
            if (qt.buoc === 4) await chain.invoke('HR_MANAGER', 'XuLyDeNghi', [`QT-${qt.id}`, 'da_xac_minh', 'TAP_THE']);
            const n = await sangBuoc(c, qt, kq);
            return { buoc: n.buoc, trang_thai: n.trang_thai, ket_qua: kq };
        }
        if (kq.khong_dong_y * 2 >= kq.tong) {
            await chain.invoke('HR_MANAGER', 'XuLyDeNghi', [`QT-${qt.id}`, 'tu_choi', 'TAP_THE']);
            await c.query(`UPDATE quy_trinh SET trang_thai = 'khong_thong_qua',
                ket_qua_buoc = ket_qua_buoc || jsonb_build_object($2::text, $3::jsonb) WHERE id = $1`, [qt.id, String(qt.buoc), JSON.stringify(kq)]);
            await thongBao(c, [qt.de_xuat_boi, qt.user_id], `Quy trình #${qt.id} không được tập thể thông qua ở bước ${qt.buoc}`);
            return { buoc: qt.buoc, trang_thai: 'khong_thong_qua', ket_qua: kq };
        }
        return { buoc: qt.buoc, trang_thai: qt.trang_thai };
    });
    // Nhật ký ghi AI đã bỏ phiếu ở bước nào, KHÔNG ghi bỏ phiếu gì
    await audit(req, 'qt_bo_phieu', `quy_trinh:${req.params.id}:buoc:${buoc}`);
    res.json(result);
});

// Bước 3 -> 4: bộ phận TCCB tổng hợp phiếu hội nghị (kết quả là ý kiến giới thiệu, để tập thể cân nhắc)
app.put('/api/quy-trinh/:id/ket-thuc-hoi-nghi', verifyToken, checkRole(['HR_MANAGER']), async (req, res) => {
    if (!(await laTCCB(req.user))) throw fail(403, 'Chỉ bộ phận tổ chức cán bộ tổng hợp phiếu');
    const result = await db.tx(async (c) => {
        const qt = await loadQT(c, req.params.id, true);
        if (qt.trang_thai !== 'dang_xu_ly' || qt.buoc !== 3) throw fail(409, 'Quy trình không ở bước lấy ý kiến giới thiệu');
        const kq = { ...(await kiemPhieu(c, qt.id, 3)), tong: (await cuTri(c, qt, 3)).length };
        const n = await sangBuoc(c, qt, kq);
        return { buoc: n.buoc, ket_qua: kq };
    });
    await audit(req, 'qt_tong_hop_phieu', `quy_trinh:${req.params.id}`);
    res.json(result);
});

// Bước 4: TCCB thẩm định (tham mưu, KHÔNG quyết định). Sau đó tập thể mới biểu quyết
app.put('/api/quy-trinh/:id/tham-dinh', verifyToken, checkRole(['HR_MANAGER']), async (req, res) => {
    const { dat, nhan_xet } = req.body ?? {};
    if (typeof dat !== 'boolean' || !String(nhan_xet ?? '').trim()) throw fail(400, 'Cần kết luận (dat: true/false) và nhận xét thẩm định');
    if (!(await laTCCB(req.user))) throw fail(403, 'Chỉ bộ phận tổ chức cán bộ thẩm định');
    const { rows } = await db.query(
        `UPDATE quy_trinh SET tham_dinh_boi = $2, tham_dinh_dat = $3, tham_dinh_nhan_xet = $4
         WHERE id = $1 AND trang_thai = 'dang_xu_ly' AND buoc = 4 AND tham_dinh_dat IS NULL AND user_id <> $2 RETURNING id, user_id`,
        [req.params.id, req.user.id, dat, String(nhan_xet).trim()]);
    if (!rows[0]) throw fail(409, 'Quy trình không ở bước thẩm định, đã thẩm định, hoặc bạn là người được đề xuất');
    await thongBao(db, await cuTri(db, rows[0], 4), `Quy trình #${rows[0].id} đã có ý kiến thẩm định, mời tập thể biểu quyết`);
    await audit(req, 'qt_tham_dinh', `quy_trinh:${req.params.id}`);
    res.json({ tham_dinh_dat: dat });
});

// Bước 5: người có thẩm quyền (Lãnh đạo đơn vị, không phải người được đề xuất) ký quyết định đã được tập thể thông qua.
// Ngay khi ký, hệ thống TỰ ĐỘNG: cập nhật hồ sơ (nhóm 5, 8, 9 + chức vụ/đơn vị hiện hành), đổi vai trò truy cập,
// tạo việc bàn giao/tiếp nhận, xếp lệnh đồng bộ CSDL quốc gia và email, thông báo, cảnh báo hồ sơ thiếu, ghi nhật ký.
// ponytail: chaincode cho 3 giao dịch riêng; nếu giao dịch sau lỗi thì CSDL quay lui nhưng giao dịch trước đã nằm trên chain
// (xác thực sẽ báo lệch). Gộp thành 1 hàm chaincode khi nâng cấp chaincode
app.post('/api/quy-trinh/:id/quyet-dinh', verifyToken, checkRole(['QUAN_LI']), upload.single('file'), async (req, res) => {
    const so = String(req.body?.so_quyet_dinh ?? '').trim(), ngay = String(req.body?.ngay_hieu_luc ?? '');
    if (!so || so.length > 50 || !/^\d{4}-\d{2}-\d{2}$/.test(ngay)) throw fail(400, 'Cần số quyết định và ngày hiệu lực (YYYY-MM-DD)');
    if (!req.file) throw fail(400, 'Cần tệp quyết định đã ký');
    const qt0 = await loadQT(db, req.params.id);
    if (qt0.user_id === req.user.id) throw fail(403, 'Không được ký quyết định cho chính mình');
    if (qt0.trang_thai !== 'dang_xu_ly' || qt0.buoc !== 5) throw fail(409, 'Chỉ ký được khi tập thể đã biểu quyết thông qua (bước 5)');
    const saved = await saveUpload(req.file);
    try {
        const r = await db.tx(async (c) => {
            const qt = await loadQT(c, req.params.id, true);
            if (qt.trang_thai !== 'dang_xu_ly' || qt.buoc !== 5) throw fail(409, 'Quy trình vừa thay đổi, tải lại');
            const uid = qt.user_id, lyDo = `${LOAI_QT[qt.loai]} theo quyết định ${so}`;
            const { rows: [nv] } = await c.query('SELECT employee_code, full_name, email, role, department_id FROM users WHERE id = $1', [uid]);
            const before = await loadProfile(c, uid);

            // 1. Quyết định thành tài liệu của hồ sơ (nhóm 16), SHA-256 nằm trong vân tay hồ sơ
            const { rows: [doc] } = await c.query(
                `INSERT INTO profile_documents (user_id, doc_type, file_path, sha256, thong_tin, uploaded_by)
                 VALUES ($1, 'Quyết định tuyển dụng, bổ nhiệm', $2, $3, $4, $5) RETURNING id`,
                [uid, saved.name, saved.sha, secure.encCol(JSON.stringify({ ten: `${LOAI_QT[qt.loai]} ${nv.full_name}`, so_ky_hieu: so,
                    ngay_ban_hanh: ngay, loai_ban: 'Điện tử gốc', su_kien: `Quy trình #${qt.id}` })), req.user.id]);
            // 2. Hồ sơ hiện hành + nhóm 5 (quá trình công tác), 8 (lương), 9 (thăng chức/bổ nhiệm)
            const cvMoi = qt.chuc_vu_moi ?? before.position, dvMoi = qt.don_vi_moi ?? nv.department_id;
            const dvTen = (await c.query('SELECT name FROM departments WHERE id = $1', [dvMoi])).rows[0]?.name ?? null;
            await c.query('UPDATE profiles SET position = $2, department = $3 WHERE user_id = $1', [uid, cvMoi, dvTen]);
            const them = async (n, d) => {
                const enc = secure.encCol(JSON.stringify(d));
                const { rows } = await c.query(
                    'INSERT INTO ho_so_nhom (user_id, nhom, du_lieu, quy_trinh_id, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                    [uid, n, enc, qt.id, req.user.id]);
                return { field_group: `nhom_${n}`, field_name: `${NHOM[n][0]} #${rows[0].id}`, old_value: null, new_value: enc, change_type: 'bo_sung' };
            };
            const changes = [{ field_group: 'giay_to', field_name: 'Quyết định tuyển dụng, bổ nhiệm', old_value: null, new_value: saved.sha, change_type: 'bo_sung' }];
            const hinhThuc = { bo_nhiem: 'Bổ nhiệm', mien_nhiem: 'Miễn nhiệm', dieu_dong: 'Điều động' }[qt.loai];
            const kiemPhieuTomTat = Object.entries(qt.ket_qua_buoc ?? {})
                .map(([b, k]) => `Bước ${b}: ${k.dong_y}/${k.tong} đồng ý`).join('; ');
            changes.push(await them(5, { tu_ngay: ngay, don_vi: dvTen ?? '', chuc_vu: cvMoi ?? '', hinh_thuc: hinhThuc,
                so_quyet_dinh: so, ngay_quyet_dinh: ngay, ly_do: qt.ly_do, trang_thai: 'Đang giữ', tai_lieu: String(doc.id) }));
            changes.push(await them(6, { chuc_vu_hien_giu: cvMoi ?? '',
                ...(qt.loai === 'bo_nhiem' ? { ngay_bo_nhiem: ngay } : {}),
                tinh_trang: qt.loai === 'mien_nhiem' ? 'Miễn nhiệm' : 'Đang giữ chức vụ',
                ho_so_quy_trinh: `Quy trình #${qt.id}, QĐ ${so}`, ket_qua_kiem_phieu: kiemPhieuTomTat }));
            if (qt.he_so_moi) {
                const luong = (await loadProfile(c, uid)).nhom.filter(([n]) => n === 8).at(-1)?.[1] ?? {};
                changes.push(await them(8, { ngach: luong.ngach ?? '', ma_ngach: luong.ma_ngach ?? '', bac: luong.bac ?? '',
                    he_so: String(qt.he_so_moi), ngay_huong: ngay, quyet_dinh: so }));
            }
            const after = await loadProfile(c, uid);
            changes.push(...diffProfile(before, after));
            // 3. Vai trò truy cập theo chức vụ mới (authMiddleware đọc vai trò từ CSDL ở mọi request -> có hiệu lực ngay)
            const roleMoi = (await chucVu(c, cvMoi))?.vai_tro ?? nv.role;
            await c.query('UPDATE users SET role = $2, department_id = $3 WHERE id = $1', [uid, roleMoi, dvMoi]);

            // 4. Chữ ký số: vân tay hồ sơ mới + quyết định lên chain. Hồ sơ đang "đã duyệt" thì giữ "đã duyệt"
            //    (quyết định đã ký là căn cứ); đang chờ duyệt (nhân viên tự sửa) thì vẫn chờ duyệt phần tự sửa
            await c.query(`UPDATE profiles SET status = 'cho_duyet', updated_at = now() WHERE user_id = $1`, [uid]);
            await chain.invoke('HR_MANAGER', 'GhiHoSo', [nv.employee_code, chain.hashProfile(after), req.user.employee_code]);
            if (before.status === 'da_duyet') {
                await chain.invoke('HR_MANAGER', 'DuyetHoSo', [nv.employee_code, 'da_duyet', req.user.employee_code]);
                await c.query(`UPDATE profiles SET status = 'da_duyet' WHERE user_id = $1`, [uid]);
            }
            const { transactionId, blockNumber } = await chain.invoke('QUAN_LI', 'XuLyDeNghi', [`QT-${qt.id}`, 'da_duyet', req.user.employee_code]);
            await c.query('UPDATE profile_documents SET chu_ky_so = $1 WHERE id = $2', [transactionId, doc.id]);
            // Lịch sử: phiên bản này có hiệu lực ngay từ ngày hiệu lực, người duyệt = người ký, chữ ký = mã giao dịch
            const version = await addHistory(c, req, uid, changes, lyDo, doc.id);
            await c.query(
                `UPDATE employee_data_history SET status = 'bi_thay_the', valid_to = $3
                 WHERE employee_id = $1 AND status = 'co_hieu_luc' AND field_name IN
                       (SELECT field_name FROM employee_data_history WHERE employee_id = $1 AND version_no = $2)`, [uid, version, ngay]);
            await c.query(
                `UPDATE employee_data_history SET status = 'co_hieu_luc', approved_by = $3, approved_at = now(), digital_signature = $4, valid_from = $5
                 WHERE employee_id = $1 AND version_no = $2`, [uid, version, req.user.id, transactionId, ngay]);
            await c.query(
                `UPDATE quy_trinh SET trang_thai = 'da_ban_hanh', so_quyet_dinh = $2, ngay_hieu_luc = $3, ky_boi = $4, ky_luc = now(),
                        tai_lieu_id = $5, chu_ky_so = $6 WHERE id = $1`, [qt.id, so, ngay, req.user.id, doc.id, transactionId]);

            // 5. Việc bàn giao (người được bổ nhiệm, ở vị trí cũ) và tiếp nhận (trưởng phòng đơn vị mới, không có thì TCCB)
            const { rows: [nhan] } = await c.query(
                `SELECT u.id FROM users u LEFT JOIN departments d ON d.id = u.department_id
                 WHERE u.role = 'HR_MANAGER' AND u.is_active AND u.deleted_at IS NULL AND u.id <> $1
                 ORDER BY (u.department_id = $2) DESC NULLS LAST, d.la_tccb DESC NULLS LAST, u.id LIMIT 1`, [uid, dvMoi]);
            await c.query(
                `INSERT INTO cong_viec (quy_trinh_id, loai, user_id, han) VALUES ($1, 'ban_giao', $2, $4::date + 15), ($1, 'tiep_nhan', $3, $4::date + 15)`,
                [qt.id, uid, nhan?.id ?? req.user.id, ngay]);

            // 6. Thông báo + email: cá nhân, trưởng phòng đơn vị cũ/mới, TCCB, quản trị viên (IT cấp lại quyền)
            const { rows: nhanTin } = await c.query(
                `SELECT DISTINCT u.id, u.email FROM users u LEFT JOIN departments d ON d.id = u.department_id
                 WHERE u.is_active AND u.deleted_at IS NULL AND (u.id = $1 OR u.role = 'ADMIN'
                       OR (u.role = 'HR_MANAGER' AND (u.department_id = $2 OR u.department_id = $3 OR d.la_tccb)))`,
                [uid, nv.department_id, dvMoi]);
            const tin = `${lyDo}: ${nv.full_name} (${nv.employee_code}) ${qt.chuc_vu_cu ?? ''} → ${cvMoi ?? ''}, đơn vị ${dvTen ?? ''}, hiệu lực ${ngay}`;
            await thongBao(c, nhanTin.map((u) => u.id), tin);
            for (const u of nhanTin) await c.query(`INSERT INTO hang_doi_gui (kenh, quy_trinh_id, noi_dung) VALUES ('email', $1, $2)`,
                [qt.id, secure.encCol(JSON.stringify({ to: u.email, subject: `[HRM] ${LOAI_QT[qt.loai]} - QĐ ${so}`, text: tin }))]);
            // 7. Đồng bộ CSDL quốc gia về CBCCVC (định danh bằng số CCCD), qua hàng đợi để tự gửi lại khi lỗi mạng
            await c.query(`INSERT INTO hang_doi_gui (kenh, quy_trinh_id, noi_dung) VALUES ('csdlqg', $1, $2)`, [qt.id, secure.encCol(JSON.stringify({
                so_dinh_danh: before.citizen_id, ho_ten: nv.full_name, loai: qt.loai, chuc_vu_cu: qt.chuc_vu_cu, chuc_vu_moi: cvMoi,
                don_vi: dvTen, he_so: qt.he_so_moi, so_quyet_dinh: so, ngay_hieu_luc: ngay, chu_ky_so: transactionId }))]);
            // 8. Cảnh báo hồ sơ còn thiếu nhóm bắt buộc
            const co = new Set(after.nhom.map(([n]) => n));
            const thieu = NHOM_BAT_BUOC.filter((n) => !co.has(n));
            if (thieu.length) await thongBao(c, [uid, ...(await c.query(IDS_TCCB)).rows.map((u) => u.id)],
                `Hồ sơ ${nv.employee_code} còn thiếu: ${thieu.map((n) => `nhóm ${n} (${NHOM[n][0]})`).join(', ')}`, 'canh_bao');
            return { trang_thai: 'da_ban_hanh', chu_ky_so: transactionId, blockNumber, vai_tro_moi: roleMoi, thieu };
        });
        // 9. Nhật ký toàn bộ sự kiện
        for (const a of ['qt_ky_quyet_dinh', 'qt_cap_nhat_ho_so', 'qt_doi_vai_tro', 'qt_tao_cong_viec', 'qt_thong_bao', 'qt_xep_dong_bo_csdlqg'])
            await audit(req, a, `quy_trinh:${req.params.id}`);
        guiHangDoi().catch((e) => console.error('Hàng đợi:', e.message));
        res.json(r);
    } catch (e) {
        removeUpload(saved.name);
        throw e;
    }
});

// Thông báo và việc được giao của chính mình
app.get('/api/thong-bao', verifyToken, async (req, res) => {
    res.json((await db.query('SELECT id, loai, noi_dung, created_at, da_doc FROM thong_bao WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [req.user.id])).rows);
});
app.put('/api/thong-bao/:id/da-doc', verifyToken, async (req, res) => {
    await db.query('UPDATE thong_bao SET da_doc = true WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
});
app.get('/api/cong-viec', verifyToken, async (req, res) => {
    const { rows } = await db.query(
        `SELECT c.id, c.loai, c.han, c.xong_luc, c.han < current_date AND c.xong_luc IS NULL AS qua_han,
                q.id AS quy_trinh_id, q.loai AS loai_qt, q.so_quyet_dinh, u.employee_code, u.full_name
         FROM cong_viec c JOIN quy_trinh q ON q.id = c.quy_trinh_id JOIN users u ON u.id = q.user_id
         WHERE c.user_id = $1 ORDER BY c.id DESC`, [req.user.id]);
    res.json(rows);
});
app.put('/api/cong-viec/:id/xong', verifyToken, async (req, res) => {
    const { rowCount } = await db.query('UPDATE cong_viec SET xong_luc = now() WHERE id = $1 AND user_id = $2 AND xong_luc IS NULL', [req.params.id, req.user.id]);
    if (!rowCount) throw fail(404, 'Không có việc chưa xong này của bạn');
    await audit(req, 'cong_viec_xong', `cong_viec:${req.params.id}`);
    res.json({ ok: true });
});
// Quản trị viên (IT) theo dõi hàng đợi gửi ra ngoài: chỉ trạng thái, không xem nội dung
app.get('/api/admin/hang-doi', verifyToken, checkRole(['ADMIN']), async (req, res) => {
    res.json((await db.query('SELECT id, kenh, quy_trinh_id, trang_thai, so_lan, loi, created_at, gui_luc FROM hang_doi_gui ORDER BY id DESC LIMIT 100')).rows);
});

// Gửi hàng đợi: CSDL quốc gia (CSDLQG_URL) và email (SMTP_URL, cần "npm i nodemailer").
// Chưa cấu hình thì giữ cho_gui; lỗi thì thử lại tối đa 5 lần
// ponytail: CSDLQG_URL là điểm tiếp nhận giả định; kết nối thật đi qua nền tảng tích hợp (LGSP/NDXP) theo đặc tả của Bộ Nội vụ
const guiHangDoi = async () => {
    const { rows } = await db.query(`SELECT id, kenh, noi_dung FROM hang_doi_gui WHERE trang_thai <> 'da_gui' AND so_lan < 5 ORDER BY id LIMIT 50`);
    for (const r of rows) {
        const dich = r.kenh === 'csdlqg' ? process.env.CSDLQG_URL : process.env.SMTP_URL;
        if (!dich) continue;
        try {
            const body = secure.decCol(r.noi_dung);
            if (r.kenh === 'csdlqg') {
                const resp = await fetch(dich, { method: 'POST', body, signal: AbortSignal.timeout(10_000),
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.CSDLQG_TOKEN ?? ''}` } });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            } else {
                const m = JSON.parse(body);
                await require('nodemailer').createTransport(dich).sendMail({ from: process.env.MAIL_FROM, to: m.to, subject: m.subject, text: m.text });
            }
            await db.query(`UPDATE hang_doi_gui SET trang_thai = 'da_gui', gui_luc = now(), so_lan = so_lan + 1 WHERE id = $1`, [r.id]);
        } catch (e) {
            await db.query(`UPDATE hang_doi_gui SET trang_thai = 'loi', loi = $2, so_lan = so_lan + 1 WHERE id = $1`, [r.id, String(e.message).slice(0, 200)]);
        }
    }
};

// Cảnh báo quá hạn: bước quy trình quá hạn xử lý, việc bàn giao/tiếp nhận quá hạn. Mỗi lần quá hạn chỉ báo 1 lần
const canhBaoQuaHan = async () => {
    const tccb = (await db.query(IDS_TCCB)).rows.map((u) => u.id);
    for (const q of (await db.query(`UPDATE quy_trinh SET canh_bao_luc = now() WHERE trang_thai = 'dang_xu_ly'
            AND han_xu_ly < now() AND canh_bao_luc IS NULL RETURNING id, buoc, de_xuat_boi`)).rows)
        await thongBao(db, [q.de_xuat_boi, ...tccb], `Quy trình #${q.id} quá hạn ở bước ${q.buoc}: ${TEN_BUOC[q.buoc]}`, 'canh_bao');
    for (const v of (await db.query(`UPDATE cong_viec SET canh_bao_luc = now() WHERE xong_luc IS NULL
            AND han < current_date AND canh_bao_luc IS NULL RETURNING id, user_id, loai, quy_trinh_id`)).rows)
        await thongBao(db, [v.user_id, ...tccb], `Việc ${v.loai === 'ban_giao' ? 'bàn giao' : 'tiếp nhận'} của quy trình #${v.quy_trinh_id} đã quá hạn`, 'canh_bao');
};
setInterval(() => {
    guiHangDoi().catch((e) => console.error('Hàng đợi:', e.message));
    canhBaoQuaHan().catch((e) => console.error('Cảnh báo quá hạn:', e.message));
}, Number(process.env.JOB_EVERY_MS ?? 10 * 60 * 1000)).unref();

// ========== 8. XỬ LÝ LỖI CHUNG (không lộ chi tiết nội bộ ra ngoài) ==========
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: `Tệp không hợp lệ: ${err.message}` });
    if (err.code === '23505') return res.status(400).json({ error: 'Email, mã cán bộ, số CCCD, số quyết định hoặc tên phòng ban đã tồn tại' });
    if (err.code === '23503') return res.status(400).json({ error: 'Phòng ban không tồn tại' });
    if (['22P02', '22007', '22008', '23514'].includes(err.code)) return res.status(400).json({ error: 'Dữ liệu không hợp lệ' });
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ' });
});

// Chỉ nghe trong máy ảo; ChainLaunch giữ khóa của mạng nên backend không mở ra ngoài
app.listen(PORT, '127.0.0.1', () => console.log(`🚀 Backend chạy tại http://localhost:${PORT} (blockchain: ${chain.mode})`));
