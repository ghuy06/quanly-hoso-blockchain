#!/bin/bash
# Ngay 14: moi lan xoa tai khoan deu qua hai nguoi: quan tri vien (de nghi, hoac kiem tra roi chuyen yeu cau
# cua can bo), sau do Lanh dao don vi hoac TCCB xac nhan.
# Xoa mem: ho so van duoc luu tru
API=http://localhost:5000/api
PWF=~/hrm/backend/.seed-passwords
J='Content-Type: application/json'
login() { read -r _ email pw < <(grep "^$1 " "$PWF"); curl -s $API/auth/login -H "$J" -d "{\"email\":\"$email\",\"password\":\"$pw\"}" | jq -r ".${2:-accessToken}"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
sql() { docker exec hrm_postgres psql -U hrm_app -d hrm_db -qtAc "$1"; }
PASS=0; FAIL=0
check() { if [[ "$3" == *"$2"* ]]; then echo "PASS | $1 | $3"; PASS=$((PASS+1)); else echo "FAIL | $1 | ky vong chua: $2 | thuc te: $3"; FAIL=$((FAIL+1)); fi; }

AD=$(login ADMIN); ADCODE=$(login ADMIN user.employee_code); HR=$(login HR_MANAGER); QL=$(login QUAN_LI); CB=$(login CAN_BO)
S=$(date +%s); PW="Tmp-$(openssl rand -hex 8)"
DEPS=$(curl -s $API/departments -H "Authorization: Bearer $AD")
DEP2=$(echo "$DEPS" | jq '.[1].id'); DEPTC=$(echo "$DEPS" | jq '.[] | select(.name=="Phòng Tổ chức cán bộ") | .id')
mk() { curl -s $API/admin/users -H "Authorization: Bearer $AD" -H "$J" -d "{\"employee_code\":\"$1$S\",\"full_name\":\"Tai khoan thu $1\",\"email\":\"$1$S@hrm.local\",\"password\":\"$PW\",\"role\":\"$2\",\"department_id\":$3}" | jq -r .id; }
tok() { curl -s $API/auth/login -H "$J" -d "{\"email\":\"$1$S@hrm.local\",\"password\":\"$PW\"}" | jq -r .accessToken; }
NVID=$(mk XN CAN_BO $DEP2); mk XL QUAN_LI null > /dev/null; mk XT HR_MANAGER $DEPTC > /dev/null; NV2ID=$(mk XY CAN_BO $DEP2)
NV=$(tok XN); LD=$(tok XL); TC=$(tok XT); NV2=$(tok XY)
curl -s -o /dev/null -X PUT $API/profiles/me -H "Authorization: Bearer $NV" -H "$J" -d "{\"position\":\"Chuyên viên\",\"citizen_id\":\"$(printf '%012d' $S)\"}"
denghi() { curl -s $API/admin/users/$1/deletion -H "Authorization: Bearer $AD" -H "$J" -d "{\"reason\":\"$2\"}"; }
dsxn() { curl -s $API/deletion-confirmations -H "Authorization: Bearer $1"; }
xn() { curl -s -X PUT $API/deletion-confirmations/$1 -H "Authorization: Bearer $2" -H "$J" -d "{\"approve\":$3}"; }

echo "########## Quan tri vien chi tao de nghi ##########"
check "1. De nghi xoa khong co ly do" 400 "$(code $API/admin/users/XN$S/deletion -H "Authorization: Bearer $AD" -H "$J" -d '{}')"
check "2. Quan tri vien tu xoa chinh minh" 400 "$(code $API/admin/users/$ADCODE/deletion -H "Authorization: Bearer $AD" -H "$J" -d '{"reason":"thu tu xoa"}')"
R=$(denghi XN$S "Nghỉ hưu theo QĐ 12/QĐ-UBND"); RID=$(echo "$R" | jq -r .id)
check "3. Quan tri vien de nghi xoa nhan vien" "cho_xac_nhan" "$(echo "$R" | jq -r .status)"
check "4. Chua xac nhan: nhan vien van dang nhap duoc" 200 "$(code $API/profiles/me -H "Authorization: Bearer $NV")"
check "5. De nghi trung khi dang cho" 409 "$(code $API/admin/users/XN$S/deletion -H "Authorization: Bearer $AD" -H "$J" -d '{"reason":"lan hai"}')"
check "6. Quan tri vien tu chap thuan de nghi cua minh" 409 "$(code -X PUT $API/admin/deletion-requests/$RID -H "Authorization: Bearer $AD" -H "$J" -d '{"approve":true}')"
check "7. Quan tri vien thay de nghi dang cho xac nhan" "cho_xac_nhan" "$(curl -s $API/admin/deletion-requests -H "Authorization: Bearer $AD" | jq -r ".[] | select(.id==$RID) | .status")"

echo "########## Chi Lanh dao don vi hoac TCCB xac nhan ##########"
check "8. Truong phong khong thuoc TCCB xem danh sach xac nhan" 403 "$(code $API/deletion-confirmations -H "Authorization: Bearer $HR")"
check "9. Nhan vien xac nhan xoa" 403 "$(code -X PUT $API/deletion-confirmations/$RID -H "Authorization: Bearer $CB" -H "$J" -d '{"approve":true}')"
check "10. Lanh dao don vi nhan thong bao" "true" "$(curl -s $API/thong-bao -H "Authorization: Bearer $QL" | jq "any(.[]; .noi_dung | contains(\"XN$S\"))")"
check "11. Lanh dao don vi thay de nghi" "XN$S" "$(dsxn $QL | jq -r ".[] | select(.id==$RID) | .employee_code")"
check "12. TCCB thay de nghi" "XN$S" "$(dsxn $TC | jq -r ".[] | select(.id==$RID) | .employee_code")"

echo "########## Nguoi bi de nghi khong tu xu ly de nghi cua minh ##########"
R2=$(denghi XL$S "Chuyển công tác"); R2ID=$(echo "$R2" | jq -r .id)
check "13. Lanh dao bi de nghi khong thay de nghi cua chinh minh" "0" "$(dsxn $LD | jq "[.[] | select(.id==$R2ID)] | length")"
check "14. Lanh dao bi de nghi tu xac nhan / tu choi" 409 "$(code -X PUT $API/deletion-confirmations/$R2ID -H "Authorization: Bearer $LD" -H "$J" -d '{"approve":false}')"
check "15. TCCB tu choi de nghi" "tu_choi" "$(xn $R2ID $TC false | jq -r .status)"
check "16. Bi tu choi: tai khoan van dung duoc" 200 "$(code $API/deletion-confirmations -H "Authorization: Bearer $LD")"

echo "########## Xac nhan -> xoa mem, ho so van luu tru ##########"
check "17. Lanh dao don vi xac nhan xoa" "da_xoa" "$(xn $RID $QL true | jq -r .status)"
check "18. Token cu cua tai khoan da xoa" 401 "$(code $API/profiles/me -H "Authorization: Bearer $NV")"
check "19. Ho so van duoc luu tru (so ho so)" "1" "$(sql "SELECT count(*) FROM profiles WHERE user_id=$NVID")"
check "20. Mo khoa tai khoan da xoa" 404 "$(code -X PATCH $API/admin/users/XN$S/active -H "Authorization: Bearer $AD" -H "$J" -d '{"is_active":true}')"
check "21. Xac nhan lai lan nua" 409 "$(code -X PUT $API/deletion-confirmations/$RID -H "Authorization: Bearer $TC" -H "$J" -d '{"approve":true}')"
check "22. Quan tri vien nhan thong bao ket qua" "true" "$(curl -s $API/thong-bao -H "Authorization: Bearer $AD" | jq "any(.[]; .noi_dung | contains(\"#$RID\"))")"
check "23. Nhat ky ghi nguoi de nghi va nguoi xac nhan" "confirm_delete_user request_delete_user" "$(sql "SELECT string_agg(action, ' ' ORDER BY action) FROM audit_logs WHERE target='user:$NVID' AND action IN ('request_delete_user','confirm_delete_user')")"
check "24. Ghi nguoi xac nhan khac nguoi de nghi" "t" "$(sql "SELECT (handled_by <> requested_by)::text FROM deletion_requests WHERE id=$RID")"

echo "########## Can bo tu yeu cau: quan tri vien kiem tra, Lanh dao don vi / TCCB xac nhan ##########"
tuyc() { curl -s $API/account/deletion-request -H "Authorization: Bearer $NV2" -H "$J" -d '{"reason":"Thoi viec"}' | jq -r .id; }
chuyen() { curl -s -X PUT $API/admin/deletion-requests/$1 -H "Authorization: Bearer $AD" -H "$J" -d "{\"approve\":$2}" | jq -r .status; }
T1=$(tuyc)
check "25. Quan tri vien dong y = chuyen di xac nhan, chua xoa" "cho_xac_nhan" "$(chuyen $T1 true)"
check "26. Chua xac nhan: can bo van dang nhap duoc" 200 "$(code $API/profiles/me -H "Authorization: Bearer $NV2")"
check "27. Can bo thay trang thai cho xac nhan" "cho_xac_nhan" "$(curl -s $API/account/deletion-request -H "Authorization: Bearer $NV2" | jq -r .status)"
check "28. Quan tri vien xu ly lai lan nua" 409 "$(code -X PUT $API/admin/deletion-requests/$T1 -H "Authorization: Bearer $AD" -H "$J" -d '{"approve":true}')"
check "29. Lanh dao thay day la yeu cau can bo tu gui" "true" "$(dsxn $QL | jq -r ".[] | select(.id==$T1) | .tu_yeu_cau")"
check "30. TCCB tu choi -> can bo nhan thong bao" "tu_choi true" "$(xn $T1 $TC false | jq -r .status) $(curl -s $API/thong-bao -H "Authorization: Bearer $NV2" | jq "any(.[]; .noi_dung | contains(\"#$T1\"))")"
T2=$(tuyc); chuyen $T2 true > /dev/null
check "31. Gui lai, chuyen, Lanh dao xac nhan -> xoa" "da_xoa" "$(xn $T2 $QL true | jq -r .status)"
check "32. Token cu cua can bo da xoa" 401 "$(code $API/profiles/me -H "Authorization: Bearer $NV2")"
check "33. Quan tri vien tu choi ngay o buoc 1" "tu_choi" "$(curl -s $API/account/deletion-request -H "Authorization: Bearer $CB" -H "$J" -d '{}' > /dev/null; chuyen $(curl -s $API/account/deletion-request -H "Authorization: Bearer $CB" | jq -r .id) false)"
check "34. Bi tu choi o buoc 1: tai khoan van dung duoc" 200 "$(code $API/profiles/me -H "Authorization: Bearer $CB")"

# Khoa cac tai khoan tam sau khi dung xong
for c in XL XT; do curl -s -o /dev/null -X PATCH $API/admin/users/$c$S/active -H "Authorization: Bearer $AD" -H "$J" -d '{"is_active":false}'; done
echo; echo "TONG KET NGAY14: $PASS PASS, $FAIL FAIL"
