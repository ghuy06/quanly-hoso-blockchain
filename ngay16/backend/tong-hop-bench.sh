#!/bin/bash
# Gộp 2 biên bản bench.sh (có / không blockchain) thành bảng so sánh Markdown, dán thẳng vào báo cáo.
# Chạy: bash tong-hop-bench.sh bien-ban/bench-on.log bien-ban/bench-off.log
ON=${1:-bien-ban/bench-on.log}; OFF=${2:-bien-ban/bench-off.log}
for f in "$ON" "$OFF"; do [ -f "$f" ] || { echo "Không thấy $f"; exit 1; }; done

# Mỗi dòng "khóa=giá trị"; số sau khóa là số thứ tự kịch bản trong bench.sh (1 ghi, 2 ghi đồng thời, 3 đọc, 4 xác thực)
parse() {
    awk '
    /^== [0-9]\)/              { s = substr($2, 1, 1) }
    /Complete requests/        { v["n" s] = $3 }
    /Non-2xx responses/        { v["loi" s] = $3 }
    /Requests per second/      { v["rps" s] = $4 }
    /Time per request:.*\(mean\)$/ { v["tb" s] = $4 }
    /^ *50%/                   { v["p50" s] = $2 }
    /^ *95%/                   { v["p95" s] = $2 }
    /^ *99%/                   { v["p99" s] = $2 }
    /So cai tang them/         { v["socai"] = $5; if (match($0, /~[0-9]+/)) v["socaitx"] = substr($0, RSTART + 1, RLENGTH - 1) }
    /1 ho so trong CSDL/       { v["dong"] = $6 }
    /peer \+ 3 orderer/        { v["ram"] = $(NF - 1) }
    /^hosocc:/                 { v["cc"] = $2 }
    /^hrm_postgres:/           { v["pg"] = $2 }
    s == 7 && /nguyenVen/      { v["phathien"] = ($0 ~ /"nguyenVen":false/) ? "Có" : "Không" }
    END { for (k in v) print k "=" v[k] }' "$1"
}
declare -A A B
while IFS='=' read -r k v; do A[$k]=$v; done < <(parse "$ON")
while IFS='=' read -r k v; do B[$k]=$v; done < <(parse "$OFF")
g() { local -n M=$1; echo "${M[$2]:-–}"; }
pp() { local -n M=$1; echo "${M[p50$2]:-–} / ${M[p95$2]:-–} / ${M[p99$2]:-–}"; }
row() { printf '| %s | %s | %s |\n' "$1" "$2" "$3"; }

echo "| Chỉ số | Có blockchain | Không blockchain |"
echo "| --- | --- | --- |"
row "Ghi tuần tự 50 lần: độ trễ trung bình (ms)" "$(g A tb1)" "$(g B tb1)"
row "Ghi tuần tự: p50 / p95 / p99 (ms)" "$(pp A 1)" "$(pp B 1)"
row "Ghi tuần tự: thông lượng (yêu cầu/giây)" "$(g A rps1)" "$(g B rps1)"
row "Ghi đồng thời (20 lần, 5 song song): trung bình (ms)" "$(g A tb2)" "$(g B tb2)"
row "Ghi đồng thời: p50 / p95 / p99 (ms)" "$(pp A 2)" "$(pp B 2)"
row "Ghi đồng thời: số yêu cầu lỗi (Non-2xx)" "${A[loi2]:-0}" "${B[loi2]:-0}"
row "Đọc (1000 lần, 20 song song): trung bình (ms)" "$(g A tb3)" "$(g B tb3)"
row "Đọc: p50 / p95 / p99 (ms)" "$(pp A 3)" "$(pp B 3)"
row "Đọc: thông lượng (yêu cầu/giây)" "$(g A rps3)" "$(g B rps3)"
row "Xác thực toàn vẹn (200 lần, 10 song song): trung bình (ms)" "$(g A tb4)" "không áp dụng"
row "Xác thực: thông lượng (yêu cầu/giây)" "$(g A rps4)" "không áp dụng"
row "Xác thực: số yêu cầu lỗi (Non-2xx, phải bằng 0)" "${A[loi4]:-0}" "không áp dụng"
row "Sổ cái tăng cho 50 lần ghi (byte)" "$(g A socai)" "$(g B socai)"
row "Sổ cái tăng mỗi giao dịch (byte)" "$(g A socaitx)" "$(g B socaitx)"
row "Một hồ sơ trong CSDL (byte)" "$(g A dong)" "$(g B dong)"
row "RAM peer + 3 orderer (MB)" "$(g A ram)" "không dùng"
row "RAM chaincode / PostgreSQL" "$(g A cc) / $(g A pg)" "– / $(g B pg)"
row "Phát hiện sửa quê quán trực tiếp trong CSDL" "$(g A phathien)" "$(g B phathien)"
echo
echo "Ghi chú: ab chạy với -l (chấp nhận câu trả lời dài ngắn khác nhau giữa các lượt), lỗi thật là Non-2xx."
echo "Ở chế độ không blockchain, API xác thực trả lỗi vì không có gì để đối chiếu."
