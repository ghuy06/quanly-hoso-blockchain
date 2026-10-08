#!/bin/bash
# Ngay 10: phong ban, ma hoa du lieu, quet ma doc, yeu cau xoa tai khoan, bo loc truy cap hang loat
API=http://localhost:5000/api
PWF=~/hrm/backend/.seed-passwords
UP=~/hrm/backend/uploads
J='Content-Type: application/json'
login() { read -r _ email pw < <(grep "^$1 " "$PWF"); curl -s $API/auth/login -H "$J" -d "{\"email\":\"$email\",\"password\":\"$pw\"}" | jq -r .accessToken; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
sql() { docker exec hrm_postgres psql -U hrm_app -d hrm_db -qtAc "$1"; }
PASS=0; FAIL=0
check() { if [[ "$3" == *"$2"* ]]; then echo "PASS | $1 | $3"; PASS=$((PASS+1)); else echo "FAIL | $1 | ky vong chua: $2 | thuc te: $3"; FAIL=$((FAIL+1)); fi; }

AD=$(login ADMIN); HR=$(login HR_MANAGER); QL=$(login QUAN_LI); CB=$(login CAN_BO)
S=$(date +%s); PW="Tmp-$(openssl rand -hex 8)"
DEP1=$(curl -s $API/departments -H "Authorization: Bearer $AD" | jq '.[0].id')
DEP2=$(curl -s $API/departments -H "Authorization: Bearer $AD" | jq '.[1].id')
DEP2NAME=$(curl -s $API/departments -H "Authorization: Bearer $AD" | jq -r '.[1].name')
# Tao tai khoan tam (ma va email duy nhat moi lan chay), in ra id
mk() { curl -s $API/admin/users -H "Authorization: Bearer $AD" -H "$J" -d "{\"employee_code\":\"$1$S\",\"full_name\":\"Tai khoan thu $1\",\"email\":\"$1$S@hrm.local\",\"password\":\"$PW\",\"role\":\"$2\",\"department_id\":$3}" | jq -r .id; }
tok() { curl -s $API/auth/login -H "$J" -d "{\"email\":\"$1$S@hrm.local\",\"password\":\"$PW\"}" | jq -r .accessToken; }
HR2ID=$(mk TP HR_MANAGER $DEP2); NV3ID=$(mk NV CAN_BO $DEP2); QL2ID=$(mk LD QUAN_LI null); NV4ID=$(mk RL CAN_BO $DEP1)
HR2=$(tok TP); NV3=$(tok NV); QL2=$(tok LD); NV4=$(tok RL)

echo "########## Phong ban: truong phong chi quan ly nhan vien cung phong ##########"
check "1. He thong dang chay CO blockchain" '"on"' "$(curl -s http://localhost:5000/ | jq -c .blockchain)"
check "2. Tao nhan vien thieu phong ban" 400 "$(code $API/admin/users -H "Authorization: Bearer $AD" -H "$J" -d "{\"employee_code\":\"X$S\",\"full_name\":\"x\",\"email\":\"x$S@hrm.local\",\"password\":\"$PW\",\"role\":\"CAN_BO\"}")"
CCCD=$(printf '%012d' $S)
curl -s -o /dev/null -X PUT $API/profiles/me -H "Authorization: Bearer $NV3" -H "$J" -d "{\"department\":\"Phong tu khai gia\",\"position\":\"Chuyên viên\",\"phone_number\":\"0912345678\",\"address\":\"Ha Noi\",\"citizen_id\":\"$CCCD\"}"
check "3. Phong ban lay theo phan cong, khong theo tu khai" "$DEP2NAME" "$(curl -s $API/profiles/me -H "Authorization: Bearer $NV3" | jq -r .department)"
check "4. Truong phong phong 1 KHONG thay nhan vien phong 2" "0" "$(curl -s $API/profiles -H "Authorization: Bearer $HR" | jq "[.[] | select(.user_id==$NV3ID)] | length")"
check "5. Truong phong phong 1 mo giay to nhan vien phong 2" 403 "$(code $API/profiles/$NV3ID/documents -H "Authorization: Bearer $HR")"
check "6. Truong phong phong 1 duyet ho so nhan vien phong 2" 403 "$(code -X PUT $API/profiles/$NV3ID/review -H "Authorization: Bearer $HR" -H "$J" -d '{"status":"da_duyet"}')"
check "7. Truong phong phong 2 thay nhan vien phong minh" "1" "$(curl -s $API/profiles -H "Authorization: Bearer $HR2" | jq "[.[] | select(.user_id==$NV3ID)] | length")"
check "8. Lanh dao don vi thay moi phong" "1" "$(curl -s $API/profiles -H "Authorization: Bearer $QL" | jq "[.[] | select(.user_id==$NV3ID)] | length")"

echo "########## Ma hoa du lieu khi luu ##########"
check "9. CCCD trong CSDL la ban ma" "enc:" "$(sql "SELECT left(citizen_id, 4) FROM profiles WHERE user_id=$NV3ID")"
check "10. So dien thoai trong CSDL la ban ma" "enc:" "$(sql "SELECT left(phone_number, 4) FROM profiles WHERE user_id=$NV3ID")"
check "11. Qua API chu ho so van thay ban ro" "$CCCD" "$(curl -s $API/profiles/me -H "Authorization: Bearer $NV3" | jq -r .citizen_id)"
check "12. Ma hoa khong lam lech van tay tren chain" '"nguyenVen":true' "$(curl -s $API/profiles/$NV3ID/verify -H "Authorization: Bearer $HR2" | jq -c '{nguyenVen}')"
OLD=$(sql "SELECT phone_number FROM profiles WHERE user_id=$NV3ID")
sql "UPDATE profiles SET phone_number='enc:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE user_id=$NV3ID"
check "13. TAN CONG: sua ban ma trong CSDL -> phat hien" '"nguyenVen":false' "$(curl -s $API/profiles/$NV3ID/verify -H "Authorization: Bearer $HR2" | jq -c '{nguyenVen}')"
sql "UPDATE profiles SET phone_number='$OLD' WHERE user_id=$NV3ID"
check "14. Trung so CCCD (so sanh bang HMAC)" 400 "$(code -X PUT $API/profiles/me -H "Authorization: Bearer $NV4" -H "$J" -d "{\"citizen_id\":\"$CCCD\"}")"

printf '%%PDF-1.4 Giay khai sinh BAN RO\n' > /tmp/ks10.pdf
DOC=$(curl -s $API/profiles/me/documents -H "Authorization: Bearer $NV3" -F 'doc_type=Giấy khai sinh' -F 'file=@/tmp/ks10.pdf;type=application/pdf' | jq -r .document.id)
FILE=$UP/$(sql "SELECT file_path FROM profile_documents WHERE id=$DOC")
check "15. Tep tren o dia co dau HRMENC1 (da ma hoa)" "HRMENC1" "$(head -c 7 "$FILE")"
check "16. Tep tren o dia KHONG chua noi dung ro (so dong)" "0" "$(grep -ac 'BAN RO' "$FILE")"
check "17. Tai ve qua API ra dung tep goc" "$(sha256sum < /tmp/ks10.pdf)" "$(curl -s $API/profiles/$NV3ID/documents/$DOC -H "Authorization: Bearer $HR2" | sha256sum)"

echo "########## Quet ma doc ##########"
printf '%s' 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > /tmp/eicar.pdf
check "18. Tep thu EICAR (ClamAV)" "mã độc" "$(curl -s $API/profiles/me/documents -H "Authorization: Bearer $NV3" -F 'doc_type=Khác' -F 'file=@/tmp/eicar.pdf;type=application/pdf' | jq -r .error)"
printf '%%PDF-1.4\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\n' > /tmp/js.pdf
check "19. PDF chua JavaScript" "/JavaScript" "$(curl -s $API/profiles/me/documents -H "Authorization: Bearer $NV3" -F 'doc_type=Khác' -F 'file=@/tmp/js.pdf;type=application/pdf' | jq -r .error)"
check "20. Tep bi tu choi khong duoc luu (so giay to cua NV)" "1" "$(sql "SELECT count(*) FROM profile_documents WHERE user_id=$NV3ID")"

echo "########## Yeu cau xoa tai khoan ##########"
check "21. Nhan vien gui yeu cau xoa" 201 "$(code $API/account/deletion-request -H "Authorization: Bearer $NV3" -H "$J" -d '{"reason":"Nghi viec"}')"
check "22. Gui trung khi dang cho" 409 "$(code $API/account/deletion-request -H "Authorization: Bearer $NV3" -H "$J" -d '{}')"
check "23. Nhan vien tu xem danh sach yeu cau (chi quan tri)" 403 "$(code $API/admin/deletion-requests -H "Authorization: Bearer $NV3")"
RID=$(curl -s $API/admin/deletion-requests -H "Authorization: Bearer $AD" | jq -r ".[] | select(.employee_code==\"NV$S\") | .id")
check "24. Quan tri vien thay yeu cau" "NV$S" "$(curl -s $API/admin/deletion-requests -H "Authorization: Bearer $AD" | jq -r '.[].employee_code' | tr '\n' ' ')"
check "25. Quan tri vien chuyen, Lanh dao don vi xac nhan xoa" "cho_xac_nhan da_xoa" "$(curl -s -X PUT $API/admin/deletion-requests/$RID -H "Authorization: Bearer $AD" -H "$J" -d '{"approve":true}' | jq -r .status) $(curl -s -X PUT $API/deletion-confirmations/$RID -H "Authorization: Bearer $QL" -H "$J" -d '{"approve":true}' | jq -r .status)"
check "26. Token cu cua tai khoan da xoa" 401 "$(code $API/profiles/me -H "Authorization: Bearer $NV3")"
check "27. Dang nhap lai" "đã bị xóa" "$(curl -s $API/auth/login -H "$J" -d "{\"email\":\"NV$S@hrm.local\",\"password\":\"$PW\"}" | jq -r .error)"
check "28. Mo khoa tai khoan da xoa" 404 "$(code -X PATCH $API/admin/users/NV$S/active -H "Authorization: Bearer $AD" -H "$J" -d '{"is_active":true}')"
check "29. Ho so van duoc luu tru (so ho so)" "1" "$(sql "SELECT count(*) FROM profiles WHERE user_id=$NV3ID")"

echo "########## Bo loc truy cap: tai khoan bi chiem truy van don dap ##########"
for i in $(seq 1 130); do LAST=$(code $API/profiles/me -H "Authorization: Bearer $NV4"); done
check "30. 130 yeu cau/phut tu 1 tai khoan -> bi chan" 429 "$LAST"
check "31. Tai khoan khac cung IP khong bi anh huong" 200 "$(code $API/profiles/me -H "Authorization: Bearer $CB")"
for i in $(seq 1 70); do LAST=$(code $API/profiles -H "Authorization: Bearer $QL2"); [ "$LAST" = 423 ] && break; done
check "32. Xem danh sach ho so lien tuc -> tu khoa tai khoan" 423 "$LAST"
check "33. Tai khoan da bi khoa ngay" 401 "$(code $API/profiles -H "Authorization: Bearer $QL2")"
check "34. Nhat ky ghi su kien tu khoa" "auto_lock_bulk_read" "$(curl -s $API/admin/audit-logs -H "Authorization: Bearer $AD" | jq -r ".[] | select(.target==\"user:$QL2ID\") | .action" | tr '\n' ' ')"
check "35. Quan tri vien mo khoa lai" 200 "$(code -X PATCH $API/admin/users/LD$S/active -H "Authorization: Bearer $AD" -H "$J" -d '{"is_active":true}')"

# Khoa cac tai khoan tam sau khi dung xong
for c in TP LD RL; do curl -s -o /dev/null -X PATCH $API/admin/users/$c$S/active -H "Authorization: Bearer $AD" -H "$J" -d '{"is_active":false}'; done
echo; echo "TONG KET NGAY10: $PASS PASS, $FAIL FAIL"
