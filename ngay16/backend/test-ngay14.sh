#!/bin/bash
# Ngay 14-15: xoa tai khoan qua hai nguoi: Lanh dao don vi (hoac TCCB) DUYET, quan tri vien THUC HIEN.
# Luong 1: can bo tu yeu cau -> lanh dao duyet -> quan tri vien xoa. Luong 2: lanh dao de nghi -> quan tri vien xoa.
# Xoa mem: ho so van duoc luu tru
API=http://localhost:5000/api
PWF=~/hrm/backend/.seed-passwords
J='Content-Type: application/json'
login() { read -r _ email pw < <(grep "^$1 " "$PWF"); curl -s $API/auth/login -H "$J" -d "{\"email\":\"$email\",\"password\":\"$pw\"}" | jq -r ".${2:-accessToken}"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
sql() { docker exec hrm_postgres psql -U hrm_app -d hrm_db -qtAc "$1"; }
PASS=0; FAIL=0
check() { if [[ "$3" == *"$2"* ]]; then echo "PASS | $1 | $3"; PASS=$((PASS+1)); else echo "FAIL | $1 | ky vong chua: $2 | thuc te: $3"; FAIL=$((FAIL+1)); fi; }

AD=$(login ADMIN); HR=$(login HR_MANAGER); QL=$(login QUAN_LI); QLCODE=$(login QUAN_LI user.employee_code)
S=$(date +%s); PW="Tmp-$(openssl rand -hex 8)"
DEPS=$(curl -s $API/departments -H "Authorization: Bearer $AD")
DEP2=$(echo "$DEPS" | jq '.[1].id'); DEPTC=$(echo "$DEPS" | jq '.[] | select(.name=="Phòng Tổ chức cán bộ") | .id')
mk() { curl -s $API/admin/users -H "Authorization: Bearer $AD" -H "$J" -d "{\"employee_code\":\"$1$S\",\"full_name\":\"Tai khoan thu $1\",\"email\":\"$1$S@hrm.local\",\"password\":\"$PW\",\"role\":\"$2\",\"department_id\":$3}" | jq -r .id; }
tok() { curl -s $API/auth/login -H "$J" -d "{\"email\":\"$1$S@hrm.local\",\"password\":\"$PW\"}" | jq -r .accessToken; }
NVID=$(mk XN CAN_BO $DEP2); mk XY CAN_BO $DEP2 > /dev/null; mk XL QUAN_LI null > /dev/null; mk XT HR_MANAGER $DEPTC > /dev/null
NV=$(tok XN); NV2=$(tok XY); LD=$(tok XL); TC=$(tok XT)
curl -s -o /dev/null -X PUT $API/profiles/me -H "Authorization: Bearer $NV" -H "$J" -d "{\"position\":\"Chuyên viên\",\"citizen_id\":\"$(printf '%012d' $S)\"}"
tuyc() { curl -s $API/account/deletion-request -H "Authorization: Bearer $1" -H "$J" -d '{"reason":"Thôi việc"}' | jq -r .id; }
ds() { curl -s $API/deletion-approvals -H "Authorization: Bearer $1"; }
duyet() { curl -s -X PUT $API/deletion-approvals/$1 -H "Authorization: Bearer $2" -H "$J" -d "{\"approve\":$3}" | jq -r '.status // .error'; }
xoa() { curl -s -X PUT $API/admin/deletion-requests/$1 -H "Authorization: Bearer $AD" -H "$J" -d "{\"approve\":$2}" | jq -r '.status // .error'; }
denghi() { curl -s $API/deletion-proposals -H "Authorization: Bearer $1" -H "$J" -d "{\"employee_code\":\"$2\",\"reason\":\"$3\"}"; }

echo "########## Luong 1: can bo tu yeu cau -> lanh dao duyet -> quan tri vien xoa ##########"
R1=$(tuyc $NV)
check "1. Can bo gui yeu cau, cho lanh dao duyet" "cho_lanh_dao" "$(curl -s $API/account/deletion-request -H "Authorization: Bearer $NV" | jq -r .status)"
check "2. Gui trung khi dang cho" 409 "$(code $API/account/deletion-request -H "Authorization: Bearer $NV" -H "$J" -d '{}')"
check "3. Quan tri vien xoa khi lanh dao chua duyet" "chưa được lãnh đạo duyệt" "$(xoa $R1 true)"
check "4. Lanh dao don vi nhan thong bao can duyet" "true" "$(curl -s $API/thong-bao -H "Authorization: Bearer $QL" | jq "any(.[]; .noi_dung | contains(\"XN$S\"))")"
check "5. Truong phong khong thuoc TCCB xem danh sach duyet" 403 "$(code $API/deletion-approvals -H "Authorization: Bearer $HR")"
check "6. Nhan vien duyet xoa" 403 "$(code -X PUT $API/deletion-approvals/$R1 -H "Authorization: Bearer $NV2" -H "$J" -d '{"approve":true}')"
check "7. TCCB thay yeu cau" "XN$S" "$(ds $TC | jq -r ".[] | select(.id==$R1) | .employee_code")"
check "8. Lanh dao duyet -> chuyen quan tri vien" "cho_xoa" "$(duyet $R1 $QL true)"
check "9. Da duyet: can bo van dang nhap duoc" 200 "$(code $API/profiles/me -H "Authorization: Bearer $NV")"
check "10. Quan tri vien nhan thong bao can thuc hien" "true" "$(curl -s $API/thong-bao -H "Authorization: Bearer $AD" | jq "any(.[]; .noi_dung | contains(\"XN$S\"))")"
check "11. Lanh dao duyet lai lan nua" 409 "$(code -X PUT $API/deletion-approvals/$R1 -H "Authorization: Bearer $LD" -H "$J" -d '{"approve":true}')"
check "12. Quan tri vien xoa" "da_xoa" "$(xoa $R1 true)"
check "13. Token cu cua tai khoan da xoa" 401 "$(code $API/profiles/me -H "Authorization: Bearer $NV")"
check "14. Ho so van duoc luu tru (so ho so)" "1" "$(sql "SELECT count(*) FROM profiles WHERE user_id=$NVID")"
check "15. Mo khoa tai khoan da xoa" 404 "$(code -X PATCH $API/admin/users/XN$S/active -H "Authorization: Bearer $AD" -H "$J" -d '{"is_active":true}')"
check "16. Nhat ky ghi lanh dao duyet va quan tri vien xoa" "approve_deletion delete_user" "$(sql "SELECT string_agg(action, ' ' ORDER BY action) FROM audit_logs WHERE target='user:$NVID' AND action IN ('approve_deletion','delete_user')")"
check "17. Nguoi duyet khac nguoi xoa" "t" "$(sql "SELECT (handled_by <> requested_by)::text FROM deletion_requests WHERE id=$R1")"

echo "########## Lanh dao tu choi ##########"
R2=$(tuyc $NV2)
check "18. TCCB tu choi -> can bo nhan thong bao" "tu_choi true" "$(duyet $R2 $TC false) $(curl -s $API/thong-bao -H "Authorization: Bearer $NV2" | jq "any(.[]; .noi_dung | contains(\"#$R2\"))")"
check "19. Bi tu choi: quan tri vien khong xoa duoc, tai khoan van dung duoc" "lãnh đạo duyệt, hoặc đã được xử lý 200" "$(xoa $R2 true) $(code $API/profiles/me -H "Authorization: Bearer $NV2")"

echo "########## Lanh dao tu yeu cau xoa: lanh dao khac duyet ##########"
R3=$(tuyc $LD)
check "20. Lanh dao khong thay yeu cau xoa cua chinh minh" "0" "$(ds $LD | jq "[.[] | select(.id==$R3)] | length")"
check "21. Lanh dao tu duyet yeu cau cua minh" 409 "$(code -X PUT $API/deletion-approvals/$R3 -H "Authorization: Bearer $LD" -H "$J" -d '{"approve":true}')"
check "22. Lanh dao khac tu choi" "tu_choi" "$(duyet $R3 $QL false)"

echo "########## Luong 2: lanh dao de nghi xoa -> quan tri vien xoa ##########"
check "23. De nghi khong co ly do" 400 "$(code $API/deletion-proposals -H "Authorization: Bearer $QL" -H "$J" -d "{\"employee_code\":\"XY$S\"}")"
check "24. Lanh dao tu de nghi xoa chinh minh" 400 "$(code $API/deletion-proposals -H "Authorization: Bearer $QL" -H "$J" -d "{\"employee_code\":\"$QLCODE\",\"reason\":\"thu tu xoa\"}")"
check "25. Truong phong khong thuoc TCCB de nghi" 403 "$(code $API/deletion-proposals -H "Authorization: Bearer $HR" -H "$J" -d "{\"employee_code\":\"XY$S\",\"reason\":\"Nghi huu\"}")"
P=$(denghi $QL "XY$S" "Nghỉ hưu theo QĐ 12/QĐ-UBND"); PID=$(echo "$P" | jq -r .id)
check "26. Lanh dao de nghi -> thang toi quan tri vien" "cho_xoa" "$(echo "$P" | jq -r .status)"
check "27. De nghi trung khi dang cho" 409 "$(code $API/deletion-proposals -H "Authorization: Bearer $TC" -H "$J" -d "{\"employee_code\":\"XY$S\",\"reason\":\"lan hai nua\"}")"
check "28. Quan tri vien thay nguon la lanh dao de nghi" "false|$QLCODE" "$(curl -s $API/admin/deletion-requests -H "Authorization: Bearer $AD" | jq -r ".[] | select(.id==$PID) | \"\(.tu_yeu_cau)|\(.duyet_boi)\"")"
check "29. Quan tri vien xoa" "da_xoa" "$(xoa $PID true)"
check "30. Lanh dao nhan thong bao ket qua" "true" "$(curl -s $API/thong-bao -H "Authorization: Bearer $QL" | jq "any(.[]; .noi_dung | contains(\"#$PID\"))")"
check "31. Token cu cua tai khoan da xoa" 401 "$(code $API/profiles/me -H "Authorization: Bearer $NV2")"

echo "########## Quan tri vien khong tu khoi tao xoa ##########"
check "32. API quan tri vien tu de nghi xoa da bo" 404 "$(code $API/admin/users/XL$S/deletion -H "Authorization: Bearer $AD" -H "$J" -d '{"reason":"thu xoa truc tiep"}')"
check "33. Quan tri vien goi API de nghi cua lanh dao" 403 "$(code $API/deletion-proposals -H "Authorization: Bearer $AD" -H "$J" -d "{\"employee_code\":\"XL$S\",\"reason\":\"thu xoa truc tiep\"}")"

# Khoa cac tai khoan tam sau khi dung xong
for c in XL XT; do curl -s -o /dev/null -X PATCH $API/admin/users/$c$S/active -H "Authorization: Bearer $AD" -H "$J" -d '{"is_active":false}'; done
echo; echo "TONG KET NGAY14: $PASS PASS, $FAIL FAIL"
