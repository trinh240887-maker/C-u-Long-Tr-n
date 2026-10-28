# MISA eShop Open API (đọc 28/10/2026)

Tài liệu: https://eshopapp.misa.vn/api/platform/documents/html (trang render JS; dữ liệu nằm trong biến `endpointsData` của script).

## Xác thực
- POST https://eshopapp.misa.vn/api/auth-platform/tokens/create  body `{ app_id, login_time, sign }`
  - login_time = Unix ms (UTC); sign = HMAC-SHA256(key = APP_KEY, msg = `app_id:{app_id};login_time:{login_time}`) → hex chữ thường
  - APP_ID / APP_KEY lấy ở màn "quản lý kết nối" trong eShop (chủ quán tự dán vào app, không gửi Claude)
  - Trả `Data.token`, `refresh_token`, `expires_in`. Làm mới: POST tokens/refresh-token `{ token, refresh_token }`
- API nghiệp vụ: base https://eshopapp.misa.vn/api/platform, header `Authorization: Bearer {token}`
- Mọi response: `{ Status: { Success, ErrorCode, Message }, Data }`

## Liên quan hoá đơn
- KHÔNG có lệnh phát hành hoá đơn điện tử trực tiếp.
- POST openpartnervouchers/orders/create: tạo đơn "Nguồn khác" (trạng thái 5 = nháp), có khối `invoice` (thông tin người mua: loại 1 công ty/2 cá nhân, MST/CCCD, tên, địa chỉ, SĐT ≤12, email).
  Bắt buộc: branch_id, stock_id, recipient_name/tel/address, shipping_service_name, weight, details[] (inventory_item_id + sku_code khớp, quantity > 0, unit_price).
- POST openpartnervouchers/einvoices: lấy hoá đơn đã phát hành (from_date, to_date, branch_id, page, page_size ≤100) → publish_status 0 chưa/1 đang/2 lỗi/3 đã phát hành, order_id…
- Cần: branchs/list, stockcategorys/list, inventoryitems/list (map món ↔ SKU eShop).
- Hướng khả thi: app tạo đơn nháp kèm thông tin xuất HĐ → người dùng phát hành HĐĐT trong eShop (eShop nối meInvoice) → app đọc einvoices để lấy trạng thái.
- meinvoice.vn trả 403 khi tải từ máy chủ; chưa có tài liệu API meInvoice trực tiếp.
