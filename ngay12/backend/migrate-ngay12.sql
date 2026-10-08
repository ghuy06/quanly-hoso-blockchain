-- Ngày 12: CCCD là mã hồ sơ, danh mục chức vụ, 16 nhóm dữ liệu (NĐ 27/2026/NĐ-CP),
-- quy trình bổ nhiệm / miễn nhiệm (giáng chức) / điều động (luân chuyển) và các tác vụ tự động sau khi ký quyết định.
-- Chạy bằng chủ CSDL hrm_app, có ON_ERROR_STOP để lỗi thì không đổi gì. Chạy lại nhiều lần vẫn an toàn.
BEGIN;

-- 1. Danh mục chức vụ (Master Data). Mọi trường "chức vụ" chỉ nhận giá trị trong bảng này.
--    thu_tu: cấp bậc (bổ nhiệm phải lên cao hơn, miễn nhiệm/giáng chức phải xuống thấp hơn)
--    vai_tro: quyền truy cập (RBAC) tương ứng, được gán tự động khi quyết định có hiệu lực
CREATE TABLE IF NOT EXISTS chuc_vu (
    ten           VARCHAR(100) PRIMARY KEY,
    thu_tu        SMALLINT NOT NULL UNIQUE,
    vai_tro       VARCHAR(20) NOT NULL CHECK (vai_tro IN ('CAN_BO', 'HR_MANAGER', 'QUAN_LI')),
    cap_phe_duyet VARCHAR(100) NOT NULL
);
INSERT INTO chuc_vu VALUES
    ('Chuyên viên', 1, 'CAN_BO', 'Thủ trưởng đơn vị'),
    ('Phó Trưởng phòng', 2, 'CAN_BO', 'Thủ trưởng đơn vị'),
    ('Trưởng phòng', 3, 'HR_MANAGER', 'Thủ trưởng đơn vị'),
    ('Phó Thủ trưởng đơn vị', 4, 'QUAN_LI', 'Cấp trên trực tiếp'),
    ('Thủ trưởng đơn vị', 5, 'QUAN_LI', 'Cấp trên trực tiếp')
ON CONFLICT (ten) DO NOTHING;
-- NOT VALID: chỉ kiểm tra dữ liệu ghi mới, giá trị cũ ngoài danh mục vẫn đọc được (và vân tay cũ trên chain không đổi)
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_position_fk;
ALTER TABLE profiles ADD CONSTRAINT profiles_position_fk FOREIGN KEY (position) REFERENCES chuc_vu(ten) NOT VALID;

-- 2. Mã hồ sơ điện tử = số CCCD, làm khóa chính (không sinh mã ngẫu nhiên).
--    Khóa chính lưu HMAC-SHA256 của CCCD: tra cứu và chống trùng theo CCCD nhưng CSDL không chứa CCCD bản rõ
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM profiles WHERE citizen_id_hmac IS NULL) THEN
        RAISE EXCEPTION 'Hồ sơ của các tài khoản sau chưa có số CCCD: %. Đăng nhập tài khoản đó, nhập CCCD rồi chạy lại',
            (SELECT string_agg(u.employee_code, ', ') FROM profiles p JOIN users u ON u.id = p.user_id WHERE p.citizen_id_hmac IS NULL);
    END IF;
END $$;
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_pkey;
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_citizen_id_hmac_key;
ALTER TABLE profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (citizen_id_hmac);
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_user_id_key;
ALTER TABLE profiles ADD CONSTRAINT profiles_user_id_key UNIQUE (user_id);

-- 3. Bộ phận Tổ chức cán bộ (TCCB): trưởng phòng của phòng này xem được hồ sơ toàn đơn vị, thẩm định, tổng hợp phiếu;
--    không biểu quyết, không ký. Quản trị viên gán trưởng phòng TCCB vào phòng này
ALTER TABLE departments ADD COLUMN IF NOT EXISTS la_tccb BOOLEAN NOT NULL DEFAULT false;
INSERT INTO departments (name, la_tccb) VALUES ('Phòng Tổ chức cán bộ', true) ON CONFLICT (name) DO UPDATE SET la_tccb = true;

-- 4. Nhóm 2-15: mỗi dòng một bản ghi (một người thân, một văn bằng...), nội dung JSON MÃ HÓA (enc:...).
--    Không sửa đè: hủy hiệu lực (giữ lại) rồi thêm bản ghi mới. Nhóm 1 ở bảng profiles, nhóm 16 ở profile_documents
CREATE TABLE IF NOT EXISTS ho_so_nhom (
    id           SERIAL PRIMARY KEY,
    user_id      INT NOT NULL REFERENCES users(id),
    nhom         SMALLINT NOT NULL CHECK (nhom BETWEEN 2 AND 15),
    du_lieu      TEXT NOT NULL,
    quy_trinh_id INT,                -- bản ghi do quyết định đã ký tạo ra (nhóm 5, 8, 9)
    created_by   INT NOT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    huy_luc      TIMESTAMPTZ,
    huy_boi      INT REFERENCES users(id),
    ly_do_huy    TEXT
);
CREATE INDEX IF NOT EXISTS ho_so_nhom_user ON ho_so_nhom (user_id, nhom);

-- 5. Nhóm 16: mã tài liệu = id, chữ ký số = mã giao dịch blockchain ghi vân tay khi đính kèm
ALTER TABLE profile_documents ADD COLUMN IF NOT EXISTS chu_ky_so TEXT;

-- 6. Quy trình: 1 Xin chủ trương -> 2 Tập thể lãnh đạo xem xét -> 3 Lấy ý kiến giới thiệu
--    -> 4 TCCB thẩm định + tập thể biểu quyết kín -> 5 Người có thẩm quyền ký quyết định
CREATE TABLE IF NOT EXISTS quy_trinh (
    id                 SERIAL PRIMARY KEY,
    loai               VARCHAR(20) NOT NULL CHECK (loai IN ('bo_nhiem', 'mien_nhiem', 'dieu_dong')),
    user_id            INT NOT NULL REFERENCES users(id),        -- cán bộ được đề xuất
    chuc_vu_cu         VARCHAR(100),
    chuc_vu_moi        VARCHAR(100) REFERENCES chuc_vu(ten),
    don_vi_cu          INT REFERENCES departments(id),
    don_vi_moi         INT REFERENCES departments(id),
    he_so_moi          NUMERIC(4, 2),
    ly_do              TEXT NOT NULL,                             -- nội dung tờ trình xin chủ trương
    buoc               SMALLINT NOT NULL DEFAULT 2 CHECK (buoc BETWEEN 1 AND 5),
    trang_thai         VARCHAR(20) NOT NULL DEFAULT 'dang_xu_ly' CHECK (trang_thai IN ('dang_xu_ly', 'da_ban_hanh', 'khong_thong_qua')),
    han_xu_ly          TIMESTAMPTZ NOT NULL,
    canh_bao_luc       TIMESTAMPTZ,
    ket_qua_buoc       JSONB NOT NULL DEFAULT '{}',              -- số phiếu từng bước khi kết thúc bước
    de_xuat_boi        INT NOT NULL REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    tx_tao             TEXT,
    tham_dinh_boi      INT REFERENCES users(id),
    tham_dinh_dat      BOOLEAN,
    tham_dinh_nhan_xet TEXT,
    so_quyet_dinh      VARCHAR(50) UNIQUE,
    ngay_hieu_luc      DATE,
    ky_boi             INT REFERENCES users(id),
    ky_luc             TIMESTAMPTZ,
    tai_lieu_id        INT REFERENCES profile_documents(id),
    chu_ky_so          TEXT                                       -- mã giao dịch ký quyết định trên blockchain
);
CREATE UNIQUE INDEX IF NOT EXISTS quy_trinh_mot_dang_xu_ly ON quy_trinh (user_id) WHERE trang_thai = 'dang_xu_ly';

-- Bỏ phiếu kín: phiếu KHÔNG có cột người bỏ phiếu, không có thời gian; ai đã bỏ phiếu nằm ở bảng riêng
CREATE TABLE IF NOT EXISTS phieu_bau (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    quy_trinh_id INT NOT NULL REFERENCES quy_trinh(id),
    buoc         SMALLINT NOT NULL,
    dong_y       BOOLEAN NOT NULL
);
CREATE TABLE IF NOT EXISTS da_bo_phieu (
    quy_trinh_id INT NOT NULL REFERENCES quy_trinh(id),
    buoc         SMALLINT NOT NULL,
    user_id      INT NOT NULL REFERENCES users(id),
    PRIMARY KEY (quy_trinh_id, buoc, user_id)
);

-- 7. Tác vụ tự động sau khi ký: việc bàn giao/tiếp nhận, thông báo, hàng đợi gửi ra ngoài (CSDL quốc gia, email)
CREATE TABLE IF NOT EXISTS cong_viec (
    id           SERIAL PRIMARY KEY,
    quy_trinh_id INT NOT NULL REFERENCES quy_trinh(id),
    loai         VARCHAR(20) NOT NULL CHECK (loai IN ('ban_giao', 'tiep_nhan')),
    user_id      INT NOT NULL REFERENCES users(id),
    han          DATE NOT NULL,
    xong_luc     TIMESTAMPTZ,
    canh_bao_luc TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS thong_bao (
    id         SERIAL PRIMARY KEY,
    user_id    INT NOT NULL REFERENCES users(id),
    loai       VARCHAR(20) NOT NULL DEFAULT 'thong_bao' CHECK (loai IN ('thong_bao', 'canh_bao')),
    noi_dung   TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    da_doc     BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS thong_bao_user ON thong_bao (user_id, id);
CREATE TABLE IF NOT EXISTS hang_doi_gui (
    id           SERIAL PRIMARY KEY,
    kenh         VARCHAR(10) NOT NULL CHECK (kenh IN ('csdlqg', 'email')),
    quy_trinh_id INT REFERENCES quy_trinh(id),
    noi_dung     TEXT NOT NULL,                                   -- enc:... (có số định danh cá nhân)
    trang_thai   VARCHAR(20) NOT NULL DEFAULT 'cho_gui' CHECK (trang_thai IN ('cho_gui', 'da_gui', 'loi')),
    so_lan       INT NOT NULL DEFAULT 0,
    loi          TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    gui_luc      TIMESTAMPTZ
);

-- 8. Quyền cho tài khoản web: vẫn không có DELETE; phiếu bầu chỉ thêm, không sửa được
GRANT SELECT ON chuc_vu TO hrm_web;
GRANT SELECT, INSERT ON ho_so_nhom TO hrm_web;
GRANT UPDATE (huy_luc, huy_boi, ly_do_huy) ON ho_so_nhom TO hrm_web;
GRANT UPDATE (chu_ky_so) ON profile_documents TO hrm_web;
GRANT SELECT, INSERT, UPDATE ON quy_trinh TO hrm_web;
GRANT SELECT, INSERT ON phieu_bau, da_bo_phieu TO hrm_web;
GRANT SELECT, INSERT ON cong_viec, thong_bao, hang_doi_gui TO hrm_web;
GRANT UPDATE (xong_luc, canh_bao_luc) ON cong_viec TO hrm_web;
GRANT UPDATE (da_doc) ON thong_bao TO hrm_web;
GRANT UPDATE (trang_thai, so_lan, loi, gui_luc) ON hang_doi_gui TO hrm_web;
GRANT USAGE ON SEQUENCE ho_so_nhom_id_seq, quy_trinh_id_seq, cong_viec_id_seq, thong_bao_id_seq, hang_doi_gui_id_seq TO hrm_web;

COMMIT;
