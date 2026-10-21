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
| 27 | 20/10 | Tên quán **Cửu Long Trấn**: đặt làm tên mặc định của app, logo chữ CLT | |
| 28 | 20/10 | Chạy song song 2 web trên Railway: dathangsi (project cũ) và Cửu Long Trấn (project mới), sửa code liên tục | Đề xuất nhánh `dev` + môi trường thử |
| 29 | 20/10 | Deploy Railway: project `marvelous-spirit`, link c-u-long-tr-n-production.up.railway.app, Volume `/data` | Dockerfile không dùng lệnh VOLUME |
| 30 | 21/10 | MISA meInvoice **có API công khai (REST, JSON) + môi trường Sandbox**, chủ quán xác nhận qua tìm kiếm | GĐ5: cần đọc docs (developer.misa.vn bị chặn mạng trong môi trường Claude) + xin tài khoản test |
| 31 | 21/10 | Quản lý trả **lương theo tháng**: lương tháng × ngày công / ngày công chuẩn (mặc định 26, cài đặt được; 0 = trả cố định) | Chủ quán yêu cầu khi nhập nhân viên thật |
| 32 | 21/10 | **Quản lý được thêm/sửa nhân sự** (tới Trưởng ca) và xem lương; chỉ Chủ tạo Quản lý. Giữ như hiện tại, không cần Chủ duyệt | |
| 33 | 21/10 | **Tổ trưởng tạo/sửa checklist của tổ mình**; trưởng ca trở lên sửa mọi tổ và checklist "Cả quán". Nút "Tạo / sửa checklist" ngay trong trang Checklist | |
| 34 | 21/10 | Lịch ca có bảng **số người theo giờ**; một loại ca = giờ của 1 người, part-time giờ khác nhau tạo loại ca riêng | Có thể làm tiếp: số tối thiểu theo khung giờ |
| 35 | 21/10 | Lịch ca đánh dấu người **làm 2 ca / quá 10 giờ một ngày** (nhãn vàng/đỏ + danh sách cảnh báo) và hiện **tổng giờ tuần / giới hạn** cạnh tên | Chủ quán có nhân viên làm cả sáng lẫn tối |
| 36 | 21/10 | **Sơ đồ bàn 3 khu A/B/C** (mặc định A 1-40, B 41-80, C 81-100, sửa ở Cài đặt → Khu & bàn). Khi xếp ca chọn **khu + bàn phụ trách** (trống = cả khu); trang "Sơ đồ bàn" hiện ai đang lo bàn nào | Chờ chủ quán báo số bàn thật từng khu |
| 37 | 21/10 | **Bộ phận → Vị trí**: Bếp là 1 bộ phận chia vị trí (Steak, Lẩu, Nướng, Topping, Thái tay, Tiếp thực), Bar riêng. Vị trí chọn theo từng ca; kỹ năng & số tối thiểu theo vị trí; checklist gắn được vị trí. Gộp tổ cũ bằng nút "Gộp" ở Cài đặt → Bộ phận & vị trí | Chủ quán tự bấm gộp trên app thật |
| 38 | 21/10 | Tài liệu **Quy trình vận hành** (Claude Docs) để chủ quán ghi ý kiến: https://claude.ai/artifact/HUtvNcqYj2RJdfWJ5vjUUm. Kaizen: vòng 1 tuần (ghi nhận → họp thứ Hai → sửa 1–3 việc → đo lại) | Báo cáo tuần làm ở GĐ4 |
| 39 | 21/10 | Railway **không tự deploy** khi push `main` (bản chạy kẹt 11 giờ). Cách tạm: trong service bấm Ctrl+K → "Deploy Latest Commit". Cần kiểm tra Settings → Source/Wait for CI | **Xong 21/10**: đã nối lại repo C-u-Long-Tr-n, nhánh main, Railway tự deploy khi push. Lưu ý: dathangsi deploy kiểu CLI (biểu tượng >_), app này deploy từ GitHub |
