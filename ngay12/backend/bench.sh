#!/bin/bash
# Do hieu nang va kha nang phat hien sua trai phep: CO blockchain (CHAIN_MODE=on) va KHONG (CHAIN_MODE=off).
# Cong cu: ApacheBench (ab) - cong cu do tai HTTP chuan cua Apache. Chi so theo nhom "Hieu suat" cua ISO/IEC 25010
# (thoi gian phan hoi, thong luong, tai nguyen) va dinh nghia do tre/thong luong cua Hyperledger Performance & Scale WG.
# Chay: bash bench.sh | tee bien-ban/bench-$(curl -s localhost:5000/ | jq -r .blockchain).log
API=http://localhost:5000/api
PWF=~/hrm/backend/.seed-passwords
J='Content-Type: application/json'
login() { read -r _ email pw < <(grep "^$1 " "$PWF"); curl -s $API/auth/login -H "$J" -d "{\"email\":\"$email\",\"password\":\"$pw\"}" | jq -r .accessToken; }
sql() { docker exec hrm_postgres psql -U hrm_app -d hrm_db -qtAc "$1"; }
summ() { grep -E "Complete requests|Failed requests|Non-2xx|Requests per second|Time per request:.*\(mean\)$|^ +(50|95|99|100)%"; }
command -v ab > /dev/null || { echo "Thieu ab. Cai: sudo apt install -y apache2-utils"; exit 1; }

MODE=$(curl -s http://localhost:5000/ | jq -r .blockchain)
echo "===== CHE DO: blockchain=$MODE | $(date '+%F %T') | $(nproc) CPU, $(free -m | awk '/Mem/{print $2}') MB RAM ====="
AD=$(login ADMIN); HR=$(login HR_MANAGER)
S=$(date +%s); PW="Bench-$(openssl rand -hex 8)"
DEP1=$(curl -s $API/departments -H "Authorization: Bearer $AD" | jq '.[0].id')
BID=$(curl -s $API/admin/users -H "Authorization: Bearer $AD" -H "$J" -d "{\"employee_code\":\"BE$S\",\"full_name\":\"Tai khoan do hieu nang\",\"email\":\"be$S@hrm.local\",\"password\":\"$PW\",\"role\":\"CAN_BO\",\"department_id\":$DEP1}" | jq -r .id)
BT=$(curl -s $API/auth/login -H "$J" -d "{\"email\":\"be$S@hrm.local\",\"password\":\"$PW\"}" | jq -r .accessToken)
printf '{"date_of_birth":"1990-01-01","gender":"Nam","phone_number":"0900000000","address":"Ha Noi","position":"Chuyên viên","citizen_id":"%012d","ethnicity":"Kinh","hometown":"Ha Noi","education_level":"Ky su","start_date":"2020-01-01"}' $S > /tmp/bench-body.json
AUTH="Authorization: Bearer $BT"

# So cai (ledger) cua kenh hosochannel tren peer: do dung luong tang them
LDIR=$(dirname "$(sudo find / -path '*hosochannel*' -name 'blockfile_*' 2>/dev/null | head -1)")
ledger() { [ -d "$LDIR" ] && sudo du -sb "$LDIR" | cut -f1 || echo 0; }

echo; echo "== 1) GHI ho so (PUT /profiles/me): 50 lan tuan tu =="
L0=$(ledger)
ab -q -n 50 -c 1 -u /tmp/bench-body.json -T application/json -H "$AUTH" $API/profiles/me | summ
L1=$(ledger)
echo "So cai tang them: $((L1 - L0)) byte cho 50 lan ghi (~$(((L1 - L0) / 50)) byte/giao dich)"

echo; echo "== 2) GHI DONG THOI cung 1 ho so: 20 lan, 5 song song (xung dot MVCC cua Fabric) =="
ab -q -n 20 -c 5 -u /tmp/bench-body.json -T application/json -H "$AUTH" $API/profiles/me | summ

echo; echo "== 3) DOC ho so (GET /profiles/me): 1000 lan, 20 song song =="
ab -q -n 1000 -c 20 -H "$AUTH" $API/profiles/me | summ

echo; echo "== 4) XAC THUC toan ven (GET /profiles/$BID/verify): 200 lan, 10 song song =="
ab -q -n 200 -c 10 -H "Authorization: Bearer $HR" $API/profiles/$BID/verify | summ

echo; echo "== 5) Dung luong CSDL =="
echo "1 ho so trong CSDL: $(sql "SELECT pg_column_size(p.*) FROM profiles p WHERE user_id=$BID") byte"

echo; echo "== 6) Tai nguyen RAM cua thanh phan blockchain (peer + orderer + chaincode) =="
ps -C peer,orderer -o rss= | awk '{s+=$1} END {printf "peer + 3 orderer: %.0f MB\n", s/1024}'
docker stats --no-stream --format '{{.Name}}: {{.MemUsage}}' hosocc hrm_postgres 2>/dev/null

echo; echo "== 7) Phat hien sua trai phep: doi que quan truc tiep trong CSDL =="
sql "UPDATE profiles SET hometown='Gia mao' WHERE user_id=$BID"
curl -s $API/profiles/$BID/verify -H "Authorization: Bearer $HR" | jq -c '{nguyenVen, coBanGhiDoiChieu: (.blockchain != null)}'
sql "UPDATE profiles SET hometown='Ha Noi' WHERE user_id=$BID"

curl -s -o /dev/null -X PATCH $API/admin/users/BE$S/active -H "Authorization: Bearer $AD" -H "$J" -d '{"is_active":false}'
echo; echo "===== XONG che do blockchain=$MODE ====="
