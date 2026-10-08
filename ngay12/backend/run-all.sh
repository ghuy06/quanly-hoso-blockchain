#!/bin/bash
# Chay lai toan bo kiem thu, moi bo mot file log trong bien-ban/
# test-ngay6 chay CUOI vi bai do mat khau khoa dang nhap 15 phut
D=~/hrm/backend/bien-ban; mkdir -p "$D"
for s in test-ngay2b test-ngay3b test-ngay5a test-ngay5b test-ngay8 test-ngay10 test-ngay11 test-ngay12 test-ngay6; do
    { echo "##### $s | $(date '+%F %T') | $(hostname)"; bash ~/hrm/backend/$s.sh; } > "$D/$s.log" 2>&1
    echo "xong $s"
done
grep -h "TONG KET" "$D/test-ngay8.log" "$D/test-ngay10.log" "$D/test-ngay11.log" "$D/test-ngay12.log" "$D/test-ngay6.log"
