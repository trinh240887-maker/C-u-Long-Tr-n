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
| 40 | 21/10 | Chủ quán: "Bếp chọn chung, không phân ra Steak và Lẩu" ở bộ phận. App **tự gộp 1 lần** các tổ Bếp steak/Lẩu/Topping/Thái tay (+ thêm Nướng) thành bộ phận Bếp khi khởi động (cờ `kitchen_merged`) | |
| 41 | 21/10 | **Tiếp thực là bộ phận riêng**, không thuộc Bếp (chủ quán sửa lại). Nếu đã lỡ gộp, app tự tách ra 1 lần (cờ `tiep_thuc_split`) | |
| 42 | 21/10 | Kế hoạch mới (chờ duyệt thứ tự): Đợt 1 **lịch rảnh hằng tuần** cho nhân sự thời vụ + xếp tự động + phân khu nhanh; Đợt 2 **checklist bắt buộc ảnh** + quản lý chấm Đạt/Chưa đạt; Đợt 3 **AI chấm ảnh** (Claude API, ảnh mẫu chuẩn, báo chủ khi dưới chuẩn; nhân viên nhập số đếm kèm ảnh); Đợt 4 **dự trù muỗng/đũa/nĩa** | Chờ: buổi hay giờ, hạn nộp lịch rảnh, tài khoản Claude API, bộ dụng cụ/khách, số khách cao điểm |
| 43 | 21/10 | Ảnh checklist **tự xoá sau 7 ngày** cho nhẹ máy (chủ quán chốt) | |
| 44 | 21/10 | **Không làm "Xếp tự động"**: quản lý xem bảng lịch rảnh rồi tự xếp ca. App chỉ hiện ai rảnh / dư / thiếu và gợi ý người rảnh khi xếp | |
| 45 | 21/10 | Checklist: **khu nào cũng phải có ảnh**. Mặc định mọi mục checklist đều "Phải có ảnh" (tắt được từng mục nếu không cần, vd đọc nhiệt độ) | Đợt 2 |
| 46 | 21/10 | **Đã làm Đợt 1 + 2** (không dùng AI chấm, chủ quán chốt "không cần API"): trang **Lịch rảnh** `/ranh` (theo buổi Sáng/Chiều/Tối, hạn Thứ Năm 21:00, sửa ở Cài đặt → Chung → Lịch rảnh; quản lý xem bảng rảnh/cần/đã xếp, nhắc người chưa gửi); **checklist bắt buộc ảnh** (ảnh nén trên máy ≤1280px, tối đa 4 ảnh/việc, lưu `/data/photos`, tự xoá sau 7 ngày); trang **Duyệt ảnh** `/duyet-anh` (Đạt / Làm lại kèm lý do → báo người làm + chủ; làm lại phải chụp ảnh MỚI); checklist gắn được **Khu**; bảng điểm 7 ngày | Đợt 4 dự trù muỗng/đũa chờ số liệu |
| 47 | 21/10 | **Dụng cụ** (Cài đặt → Dụng cụ): chủ quán tự khai dụng cụ + số đang có, mỗi kiểu phục vụ (Steak/Lẩu/…) dùng mấy cái/khách; dự trù = khách cao điểm × cái/khách × (1 + rửa/ngồi) × (1 + dự phòng). Khi có GĐ3 sẽ lấy số khách & thời gian ngồi thật từ bán hàng | |
| 48 | 21/10 | **GĐ3 kế hoạch đã trình**: 3A Thực đơn+công thức → 3B Bàn/gọi món + **Đặt bàn R1** → 3C màn Bếp/Lẩu/Bar + **tự in phiếu giấy khi gọi món** → 3D Thanh toán/VietQR/bill 80mm → R2 trang đặt bàn online (+cọc) → 3E trừ kho/dự trù. R3 nhắc Zalo ZNS (phải đọc docs) | Chờ: ảnh menu, danh sách máy in + IP, máy luôn bật ở quán, thông tin đặt bàn |
| 49 | 21/10 | Máy in hiện có: **máy in nhiệt Sapo 80mm, LAN**, vd "Rau" 192.168.1.248. App trên Railway không với tới LAN → cần **cầu nối in** chạy trên 1 máy luôn bật ở quán (máy quầy / TV box), nhận lệnh qua internet rồi in ESC/POS (thường cổng 9100, phải in thử; nếu không có tiếng Việt thì in dạng ảnh) | |
| 50 | 21/10 | Dự trù dụng cụ (3E): **lấy số cao nhất**, không lấy trung bình: khách ngồi cùng lúc = mức cao nhất của cùng thứ 4 tuần gần nhất (+ khách đặt bàn hôm đó nếu cao hơn); thời gian ngồi lấy mức **ngắn** (quay vòng nhanh = nhiều bộ chờ rửa) để không thiếu | |
| 51 | 21/10 | Máy in Sapo LAN đã biết: **Rau 192.168.1.248**, **N.Lẩu (nước lẩu) 192.168.1.238**, **Steak 192.168.1.234**, **Pha chế (Bar) 192.168.1.244** (cạnh đó có máy "Ưu tiên", chưa dán IP). Phiếu Sapo hiện in từ **Sapo bản PC** ("PC 1.86.15.0") → quán có máy tính chạy được cầu nối in. Phiếu ghi "(Bàn) KHU C - 52" → bàn 52 thuộc Khu C, số bàn khu mặc định (C 81-100) cần sửa theo thật | Chờ IP máy Ưu tiên + công dụng, máy bill Quầy |
| 52 | 21/10 | Máy in **Ưu tiên** (cạnh máy Steak, chưa có IP) in phiếu của **(A) bàn ưu tiên** (VIP/đặt trước/nhóm đông) và **(B) món gấp / làm lại**; phiếu in chữ ƯU TIÊN đậm | 3C |
