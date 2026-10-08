#!/bin/bash
# Ngay 16: email (dinh dang, khong phan biet hoa thuong, sua email), chuyen phong (chi tai khoan chua co ho so,
# canh bao khuyet truong phong), so quyet dinh he thong tu cap
API=http://localhost:5000/api
PWF=~/hrm/backend/.seed-passwords
J='Content-Type: application/json'
login() { read -r _ email pw < <(grep "^$1 " "$PWF"); curl -s $API/auth/login -H "$J" -d "{\"email\":\"$email\",\"password\":\"$pw\"}" | jq -r .accessToken; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
sql() { docker exec hrm_postgres psql -U hrm_app -d hrm_db -qtAc "$1"; }
PASS=0; FAIL=0
check() { if [[ "$3" == *"$2"* ]]; then echo "PASS | $1 | $3"; PASS=$((PASS+1)); else echo "FAIL | $1 | ky vong chua: $2 | thuc te: $3"; FAIL=$((FAIL+1)); fi; }

AD=$(login ADMIN); HR=$(login HR_MANAGER); QL=$(login QUAN_LI)
S=$(date +%s); PW="Tmp-$(openssl rand -hex 8)"
DEP2=$(curl -s $API/departments -H "Authorization: Bearer $AD" | jq '.[1].id')
mk() { curl -s $API/admin/users -H "Authorization: Bearer $AD" -H "$J" -d "{\"employee_code\":\"$1$S\",\"full_name\":\"Tai khoan thu $1\",\"email\":\"$2\",\"password\":\"$PW\",\"role\":\"$3\",\"department_id\":$4}"; }
dn() { curl -s $API/auth/login -H "$J" -d "{\"email\":\"$1\",\"password\":\"$PW\"}"; }
doiEmail() { curl -s -X PATCH $API/admin/users/$1/email -H "Authorization: Bearer ${3:-$AD}" -H "$J" -d "{\"email\":\"$2\"}"; }
chuyen() { curl -s -X PATCH $API/admin/users/$1/department -H "Authorization: Bearer $AD" -H "$J" -d "{\"department_id\":$2}"; }

echo "########## Email ##########"
check "1. Cap tai khoan email sai dinh dang" "không đúng định dạng" "$(mk EA abc CAN_BO $DEP2 | jq -r .error)"
check "2. Email luu chu thuong" "ea$S@hrm.local" "$(mk EA "EA$S@HRM.Local" CAN_BO $DEP2 | jq -r .email)"
check "3. Dang nhap go chu hoa van vao duoc" "CAN_BO" "$(dn "Ea$S@Hrm.LOCAL" | jq -r .user.role)"
check "4. Email trung khac hoa thuong" "đã tồn tại" "$(mk EB "EA$S@hrm.local" CAN_BO $DEP2 | jq -r .error)"
check "5. Nhan vien sua email" 403 "$(code -X PATCH $API/admin/users/EA$S/email -H "Authorization: Bearer $HR" -H "$J" -d '{"email":"x@y.vn"}')"
check "6. Sua email sai dinh dang" "không đúng định dạng" "$(doiEmail EA$S "khong co a cong" | jq -r .error)"
check "7. Quan tri vien sua email" "ea$S@coquan.gov.vn" "$(doiEmail EA$S "EA$S@CoQuan.gov.vn" | jq -r .email)"
check "8. Dang nhap bang email moi" "CAN_BO" "$(dn "ea$S@coquan.gov.vn" | jq -r .user.role)"
check "9. Email cu khong dang nhap duoc" "không đúng" "$(dn "ea$S@hrm.local" | jq -r .error)"
check "10. Nhat ky ghi change_email" "1" "$(sql "SELECT count(*) FROM audit_logs WHERE action = 'change_email' AND target = (SELECT 'user:' || id FROM users WHERE employee_code = 'EA$S')")"

echo "########## Chuyen phong ##########"
# Phong thu nghiem co dinh (tao lan dau, cac lan sau bao trung va dung lai) de danh sach phong ban khong phinh ra
curl -s -o /dev/null $API/admin/departments -H "Authorization: Bearer $AD" -H "$J" -d '{"name":"Phòng thử nghiệm khuyết TP"}'
DEPX=$(curl -s $API/departments -H "Authorization: Bearer $AD" | jq '.[] | select(.name == "Phòng thử nghiệm khuyết TP") | .id')
check "11. Chuyen tai khoan chua khai ho so (sua nham)" "$DEPX" "$(chuyen EA$S $DEPX | jq -r .department_id)"
mk EC "ec$S@hrm.local" CAN_BO $DEP2 > /dev/null
EC=$(dn "ec$S@hrm.local" | jq -r .accessToken)
curl -s -o /dev/null -X PUT $API/profiles/me -H "Authorization: Bearer $EC" -H "$J" -d "{\"position\":\"Chuyên viên\",\"citizen_id\":\"$(printf '%012d' $((S + 16)))\"}"
check "12. Can bo da co ho so: phai qua Dieu dong" "Điều động" "$(chuyen EC$S $DEPX | jq -r .error)"
check "13. Phong cua can bo khong doi" "$DEP2" "$(sql "SELECT department_id FROM users WHERE employee_code = 'EC$S'")"
# Truong phong duy nhat cua phong thu nghiem roi phong -> canh bao khuyet
sql "UPDATE users SET is_active = false WHERE department_id = $DEPX AND role = 'HR_MANAGER'" > /dev/null
mk TK "tk$S@hrm.local" HR_MANAGER $DEPX > /dev/null
chuyen TK$S $DEP2 > /dev/null
check "14. Truong phong roi phong -> lanh dao nhan canh bao khuyet" "true" "$(curl -s $API/thong-bao -H "Authorization: Bearer $QL" | jq '.[0:5] | any(.[]; .loai == "canh_bao" and (.noi_dung | contains("thử nghiệm khuyết TP")))')"
N0=$(sql "SELECT count(*) FROM thong_bao WHERE noi_dung LIKE '%Phòng thử nghiệm khuyết TP%'")
mk TP "tp$S@hrm.local" HR_MANAGER $DEPX > /dev/null; mk TQ "tq$S@hrm.local" HR_MANAGER $DEPX > /dev/null
chuyen TP$S $DEP2 > /dev/null
check "15. Phong con truong phong khac -> khong canh bao" "$N0" "$(sql "SELECT count(*) FROM thong_bao WHERE noi_dung LIKE '%Phòng thử nghiệm khuyết TP%'")"

echo "########## So quyet dinh he thong tu cap ##########"
NAM=$(date +%Y)
KY=$(sql "SELECT lpad((coalesce(max(split_part(so_quyet_dinh, '/', 1)::int), 0) + 1)::text, 2, '0') || '/$NAM/QĐ' FROM quy_trinh WHERE so_quyet_dinh ~ '^[0-9]+/$NAM/QĐ\$'")
check "16. So du kien = so lon nhat trong nam + 1, dang 01/$NAM/QĐ" "$KY" "$(curl -s $API/quy-trinh/so-quyet-dinh-tiep-theo -H "Authorization: Bearer $QL" | jq -r .so_quyet_dinh)"
check "17. Truong phong xem so du kien" 403 "$(code $API/quy-trinh/so-quyet-dinh-tiep-theo -H "Authorization: Bearer $HR")"
check "18. Quyet dinh ky gan nhat mang so he thong cap" "t" "$(sql "SELECT (so_quyet_dinh ~ '^[0-9]{2,}/[0-9]{4}/QĐ\$')::text FROM quy_trinh WHERE ky_luc IS NOT NULL ORDER BY ky_luc DESC LIMIT 1")"

# Khoa cac tai khoan tam sau khi dung xong
for c in EA EC TK TP TQ; do curl -s -o /dev/null -X PATCH $API/admin/users/$c$S/active -H "Authorization: Bearer $AD" -H "$J" -d '{"is_active":false}'; done
echo; echo "TONG KET NGAY16: $PASS PASS, $FAIL FAIL"
