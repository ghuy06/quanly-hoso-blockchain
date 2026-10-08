#!/bin/bash
# Dọn tài khoản tạm do các bộ kiểm thử tạo ra (mã = 1-2 chữ cái + 10 chữ số thời gian, vd. XN1791295817, TC1791295841).
# Xóa mềm như luồng xóa thật: khóa vĩnh viễn + ẩn khỏi danh sách; hồ sơ và lịch sử trên chain vẫn được giữ.
# Tài khoản thật (CB01, HR01, QL01, AD01, P01TP, P01NV1, LD02...) không khớp mẫu nên không bị đụng tới.
# Chạy: bash ~/hrm/backend/don-tai-khoan-thu.sh
sql() { docker exec hrm_postgres psql -U hrm_app -d hrm_db -qtAc "$1"; }
TAM="employee_code ~ '^[A-Z]{1,2}[0-9]{10}\$' AND deleted_at IS NULL"
echo "Tài khoản tạm sẽ dọn: $(sql "SELECT count(*) FROM users WHERE $TAM")"
# Đóng các việc còn treo của tài khoản tạm để không hiện ở khung "chờ xử lý"
sql "UPDATE deletion_requests SET status = 'tu_choi', handled_at = now()
     WHERE status IN ('cho_lanh_dao', 'cho_xoa', 'cho_xu_ly', 'cho_xac_nhan') AND user_id IN (SELECT id FROM users WHERE $TAM)" > /dev/null
sql "UPDATE quy_trinh SET trang_thai = 'khong_thong_qua'
     WHERE trang_thai = 'dang_xu_ly' AND user_id IN (SELECT id FROM users WHERE $TAM)" > /dev/null
sql "UPDATE users SET is_active = false, deleted_at = now() WHERE $TAM" > /dev/null
echo "Đã dọn. Còn lại $(sql "SELECT count(*) FROM users WHERE deleted_at IS NULL") tài khoản đang dùng."
