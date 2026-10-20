# Quản lý quán: Steak & Lẩu bò

App web quản lý vận hành quán. **Giai đoạn 1 (đã làm): nhân sự & công việc.**

- Đăng nhập bằng **mã PIN riêng**, phân quyền 5 cấp: Chủ → Quản lý → Trưởng ca → Tổ trưởng → Nhân viên.
- **Nhân viên**: tổ chính, vị trí phụ đã được đào tạo (để làm thay), lương theo giờ hoặc theo ca, giới hạn giờ/tuần.
- **Loại ca do quán tự tạo** (không cố định), ca gãy nhiều khúc, ca qua nửa đêm.
- **Lịch ca tuần**: xếp, sửa, chép tuần trước, cảnh báo thiếu người theo số tối thiểu của tổ, gửi lịch cho nhân viên.
- **Chấm công** vào/ra (tự nhận ca, tính đi trễ, tự đóng khi quên chấm ra, có thể giới hạn chỉ trong wifi quán).
- **Xin nghỉ → gợi ý người làm thay** (lọc trùng giờ, đang nghỉ, chưa biết việc, vượt giờ/tuần) → nhờ người → người đó nhận → quản lý duyệt, ca tự chuyển sang người thay.
- **Checklist theo tổ** (mở ca / trong ca / đóng ca), kiểu tick, nhập số (nhiệt độ, kg…) hoặc ghi chữ.
- **Giao việc** cho người hoặc cả tổ, có hạn chót và mức ưu tiên.
- **Bảng việc quản lý**: ai đang trong ca, ai chưa vào, vắng, checklist từng tổ, đơn nghỉ chờ duyệt, việc quá hạn, thiếu người 7 ngày tới.
- **Bảng công & lương tạm tính** theo tháng (giờ làm, giờ đêm 22h–6h có phụ cấp, số ca, trễ, vắng).
- **Sơ đồ tổ chức** tự vẽ theo vai trò và tổ.
- **Thông báo** trong app, gửi qua **Zalo OA** (có hàng đợi gửi lại, giờ yên lặng ban đêm).
- **Tự sao lưu mỗi giờ**, giữ 7 ngày.
- Cập nhật **thời gian thực** giữa các máy. Dùng được trên điện thoại (cài lên màn hình chính như app).

Các giai đoạn sau: Kho (kho tổng, kho từng khu, đề xuất đặt hàng gửi Zalo), Bán hàng (sơ đồ 100 bàn, gọi món, bếp/lẩu/bar), Báo cáo doanh thu & chi phí, Hoá đơn điện tử MISA meInvoice.

## Cài đặt trên máy chủ của quán

App chạy trên **một máy để ở quán** (mini PC, laptop cũ, Windows hoặc Mac đều được). Các điện thoại và máy tính khác dùng qua wifi của quán. **Mất internet vẫn dùng bình thường.**

1. Cài **Node.js bản 22 LTS** (22.13 trở lên) từ https://nodejs.org
2. Tải thư mục `quanly` về máy (hoặc `git clone` repo rồi vào thư mục `quanly`). App **không cần cài thêm thư viện** (không cần `npm install`).
3. Mở Terminal (Mac) hoặc PowerShell (Windows) trong thư mục `quanly`, chạy:

   ```bash
   npm start
   ```

   Màn hình sẽ hiện địa chỉ, ví dụ:

   ```
   Quản lý quán đang chạy: http://localhost:3000
     Máy khác trong wifi quán mở: http://192.168.1.20:3000
   ```

4. Trên điện thoại (cùng wifi quán) mở địa chỉ thứ hai. Trên iPhone: Safari → nút Chia sẻ → **Thêm vào MH chính**. Trên Android: Chrome → ⋮ → **Thêm vào màn hình chính**.

> Nên đặt **IP cố định** cho máy chủ trong modem/router (DHCP reservation) để địa chỉ không đổi.

### Đăng nhập lần đầu

- PIN chủ quán ban đầu: **`123456`**. App bắt đổi ngay sang PIN riêng (6–8 số, không dùng số lặp/liên tiếp).
- Nhập sai PIN 5 lần thì khoá 5 phút trên máy đó.

### Thiết lập ban đầu (theo thứ tự)

1. **Cài đặt → Tổ**: sửa tên tổ, đặt **số người tối thiểu mỗi ngày** (để lịch ca cảnh báo thiếu). Mặc định có: Bếp steak, Lẩu, Bar, Phục vụ, Thu ngân, Tạp vụ.
2. **Nhân viên → Thêm nhân viên**: tên, số điện thoại, vai trò, tổ chính, **vị trí phụ** (Cơ bản / Khá / Thạo), lương, PIN.
   - PIN nhân viên/tổ trưởng/trưởng ca: 4–8 số; quản lý/chủ: 6–8 số. Mỗi người một PIN khác nhau.
   - Nhân viên đăng nhập lần đầu sẽ phải tự đổi PIN.
   - Nghỉ việc: mở người đó → Nâng cao → bỏ chọn "Đang làm việc" (giữ lại lịch sử công).
3. **Cài đặt → Loại ca**: tạo các ca theo lịch của quán (tuỳ chọn, chỉ để xếp nhanh).
4. **Cài đặt → Checklist**: sửa các checklist **(mẫu)** theo cách làm thật của từng tổ.
5. **Lịch ca**: xếp ca tuần → **Gửi lịch cho nhân viên**. Tuần sau dùng **Chép tuần trước** rồi sửa.
6. **Cài đặt → Chung**: giờ cho phép trễ, tự đóng ca, phụ cấp đêm, **chỉ chấm công trong wifi quán** (điền dải IP, vd `192.168.1.`).

### Thử với dữ liệu mẫu

```bash
npm run demo     # thêm 14 nhân viên mẫu, 4 loại ca mẫu và lịch tuần này
npm start
```

Chỉ chạy được khi chưa có nhân viên nào (tránh ghi đè dữ liệu thật). PIN mẫu in ra màn hình (vd quản lý Hùng `736251`, nhân viên Lan `5826`). Tên có chữ **(mẫu)**: xoá/sửa khi dùng thật. Muốn làm lại từ đầu: tắt app, xoá thư mục `data/`.

## Chạy tự động khi bật máy

- **Windows**: cài `pm2` một lần (`npm i -g pm2 pm2-windows-startup`, `pm2-startup install`), rồi trong thư mục `quanly`: `pm2 start server.js --name quanly --node-args="--disable-warning=ExperimentalWarning"` và `pm2 save`.
- **Mac**: `npm i -g pm2`, `pm2 start server.js --name quanly --node-args="--disable-warning=ExperimentalWarning"`, `pm2 startup` (làm theo lệnh nó in ra), `pm2 save`.
- Nên cắm **UPS** cho máy chủ và modem.

## Truy cập từ xa (chủ/quản lý xem khi không ở quán)

Dùng **Cloudflare Tunnel** (miễn phí, không cần mở cổng modem):

1. Tạo tài khoản Cloudflare, thêm tên miền của quán (hoặc mua tên miền trong Cloudflare).
2. Zero Trust → Networks → Tunnels → Create tunnel → cài `cloudflared` trên máy chủ theo hướng dẫn hiện ra.
3. Public hostname: ví dụ `quan.tenmien.vn` → Service `http://localhost:3000`.
4. Trong app: **Cài đặt → Chung → Địa chỉ truy cập từ xa** điền `https://quan.tenmien.vn`.

Khi bật "chỉ chấm công trong wifi quán", truy cập qua tunnel **không chấm công được**, nên nhân viên không chấm công từ nhà được.

## Chạy trên máy chủ cloud (Railway)

Dùng khi quán chưa có máy chạy cả ngày, hoặc muốn có link dùng ngay. Lưu ý: **mất internet ở quán thì không dùng được**.

1. Tạo tài khoản ở https://railway.com (gói Hobby khoảng 5 USD/tháng), đăng nhập bằng GitHub.
2. **New Project → Deploy from GitHub repo** → chọn repo này.
3. Vào service vừa tạo → **Settings → Root Directory**: điền `quanly`. Railway tự dùng `Dockerfile` và `railway.json` có sẵn.
4. **Settings → Volumes → Add Volume**, mount path: `/data` (bắt buộc, nếu không mỗi lần khởi động lại sẽ mất dữ liệu).
5. **Settings → Networking → Generate Domain** để có link dạng `https://xxx.up.railway.app` (hoặc gắn tên miền riêng).
6. Mở link, đăng nhập bằng PIN chủ `123456` và **đổi PIN ngay**. Gửi link cho nhân viên.

Trên cloud, "chỉ chấm công trong wifi quán" so khớp với **IP internet của quán**: mở app bằng wifi quán, xem IP ở trang https://ifconfig.me, rồi điền IP đó vào Cài đặt → Chung (IP này có thể đổi nếu nhà mạng cấp IP động).

Sao lưu trên cloud nằm trong volume `/data/backups`. Nên tải bản sao lưu về máy định kỳ.

## Bản chạy thử trên web (một file HTML)

`demo-web/` đóng gói cả máy chủ và giao diện thành **một file HTML chạy hoàn toàn trong trình duyệt** (SQLite bản WebAssembly), kèm dữ liệu mẫu và nút chọn tài khoản. Dữ liệu chỉ lưu trên trình duyệt đang mở, **không dùng chung giữa các máy**, nên chỉ để xem thử.

```bash
cd demo-web && npm install && npm run build   # ra file dist/quanly-chay-thu.html
```

## Sao lưu

- App tự sao lưu **mỗi giờ** vào `data/backups/` (giữ 7 ngày), và một bản khi tắt app. Bấm **Cài đặt → Sao lưu → Sao lưu ngay** khi cần.
- **Nên có thêm bản ngoài máy**: cài Google Drive cho máy tính và chọn đồng bộ thư mục `data/backups`, hoặc chép sang USB/ổ cứng khác mỗi tuần.
- **Khôi phục**: tắt app → chép file backup mới nhất thành `data/quanly.db` (xoá `quanly.db-wal`, `quanly.db-shm` nếu có) → bật app.

## Zalo OA

> ⚠️ Phần gửi Zalo viết theo API Zalo OA v3 (tin nhắn tư vấn) nhưng **chưa thử với OA thật**. Hãy thử và báo lại trước khi bật cho cả quán.

1. https://developers.zalo.me → tạo ứng dụng → liên kết với OA của quán.
2. Lấy **App ID**, **Secret key**; cấp quyền OA để có **Refresh token** (và Access token).
3. App: **Cài đặt → Zalo OA**: dán các khoá (chỉ lưu trên máy chủ, không bao giờ gửi xuống điện thoại).
4. Ở phần Webhook của ứng dụng Zalo: dán **Địa chỉ Webhook** hiện trong app (cần đã có truy cập từ xa), bật sự kiện người dùng gửi tin nhắn văn bản.
5. Bật "Gửi thông báo qua Zalo" → **Gửi thử cho tôi**.
6. Mỗi nhân viên: quan tâm OA → trong app vào **Tài khoản → Lấy mã liên kết** → nhắn mã cho OA.

Giới hạn của Zalo: OA chỉ gửi tin tư vấn trong một khoảng thời gian sau lần cuối người đó nhắn cho OA (khoảng 7 ngày, kiểm tra lại với Zalo). Tin không gửi được vẫn nằm trong mục Thông báo của app. Ngoài giờ yên lặng (mặc định 23:00–07:00) tin thường được dồn lại; tin gấp (nhờ làm thay, việc gấp) gửi ngay.

## Quy tắc tính giờ & lương

- **Ngày làm việc** chốt lúc 5h sáng (đổi được): ca 17:00–00:30 tính cho ngày bắt đầu.
- Giờ làm = giờ ra − giờ vào thực tế. **Giờ đêm** = phần nằm trong 22h–6h, cộng phụ cấp % (mặc định 30%) cho lương theo giờ.
- Lương theo ca: đếm số ca có chấm công; **ca gãy tính 1 ca**.
- **Quên chấm ra**: tự đóng ở giờ hết ca (sau 120 phút); chấm ngoài lịch mà quên ra thì để 0 giờ cho quản lý sửa. Cả hai đều báo trưởng ca.
- Đây là **lương tạm tính để tham khảo**, chưa gồm thưởng/phạt/bảo hiểm/tăng ca lễ. Chủ quán tự đối chiếu với Bộ luật Lao động.

## Dữ liệu cá nhân

Số điện thoại chỉ tổ trưởng trở lên thấy; lương chỉ quản lý và chủ thấy. Nên có sự đồng ý của nhân viên khi lưu thông tin cá nhân (Nghị định 13/2023/NĐ-CP). Mọi thay đổi quan trọng được ghi ở **Cài đặt → Nhật ký**.

## Dành cho người bảo trì

```bash
npm test     # test tính giờ qua đêm, giờ đêm, lương, gợi ý người thay và cả luồng API
```

- `server.js`: khởi động, sao lưu định kỳ.
- `server/`: `db.js` (cấu trúc dữ liệu SQLite), `app.js` (phiên đăng nhập, phân quyền, đồng bộ thời gian thực), `routes/*` (từng chức năng), `lib/*` (tính giờ, lương, gợi ý người thay), `notify/*` (thông báo & Zalo OA).
- `public/`: giao diện (Preact + htm, chép sẵn trong `public/vendor`, không cần build, chạy được không có internet).
- Dữ liệu nằm ở `data/quanly.db` (đổi bằng biến `DATA_DIR`), cổng đổi bằng `PORT`.
