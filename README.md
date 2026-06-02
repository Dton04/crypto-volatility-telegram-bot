# TeleCryp 🤖📈
> **Hệ thống giám sát thị trường Binance & Cảnh báo lệnh Futures tự động thời gian thực.**
> **Tác giả:** Tấn Đạt (Tan Dat)

---

## 🌟 Giới Thiệu
**TeleCryp** là một hệ thống microservice hiện đại được thiết kế để phân tích kỹ thuật, giám sát độ biến động volume/giá và đưa ra cảnh báo giao dịch (Trading Signals) tự động gửi đến người dùng qua Telegram. 

Hệ thống theo dõi liên tục hơn **400+ cặp giao dịch** trên sàn Binance qua kết nối WebSocket thời gian thực, tự động tính toán các tín hiệu kỹ thuật nâng cao và đề xuất các điểm vào lệnh (Entry), chặn lỗ (Stop Loss) và chốt lời (Take Profit) thông minh dựa trên phương pháp **Smart Money Concepts (SMC)** và hành vi giá.

---

## 🚀 Tính Năng Nổi Bật

### 1. Phân Tích & Xác Nhận SMC Đa Khung Thời Gian (CHoCH)
Hệ thống không chỉ đưa ra cảnh báo thô mà còn tự động liên kết đa khung thời gian để tìm điểm xoay cấu trúc thị trường (**CHoCH - Change of Character** / phá vỡ swing point gần nhất) trên khung thời gian nhỏ (LTF) khi khung thời gian lớn (HTF) có tín hiệu:
*   **1 Ngày (1D)** $\rightarrow$ Xác nhận ở **1 Giờ (1H)**
*   **4 Giờ (4H)** $\rightarrow$ Xác nhận ở **15 Phút (15m)**
*   **1 Giờ (1H)** $\rightarrow$ Xác nhận ở **5 Phút (5m)**

### 2. Thiết Lập Điểm SL/TP Tự Động Theo Râu Nến (Pattern-Aware SL)
*   **Stop Loss Động:** Nếu phát hiện các mô hình nến đảo chiều (Bullish Hammer, Engulfing, Shooting Star,...), Bot tự động tính toán điểm SL nằm ngoài râu nến xa nhất của mô hình kèm biên an toàn 0.8% để tránh các pha quét thanh khoản (Stop Hunt).
*   **Take Profit Động:** Xuất ra 2 mức chốt lời **TP1 (R:R 1:1.5)** và **TP2 (R:R 1:2.5)** dựa trên biên độ dừng lỗ thực tế.

### 3. Tín Hiệu 2 Lựa Chọn (Dual-Entry Format)
Mỗi tin nhắn cảnh báo gửi về Telegram hoặc khi sử dụng lệnh giả lập `/test <symbol>` đều cung cấp:
*   **Option 1: Direct Entry (Aggressive):** Vào lệnh trực tiếp ngay khi nến HTF đóng cửa.
*   **Option 2: SMC Confirmation (Safe):** Chờ đợi nến LTF đóng cửa xác nhận phá vỡ CHoCH kèm mức SL cực kỳ tối ưu theo cấu trúc khung nhỏ giúp tăng đòn bẩy và nâng cao tỷ lệ R:R.

### 4. Thuật Toán Cắt Giảm Giao Thức Đĩa (RAM-based Sliding Window)
*   Sử dụng cơ chế lưu trữ đệm sliding window trực tiếp trên bộ nhớ RAM để phân tích khối lượng giao dịch trong 1h/24h, giúp **giảm 99% lượng I/O đọc/ghi** vào database.

---

## 🛠️ Công Nghệ Sử Dụng (Tech Stack)
*   **Core:** TypeScript, NestJS (Modular Architecture), RxJS
*   **Database & ORM:** PostgreSQL, Prisma ORM
*   **Caching & Queue:** Redis, BullMQ (Quản lý hàng đợi tin nhắn cảnh báo bất đồng bộ)
*   **Telegram Library:** Telegraf (Telegram Bot API framework)
*   **API & Streams:** Binance API & Binance WebSocket Live Feed
*   **DevOps:** Docker, Docker Compose

---

## 📂 Cấu Trúc Mã Nguồn (Modular Architecture)
Hệ thống được thiết kế theo mô hình Monorepo chia làm hai microservice chính và một thư viện dùng chung:

```
├── apps/
│   ├── binance-worker/           # Service chịu trách nhiệm lắng nghe WebSocket, quét Klines & chạy chỉ báo kỹ thuật
│   │   └── src/
│   │       ├── indicators/       # Dịch vụ tính toán kỹ thuật thuần túy (EMA, RSI, Divergence, CHoCH, SR)
│   │       └── scanner/          # Quét dữ liệu thị trường và đẩy job cảnh báo vào hàng đợi BullMQ
│   └── telegram-bot/             # Service quản trị Telegram Bot, tiếp nhận tương tác & tiêu thụ hàng đợi gửi tin nhắn
│       └── src/
│           ├── alerts/           # Consumer xử lý tin nhắn cảnh báo từ Queue và định dạng gửi đi
│           ├── settings/         # Quản trị cấu hình bật/tắt chỉ báo của người dùng
│           ├── test-command/     # Lệnh mô phỏng giao dịch tại chỗ (/test <symbol>)
│           └── user/             # Quản lý định danh người dùng
└── libs/
    └── database/                 # Thư viện Prisma ORM & Database kết nối PostgreSQL dùng chung
```

---

## ⚙️ Hướng Dẫn Cài Đặt & Chạy Hệ Thống

### 1. Chuẩn Bị File Cấu Hình `.env`
Tạo file `.env` ở thư mục gốc của dự án với các thông tin sau:
```env
DATABASE_URL="postgresql://username:password@localhost:5432/telecryp?schema=public"
REDIS_URL="redis://localhost:6379"
TELEGRAM_BOT_TOKEN="your_telegram_bot_token"
```

### 2. Cài Đặt Thư Viện & Khởi Tạo Cơ Sở Dữ Liệu
```bash
# Cài đặt dependencies
npm install

# Đồng bộ Prisma ORM với Database
npx prisma db push
npx prisma generate
```

### 3. Khởi Chạy Ứng Dụng Trong Môi Trường Phát Triển
```bash
# Chạy Telegram Bot ở chế độ Watch Mode
npm run start:dev telegram-bot

# Chạy Binance Worker ở chế độ Watch Mode
npm run start:dev binance-worker
```

### 4. Khởi Chạy Toàn Bộ Hệ Thống Với Docker Compose
```bash
docker-compose up -d --build
```

### 5. Chạy Kiểm Thử (Unit Tests)
```bash
npm run test
```

---

## 📃 Giấy Phép & Bản Quyền
Dự án được phân phối dưới giấy phép **MIT**. Mọi đóng góp xin vui lòng gửi Pull Request hoặc liên hệ trực tiếp với tác giả **Tấn Đạt**.
