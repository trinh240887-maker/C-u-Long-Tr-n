# Dự án: Quản lý quán (Steak & Lẩu bò Thái tay)

**Repo:** `trinh240887-maker/C-u-Long-Tr-n` (tách từ `dathangsi/quanly`) · **Cũng gọi là:** app quản lý, quanly
**Trạng thái (cập nhật 20/10/2026):** GĐ1 + GĐ2 xong (15 test xanh), bản chạy thử web đã cập nhật; chưa deploy thật cho nhân viên.

## Mục tiêu
Một app web dùng chung cho cả quán (điện thoại phục vụ, màn hình bếp, máy quầy): nhân viên vào ca biết việc mình; quản lý nắm người, việc, kho trong ngày; bếp biết cần đặt gì; chủ xem doanh thu, chi phí, lãi.

## Lộ trình
| GĐ | Nội dung | Trạng thái |
|----|----------|-----------|
| 0 | Chuẩn bị dữ liệu thật (nhân viên, ca, checklist, nguyên liệu, NCC, menu, định lượng) | Chờ chủ quán gửi |
| 1 | Nhân sự & công việc | **Xong** (10 test xanh, đã thử trên trình duyệt) |
| 2 | Kho tổng + kho khu, lô hạn dùng, kiểm kho cuối ca, dự báo & gợi ý lĩnh/đặt hàng, duyệt đơn, nhận hàng | **Xong** (định lượng món làm ở GĐ3 cùng thực đơn; gửi Zalo nhóm tạm bằng nút chép) |
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

## GĐ2 đã có
- Bảng: suppliers, stores (main/area, supplier_id), ingredients (unit/purchase_unit/factor/order_step/price/min/shelf/lead/cycle/safety), stock_lots (FEFO), stock_moves (receive/transfer/consume/waste/adjust), stock_counts(+lines), transfers(+lines), purchase_orders(+po_lines).
- `server/lib/forecast.js` (dự báo, purchaseNeed, areaNeed, làm tròn) và `server/lib/stock.js` (lô, xuất FEFO, kiểm kho) có test trong `test/stock.test.js`.
- Kiểm kho khu: chênh lệch = **consume** khi `area_count_is_usage = 1` (mặc định, vì chưa có bán hàng). Khi có GĐ3 bán hàng tự trừ kho thì đặt về 0 để chênh lệch thành hao hụt.
- Người giữ kho tổng = Cài đặt `kho_tong_staff_id` (trống: trưởng ca trở lên làm thay).
- Checklist có `shift_template_id` (Áp dụng cho ca).

## Kiến trúc
- `server.js` khởi động + hẹn giờ sao lưu/tự đóng ca.
- `server/db.js` schema SQLite + seed; `server/app.js` phiên, phân quyền, SSE realtime; `server/routes/*` từng chức năng; `server/lib/*` (time, payroll, replacement, schedule) có test; `server/notify/*` Zalo.
- `public/` Preact + htm, không build; `ui.js` (api, realtime, điều hướng), `views/*`.
- `demo-web/` esbuild + sql.js đóng gói thành 1 file HTML; shims cho node:sqlite/crypto/fs/path.
- Deploy: `Dockerfile`, `railway.json`, biến `DATA_DIR`, `PORT`, `TRUST_PROXY=1` khi sau proxy cloud.

## Câu hỏi mở (chờ chủ quán)
- (24/10) **Xếp ca tự động theo lịch rảnh**: đã đề xuất (nút ⚡ xếp đủ số tối thiểu, ca nằm gọn giờ rảnh, chia đều giờ, bản nháp rồi Công bố). Chủ quán: để nhân viên dùng lịch rảnh mới trước, quản lý thấy chỗ nào không ổn thì báo lại rồi mới quyết.
0. **Số bàn thật từng khu A/B/C** (đang để mặc định A 1-40, B 41-80, C 81-100). Sửa ở Cài đặt → Khu & bàn.
1. ~~Checklist theo ca~~: **đã làm** (ô "Áp dụng cho ca"). Vẫn cần giờ thật của ca sáng/chiều để tạo loại ca.
2. ~~Deploy~~: **xong 20/10** trên Railway: https://c-u-long-tr-n-production.up.railway.app (project `marvelous-spirit`, Volume `c-u-long-tr-n-volume` ở `/data`). dathangsi cũng chạy trên Railway (project `dathangsi`, 7 dịch vụ). Railway GitHub App được cấp All repositories.
3. Cách chấm công: chỉ wifi quán / máy cố định ở quầy / có chụp ảnh.
4. Lịch phân ca thật (ảnh/Excel).
5. Danh sách tổ đủ chưa, có tổ phó không, có kiêm nhiệm không.
6. Người giữ kho tổng (chủ quán báo sau; đã có ô chọn trong Cài đặt).
7. Đồ tươi nhập vào kho tổng hay giao thẳng vào khu.
8. Zalo OA: đã xác thực chưa, gói dịch vụ, có "Nhóm chat OA" không (OA không gửi được vào nhóm Zalo cá nhân).
9. Mở quyền mạng `developer.misa.vn`, `*.misa.vn`, `*.meinvoice.vn` để đọc tài liệu HĐĐT.
10. Bảng mô tả công việc theo vị trí (đầu việc cố định của từng vai): đã đề xuất, chưa chốt.

## Trạng thái chờ (20/10 tối)
- Chủ quán **tự kiểm tra lại GĐ1 + GĐ2 trên app thật** rồi mới làm tiếp. Phiên sau: hỏi kết quả kiểm tra, sửa lỗi họ gặp trước.
- Đề xuất kaizen chưa chốt: (1) `memory/bai-hoc.md` + quy tắc ghi lỗi & thêm test, (2) báo cáo hao hụt tuần + bảng cải tiến cho nhân viên, (3) GĐ3 gợi ý tự chỉnh định lượng.

## Việc nên làm tiếp (khi được duyệt)
- Deploy Railway (chủ quán tạo tài khoản; Root Directory để trống, Volume `/data`).
- Nhập dữ liệu thật: nhân viên, loại ca, nguyên liệu, NCC.
- GĐ3 Bán hàng: thực đơn + **định lượng món** → bán tự trừ kho; đổi `area_count_is_usage` = 0.
