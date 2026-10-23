# Label Studio

[Tiếng Việt](README.md) · [English](README.en.md) · [日本語](README.ja.md)

Ứng dụng thiết kế và in nhãn bằng máy in nhiệt PT-260. Dự án gồm giao diện
web chạy cục bộ và công cụ dòng lệnh để in nhanh nội dung hoặc hình ảnh.

## Tính năng

- Thiết kế nhãn bằng mẫu có sẵn hoặc bắt đầu từ nhãn trống.
- Thêm nội dung và hình ảnh, tạo mã QR, chỉnh sửa ảnh, xóa nền và chọn vùng ảnh.
- Xem trước, xuất PNG/PDF, lưu thiết kế và in trực tiếp lên PT-260.
- Hỗ trợ dữ liệu động để xem trước và in nhiều nhãn.
- Giao diện Tiếng Việt, English và 日本語.
- Lưu mẫu riêng trong cơ sở dữ liệu SQLite trên máy đang chạy ứng dụng.

## Yêu cầu

- Windows và Python 3.10 trở lên.
- Máy in PT-260 đã bật và ghép nối Bluetooth với máy tính (khi cần in).
- Kết nối Internet để tải model ONNX lần đầu và tải thư viện JavaScript từ CDN.

## Thiết bị thử nghiệm

Dự án được kiểm thử với máy in nhãn nhiệt PT-260: thiết bị nhỏ gọn màu đen,
có màn hình và nút điều khiển ở mặt trước, sử dụng cuộn giấy nhãn nhiệt. Máy in
kết nối với máy tính qua Bluetooth; kích thước nhãn và khoảng cách giữa các nhãn
cần được cấu hình theo cuộn giấy đang dùng.

![Máy in nhãn nhiệt PT-260 và cuộn nhãn được dùng để kiểm thử](static/images/device.png)

## Cài đặt

Mở PowerShell tại thư mục dự án, tạo môi trường ảo và cài các thư viện Python:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install Pillow pyserial qrcode
```

Nếu PowerShell không cho phép kích hoạt môi trường ảo, có thể dùng Python trực
tiếp thông qua `.\.venv\Scripts\python.exe` thay cho `python`.

## Cấu hình máy in

Ghép nối PT-260 với Windows trước, sau đó chạy:

```powershell
python detect_printer.py
```

Nhập kích thước nhãn và khoảng cách giữa các nhãn theo milimét. Chương trình sẽ
tìm cổng máy in và ghi cấu hình vào `printer.env`. File này được Git bỏ qua vì
có cấu hình riêng cho từng máy.

## Chạy giao diện thiết kế

```powershell
python label_maker.py
```

Mở [http://127.0.0.1:8765](http://127.0.0.1:8765) trong trình duyệt. Dừng máy
chủ bằng `Ctrl+C`.

Máy chủ hiện lắng nghe trên tất cả giao diện mạng (`0.0.0.0`). Chỉ chạy trên
mạng tin cậy và không chuyển tiếp cổng này ra Internet.

### Tải model ONNX

Các file ONNX dung lượng lớn không được lưu trong Git. Tải chúng trước khi dùng
các chức năng chọn vùng ảnh và xóa nền:

```powershell
python download_models.py
```

Script tải các model vào `static/models/`, bỏ qua file đã có và chỉ thay file
đích sau khi tải thành công. Dùng `python download_models.py --force` để tải lại.
Các model được ghim theo revision; thông tin nguồn và giấy phép nằm trong
[static/models/README.txt](static/models/README.txt).

## In từ dòng lệnh

Sau khi cấu hình máy in, in văn bản:

```powershell
python print_label.py --text "Tên sản phẩm - 25.000đ"
```

In ảnh:

```powershell
python print_label.py --image ".\static\images\sample.png"
```

Với ảnh chụp có sắc độ xám, có thể bật dithering:

```powershell
python print_label.py --image ".\static\images\sample.png" --dither
```

Chạy `python print_label.py` không có tham số để nhập nội dung tương tác.

## Dữ liệu và giấy phép

- Thiết kế mẫu được lưu cục bộ trong `label-studio.sqlite3`; mẫu riêng được
  gắn với fingerprint của trình duyệt, không phải tài khoản bảo mật.
- `printer.env`, cơ sở dữ liệu và các file `*.onnx` được loại khỏi Git.
- Model RMBG-1.4 có điều khoản mặc định hạn chế sử dụng thương mại. Đọc giấy
  phép trong [static/models/README.txt](static/models/README.txt) và xin giấy
  phép phù hợp từ BRIA trước khi sử dụng hoặc phân phối cho mục đích thương mại.
- Thông tin ghi công và giấy phép sticker OpenMoji được cung cấp trong
  [static/stickers/ATTRIBUTION.txt](static/stickers/ATTRIBUTION.txt) và
  `static/stickers/OPENMOJI-LICENSE.txt`.

## Cấu trúc chính

```text
label_maker.py       Máy chủ giao diện web và API cục bộ
print_label.py       Tạo lệnh TSPL và in nhãn từ dòng lệnh
detect_printer.py    Phát hiện máy in, ghi cấu hình printer.env
download_models.py   Tải model ONNX vào static/models/
static/              Giao diện, mẫu nhãn, sticker và cấu hình model
```
