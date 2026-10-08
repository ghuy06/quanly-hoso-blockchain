#!/bin/bash
# Ngay 12-13: CCCD la ma ho so, danh muc chuc vu, 15 nhom du lieu, quy trinh bo nhiem/mien nhiem 5 buoc,
# tac vu tu dong khi ky quyet dinh
API=http://localhost:5000/api
PWF=~/hrm/backend/.seed-passwords
J='Content-Type: application/json'
login() { read -r _ email pw < <(grep "^$1 " "$PWF"); curl -s $API/auth/login -H "$J" -d "{\"email\":\"$email\",\"password\":\"$pw\"}" | jq -r .accessToken; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
sql() { docker exec hrm_postgres psql -U hrm_app -d hrm_db -qtAc "$1"; }
web() { docker exec hrm_postgres psql -U hrm_web -d hrm_db -c "$1" 2>&1 | tail -1; }
PASS=0; FAIL=0
check() { if [[ "$3" == *"$2"* ]]; then echo "PASS | $1 | $3"; PASS=$((PASS+1)); else echo "FAIL | $1 | ky vong chua: $2 | thuc te: $3"; FAIL=$((FAIL+1)); fi; }

AD=$(login ADMIN); HR=$(login HR_MANAGER); QL=$(login QUAN_LI); CB=$(login CAN_BO)
S=$(date +%s); PW="Tmp-$(openssl rand -hex 8)"
DEPS=$(curl -s $API/departments -H "Authorization: Bearer $AD")
DEP2=$(echo "$DEPS" | jq '.[1].id'); DEPTC=$(echo "$DEPS" | jq '.[] | select(.name=="Phòng Tổ chức cán bộ") | .id')
mk() { curl -s $API/admin/users -H "Authorization: Bearer $AD" -H "$J" -d "{\"employee_code\":\"$1$S\",\"full_name\":\"Tai khoan thu $1\",\"email\":\"$1$S@hrm.local\",\"password\":\"$PW\",\"role\":\"$2\",\"department_id\":$3}" | jq -r .id; }
tok() { curl -s $API/auth/login -H "$J" -d "{\"email\":\"$1$S@hrm.local\",\"password\":\"$PW\"}" | jq -r .accessToken; }
# Tap the lanh dao = QL01 + 2 lanh dao tam; TC = truong phong To chuc can bo; NV (phong 2) la nguoi duoc de xuat
mk LA QUAN_LI null > /dev/null; mk LB QUAN_LI null > /dev/null; mk TC HR_MANAGER $DEPTC > /dev/null; NVID=$(mk NV CAN_BO $DEP2)
LA=$(tok LA); LB=$(tok LB); TC=$(tok TC); NV=$(tok NV)
CCCD=$(printf '%012d' $((S + 7)))
hoso() { printf '{"date_of_birth":"1990-03-15","gender":"Nữ","phone_number":"0911222333","address":"Hà Nội","ethnicity":"Kinh","hometown":"Hải Dương","education_level":"Cử nhân Luật","start_date":"2018-07-01"%s}' "$1"; }
nhom() { curl -s -X POST $API/profiles/$NVID/nhom/$2 -H "Authorization: Bearer $1" -H "$J" -d "$3"; }

echo "########## Ma ho so = CCCD, chuc vu chon tu danh muc ##########"
check "1. Danh muc chuc vu (Master Data)" "Chuyên viên,Phó Trưởng phòng,Trưởng phòng" "$(curl -s $API/master/chuc-vu -H "Authorization: Bearer $NV" | jq -r '[.[].ten] | join(",")')"
check "2. Khai ho so khong co CCCD (ma ho so)" 400 "$(code -X PUT $API/profiles/me -H "Authorization: Bearer $NV" -H "$J" -d "$(hoso ',"position":"Chuyên viên"')")"
check "3. Chuc vu go tu do, khong co trong danh muc" 400 "$(code -X PUT $API/profiles/me -H "Authorization: Bearer $NV" -H "$J" -d "$(hoso ",\"citizen_id\":\"$CCCD\",\"position\":\"Giam doc tu phong\"")")"
curl -s -o /dev/null -X PUT $API/profiles/me -H "Authorization: Bearer $NV" -H "$J" -d "$(hoso ",\"citizen_id\":\"$CCCD\",\"position\":\"Chuyên viên\"")"
check "4. Khoa chinh bang profiles la ma ho so (tu CCCD)" "citizen_id_hmac" "$(sql "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = 'profiles'::regclass AND i.indisprimary")"
check "5. CSDL khong chua CCCD ban ro" "0" "$(sql "SELECT count(*) FROM profiles WHERE citizen_id = '$CCCD' OR citizen_id_hmac = '$CCCD'")"
check "6. Tu sua chuc vu sau khi da khai" 400 "$(code -X PUT $API/profiles/me -H "Authorization: Bearer $NV" -H "$J" -d "$(hoso ',"position":"Trưởng phòng"')")"

echo "########## 16 nhom du lieu ##########"
check "7. Cau hinh nhom 2-14 (nhom 1 la ho so, 15 la tai lieu)" "13" "$(curl -s $API/master/nhom -H "Authorization: Bearer $NV" | jq 'keys | length')"
check "8. Nhom 2: chuc vu nguoi than go tu do" "danh mục chức vụ" "$(nhom $NV 2 '{"ho_ten":"Trần Văn Bố","cccd":"001060000001","quan_he":"Bố","chuc_vu":"Giam doc"}' | jq -r .error)"
check "9. Nhom 2: chuc vu chon tu danh muc" "2" "$(nhom $NV 2 '{"ho_ten":"Trần Văn Bố","cccd":"001060000001","quan_he":"Bố","chuc_vu":"Trưởng phòng"}' | jq -r .ban_ghi.nhom)"
check "10. Nhom 2 trong CSDL la ban ma" "enc:" "$(sql "SELECT left(du_lieu, 4) FROM ho_so_nhom WHERE user_id = $NVID AND nhom = 2 LIMIT 1")"
check "11. Nhom 15 la quan ly tai lieu, khong ghi nhu ban ghi" "nhóm 15 là tài liệu" "$(nhom $NV 15 '{}' | jq -r .error)"
check "12. Nhan vien tu ghi nhom 8 (luong) cua minh" "trưởng phòng hoặc bộ phận tổ chức" "$(nhom $NV 8 '{"ma_ngach":"01.003","bac":"9","he_so":"9.99"}' | jq -r .error)"
check "13. Nhom 12 tai san: chu ho so ke khai" "12" "$(nhom $NV 12 '{"loai":"Hằng năm","nam":"2026","bien_dong":"Mua nhà 2 tỷ"}' | jq -r .ban_ghi.nhom)"
check "14. Truong phong TCCB khong thay nhom 12" "0" "$(curl -s $API/profiles/$NVID/nhom -H "Authorization: Bearer $TC" | jq '[.[] | select(.nhom == 12)] | length')"
check "15. Lich su phien ban cung khong lo nhom 12" "0" "$(curl -s $API/profiles/$NVID/data-history -H "Authorization: Bearer $TC" | jq '[.[] | select(.field_name | startswith("Tài sản"))] | length')"
check "16. Lanh dao don vi xem duoc nhom 12" "1" "$(curl -s $API/profiles/$NVID/nhom -H "Authorization: Bearer $QL" | jq '[.[] | select(.nhom == 12)] | length')"
check "17. TCCB ghi nhom 8 (luong) cho nhan vien" "8" "$(nhom $TC 8 '{"ngach":"Chuyên viên","ma_ngach":"01.003","bac":"3","he_so":"3.00","ngay_huong":"2024-01-01"}' | jq -r .ban_ghi.nhom)"
check "18. Truong phong phong khac ghi nhom 8" "trong phòng" "$(nhom $HR 8 '{"ngach":"Chuyên viên","ma_ngach":"01.003","bac":"3","he_so":"3.00","ngay_huong":"2024-01-01"}' | jq -r .error)"
B2=$(sql "SELECT id FROM ho_so_nhom WHERE user_id = $NVID AND nhom = 2 LIMIT 1")
check "19. Huy hieu luc khong co ly do" 400 "$(code -X PUT $API/profiles/$NVID/nhom/ban-ghi/$B2/huy -H "Authorization: Bearer $NV" -H "$J" -d '{}')"
curl -s -o /dev/null -X PUT $API/profiles/$NVID/nhom/ban-ghi/$B2/huy -H "Authorization: Bearer $NV" -H "$J" -d '{"ly_do":"Khai nhầm"}'
check "20. Huy hieu luc = giu ban ghi, danh dau ngay huy" "true|Khai nhầm" "$(sql "SELECT (huy_luc IS NOT NULL)::text || '|' || ly_do_huy FROM ho_so_nhom WHERE id = $B2")"

echo "########## Quy trinh bo nhiem: tap the quyet dinh, TCCB chi tham muu ##########"
qt() { curl -s $API/quy-trinh -H "Authorization: Bearer $1" -H "$J" -d "$2"; }
check "21. Nhan vien tao quy trinh" 403 "$(code $API/quy-trinh -H "Authorization: Bearer $CB" -H "$J" -d '{}')"
check "22. Truong phong de xuat can bo phong khac" "trong phòng mình" "$(qt $HR "{\"loai\":\"bo_nhiem\",\"cccd\":\"$CCCD\",\"chuc_vu_moi\":\"Trưởng phòng\",\"ly_do\":\"x\"}" | jq -r .error)"
check "23. Bo nhiem xuong chuc vu khong cao hon" "cao hơn" "$(qt $QL "{\"loai\":\"bo_nhiem\",\"cccd\":\"$CCCD\",\"chuc_vu_moi\":\"Chuyên viên\",\"ly_do\":\"x\"}" | jq -r .error)"
check "24. Dieu dong ve chinh don vi hien tai" "khác đơn vị" "$(qt $QL "{\"loai\":\"dieu_dong\",\"cccd\":\"$CCCD\",\"don_vi_moi\":$DEP2,\"ly_do\":\"x\"}" | jq -r .error)"
R=$(qt $QL "{\"loai\":\"bo_nhiem\",\"cccd\":\"$CCCD\",\"chuc_vu_moi\":\"Trưởng phòng\",\"he_so_moi\":4.4,\"ly_do\":\"Tờ trình xin chủ trương bổ nhiệm trưởng phòng\"}")
QT=$(echo "$R" | jq -r .id)
check "25. Xin chu truong (tra can bo theo CCCD) -> buoc 2" "2" "$(echo "$R" | jq -r .buoc)"
check "26. Tao trung khi dang xu ly" 409 "$(code $API/quy-trinh -H "Authorization: Bearer $QL" -H "$J" -d "{\"loai\":\"bo_nhiem\",\"cccd\":\"$CCCD\",\"chuc_vu_moi\":\"Trưởng phòng\",\"ly_do\":\"x\"}")"
printf '%%PDF-1.4 Quyet dinh bo nhiem QD%s\n' "$S" > /tmp/qd12.pdf
ky() { curl -s $API/quy-trinh/$QT/quyet-dinh -H "Authorization: Bearer $1" -F "so_quyet_dinh=QD$S" -F "ngay_hieu_luc=$(date +%F)" "${@:2}"; }
check "27. Ky quyet dinh khi tap the chua thong qua" "biểu quyết thông qua" "$(ky $QL -F 'file=@/tmp/qd12.pdf;type=application/pdf' | jq -r .error)"
TT=$(curl -s $API/quy-trinh -H "Authorization: Bearer $QL" | jq ".[] | select(.id == $QT) | .phieu.tong")
echo "(tap the lanh dao dang hoat dong: $TT nguoi; kiem thu gia dinh 3 nguoi)"
phieu() { curl -s $API/quy-trinh/$QT/phieu -H "Authorization: Bearer $1" -H "$J" -d "{\"dong_y\":$2}"; }
check "28. TCCB bieu quyet (chi tham muu)" "tập thể lãnh đạo" "$(phieu $TC true | jq -r .error)"
check "29. Lanh dao 1/3 dong y -> chua du, van buoc 2" "2" "$(phieu $QL true | jq -r .buoc)"
check "30. Bo phieu lan 2" "đã bỏ phiếu" "$(phieu $QL false | jq -r .error)"
check "31. Lanh dao 2/3 dong y (> 50%) -> buoc 3 lay y kien" "3" "$(phieu $LA true | jq -r .buoc)"
check "32. Phieu kin: bang phieu khong co cot nguoi bo phieu, thoi gian" "0" "$(sql "SELECT count(*) FROM information_schema.columns WHERE table_name = 'phieu_bau' AND column_name IN ('user_id', 'created_at')")"
phieu $QL true > /dev/null
check "33. Dang bo phieu: chi hien so nguoi da bo, khong hien ket qua" "1|false" "$(curl -s $API/quy-trinh -H "Authorization: Bearer $QL" | jq -r ".[] | select(.id == $QT) | \"\(.phieu.da_bo)|\(.phieu | has(\"dong_y\"))\"")"
check "34. Can bo phong khac bo phieu hoi nghi" "hội nghị" "$(phieu $CB true | jq -r .error)"
check "35. Truong phong khong thuoc TCCB tong hop phieu" 403 "$(code -X PUT $API/quy-trinh/$QT/ket-thuc-hoi-nghi -H "Authorization: Bearer $HR")"
check "36. TCCB tong hop phieu hoi nghi -> buoc 4" "4" "$(curl -s -X PUT $API/quy-trinh/$QT/ket-thuc-hoi-nghi -H "Authorization: Bearer $TC" | jq -r .buoc)"
check "37. Bieu quyet truoc khi TCCB tham dinh" "thẩm định trước" "$(phieu $QL true | jq -r .error)"
check "38. Lanh dao tu tham dinh (viec cua TCCB)" 403 "$(code -X PUT $API/quy-trinh/$QT/tham-dinh -H "Authorization: Bearer $QL" -H "$J" -d '{"dat":true,"nhan_xet":"x"}')"
check "39. TCCB tham dinh" "true" "$(curl -s -X PUT $API/quy-trinh/$QT/tham-dinh -H "Authorization: Bearer $TC" -H "$J" -d '{"dat":true,"nhan_xet":"Đủ tiêu chuẩn, điều kiện"}' | jq -r .tham_dinh_dat)"
check "40. TCCB ky quyet dinh" 403 "$(code $API/quy-trinh/$QT/quyet-dinh -H "Authorization: Bearer $TC" -F so_quyet_dinh=x -F ngay_hieu_luc=2026-01-01)"
phieu $QL true > /dev/null
check "41. Tap the bieu quyet kin thong qua -> buoc 5" "5" "$(phieu $LB true | jq -r .buoc)"
check "42. Nguoi duoc de xuat tu ky" 403 "$(code $API/quy-trinh/$QT/quyet-dinh -H "Authorization: Bearer $NV" -F so_quyet_dinh=x -F ngay_hieu_luc=2026-01-01)"
check "43. Ky khong kem tep quyet dinh" "tệp quyết định" "$(ky $QL | jq -r .error)"
K=$(ky $QL -F 'file=@/tmp/qd12.pdf;type=application/pdf'); SIG=$(echo "$K" | jq -r .chu_ky_so)
check "44. Lanh dao ky quyet dinh -> ban hanh" "da_ban_hanh" "$(echo "$K" | jq -r .trang_thai)"

echo "########## Tac vu tu dong ngay khi ky ##########"
check "45. Ho so: chuc vu hien hanh doi theo quyet dinh" "Trưởng phòng" "$(curl -s $API/profiles/me -H "Authorization: Bearer $NV" | jq -r .position)"
check "46. Nhom 6: chuc vu hien giu, ho so quy trinh" "Trưởng phòng|Quy trình #$QT, QĐ QD$S" "$(curl -s $API/profiles/$NVID/nhom -H "Authorization: Bearer $QL" | jq -r '.[] | select(.nhom == 6) | .du_lieu | "\(.chuc_vu_hien_giu)|\(.ho_so_quy_trinh)"')"
check "47. Nhom 5: them dong qua trinh cong tac" "Trưởng phòng" "$(curl -s $API/profiles/$NVID/nhom -H "Authorization: Bearer $QL" | jq -r '.[] | select(.nhom == 5) | .du_lieu.chuc_vu')"
check "48. Nhom 8: he so luong moi" "4.4" "$(curl -s $API/profiles/$NVID/nhom -H "Authorization: Bearer $QL" | jq -r '[.[] | select(.nhom == 8)] | last | .du_lieu.he_so')"
check "49. Vai tro truy cap doi theo chuc vu moi (RBAC)" "HR_MANAGER" "$(sql "SELECT role FROM users WHERE id = $NVID")"
check "50. Quyen moi co hieu luc ngay, khong can dang nhap lai" 200 "$(code $API/profiles -H "Authorization: Bearer $NV")"
check "51. Lich su: chuc vu co hieu luc, chu ky so = giao dich quyet dinh" "co_hieu_luc|$SIG" "$(sql "SELECT status || '|' || digital_signature FROM employee_data_history WHERE employee_id = $NVID AND field_name = 'position' ORDER BY history_id DESC LIMIT 1")"
check "52. Nhom 15: tep quyet dinh co chu ky so" "$SIG" "$(curl -s $API/profiles/$NVID/documents -H "Authorization: Bearer $QL" | jq -r '.[] | select(.doc_type == "Quyết định tuyển dụng, bổ nhiệm") | .chu_ky_so')"
check "53. Ho so sau quyet dinh van khop blockchain" '"nguyenVen":true' "$(curl -s $API/profiles/$NVID/verify -H "Authorization: Bearer $QL" | jq -c '{nguyenVen}')"
check "54. Tao viec ban giao va tiep nhan" "ban_giao,tiep_nhan" "$(sql "SELECT string_agg(loai, ',' ORDER BY loai) FROM cong_viec WHERE quy_trinh_id = $QT")"
check "55. Xep lenh dong bo CSDL quoc gia (ban ma)" "csdlqg|enc:" "$(sql "SELECT kenh || '|' || left(noi_dung, 4) FROM hang_doi_gui WHERE quy_trinh_id = $QT AND kenh = 'csdlqg'")"
check "56. Xep email cho ca nhan, truong phong, TCCB, IT" "t" "$(sql "SELECT (count(*) >= 3)::text FROM hang_doi_gui WHERE quy_trinh_id = $QT AND kenh = 'email'")"
TB=$(curl -s $API/thong-bao -H "Authorization: Bearer $NV" | jq -r '.[].noi_dung')
check "57. Thong bao cho ca nhan" "QD$S" "$TB"
check "58. Canh bao ho so con thieu nhom bat buoc" "còn thiếu" "$TB"
check "59. Nhat ky ghi toan bo su kien quy trinh" "t" "$(sql "SELECT (count(*) >= 12)::text FROM audit_logs WHERE target LIKE 'quy_trinh:$QT%' AND action LIKE 'qt_%'")"
check "60. Tai khoan web sua phieu bau" "permission denied" "$(web "UPDATE phieu_bau SET dong_y = true WHERE quy_trinh_id = $QT")"

echo "########## Mien nhiem khong duoc thong qua, canh bao qua han ##########"
check "61. Mien nhiem len chuc vu cao hon" "thấp hơn" "$(qt $QL "{\"loai\":\"mien_nhiem\",\"cccd\":\"$CCCD\",\"chuc_vu_moi\":\"Thủ trưởng đơn vị\",\"ly_do\":\"x\"}" | jq -r .error)"
QT=$(qt $QL "{\"loai\":\"mien_nhiem\",\"cccd\":\"$CCCD\",\"chuc_vu_moi\":\"Chuyên viên\",\"ly_do\":\"Kiểm thử miễn nhiệm\"}" | jq -r .id)
sql "UPDATE quy_trinh SET han_xu_ly = now() - interval '1 day' WHERE id = $QT" > /dev/null
check "62. Qua han xu ly -> danh dau qua han" "true" "$(curl -s $API/quy-trinh -H "Authorization: Bearer $QL" | jq -r ".[] | select(.id == $QT) | .qua_han")"
phieu $QL false > /dev/null
check "63. Tap the khong thong qua (2/3 khong dong y)" "khong_thong_qua" "$(phieu $LA false | jq -r .trang_thai)"
check "64. Khong thong qua -> chuc vu giu nguyen" "Trưởng phòng" "$(curl -s $API/profiles/me -H "Authorization: Bearer $NV" | jq -r .position)"

echo "########## Nhom 15: quan ly tai lieu ##########"
printf '%%PDF-1.4 Ban ke khai tai san %s
' "$S" > /tmp/kk12.pdf
curl -s -o /dev/null $API/profiles/me/documents -H "Authorization: Bearer $NV" -F 'doc_type=Bản kê khai tài sản' -F 'ten=Kê khai năm 2026' -F 'so_ky_hieu=KK-01' -F 'muc_do_mat=Mật' -F 'file=@/tmp/kk12.pdf;type=application/pdf'
check "65. Thong tin quan ly tai lieu duoc luu (ten, so ky hieu, muc do mat)" "Kê khai năm 2026|KK-01|Mật|true" "$(curl -s $API/profiles/$NVID/documents -H "Authorization: Bearer $NV" | jq -r '.[] | select(.doc_type == "Bản kê khai tài sản") | "\(.thong_tin.ten)|\(.thong_tin.so_ky_hieu)|\(.thong_tin.muc_do_mat)|\(.xac_thuc)"')"
check "66. TCCB khong thay ban ke khai tai san" "0" "$(curl -s $API/profiles/$NVID/documents -H "Authorization: Bearer $TC" | jq '[.[] | select(.doc_type == "Bản kê khai tài sản")] | length')"
check "67. Truong thong tin sai kieu bi tu choi" "ngày dạng" "$(curl -s $API/profiles/me/documents -H "Authorization: Bearer $NV" -F 'doc_type=Khác' -F 'ngay_ban_hanh=hom qua' -F 'file=@/tmp/kk12.pdf;type=application/pdf' | jq -r .error)"

# Khoa cac tai khoan tam sau khi dung xong
for c in LA LB TC NV; do curl -s -o /dev/null -X PATCH $API/admin/users/$c$S/active -H "Authorization: Bearer $AD" -H "$J" -d '{"is_active":false}'; done
echo; echo "TONG KET NGAY12: $PASS PASS, $FAIL FAIL"
