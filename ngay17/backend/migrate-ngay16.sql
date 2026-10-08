-- Ngày 16: email không phân biệt hoa thường; sửa bản ghi nhóm 2-14 (bản mới thay cho bản cũ, bản cũ vẫn giữ)
-- Chạy được nhiều lần. Chạy sau migrate-ngay15.sql

-- 1. Email về chữ thường; chống trùng không phân biệt hoa thường (vd. CB01@hrm.local và cb01@hrm.local)
UPDATE users SET email = lower(trim(email)) WHERE email <> lower(trim(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));

-- 2. Bản ghi sửa trỏ về bản ghi nó thay thế
ALTER TABLE ho_so_nhom ADD COLUMN IF NOT EXISTS thay_cho INT REFERENCES ho_so_nhom(id);
