# Lỗi tải tài liệu API MISA eShop

Ngày thử: 2026-10-22 (phiên Claude Code trên cloud).
Kết quả: **không tải được trang nào** → chưa có file gốc, chưa có `TOM-TAT.md`.
Không ghi bất kỳ nội dung đoán nào về API.

## URL cần tải
1. https://eshopapp.misa.vn/api/platform/documents/html
2. https://helpeshop.misa.vn/kb/ket-noi-voi-cac-ung-dung-khac-qua-open-api-tren-may-tinh

## Lỗi gặp
| Cách thử | Lỗi |
|---|---|
| `curl` qua proxy của môi trường | `CONNECT tunnel failed, response 403` (proxy từ chối host `eshopapp.misa.vn:443`, `helpeshop.misa.vn:443`) |
| Công cụ WebFetch | `getaddrinfo ENOTFOUND eshopapp.misa.vn` / `ENOTFOUND helpeshop.misa.vn` |
| Bản lưu web.archive.org, r.jina.ai | Cũng bị proxy chặn (403) |
| Tìm kiếm web | Không thấy bản sao tài liệu eShop Open API ở nơi khác |

Nguyên nhân: chính sách mạng (Network access) của môi trường cloud không cho phép các tên miền `*.misa.vn`.

## Cách mở
Vào cài đặt môi trường cloud (menu môi trường ở thanh tiêu đề phiên → Edit) → Network access:
thêm `eshopapp.misa.vn`, `helpeshop.misa.vn` (nên thêm cả `misa.vn`, `*.misa.vn`) vào Allowed domains,
hoặc chọn mức truy cập rộng hơn. Hướng dẫn: https://code.claude.com/docs/en/cloud-environments#network-access

Cách khác: chủ quán mở 2 link trên bằng máy tính, "Lưu trang" (Ctrl+S) hoặc in PDF, rồi tải file lên repo vào thư mục `docs/misa/`.

## Ghi chú phụ (từ kết quả tìm kiếm, chưa kiểm chứng nội dung)
- MISA meInvoice (HĐĐT, sản phẩm khác với eShop) có tài liệu cho lập trình viên tại https://doc.meinvoice.vn — cũng thuộc tên miền cần cho phép nếu muốn tải.
