# Rà soát lỗi toàn hệ thống 28/10/2026 (chưa sửa — chờ chủ quán chọn)

## CAO
1. Bảo mật đăng nhập: app tin header `cf-connecting-ip` (app.js:128-131) → giả IP: dò PIN không giới hạn, giả wifi quán chấm công từ xa (bridge_ip trả cho staff ở /api/attendance/network). failedLogins không dọn.
2. Lộ PIN người khác: /api/me/pin báo "PIN đã có người dùng" + không giới hạn lần (auth.js:10-12, 369); /api/login báo khác nhau khi PIN đúng mà thiếu SĐT.
3. Quản lý tự tăng lương mình (staff.js:195, 205-214). Cấp quyền XEM mục Nhân viên = nâng role manager cho mọi lệnh ghi /api/staff (perms.js:121-128 apiGate).
4. Trưởng ca tự thêm/sửa chấm công của mình & cấp trên; sửa giờ ra không reset ot_status (attendance.js:483-513).
5. Thanh toán/hoàn tiền sau khi đã chốt ngày (trước 5h) rơi vào ngày đã chốt → két lệch; handover kẹt (payments.js:246-295, 427, 645-661, 317). Chốt ngày không chặn bàn đang mở.
6. Zalo: tin riêng/nhóm lạ gửi bot → tạo đơn mua "đã duyệt"; khớp tên NCC kiểu "chứa nhau"; spam báo khẩn (availability.js:524, zalo-orders.js:66-112).
7. DB mới: khởi động lần 2 xoá hết việc checklist Bếp/Bar/Tạp vụ (checklists.js:68,154,210-225 hadMoCa); lead_pool_v1 chạy khi có job đầu tiên (jobs.js:223). Live DB đã qua.
8. Ổ /data: backup mỗi giờ giữ 7 ngày (~168 bản) cùng ổ; ảnh việc ca không bao giờ xoá (jobs.js photos/viec).
9. Mua hàng: quy đổi dòng của bill đang CHỜ NHẬN làm cộng kho sai (purchases.js:357-386).
10. Kho mới (/kho-tx): bấm 2 lần ra 2 chứng từ (warehouse.js không busy).

## TRUNG BÌNH
- Tách món (pos.js:497-503) + restoreSale: huỷ trả kho sai số.
- Tiền mặt không kiểm đã có CK một phần (payments.js:273-289) → khách trả 2 lần. Gộp bàn không chuyển bank_txns (pos.js:569-575).
- Sapo: Bỏ nhập không đánh dấu consume cũ → nhập lại/bỏ lần 2 cộng kho dư; recount cộng cả lần cũ (sapo.js:116, 140-150). NXT cột Nhập/Lệch phồng khi up Sapo sau kiểm.
- Kiểm kho: day_in loại dòng huỷ bill (âm) → "nhập" thừa (stock.js:432); day_open có thể từ 2-3 ngày trước nhưng day_in chỉ hôm nay.
- Việc ca: /done xoá ảnh shot trước khi kiểm số đếm → lỗi là mất ảnh (jobs.js:467); jobsLeftTick không chạy với khung qua nửa đêm (job_to ≥1440); tick "Chưa ai nhận" bắn 1 báo / việc ở chế độ điều phối (~150 báo).
- Mua hàng: ArriveCard sau Sửa bill gửi qty "undefined" (id dòng đổi); bill chờ có 2 dòng cùng NL kẹt; Sửa bill mất/giữ sai cờ chưa quy đổi; đổi ngày bill khi hàng về làm lệch đối soát CK ngày đã chốt; nhận đủ tự duyệt bỏ qua kiểm giá tăng.
- Lịch: quản lý bộ phận báo lịch rảnh hộ bất kỳ ai (availability targetOf); publish của quản lý bộ phận ghi khoá published:tuần:t<id> không ai đọc → lịch đã duyệt vẫn bị lịch rảnh ghi đè.
- server.js: các tick chung 1 try → 1 tick lỗi chặn các tick sau.
- Xoá 1 việc checklist cascade xoá lịch sử entries/ảnh/jobs (checklists.js:280,469).
- Khoá máy chấm công bỏ qua được khi không gửi cookie did/X-Device; GPS lấy từ body.
- Nghỉ 1 khúc: huỷ không gộp ca lại; splitOff ghi DB trước khi kiểm ca đã qua; quản lý tự duyệt đơn nghỉ mình.
- Giao diện: /thuc-don mô tả món tràn ngang (button nowrap); /phieu-bep nhân viên 403 /api/print/status → không thấy báo máy in hỏng.
- Tasks: sửa việc đổi người nhận ngoài tổ không kiểm.

## THẤP
VEG_RE nhận nhầm "Bò bít tết", "Giăm bông", "Men"…; thêm hàng khác ở kiểm kho rơi vào tab Bếp; hoàn tiền trùng món trong 1 request; refund món chưa ra không trả kho; huỷ cả bàn không trả kho; QR tự đóng bill còn món chưa gửi; báo cáo KM cả bill đọc sai kiểu; lost_value lọc 0h thay vì 5h; tab Đóng ca ẩn cả khi xem ngày cũ; dashboard nhỏ (đơn nghỉ người không khu, checklist không bộ phận); settings/notifications/sessions phình; Zalo OA không timeout; bấm đúp Gửi bếp/Thu tiền hiện toast đỏ; đổi PIN không đăng xuất phiên khác.
