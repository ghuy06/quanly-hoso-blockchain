-- Ngày 13: hồ sơ cán bộ theo chuẩn 15 nhóm dữ liệu.
-- Nhóm 1 thêm trường định danh; nhóm 2-14 đánh số lại; nhóm 15 (quản lý tài liệu) thêm thông tin quản lý.
-- Chạy bằng chủ CSDL hrm_app với ON_ERROR_STOP. Chạy lại nhiều lần vẫn an toàn.
BEGIN;

-- 1. Đánh số lại bản ghi theo chuẩn 15 nhóm (chỉ chạy lần đầu, nhận biết qua cột mới của profiles):
--    cũ 9 (thăng chức/bổ nhiệm) -> 6; cũ 10-15 -> 9-14; nhóm 2-8 giữ nguyên
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'ten_goi_khac') THEN
        ALTER TABLE ho_so_nhom DROP CONSTRAINT IF EXISTS ho_so_nhom_nhom_check;
        UPDATE ho_so_nhom SET nhom = CASE WHEN nhom = 9 THEN 6 WHEN nhom >= 10 THEN nhom - 1 ELSE nhom END;
    END IF;
END $$;
ALTER TABLE ho_so_nhom DROP CONSTRAINT IF EXISTS ho_so_nhom_nhom_check;
ALTER TABLE ho_so_nhom ADD CONSTRAINT ho_so_nhom_nhom_check CHECK (nhom BETWEEN 2 AND 14);

-- 2. Nhóm 1: tên gọi khác, nơi đăng ký khai sinh, quốc tịch, cơ quan lập hồ sơ gốc, ngày tạo
ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS ten_goi_khac          VARCHAR(150),
    ADD COLUMN IF NOT EXISTS noi_dang_ky_khai_sinh VARCHAR(255),
    ADD COLUMN IF NOT EXISTS quoc_tich             VARCHAR(100),
    ADD COLUMN IF NOT EXISTS co_quan_lap           VARCHAR(255),
    ADD COLUMN IF NOT EXISTS created_at            TIMESTAMPTZ NOT NULL DEFAULT now();

-- 3. Nhóm 15: thông tin quản lý tài liệu (JSON mã hóa) và người tải lên
ALTER TABLE profile_documents
    ADD COLUMN IF NOT EXISTS thong_tin   TEXT,
    ADD COLUMN IF NOT EXISTS uploaded_by INT REFERENCES users(id);
UPDATE profile_documents SET uploaded_by = user_id WHERE uploaded_by IS NULL;

COMMIT;
