# Yêu cầu gốc: App quản lý tiệm Steak & Lẩu bò Thái tay

> Chép từ bản yêu cầu chủ quán gửi ngày 20/10/2026. Phần thay đổi sau đó xem `quanly-quyet-dinh.md` (ví dụ: làm Nhân sự trước, MISA thay Sapo, Node + SQLite thay Next.js + Supabase).

Web app quản lý vận hành nhà hàng, dùng trên điện thoại, máy tính bảng, máy tính quầy. Tiếng Việt, VNĐ, múi giờ Asia/Ho_Chi_Minh.

## Bối cảnh
- **100 bàn**, khu vực mặc định: Tầng 1 bàn 1–40, Tầng 2 bàn 41–80, Sân vườn 81–100 (sửa được trong Cài đặt).
- Nhiều nhân viên, nhiều thiết bị, **đồng bộ realtime**: phục vụ gọi món bằng điện thoại, bếp xem màn hình bếp, thu ngân tính tiền ở quầy.
- Vai trò gốc: Chủ, Thu ngân, Phục vụ, Bếp (sau mở rộng thành 5 cấp, xem glossary).

## 1. Sơ đồ bàn, gọi món & tính tiền
- Lưới 100 bàn theo khu, màu theo trạng thái Trống / Đang phục vụ / Chờ thanh toán; ô hiện số bàn, thời gian ngồi, tạm tính, số món chưa gửi bếp.
- Danh mục: Steak, Lẩu bò, Thịt nhúng thêm, Rau & món kèm, Đồ uống.
- Steak **bắt buộc chọn độ chín** (Rare / Medium rare / Medium / Medium well / Well done) và có ghi chú.
- Tăng/giảm/huỷ món, số khách, chuyển bàn, gộp bàn, tách bill. "Gửi bếp" chỉ gửi món mới.
- Thanh toán: giảm giá % hoặc số tiền; Tiền mặt / Chuyển khoản / Thẻ; **QR VietQR** theo số tiền; in tạm tính và hoá đơn khổ **80mm**.

## 2. Màn hình bếp (KDS)
- Món đã gửi theo thời gian, nhóm theo bàn, hiện độ chín/ghi chú, đếm phút chờ (đổi màu khi quá 15 phút).
- Bấm "Xong" từng món hoặc cả bàn; phục vụ thấy món sẵn sàng.

## 3. Kho nguyên liệu
- Nguyên liệu: tên, đơn vị (g, kg, lít, phần, lon…), tồn, mức tối thiểu, đơn giá nhập.
- **Định lượng món** (vd Steak thăn ngoại = 250g thịt + 100g khoai + 20g bơ; Lẩu bò nhỏ = 1 phần nước lẩu + 150g bắp + 100g gầu + 1 phần rau). **Thanh toán tự trừ kho.**
- Nhập kho (số lượng, đơn giá, NCC), kiểm kho (số thực tế, chênh lệch hao hụt), cảnh báo sắp hết, lịch sử nhập/xuất/kiểm.

## 4. Doanh thu & chi phí
- Báo cáo ngày / 7 ngày / tháng / tuỳ chọn: doanh thu, số bill, TB/bill, số khách, **giá vốn** (định lượng × đơn giá), chi phí vận hành, **lãi gộp ước tính**.
- Biểu đồ theo ngày và theo giờ, top món, tỷ lệ phương thức thanh toán.
- Nhập chi phí: mặt bằng, điện nước, gas, lương, marketing, sửa chữa, khác. **Xuất Excel.**

## 5. Nhân viên & ca làm
- Nhân viên: tên, vai trò, lương theo giờ hoặc theo ca. Chấm công vào/ra (ca qua nửa đêm), lịch ca tuần. Bảng công & lương tạm tính theo tháng.

## 6. Hoá đơn điện tử
- Ban đầu yêu cầu Sapo: phải **kiểm tra API công khai trước, không tự đoán endpoint**. Kết quả: không tìm thấy, nên chuyển sang **MISA meInvoice**.
- Thiết kế **adapter `InvoiceProvider`** để đổi nhà cung cấp (MISA, Viettel, VNPT, EasyInvoice…).
- Luồng: bill đã thanh toán → "Xuất HĐĐT" → nhập người mua (hoặc khách lẻ) → gửi → lưu số HĐ, mã tra cứu, trạng thái, link PDF; **hàng đợi gửi lại** khi lỗi mạng.
- Hỗ trợ **hoá đơn khởi tạo từ máy tính tiền** nếu nhà cung cấp hỗ trợ. **API key chỉ ở server.**

## Yêu cầu kỹ thuật
- PWA cài lên điện thoại, nút lớn, thao tác 1 tay.
- Tiền số nguyên VNĐ; **trừ kho và ghi bill trong một transaction**.
- Dữ liệu mẫu đánh dấu rõ là mẫu.
- Test cho: tính tiền, giảm giá, trừ kho định lượng, **tính công qua nửa đêm**.
- README: cài đặt, tạo tài khoản nhân viên, kết nối máy in, cấu hình HĐĐT.

## Bổ sung sau (nhân sự & vận hành)
- Phân ca, trực ca; quản lý thấy các đầu việc chính.
- Bếp kiểm kho trong bếp: thiếu gì, cần bổ sung gì theo **tốc độ bán**; **đồ để lâu thì trữ, đồ tươi thì gọi trong ngày**; pha chế cũng vậy.
- Nhân viên vào ca biết việc của mình qua **checklist**; bếp cũng vậy.
- Nhân viên off thì báo **ai có thể hỗ trợ** vị trí đó.
- **Sơ đồ công việc** (tổ chức + quy trình).
- Đơn đặt hàng duyệt xong **bot tự gửi nhóm Zalo mua đồ**.

## Cách làm việc chủ quán yêu cầu
Hỏi điểm chưa rõ → trình bày kế hoạch (dữ liệu, màn hình, giai đoạn) → làm từng giai đoạn chạy được → cuối GĐ tóm tắt đã làm, cách thử, việc còn lại.
