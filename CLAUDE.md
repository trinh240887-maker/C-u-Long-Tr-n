# Bộ nhớ dự án

> Claude tự đọc file này mỗi phiên làm việc. Chi tiết nằm trong `memory/`. Cập nhật file này khi có quyết định mới.

## Tôi (chủ repo)
Chủ quán **Cửu Long Trấn**: Steak & Lẩu bò Thái tay (100 bàn). Cũng vận hành hệ thống **dathangsi / ordership** (đặt hàng sỉ từ 1688). Dùng Claude Code chủ yếu trên **điện thoại**.

## Dự án
**Quản lý quán**: app vận hành nhà hàng (repo này). GĐ1 Nhân sự + GĐ2 Kho **xong, đang chạy thử**; chờ deploy thật.
Công cụ import đơn 1688 nằm riêng ở repo `trinh240887-maker/dathangsi`.
→ Chi tiết: `memory/projects/quanly-quan.md`, yêu cầu gốc: `memory/projects/quanly-yeu-cau.md`, quyết định: `memory/projects/quanly-quyet-dinh.md`

## Thuật ngữ hay dùng
| Từ | Nghĩa |
|----|-------|
| **GĐ1…GĐ5** | Giai đoạn: 1 Nhân sự, 2 Kho, 3 Bán hàng (bàn/gọi món/bếp), 4 Báo cáo, 5 Hoá đơn điện tử |
| **ca / ca gãy / ca đóng** | Ca làm; ca gãy = nhiều khúc; ca qua nửa đêm. Quán **tự tạo loại ca**, không cố định |
| **tổ** | Bếp steak, Lẩu, Bar, Phục vụ, Thu ngân, Tạp vụ (sửa được) |
| **3 điểm chế biến** | Bếp (steak) · Lẩu (nước lẩu, topping, bò thái tay) · Bar (pha chế + nước đóng chai) |
| **kho tổng / kho khu** | Hàng nhập về kho tổng rồi xuất cho từng khu; NL dùng chung chọn "khu chính" hoặc "kho chung" |
| **NCC** | Nhà cung cấp, **mỗi khu 1 NCC** |
| **OA** | Zalo Official Account của quán, kênh thông báo nhân viên |
| **HĐĐT** | Hoá đơn điện tử: dùng **MISA meInvoice** (không dùng Sapo) |
| **bản chạy thử** | Artifact chạy trong trình duyệt, dữ liệu chỉ trên máy đó |
→ Đầy đủ: `memory/glossary.md`

## Cách làm việc với tôi (bắt buộc)
- Trả lời **tiếng Việt**, ngắn, kết quả trước; tôi đọc trên điện thoại.
- **Báo kế hoạch trước khi làm** việc lớn; hỏi tối đa vài câu khi chưa rõ.
- Làm theo **giai đoạn**, mỗi GĐ chạy được và thử được; cuối GĐ tóm tắt: đã làm gì, cách thử, việc còn lại.
- Không tự đoán API bên ngoài (Sapo/MISA/Zalo): kiểm tra tài liệu, không có thì báo tôi.
- Tiền là số nguyên VNĐ, múi giờ Asia/Ho_Chi_Minh, giao diện tiếng Việt, nút lớn cho cảm ứng.
- Commit & push lên nhánh đang làm; không tạo PR khi tôi chưa yêu cầu.

## Kỹ thuật
- Node.js ≥ 22.13, **không thư viện ngoài** cho app; SQLite có sẵn (`node:sqlite`); giao diện Preact + htm chép sẵn trong `public/vendor` (không build).
- Chạy: `npm start` · Dữ liệu mẫu: `npm run demo` · Test: `npm test` (phải xanh trước khi push).
- Bản chạy thử web: `cd demo-web && npm i && npm run build` → publish artifact (URL bên dưới).
- Deploy cloud: `Dockerfile`, `railway.json` (Volume `/data`).

## Link
- Bản chạy thử: https://claude.ai/artifact/4BLaeEpr4EZzDJGroCDHNa (riêng tư)
- Repo: `trinh240887-maker/C-u-Long-Tr-n` (nhánh chính `main`)

## Đang chờ tôi trả lời
→ `memory/projects/quanly-quan.md` mục "Câu hỏi mở"
