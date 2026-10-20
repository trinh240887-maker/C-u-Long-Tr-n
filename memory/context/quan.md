# Bối cảnh quán

## Quán
- **Steak & Lẩu bò Thái tay**, 100 bàn, 3 khu (Tầng 1 / Tầng 2 / Sân vườn).
- Có **ca sáng và ca chiều** (giờ cụ thể chưa có). Chủ quán tự xếp lịch.
- Có **kho tổng**; mỗi khu (Bếp, Lẩu, Bar) có kho riêng và **1 nhà cung cấp riêng**.

## Tổ (mặc định trong app, sửa được)
| Tổ | Việc chính |
|----|-----------|
| Bếp steak | Nướng steak theo độ chín, sốt, khoai |
| Lẩu | Nước lẩu, topping, thái bò |
| Bar | Pha chế, nước đóng chai |
| Phục vụ | Setup bàn, bếp lẩu mini, gọi món, chạy món |
| Thu ngân | Tính tiền, in bill |
| Tạp vụ | Rửa bát, vệ sinh |

## Công cụ & hệ thống
| Công cụ | Dùng cho | Tình trạng |
|---------|----------|-----------|
| Zalo OA | Thông báo nhân viên, gửi đơn mua đồ | Đã có OA; chưa kết nối API |
| Nhóm Zalo "Mua đồ" | Nhận đơn đặt hàng NCC | Nhóm cá nhân: OA không gửi được vào, cần nhóm OA |
| MISA meInvoice | Hoá đơn điện tử | Đã chọn; chưa đọc được docs |
| dathangsi / ordership | Hệ thống đặt hàng sỉ (1688) | Nơi host chưa rõ |
| GitHub `trinh240887-maker/C-u-Long-Tr-n` | Repo app quán (tách từ `dathangsi`) | |

## Môi trường Claude (hạn chế đã gặp)
- Mạng chặn: sapo.vn, developer.misa.vn, bot.zaloplatforms.com, các dịch vụ tunnel. Cho phép npm, GitHub.
- Không tự deploy được (cần tài khoản của chủ quán).
