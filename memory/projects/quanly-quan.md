# Dự án: Quản lý quán (Steak & Lẩu bò Thái tay)

**Repo:** `trinh240887-maker/C-u-Long-Tr-n` (tách từ `dathangsi/quanly`) · **Cũng gọi là:** app quản lý, quanly
**Trạng thái (cập nhật 20/10/2026):** GĐ1 xong, có bản chạy thử trên web; chưa deploy thật cho nhân viên.

## Mục tiêu
Một app web dùng chung cho cả quán (điện thoại phục vụ, màn hình bếp, máy quầy): nhân viên vào ca biết việc mình; quản lý nắm người, việc, kho trong ngày; bếp biết cần đặt gì; chủ xem doanh thu, chi phí, lãi.

## Lộ trình
| GĐ | Nội dung | Trạng thái |
|----|----------|-----------|
| 0 | Chuẩn bị dữ liệu thật (nhân viên, ca, checklist, nguyên liệu, NCC, menu, định lượng) | Chờ chủ quán gửi |
| 1 | Nhân sự & công việc | **Xong** (10 test xanh, đã thử trên trình duyệt) |
| 2 | Kho tổng + kho khu, định lượng, kiểm kho cuối ca, đề xuất đặt hàng theo tốc độ bán, gửi Zalo nhóm "Mua đồ" | Chưa làm |
| 3 | Sơ đồ 100 bàn, gọi món, Bếp/Lẩu/Bar, thanh toán, VietQR, in 80mm, tách bill theo món, tự trừ kho | Chưa làm (bản nháp POS cũ đã xoá, còn trong git history commit 74270c6) |
| 4 | Doanh thu, chi phí, giá vốn, lãi gộp, biểu đồ, xuất Excel | Chưa làm |
| 5 | HĐĐT MISA meInvoice qua adapter | Chưa làm, cần đọc docs MISA |

## GĐ1 đã có
- Đăng nhập PIN riêng (nhân viên 4–8 số, quản lý trở lên 6–8 số), khoá 5 phút sau 5 lần sai, bắt đổi PIN lần đầu. PIN chủ ban đầu `123456`.
- Nhân viên: tổ chính, kỹ năng phụ (1–3), lương giờ/ca, giới hạn giờ/tuần, liên kết Zalo.
- Loại ca tự tạo (nhiều khúc, qua đêm), lịch tuần (xếp/sửa/xoá, chép tuần trước, cảnh báo thiếu người theo số tối thiểu của tổ, gửi lịch).
- Chấm công: tự nhận ca, trễ, tự đóng khi quên chấm ra, tuỳ chọn chỉ chấm trong wifi quán (dải IP).
- Xin nghỉ → gợi ý người thay → nhờ → người được nhờ nhận → quản lý duyệt → ca chuyển cho người thay.
- Checklist theo tổ & thời điểm (mở/trong/đóng ca), kiểu tick/nhập số/ghi chữ; có checklist **(mẫu)**.
- Giao việc (người hoặc tổ, hạn, ưu tiên). Bảng việc quản lý. Bảng công & lương tạm tính. Sơ đồ tổ chức.
- Thông báo trong app + hàng đợi Zalo OA (API v3 tin tư vấn, **chưa thử với OA thật**), giờ yên lặng 23–7h.
- Sao lưu mỗi giờ giữ 7 ngày; nhật ký thao tác.
- Bản chạy thử web: `demo-web/` → https://claude.ai/artifact/4BLaeEpr4EZzDJGroCDHNa

## Kiến trúc
- `server.js` khởi động + hẹn giờ sao lưu/tự đóng ca.
- `server/db.js` schema SQLite + seed; `server/app.js` phiên, phân quyền, SSE realtime; `server/routes/*` từng chức năng; `server/lib/*` (time, payroll, replacement, schedule) có test; `server/notify/*` Zalo.
- `public/` Preact + htm, không build; `ui.js` (api, realtime, điều hướng), `views/*`.
- `demo-web/` esbuild + sql.js đóng gói thành 1 file HTML; shims cho node:sqlite/crypto/fs/path.
- Deploy: `Dockerfile`, `railway.json`, biến `DATA_DIR`, `PORT`, `TRUST_PROXY=1` khi sau proxy cloud.

## Câu hỏi mở (chờ chủ quán)
1. **Checklist theo ca sáng / ca chiều**: đề xuất thêm ô "Áp dụng cho ca" + mỗi ca một lượt riêng. Chờ đồng ý và **giờ cụ thể các ca**.
2. **Deploy thật cho nhân viên**: Railway (đề xuất; Root Directory để trống vì app ở gốc repo) / VPS / máy ở quán + Cloudflare Tunnel. Chờ chủ quán tạo tài khoản. (Chủ quán hỏi "giống dathangsi": chưa biết dathangsi đang host ở đâu.)
3. Cách chấm công: chỉ wifi quán / máy cố định ở quầy / có chụp ảnh.
4. Lịch phân ca thật (ảnh/Excel).
5. Danh sách tổ đủ chưa, có tổ phó không, có kiêm nhiệm không.
6. Người giữ kho tổng (chủ quán báo sau; đã có ô chọn trong Cài đặt).
7. Đồ tươi nhập vào kho tổng hay giao thẳng vào khu.
8. Zalo OA: đã xác thực chưa, gói dịch vụ, có "Nhóm chat OA" không (OA không gửi được vào nhóm Zalo cá nhân).
9. Mở quyền mạng `developer.misa.vn`, `*.misa.vn`, `*.meinvoice.vn` để đọc tài liệu HĐĐT.
10. Bảng mô tả công việc theo vị trí (đầu việc cố định của từng vai): đã đề xuất, chưa chốt.

## Việc nên làm tiếp (khi được duyệt)
- Checklist gắn theo ca (câu 1).
- Thêm việc mẫu vào bản chạy thử.
- Hướng dẫn deploy theo nơi chủ quán chọn.
- Bắt đầu GĐ2 Kho.
