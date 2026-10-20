# Từ điển nội bộ

Cách gọi tắt, thuật ngữ dùng khi trao đổi về quán và các dự án.

## Giai đoạn dự án Quản lý quán
| Từ | Nghĩa |
|----|-------|
| GĐ1 | Nhân sự & công việc: PIN, phân quyền, ca, chấm công, nghỉ & thay ca, checklist, giao việc (**đã làm**) |
| GĐ2 | Kho: kho tổng, kho từng khu, định lượng, kiểm kho cuối ca, đề xuất đặt hàng, gửi Zalo |
| GĐ3 | Bán hàng: sơ đồ 100 bàn, gọi món, màn hình Bếp/Lẩu/Bar, thanh toán, in bill 80mm, tự trừ kho |
| GĐ4 | Doanh thu, chi phí, giá vốn, lãi gộp, xuất Excel, bảng lương |
| GĐ5 | Hoá đơn điện tử qua MISA meInvoice (adapter `InvoiceProvider`) |

## Cấp bậc
| Từ | Nghĩa |
|----|-------|
| Chủ | Mọi quyền: lương, cài đặt, tạo quản lý |
| Quản lý | Xếp lịch, duyệt nghỉ, duyệt đơn đặt hàng, giao việc |
| Trưởng ca | Mỗi ca 1 người; mở/đóng ca, điều người, xử lý sự cố, sửa chấm công |
| Tổ trưởng | Checklist & kho của tổ, lập đề xuất đặt hàng, nhờ người thay, giao việc trong tổ |
| Nhân viên | Chấm công, xem lịch, làm checklist, xin nghỉ, nhận ca thay |
Chuỗi: **Chủ → Quản lý → Trưởng ca → Tổ trưởng → Nhân viên**

## Vận hành
| Từ | Nghĩa |
|----|-------|
| ca sáng / ca chiều | Quán có ca sáng và ca chiều (giờ cụ thể: chưa có) |
| ca gãy | Một ca nhiều khúc, ví dụ 10–14h + 17–22h, tính lương 1 ca |
| ca đóng | Ca qua nửa đêm, ví dụ 17:00–00:30 |
| ngày làm việc | Chốt lúc 5h sáng: trước 5h vẫn tính ngày hôm trước |
| giờ đêm | 22h–6h, phụ cấp mặc định +30% (lương giờ) |
| làm thay / người thay | Người nhận ca của người xin nghỉ; app gợi ý theo kỹ năng, trùng giờ, giới hạn giờ/tuần |
| vị trí phụ / kỹ năng | Tổ khác mà nhân viên đã được đào tạo (Cơ bản/Khá/Thạo) |
| checklist mở/trong/đóng ca | Đầu việc lặp lại theo tổ |
| việc | Việc giao lẻ có hạn chót |
| đồ tươi / đồ mát / đồ khô-đông | 3 nhóm nguyên liệu: đặt hằng ngày / trữ 5–7 ngày / trữ 1–4 tuần |
| khu chính / kho chung | Cách gán nguyên liệu dùng chung (đá, chanh, rau thơm) |
| nhóm "Mua đồ" | Nhóm Zalo nhận đơn đặt hàng đã duyệt (1 nhóm chung) |
| 86 / tạm hết | Món hết nguyên liệu, báo phục vụ ngưng nhận |

## Món & khu
| Từ | Nghĩa |
|----|-------|
| Bếp | Làm steak (bắt buộc chọn độ chín: Rare → Well done) |
| Lẩu | Nước lẩu, topping, bò thái tay |
| Bar | Nước pha chế + nước đóng chai |
| Khu bàn | Mặc định Tầng 1 bàn 1–40, Tầng 2 bàn 41–80, Sân vườn 81–100 |

## Hệ thống & đối tác
| Từ | Nghĩa |
|----|-------|
| dathangsi | Hệ thống đặt hàng sỉ của chủ repo (nhận đơn 1688 qua webhook) |
| ordership | Hệ thống vận chuyển/đơn hàng, cũng nhận đơn 1688 |
| OA | Zalo Official Account của quán (đã có) |
| ZNS | Tin Zalo theo số điện thoại, tính phí, cần duyệt mẫu (dự phòng) |
| MISA / meInvoice | Nhà cung cấp hoá đơn điện tử đã chọn; docs: developer.misa.vn (bị chặn mạng trong môi trường Claude) |
| Sapo | Đã bỏ cho HĐĐT: không có API công khai |
| Railway | Nơi đề xuất chạy cloud (~5 USD/tháng) |
| Cloudflare Tunnel | Đưa máy ở quán ra internet để xem từ xa |
| artifact / bản chạy thử | Trang web claude.ai chạy app trong trình duyệt, dữ liệu riêng từng máy |
