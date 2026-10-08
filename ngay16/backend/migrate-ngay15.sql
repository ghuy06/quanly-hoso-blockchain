-- Ngày 15: đổi thứ tự xóa tài khoản: Lãnh đạo đơn vị (hoặc TCCB) DUYỆT trước, quản trị viên THỰC HIỆN xóa sau.
--   cho_lanh_dao: cán bộ đã gửi yêu cầu, chờ lãnh đạo duyệt
--   cho_xoa:      lãnh đạo đã duyệt hoặc tự đề nghị, chờ quản trị viên thực hiện
-- requested_by = lãnh đạo đã duyệt/đề nghị; handled_by = người kết thúc (quản trị viên xóa, hoặc người từ chối).
-- Chạy SAU migrate-ngay14.sql, bằng chủ CSDL hrm_app với ON_ERROR_STOP. Chạy lại nhiều lần vẫn an toàn.
BEGIN;

-- Yêu cầu cũ đang chờ (theo luồng cũ, chưa lãnh đạo nào duyệt) chuyển về chờ lãnh đạo duyệt
UPDATE deletion_requests SET status = 'cho_lanh_dao', requested_by = NULL WHERE status IN ('cho_xu_ly', 'cho_xac_nhan');

ALTER TABLE deletion_requests ALTER COLUMN status SET DEFAULT 'cho_lanh_dao';
ALTER TABLE deletion_requests DROP CONSTRAINT IF EXISTS deletion_requests_status_check;
ALTER TABLE deletion_requests ADD CONSTRAINT deletion_requests_status_check
    CHECK (status IN ('cho_xu_ly', 'cho_xac_nhan', 'cho_lanh_dao', 'cho_xoa', 'da_xoa', 'tu_choi'));

COMMIT;
