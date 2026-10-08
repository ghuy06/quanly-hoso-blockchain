#!/bin/bash
# Đo lại hiệu năng bằng MỘT lệnh: tự chạy backend ở chế độ CÓ blockchain rồi KHÔNG blockchain,
# mỗi chế độ chạy bench.sh, sau đó tổng hợp bảng so sánh và trả backend về chế độ thường.
# Chạy: bash ~/hrm/backend/do-hieu-nang.sh        (đo cả 2 chế độ)
#       bash ~/hrm/backend/do-hieu-nang.sh on     (chỉ đo lại 1 chế độ, bảng dùng biên bản cũ của chế độ kia)
# Backend đang chạy ở terminal khác sẽ bị tắt (script tự bật lại ở chế độ thường khi xong).
cd ~/hrm/backend || exit 1
D=bien-ban; mkdir -p "$D"
command -v ab > /dev/null || { echo "Thiếu ab. Cài: sudo apt install -y apache2-utils"; exit 1; }
sudo -v || exit 1   # hỏi mật khẩu sudo 1 lần (bench.sh cần sudo để đo dung lượng sổ cái)

pid5000() { ss -ltnpH 'sport = :5000' | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1; }
stop() {
    local pid; pid=$(pid5000)
    [ -n "$pid" ] && kill "$pid"
    for _ in $(seq 1 20); do [ -z "$(pid5000)" ] && return 0; sleep 1; done
    echo "Không tắt được backend ở cổng 5000"; exit 1
}
# start <on|off> [BIẾN=giá_trị ...]: chạy nền, chờ tới khi backend báo đúng chế độ
start() {
    local m=$1; shift
    env CHAIN_MODE="$m" "$@" nohup npm start > "$D/backend-$m.log" 2>&1 &
    for _ in $(seq 1 60); do
        [ "$(curl -s localhost:5000/ | jq -r .blockchain 2>/dev/null)" = "$m" ] && return 0; sleep 1
    done
    echo "Backend không lên ở chế độ $m, xem $D/backend-$m.log"; exit 1
}

# Nới giới hạn yêu cầu/phút để công cụ đo không bị chặn (chỉ trong lúc đo)
for m in ${@:-on off}; do
    echo; echo "########## Đo chế độ blockchain=$m ##########"
    stop; start "$m" USER_RATE_MAX=100000
    bash bench.sh | tee "$D/bench-$m.log"
done

stop; start on
echo; echo "Backend đã về chế độ thường, chạy nền (log: $D/backend-on.log)."
echo "Muốn chạy lại ở terminal như cũ: kill \$(ss -ltnpH 'sport = :5000' | grep -o 'pid=[0-9]*' | cut -d= -f2) rồi npm start"
echo
bash tong-hop-bench.sh "$D/bench-on.log" "$D/bench-off.log" | tee "$D/bang-so-sanh.md"
echo; echo "Bảng trên đã lưu ở ~/hrm/backend/$D/bang-so-sanh.md"
