# ตลาด ข้อมูล และการเชื่อมบัญชี

## 1. สองแหล่งข้อมูล หนึ่งที่ส่งคำสั่ง

| ฝั่ง | หน้าที่ | การเข้าถึง |
| --- | --- | --- |
| Binance TH | เลือกคู่เงินบาท อ่านราคาและสมุดคำสั่ง คำนวณต้นทุน ส่งและตรวจคำสั่งจริง | Public สำหรับข้อมูลตลาด ส่วน private อยู่ใน surface backend |
| Binance Global | อ่านสถานะคู่ spot USDT และแท่งรายวันสำหรับจัดอันดับข้ามเหรียญ | Spot market data แบบ public ไม่มี API key หรือเส้นทางส่งคำสั่ง |

ใช้ adapter `ThMarketData`, `GlobalSignalData` และ `ThExecution` โดย simulator ใช้ข้อมูลและตัวตรวจคำสั่งชุดเดียวกับฝั่ง TH แต่เรียก `ThExecution` ไม่ได้ กำหนด host ฝั่ง TH เป็น `https://api.binance.th` และ Global เป็น `https://data-api.binance.vision` ห้ามส่ง key หรือ signature ข้าม host เริ่มด้วย REST และใช้ REST ยืนยันสถานะหลังเชื่อมใหม่แม้เพิ่ม stream ภายหลัง เมื่อพบ rate limit ให้เคารพ `Retry-After` และให้การตรวจคำสั่งค้างมาก่อน refresh อันดับ

| งาน | API ที่อ้างอิง |
| --- | --- |
| TH สถานะคู่และกฎ | `GET /api/v1/exchangeInfo` อ่าน `baseAsset`, `quoteAsset`, `status`, `orderTypes` และ `filters` |
| TH ราคา สภาพคล่อง และเวลา | `GET /api/v1/ticker/24hr`, `GET /api/v1/ticker/bookTicker`, `GET /api/v1/depth` ระบุ `symbol` ต่อคู่ และ `GET /api/v1/time` |
| TH ราคาย้อนหลัง | `GET /api/v1/klines` ใช้คำนวณ ATR และทดสอบการซื้อขายใน THB |
| TH ยอดบัญชีและค่าธรรมเนียม | `GET /api/v1/accountV2`, `GET /api/v1/asset/tradeFee` |
| TH ส่ง ตรวจ และยกเลิกเป็นรายคำสั่ง | `POST`, `GET`, `DELETE /api/v1/order` ใช้ `symbol` และ ID ของคำสั่ง |
| TH ตรวจรายการที่เปิดและ fill | `GET /api/v1/openOrders`, `GET /api/v1/userTrades` เทียบกับ order ID และข้อมูล fill ที่บันทึกไว้ |
| Global จับคู่ตลาดและอ่านแท่ง | `GET /api/v3/exchangeInfo`, `GET /api/v3/time`, `GET /api/v3/klines` ที่ `interval=1d` ใช้ขอบแท่ง UTC |

เอกสารสาธารณะระบุชนิดคำสั่งและ time-in-force ระดับ API ให้ยืนยันการใช้งานจริง **ต่อคู่และต่อชนิดคำสั่ง** ใน pilot ก่อนเปิดใช้ ค่า `orderTypes` เพียงอย่างเดียวไม่ได้ยืนยันว่า IOC ทำงานกับคู่นั้น และการรองรับบน Global ใช้แทนหลักฐานฝั่ง TH ไม่ได้ [Binance TH Open API](https://www.binance.th/api-docs/en/) · [Binance Global Spot Market Data](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market)

## 2. คู่เงิน ราคา และตัวกรอง

- Universe สำหรับ momentum มาจากคู่ THB ที่สถานะ `TRADING` ตัด stablecoin ฝั่ง base และคู่ที่ผู้ใช้ซ่อน ไม่มีจำนวนคู่ตายตัว เก็บเหตุผลรายคู่และเวลา snapshot แสดง quote volume 24 ชม. เป็นข้อมูลประกอบและใช้ตัดสินเมื่ออันดับเสมอ คู่ที่ volume ต่ำยังจัดอันดับได้ สิทธิ์ส่งเงินจริงพิจารณาจากคู่ที่ผ่าน pilot และสภาพคล่องของคำสั่งนั้น แสดงคู่ที่ยังไม่ผ่าน pilot เป็น “จำลองเท่านั้น”
- จับคู่กับ Global ด้วย base asset เดียวกันและ quote `USDT` จาก metadata ทั้งสองตลาด ดึงเฉพาะคู่ที่ต้องใช้และ cache ผลตามวันสัญญาณ กรณี ticker ซ้ำ เปลี่ยนชื่อ หรือมีหน่วยต่างกัน ใช้ mapping ที่ตรวจแล้วและมีเวอร์ชัน หรือคัดออกพร้อมเหตุผล
- สำหรับการเปิดสถานะ ตรวจ spread เทียบ midpoint และยอดรวมใน order book ของ TH ภายในราคา limit สำหรับ **ขนาดจริงของคำสั่ง** ค่าเริ่มต้นของนโยบายคือ spread ไม่เกิน 0.5% และสำหรับ IOC ต้องเห็น depth รองรับจำนวนที่ขอ ณ ราคา limit ขณะ preview และ submit ซึ่งยังอาจได้ partial fill ถ้า book เปลี่ยน สำหรับ GTC ที่ผู้ใช้ตั้งใจวางรอ ให้แสดงว่าจำนวนที่จับคู่ทันทีอาจเป็นศูนย์และยืนยันเงื่อนไขค้างคำสั่ง ใช้เวลา fetch ของ backend และเก็บเวลาตลาดเมื่อมี การขายลดสถานะที่ผู้ใช้ยืนยันเองใช้ราคา limit และ quote สด ไม่ติดขั้นต่ำด้านสภาพคล่องของแผนเปิด
- ตรวจ tick size, quantity step, min/max quantity, notional, price band และกฎชนิดคำสั่งจาก TH ต่อรายการหลังปัด ทั้งซื้อ ขาย และ stop limit คำนวณด้วย decimal และใช้กฎที่เข้มกว่าเมื่อ metadata กับนโยบาย surface ให้ผลต่างกัน
- `BTCTHB` เป็นคู่แรกสำหรับ pilot การอ่าน public API ในรอบเขียนสเปกพบ `MIN_NOTIONAL=100 THB` และมี `LIMIT` กับ `STOP_LOSS_LIMIT` ใน `orderTypes` ค่านี้เป็นหลักฐานประกอบการออกแบบ ตัวส่งจริงต้องอ่านกฎล่าสุด

## 3. เชื่อมบัญชีสำหรับเงินจริง

1. จาก `confirm` เปิด API Management ของ Binance TH ในเบราว์เซอร์ ผู้ใช้สร้าง key เฉพาะแอปสำหรับ read + spot trade เท่านั้น และจำกัด IP หากเครือข่ายรองรับ
2. ใช้คำสั่ง `connect` หรือ `connect-pilot` ของ backend จาก Terminal ตาม [คู่มือใช้จริง](usage.md) ตัวรับซ่อนอักขระและเก็บ key กับ secret ใน macOS Keychain UI และ JSON-RPC ของ surface ไม่รับค่าลับ การเพิ่ม OS อื่นต้องมี OS credential store ที่รองรับ
3. backend ตรวจการอ่านบัญชีและตรวจสิทธิ์ของ **key** ด้วยข้อมูลที่ venue รับรอง ค่า `canTrade` / `canWithdraw` ของบัญชีเพียงอย่างเดียวใช้สรุป scope ของ key ไม่ได้ ถ้าไม่มีวิธีตรวจ scope โดยตรง ให้เปิด `confirm` ได้เฉพาะประเภท key ที่เอกสารและหน้าจอสร้าง key ยืนยันว่าให้สิทธิ์ได้แค่ read/spot และให้ผู้ใช้ยืนยันการตั้งค่านั้น แสดงตามตรงว่าอะไรตรวจอัตโนมัติได้ หากยังยืนยันข้อจำกัดของประเภท key ไม่ได้ ให้คง read-only และถือเป็น blocker ของ pilot
4. แสดง connection ตัวระบุ key แบบปิดบัง สิทธิ์ที่ยืนยันได้ และเวลาที่อ่านบัญชีล่าสุด การเปลี่ยน key, เครื่อง, restore จาก snapshot หรือ account mismatch ต้องตรวจสถานะใหม่ก่อนส่งคำสั่ง
5. เก็บเฉพาะตัวอ้างอิง credential และ ledger ในข้อมูล surface ห้ามเก็บ secret หรือ signed request ในไฟล์ surface, SQLite, log, capture, backup, export, analytics หรือ AI prompt ห้ามมี API route ถอน โอน หรือ arbitrary signed request

เมื่อ disconnect ให้หยุดส่งใหม่และแสดงคำสั่งที่ค้างหรือยังตรวจไม่ได้ก่อนลบ credential การลบ key ในเครื่องไม่ยกเลิกคำสั่งบน Binance TH ให้แสดงทางไปจัดการคำสั่งและเพิกถอน key ที่ exchange [การจัดการ API key ของ Binance TH](https://www.binance.th/api-docs/en/)

## 4. ต้นทุนและแหล่งข้อมูลของผลลัพธ์

| โหมด | ราคาและค่าธรรมเนียม |
| --- | --- |
| `paper` ปัจจุบัน | จำลองจาก bid/ask และ depth ที่บันทึก ณ เวลาส่ง ใช้ค่าธรรมเนียมมาตรฐานคู่ THB VIP 0 ตามประกาศที่บันทึกเวอร์ชันไว้ ซึ่งเอกสารอ้างอิงระบุ 0.25% ต่อข้าง แสดงว่าเป็นค่าประมาณ การจำลองต้องไม่ fill ถ้า book ขาดหรือราคาหลุด limit |
| backtest | ใช้ข้อมูล TH ที่มี ณ เวลานั้น ติดป้ายว่า spread/slippage เป็นสมมติฐานเมื่อไม่มีข้อมูลจริง ห้ามนำ order book ปัจจุบันไปเติมช่องว่างอดีต ทดสอบต้นทุนหลายระดับ |
| `confirm` | ใช้ค่าธรรมเนียมรายคู่ที่อ่านได้ตอน preview และค่า fee/asset จริงต่อ fill ถ้า fee ล่าสุดอ่านไม่ได้ ให้ใช้เพียงอัตราสำรองที่ตรวจเวอร์ชันและยืนยันว่าเป็นเพดานสำหรับบัญชีนั้น มิฉะนั้นหยุดส่งใหม่พร้อมเหตุผล |

สำหรับราคาจาก bid/ask หรือ depth ค่า spread และผลของ depth อยู่ในราคาที่ใช้แล้ว ให้คิดเพียงครั้งเดียว ค่า fee ฝั่งซื้ออาจหักจากเหรียญที่รับ ให้ใช้จำนวนสุทธิและยอด free สำหรับขาย บันทึก fee asset แยกเพื่อประเมินเป็นบาท ณ เวลาที่ fill หากแปลงไม่ได้ให้แสดง `unmeasured` และพักการเปิดไม้ใหม่เมื่อคำนวณเพดานขาดทุนไม่ได้ [ตารางค่าธรรมเนียม VIP](https://www.binance.th/th/aboutus/spot-trading/4900a0792af24f5e853e2373b84f94e7) · [วิธีคิดค่าธรรมเนียม Binance TH](https://www.binance.th/th/faq/spot-trading/0e9f70a2b6ed49e4884b2ee0aed26051)
