# คู่มือ getFileName.js

สคริปต์นี้เชื่อม SFTP เพื่อดูชื่อไฟล์ CDR แล้วดาวน์โหลดเฉพาะไฟล์ `.csv` ที่ยังไม่เคยโหลดในวันนั้น จากนั้น zip เก็บ backup และย้ายไฟล์ต้นฉบับไปโฟลเดอร์ data

ต้องมีไฟล์ `getFileName.config.js` อยู่โฟลเดอร์เดียวกับสคริปต์ ไฟล์นี้มีรหัสผ่าน ห้าม commit

## สิ่งที่ต้องมี

- Node.js
- แพ็กเกจ `ssh2` และ `node-cron`

```bash
npm install ssh2 node-cron
```

โปรแกรม SFTP ขึ้นกับเครื่องที่รัน:

| เครื่อง | โปรแกรม | รหัสผ่าน |
|---|---|---|
| Windows | PuTTY `psftp.exe` | ส่งจาก `ssh.password` ใน config |
| macOS / Linux | คำสั่ง `sftp` ของระบบ | ไม่ได้ส่งรหัสผ่านในคำสั่ง ใช้ SSH key หรือค่าใน `~/.ssh/config` |

บน Windows ถ้า PuTTY ไม่ได้อยู่ที่ `C:\Program Files\PuTTY\psftp.exe` ให้ตั้งตัวแปร `PSFTP_PATH` เป็น path เต็มของ `psftp.exe` หรือใส่ path ใน `puttyPsftpCandidates` บน macOS / Linux ถ้า `sftp` ไม่อยู่ใน PATH ให้ตั้ง `SFTP_PATH`

## ตั้งค่า

สร้าง `getFileName.config.js`:

```javascript
module.exports = {
  ssh: {
    host: 'sftp.example.com',
    port: 22,
    username: 'user',
    password: 'secret',
  },
  paths: {
    remoteDir: '/cdr',
    downloadDir: './download',
    dataDir: './data',
    listBase: './downloaded',
  },
  retry: {
    maxRetries: 3,
    delayMs: 5000,
  },
  puttyPsftpCandidates: [
    'C:\\Program Files\\PuTTY\\psftp.exe',
  ],
  cron: {
    enabled: false,
    timezone: 'Asia/Bangkok',
    runOnStart: true,
    usePsftp: true,
    download: true,
    jobs: [
      {
        name: 'cdr',
        schedule: '*/10 * * * *',
        downloadFiles: [],
      },
    ],
  },
};
```

| ค่า | ความหมาย |
|---|---|
| `ssh` | โฮสต์ พอร์ต ชื่อผู้ใช้ รหัสผ่านของ SFTP |
| `paths.remoteDir` | โฟลเดอร์บนเซิร์ฟเวอร์ |
| `paths.downloadDir` | ที่วางไฟล์ตอนโหลด ก่อนย้ายไป data |
| `paths.dataDir` | ที่อยู่ของไฟล์ `.csv` หลังโหลดเสร็จ |
| `paths.listBase` | ฐานของรายชื่อที่โหลดแล้ววันนี้ |
| `retry.maxRetries` | จำนวนครั้งที่ลองเชื่อมใหม่เมื่อต่อด้วย ssh2 ไม่ได้ |
| `retry.delayMs` | ระยะรอก่อนลองใหม่ หน่วยมิลลิวินาที |
| `cron.enabled` | `true` แล้วรันคำสั่งโดยไม่มี flag จะค้างทำงานตามเวลา |
| `cron.jobs[]` | รายการงาน ถ้ามีรายการนี้ จะไม่ใช้ `cron.schedule` เดี่ยว |
| `cron.schedule` | ตารางเดี่ยว ใช้เมื่อไม่ได้ตั้ง `jobs` |
| `job.schedule` | รูปแบบ cron ของ node-cron เช่น `*/10 * * * *` คือทุก 10 นาที |
| `job.timezone` | เช่น `Asia/Bangkok` ว่างไว้ใช้เวลาของเครื่อง |
| `job.runOnStart` | รันทันทีตอนเปิดโปรเซส ค่าเริ่มต้นคือรัน |
| `job.download` | `false` คือดูชื่อไฟล์อย่างเดียว |
| `job.downloadFiles` | รายชื่อ `.csv` ที่ต้องการ ว่างไว้คือทุกไฟล์ `.csv` |
| `job.usePsftp` | งาน cron ต้องเป็น `true` |

`downloadDir`, `dataDir`, `listBase` เป็น path เทียบกับโฟลเดอร์ที่รันคำสั่ง โฟลเดอร์ backup อยู่ข้างไฟล์สคริปต์เสมอ ไม่ขึ้นกับโฟลเดอร์ที่รัน

## ทดสอบดาวน์โหลดครั้งเดียว

รันในโฟลเดอร์ที่มีสคริปต์กับ config:

```bash
node getFileName.js --once --psftp --download
```

โหลดไฟล์เดียว:

```bash
node getFileName.js --once --psftp --download --file CDR.csv
```

โหลดหลายไฟล์:

```bash
node getFileName.js --once --psftp --download --files CDR.csv,SBC_data_1.csv
```

หรือ

```bash
DOWNLOAD_FILES=CDR.csv,SBC_data_1.csv node getFileName.js --once --psftp --download
```

ชื่อที่ไม่ได้ลงท้าย `.csv` จะถูกข้าม

## คำสั่งอื่น

ดูชื่อไฟล์ผ่าน ssh2 อย่างเดียว ไม่ดาวน์โหลดและไม่สร้าง backup:

```bash
node getFileName.js --once
```

ดูชื่อไฟล์ผ่าน psftp / sftp โดยไม่ดาวน์โหลด:

```bash
node getFileName.js --once --psftp
```

เปิดตารางเวลา โปรเซสจะค้างไว้ กด Ctrl+C เพื่อหยุด:

```bash
node getFileName.js --schedule
```

ถ้า `cron.enabled` เป็น `true` และมี `cron.jobs` หรือ `cron.schedule` คำสั่ง `node getFileName.js` โดยไม่มี flag จะเข้าโหมดตารางเวลาเช่นกัน `--once`, `--psftp`, `--download` หรือ `--file` ทำให้รันครั้งเดียวแล้วจบ แม้ `cron.enabled` จะเป็น `true`

## หลังดาวน์โหลดสำเร็จ

ทำทีละไฟล์ตามลำดับนี้

1. โหลดมาไว้ที่ `downloadDir`
2. zip แล้วเก็บ backup ข้างสคริปต์

```text
backup/yyyy/mm/dd/<ชื่อไฟล์>_<HHmmss>.zip
```

ตัวอย่างไฟล์ `CDR.csv` ที่โหลดเวลา 15:40:12 วันที่ 9 พฤศจิกายน 2026:

```text
backup/2026/11/09/CDR_154012.csv.zip
```

ใน zip ยังใช้ชื่อเดิม `CDR.csv` เวลาเป็นนาฬิกา 24 ชั่วโมงของเครื่องที่รัน

3. จดชื่อไฟล์ลงรายการของวันนี้ เพื่อไม่โหลดซ้ำในวันเดียวกัน

```text
<listBase>/yyyy/mm/dd/list.txt
```

ชื่ออย่าง `SBC_data_1.csv` ซ้ำได้ทุกวัน รายการนี้ดูแค่วันนั้น พรุ่งนี้ชื่อเดิมจะถูกโหลดใหม่

4. ย้ายไฟล์ `.csv` จาก `downloadDir` ไป `dataDir`

ถ้า zip ไม่สำเร็จ ชื่อไฟล์จะยังไม่ถูกจดใน `list.txt` รอบถัดไปจึงลองใหม่ได้ ไฟล์ที่ใหญ่กว่า 4GB จะ zip ไม่ได้

## สิ่งที่สคริปต์ไม่ดาวน์โหลด

- ไฟล์ที่ไม่ได้ลงท้าย `.csv`
- ไฟล์ที่ชื่ออยู่ใน `list.txt` ของวันนี้แล้ว
- โหมด ssh2 (`node getFileName.js --once` โดยไม่มี `--psftp`) แสดงชื่อไฟล์อย่างเดียว
