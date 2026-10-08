#!/bin/bash
# Ngay 11: lich su phien ban (khong sua de), nguoi duyet, chu ky so sau phe duyet
API=http://localhost:5000/api
PWF=~/hrm/backend/.seed-passwords
J='Content-Type: application/json'
login() { read -r _ email pw < <(grep "^$1 " "$PWF"); curl -s $API/auth/login -H "$J" -d "{\"email\":\"$email\",\"password\":\"$pw\"}" | jq -r .accessToken; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
sql() { docker exec hrm_postgres psql -U hrm_app -d hrm_db -qtAc "$1"; }
web() { docker exec hrm_postgres psql -U hrm_web -d hrm_db -c "$1" 2>&1 | tail -1; }
PASS=0; FAIL=0
check() { if [[ "$3" == *"$2"* ]]; then echo "PASS | $1 | $3"; PASS=$((PASS+1)); else echo "FAIL | $1 | ky vong chua: $2 | thuc te: $3"; FAIL=$((FAIL+1)); fi; }

CB=$(login CAN_BO); HR=$(login HR_MANAGER)
CBID=$(curl -s $API/profiles/me -H "Authorization: Bearer $CB" | jq -r .user_id)
HRID=$(curl -s $API/profiles/me -H "Authorization: Bearer $HR" | jq -r .user_id)
HRCODE=$(curl -s $API/profiles/me -H "Authorization: Bearer $HR" | jq -r .employee_code)
S=$(date +%s)
last() { sql "SELECT $2 FROM employee_data_history WHERE employee_id=$CBID AND field_name='$1' ORDER BY history_id DESC LIMIT 1"; }
# Tu ngay 12 chuc vu chi doi theo quyet dinh, nen lich su duoc thu tren truong trinh do chuyen mon
body() { printf '{"date_of_birth":"1995-05-20","gender":"Nam","phone_number":"%s","address":"Hà Nội","position":"%s","citizen_id":"001095012345","ethnicity":"Kinh","hometown":"Nam Định","education_level":"%s","start_date":"2020-09-01"%s}' "$1" "${POS:-Chuyên viên}" "$2" "$3"; }

echo "########## Can cu va lich su khi thay doi ##########"
printf '%%PDF-1.4 Bang thac si %s\n' "$S" > /tmp/qd11.pdf
DOC=$(curl -s $API/profiles/me/documents -H "Authorization: Bearer $CB" -F 'doc_type=Bằng cấp, chứng chỉ' -F 'file=@/tmp/qd11.pdf;type=application/pdf' | jq -r .document.id)
check "1. Tai bang cap -> ghi lich su bo sung giay to" "bo_sung" "$(sql "SELECT change_type FROM employee_data_history WHERE legal_document_id=$DOC AND field_group='giay_to'")"
check "2. Can cu khong thuoc ho so cua minh" 400 "$(code -X PUT $API/profiles/me -H "Authorization: Bearer $CB" -H "$J" -d "$(body 0900000011 "Thac si CNTT $S" ',"legal_document_id":999999')")"
check "3. Tu sua chuc vu (chi doi theo quyet dinh)" 400 "$(code -X PUT $API/profiles/me -H "Authorization: Bearer $CB" -H "$J" -d "$(POS="Trưởng phòng" body 0900000011 "Kỹ sư CNTT")")"
V=$(curl -s -X PUT $API/profiles/me -H "Authorization: Bearer $CB" -H "$J" -d "$(body 0900000011 "Thac si CNTT $S" ",\"change_reason\":\"Bo sung bang thac si\",\"legal_document_id\":$DOC")" | jq -r .version)
check "4. Doi trinh do tao phien ban moi" "$V" "$(last education_level version_no)"
check "5. Luu ca gia tri cu va moi" "Kỹ sư CNTT > Thac si CNTT $S" "$(last education_level "coalesce(old_value,'')||' > '||new_value")"
check "6. Ghi ly do va can cu" "Bo sung bang thac si|$DOC" "$(last education_level "reason||'|'||legal_document_id")"
check "7. Phien ban moi dang cho duyet" "cho_duyet" "$(last education_level status)"
check "8. So dien thoai trong lich su la ban ma" "enc:" "$(last phone_number "left(new_value,4)")"

echo "########## Nguoi duyet va chu ky so ##########"
check "9. Truong phong duyet, tra ve nguoi duyet" "$HRCODE" "$(curl -s -X PUT $API/profiles/$CBID/review -H "Authorization: Bearer $HR" -H "$J" -d '{"status":"da_duyet"}' | jq -r .approvedBy)"
check "10. Phien ban co hieu luc, ghi nguoi duyet" "co_hieu_luc|$HRID" "$(last education_level "status||'|'||approved_by")"
check "11. Co ma giao dich ky so (do dai > 20)" "t" "$(last education_level "(length(digital_signature) > 20)::text")"
check "12. Chi 1 gia tri trinh do dang hieu luc" "1" "$(sql "SELECT count(*) FROM employee_data_history WHERE employee_id=$CBID AND field_name='education_level' AND status='co_hieu_luc'")"
check "13. Ho so hien nguoi duyet" "$HRCODE" "$(curl -s $API/profiles/me -H "Authorization: Bearer $CB" | jq -r .reviewed_by_code)"
check "14. Lich su qua API nguyen ven" "true" "$(curl -s $API/profiles/$CBID/data-history -H "Authorization: Bearer $HR" | jq -r '.[0].hashOk')"

echo "########## Tan cong vao lich su ##########"
check "15. Tai khoan web sua gia tri lich su" "permission denied" "$(web "UPDATE employee_data_history SET new_value='Giam doc' WHERE employee_id=$CBID")"
check "16. Tai khoan web xoa lich su" "permission denied" "$(web "DELETE FROM employee_data_history WHERE employee_id=$CBID")"
HID=$(last education_level history_id); OLD=$(last education_level new_value)
sql "UPDATE employee_data_history SET new_value='Tien si' WHERE history_id=$HID"
check "17. TAN CONG: chu CSDL sua lich su -> phat hien" "false" "$(curl -s $API/profiles/$CBID/data-history -H "Authorization: Bearer $HR" | jq -r ".[] | select(.history_id==$HID) | .hashOk")"
sql "UPDATE employee_data_history SET new_value='$OLD' WHERE history_id=$HID"
check "18. Nhan vien xem lich su nguoi khac" 403 "$(code $API/profiles/$HRID/data-history -H "Authorization: Bearer $CB")"

echo "########## Khoi phuc ve gia tri cu = mot phien ban moi, khong xoa lich su ##########"
N0=$(sql "SELECT count(*) FROM employee_data_history WHERE employee_id=$CBID")
curl -s -o /dev/null -X PUT $API/profiles/me -H "Authorization: Bearer $CB" -H "$J" -d "$(body 0900000000 "Kỹ sư CNTT" ',"change_reason":"Khoi phuc sau kiem thu"')"
check "19. Khoi phuc them dong, khong xoa dong cu" "t" "$(sql "SELECT (count(*) > $N0)::text FROM employee_data_history WHERE employee_id=$CBID")"
check "20. Duyet ban khoi phuc" "da_duyet" "$(curl -s -X PUT $API/profiles/$CBID/review -H "Authorization: Bearer $HR" -H "$J" -d '{"status":"da_duyet"}' | jq -r .status)"
check "21. Phien ban truoc chuyen sang bi thay the" "bi_thay_the" "$(sql "SELECT status FROM employee_data_history WHERE history_id=$HID")"

echo; echo "TONG KET NGAY11: $PASS PASS, $FAIL FAIL"
