# Bộ nhớ dự án

> Claude tự đọc file này mỗi phiên làm việc. Chi tiết nằm trong `memory/`. Cập nhật file này khi có quyết định mới.

## Tôi (chủ repo)
Chủ quán **Cửu Long Trấn**: Steak & Lẩu bò Thái tay (100 bàn). Cũng vận hành hệ thống **dathangsi / ordership** (đặt hàng sỉ từ 1688). Dùng Claude Code chủ yếu trên **điện thoại**.

## Dự án
**Quản lý quán**: app vận hành nhà hàng (repo này). GĐ1 Nhân sự + GĐ2 Kho **xong**; **đã deploy Railway** (project `marvelous-spirit`, vùng **Singapore**, Volume `/data`).
Công cụ import đơn 1688 nằm riêng ở repo `trinh240887-maker/dathangsi`.
→ Chi tiết: `memory/projects/quanly-quan.md`, yêu cầu gốc: `memory/projects/quanly-yeu-cau.md`, quyết định: `memory/projects/quanly-quyet-dinh.md`

## Thuật ngữ hay dùng
| Từ | Nghĩa |
|----|-------|
| **GĐ1…GĐ5** | Giai đoạn: 1 Nhân sự, 2 Kho, 3 Bán hàng (bàn/gọi món/bếp), 4 Báo cáo, 5 Hoá đơn điện tử |
| **ca / ca gãy / ca đóng** | Ca làm; ca gãy = nhiều khúc; ca qua nửa đêm. Quán **tự tạo loại ca**, không cố định |
| **bộ phận / vị trí** | Bộ phận: Bếp, Bar, Tiếp thực, Phục vụ, Thu ngân, Tạp vụ. Bếp chia vị trí (Steak, Lẩu, Nướng, Topping, Thái tay), chọn theo ca. Trong code bộ phận = bảng `teams` |
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
- (25/10: chủ quán nói app **chưa dùng thật** → được đẩy `main` bất cứ lúc nào. Khi app dùng thật thì áp dụng quy tắc dưới.)
- **Không đẩy code app lên `main` trong giờ bán (9:00–23:30 giờ VN)**: mỗi lần đẩy Railway khởi động lại, app mất kết nối ~1–2 phút (25/10 mất lúc đang order). Trong giờ bán: commit lên nhánh `cho-deploy`, sau 23:30 (hoặc khi chủ quán bảo) mới gộp vào `main`. Sửa lỗi gấp thì hỏi chủ quán trước. (Chỉ đổi `*.md`, `memory/`, `test/` thì không khởi động lại.)

## Kỹ thuật
- Node.js ≥ 22.13, **không thư viện ngoài** cho app; SQLite có sẵn (`node:sqlite`); giao diện Preact + htm chép sẵn trong `public/vendor` (không build).
- Chạy: `npm start` · Dữ liệu mẫu: `npm run demo` · Test: `npm test` (phải xanh trước khi push).
- Bản chạy thử web: `cd demo-web && npm i && npm run build` → publish artifact (URL bên dưới).
- Deploy cloud: `Dockerfile`, `railway.json` (Volume `/data`).

## Link
- **App thật:** https://c-u-long-tr-n-production.up.railway.app (Railway, cổng 8080, tự deploy khi push `main`)
- Quy trình vận hành (chủ quán ghi ý kiến): https://claude.ai/artifact/HUtvNcqYj2RJdfWJ5vjUUm
- Bản chạy thử: https://claude.ai/artifact/4BLaeEpr4EZzDJGroCDHNa (riêng tư)
- Repo: `trinh240887-maker/C-u-Long-Tr-n` (nhánh chính `main`)

## Đang chờ tôi trả lời
→ `memory/projects/quanly-quan.md` mục "Câu hỏi mở"
