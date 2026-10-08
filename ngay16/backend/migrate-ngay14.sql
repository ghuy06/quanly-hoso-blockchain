-- Ngày 14: mọi lần xóa tài khoản đều qua hai người: quản trị viên (đề nghị, hoặc kiểm tra rồi chuyển yêu cầu
-- của cán bộ), sau đó Lãnh đạo đơn vị hoặc TCCB xác nhận.
-- Xóa vẫn là xóa mềm: hồ sơ, giấy tờ, lịch sử và dữ liệu trên blockchain được giữ nguyên.
-- Chạy bằng chủ CSDL hrm_app với ON_ERROR_STOP. Chạy lại nhiều lần vẫn an toàn (kể cả sau migrate-ngay15.sql).
BEGIN;

-- requested_by: quản trị viên đã đề nghị hoặc đã chuyển yêu cầu sang chờ xác nhận
ALTER TABLE deletion_requests ADD COLUMN IF NOT EXISTS requested_by INT REFERENCES users(id);
-- tu_yeu_cau: true = cán bộ tự gửi yêu cầu; false = quản trị viên chủ động đề nghị
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deletion_requests' AND column_name = 'tu_yeu_cau') THEN
        ALTER TABLE deletion_requests ADD COLUMN tu_yeu_cau BOOLEAN NOT NULL DEFAULT true;
        UPDATE deletion_requests SET tu_yeu_cau = false WHERE requested_by IS NOT NULL;
    END IF;
END $$;

-- cho_xac_nhan: quản trị viên đã đề nghị, chờ Lãnh đạo đơn vị hoặc TCCB xác nhận
ALTER TABLE deletion_requests DROP CONSTRAINT IF EXISTS deletion_requests_status_check;
ALTER TABLE deletion_requests ADD CONSTRAINT deletion_requests_status_check
    CHECK (status IN ('cho_xu_ly', 'cho_xac_nhan', 'cho_lanh_dao', 'cho_xoa', 'da_xoa', 'tu_choi'));

-- Mỗi người tối đa một yêu cầu đang chờ, dù do ai khởi tạo
DROP INDEX IF EXISTS deletion_one_pending;
CREATE UNIQUE INDEX deletion_one_pending ON deletion_requests (user_id) WHERE status IN ('cho_xu_ly', 'cho_xac_nhan', 'cho_lanh_dao', 'cho_xoa');

COMMIT;
