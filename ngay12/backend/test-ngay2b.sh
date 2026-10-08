#!/bin/bash
API=http://localhost:5000/api
PWF=~/hrm/backend/.seed-passwords
login() { read -r _ email pw < <(grep "^$1 " "$PWF"); curl -s $API/auth/login -H 'Content-Type: application/json' -d "{\"email\":\"$email\",\"password\":\"$pw\"}" | jq -r .accessToken; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
t() { echo; echo "=== $1"; echo "    KY VONG: $2"; echo -n "    THUC TE: "; }
sql() { docker exec hrm_postgres psql -U hrm_app -d hrm_db -qtAc "$1"; }
J='Content-Type: application/json'
HOSO='{"date_of_birth":"1995-05-20","gender":"Nam","phone_number":"0900000000","address":"Hà Nội","department":"Phòng ATTT","position":"Chuyên viên"}'

CB=$(login CAN_BO); HR=$(login HR_MANAGER); QL=$(login QUAN_LI)
CBID=$(curl -s $API/profiles/me -H "Authorization: Bearer $CB" | jq -r .user_id)
HRID=$(curl -s $API/profiles/me -H "Authorization: Bearer $HR" | jq -r .user_id)
verify() { curl -s $API/profiles/$CBID/verify -H "Authorization: Bearer $1" | jq -c '{nguyenVen, trangThaiKhop, trenChain: .blockchain.trangThai, phienBan: .blockchain.phienBan}'; }

t "1. CAN_BO cap nhat ho so -> ghi van tay len blockchain" "status cho_duyet, co transactionId va blockNumber"
curl -s -X PUT $API/profiles/me -H "Authorization: Bearer $CB" -H "$J" -d "$HOSO" | jq -c '{status: .profile.status, blockchain}'

t "2. CAN_BO xac thuc ho so cua minh" "nguyenVen true, trangThaiKhop true, trenChain cho_duyet"
verify $CB

t "3. TAN CONG: sua thang DB, tu dat da_duyet (bo qua HR)" "nguyenVen true, trangThaiKhop FALSE"
sql "UPDATE profiles SET status='da_duyet' WHERE user_id=$CBID"; verify $HR
sql "UPDATE profiles SET status='cho_duyet' WHERE user_id=$CBID"

t "4. TAN CONG: sua thang DB, doi chuc vu thanh Thu truong don vi" "nguyenVen FALSE"
sql "UPDATE profiles SET position='Thủ trưởng đơn vị' WHERE user_id=$CBID"; verify $HR

t "5. Khoi phuc du lieu goc, xac thuc lai" "nguyenVen true, trangThaiKhop true"
sql "UPDATE profiles SET position='Chuyên viên' WHERE user_id=$CBID"; verify $HR

t "6. HR duyet ho so -> ghi len blockchain" "status da_duyet, co transactionId"
curl -s -X PUT $API/profiles/$CBID/review -H "Authorization: Bearer $HR" -H "$J" -d '{"status":"da_duyet"}' | jq -c .

t "7. QUAN_LI xac thuc sau khi duyet" "nguyenVen true, trangThaiKhop true, trenChain da_duyet"
verify $QL

t "8. QUAN_LI xem lich su tren blockchain" "cac phien ban, moi nhat truoc"
echo; curl -s $API/profiles/$CBID/history -H "Authorization: Bearer $QL" | jq -r '.[] | "      v\(.giaTri.phienBan) \(.giaTri.trangThai) boi \(.giaTri.nguoiThucHien) (\(.giaTri.vaiTro)) luc \(.giaTri.thoiGian)"' | head -6

t "9. CAN_BO xac thuc ho so nguoi khac" "403"
code $API/profiles/$HRID/verify -H "Authorization: Bearer $CB"; echo

t "10. HR tu duyet ho so cua chinh minh" "403"
code -X PUT $API/profiles/$HRID/review -H "Authorization: Bearer $HR" -H "$J" -d '{"status":"da_duyet"}'; echo

t "11. QUAN_LI tu khai ho so" "403"
code -X PUT $API/profiles/me -H "Authorization: Bearer $QL" -H "$J" -d '{}'; echo

# Tu ngay 12 chuc vu chi doi theo quyet dinh, nen thu bang doi so dien thoai
t "12. Blockchain gap su co -> DB KHONG bi ghi" "502 | so dien thoai van la 0900000000"
docker stop hosocc >/dev/null
code -X PUT $API/profiles/me -H "Authorization: Bearer $CB" -H "$J" -d "${HOSO/0900000000/0999999999}"
echo -n " | so dien thoai trong DB: "; curl -s $API/profiles/me -H "Authorization: Bearer $CB" | jq -r .phone_number
docker start hosocc >/dev/null
