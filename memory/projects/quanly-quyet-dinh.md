# Nhật ký quyết định: Quản lý quán

Mỗi dòng là một điều chủ quán đã chốt (hoặc Claude đề xuất và chủ quán đồng ý). Mới nhất ở cuối.

| # | Ngày | Quyết định | Ghi chú |
|---|------|-----------|---------|
| 1 | 20/10/2026 | Loại hình: nhà hàng/quán ăn 100 bàn, bán **steak** và **lẩu bò Thái tay** | |
| 2 | 20/10 | Nhiều máy dùng chung, đồng bộ thời gian thực | |
| 3 | 20/10 | Đăng nhập **PIN riêng mỗi người** | |
| 4 | 20/10 | **Tách bill theo món** (không chia đều) | GĐ3 |
| 5 | 20/10 | **3 điểm chế biến**: Bếp (steak), Lẩu (nước lẩu, topping, bò thái tay), Bar (pha chế + đóng chai) | GĐ3 |
| 6 | 20/10 | Nền tảng **"cả 2"**: máy chủ đặt ở quán (chạy khi mất mạng) + quản lý từ xa + sao lưu cả máy nội bộ và cloud | Công nghệ: Node + SQLite thay cho Next.js + Supabase |
| 7 | 20/10 | Ưu tiên làm **Nhân sự trước** (đổi thứ tự so với yêu cầu gốc) | |
| 8 | 20/10 | **Ca làm không cố định**: chủ quán tự tạo loại ca và tự xếp lịch | |
| 9 | 20/10 | Cấp bậc: **Chủ → Quản lý → Trưởng ca → Tổ trưởng → Nhân viên** | |
| 10 | 20/10 | Thông báo nhân viên qua **Zalo**; quán dùng **Zalo OA** | |
| 11 | 20/10 | Có **kho tổng**, các khu lĩnh hàng từ kho tổng | GĐ2 |
| 12 | 20/10 | Nguyên liệu dùng chung: chọn **khu chính** hoặc **kho chung** từng loại | GĐ2 |
| 13 | 20/10 | **Mỗi khu 1 nhà cung cấp**; đề xuất mua tự tách theo NCC | GĐ2 |
| 14 | 20/10 | Đơn đặt hàng đã duyệt gửi vào **1 nhóm Zalo "Mua đồ" chung** | Claude hiểu từ câu trả lời "nhóm"; chưa xác nhận lại |
| 15 | 20/10 | Bếp và **pha chế** đều có gợi ý đặt hàng theo tốc độ bán, hạn dùng | GĐ2 |
| 16 | 20/10 | Luồng đặt hàng: cuối ca đếm tồn → đề xuất → tổ trưởng sửa → quản lý duyệt → **bot tự gửi Zalo** | GĐ2 |
| 17 | 20/10 | Người giữ kho tổng: **báo sau** | Đã có ô chọn trong Cài đặt |
| 18 | 20/10 | HĐĐT dùng **MISA meInvoice** thay Sapo | Sapo không có API công khai |
| 19 | 20/10 | Cần **link web** để thử ngay → làm bản chạy thử chạy trong trình duyệt | Không dùng chung dữ liệu giữa các máy |
| 20 | 20/10 | Quán có **ca sáng và ca chiều**; checklist cần theo từng ca | Đề xuất đã gửi, chờ đồng ý + giờ ca |
| 21 | 20/10 | Lưu toàn bộ vào bộ nhớ md trong repo (`CLAUDE.md` + `memory/`) | |
| 22 | 20/10 | Tách app quán ra **repo riêng `C-u-Long-Tr-n`** (chủ quán đặt tên) | |
| 23 | 20/10 | Làm luôn 3 bước: checklist theo ca, GĐ2 Kho, deploy | Deploy cần chủ quán tạo tài khoản Railway |
| 24 | 20/10 | Checklist gắn theo **loại ca**; checklist "Mọi ca" chạy 1 lượt/ngày | |
| 25 | 20/10 | Chưa có bán hàng: **lượng dùng = chênh lệch kiểm kho cuối ca của khu** | Đổi khi có GĐ3 |
| 26 | 20/10 | Đơn đã duyệt gửi Zalo nhóm bằng **nút chép nội dung** tới khi xác nhận API nhóm OA | |
