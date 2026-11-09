/**
 * Connect SFTP แสดงชื่อไฟล์ / ดาวน์โหลด — ค่าตั้งใน getFileName.config.js
 *
 * รันครั้งเดียวแล้วจบ:
 *   node getFileName.js --once
 *   node getFileName.js --once --psftp
 *   node getFileName.js --once --psftp --download
 *   node getFileName.js --once --psftp --download --file CDR.csv
 *
 * หลังดาวน์โหลดสำเร็จ จะ zip ไฟล์นั้นแล้วเก็บ backup ที่
 *   ./backup/yyyy/mm/dd/<ชื่อไฟล์>_<HHmmss>.zip
 * (โฟลเดอร์อยู่ข้างสคริปต์นี้)
 *
 * รันตาม schedule ใน config (cron.enabled: true) หรือบังคับ:
 *   node getFileName.js --schedule
 *   หลาย schedule ได้ที่ cron.jobs[] ใน getFileName.config.js
 *   (โปรเซสค้างไว้ — กด Ctrl+C หยุด)
 *
 * env: DOWNLOAD_FILES=a.csv,b.csv (ใช้กับ --once + --download)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cron = require('node-cron');
const { Client } = require('ssh2');
const { spawn } = require('child_process');

let appConfig;
try {
  appConfig = require('./getFileName.config.js');
} catch (err) {
  console.error('โหลด getFileName.config.js ไม่ได้:', err.message);
  process.exit(1);
}

const REMOTE_DIR = appConfig.paths.remoteDir;
const DOWNLOAD_DIR = appConfig.paths.downloadDir;
const DATA_DIR = appConfig.paths.dataDir;
const LIST_BASE = appConfig.paths.listBase;
const MAX_RETRIES = appConfig.retry.maxRetries;
const RETRY_DELAY_MS = appConfig.retry.delayMs;

const config = {
  ...appConfig.ssh,
  authHandler: (methodsLeft, partialSuccess, cb) => cb('password'),
};

function isCsvRemoteName(name) {
  return name.toLowerCase().endsWith('.csv');
}

/**
 * ชื่อไฟล์จาก CLI / env (ว่าง = ทุก .csv ตาม logic เดิม)
 */
function parseDownloadFileArgs() {
  const argv = process.argv;
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') {
      if (argv[i + 1]) names.push(argv[++i]);
      continue;
    }
    if (a.startsWith('--file=')) {
      names.push(a.slice('--file='.length));
      continue;
    }
    if (a === '--files') {
      if (argv[i + 1]) {
        argv[++i].split(',').forEach((s) => {
          const t = s.trim();
          if (t) names.push(t);
        });
      }
      continue;
    }
  }
  if (names.length === 0 && process.env.DOWNLOAD_FILES) {
    process.env.DOWNLOAD_FILES.split(',').forEach((s) => {
      const t = s.trim();
      if (t) names.push(t);
    });
  }
  return names;
}

function getListPathForToday() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return path.join(LIST_BASE, String(y), m, d, 'list.txt');
}

/** ชื่อที่โหลดแล้ววันนี้เท่านั้น — ชื่อ SBC_data_N.csv ซ้ำทุกวัน */
function readDownloadedSet() {
  const set = new Set();
  const listPath = getListPathForToday();
  if (!fs.existsSync(listPath)) return set;
  const content = fs.readFileSync(listPath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const fn = line.trim();
    if (fn) set.add(fn);
  });
  return set;
}

function appendToDownloadedList(filename) {
  const listPath = getListPathForToday();
  const dir = path.dirname(listPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(listPath, filename + '\n', 'utf8');
}

function resolvePuttyPsftpExe() {
  const fromEnv = process.env.PSFTP_PATH;
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) {
      throw new Error(`PSFTP_PATH ไม่พบไฟล์: ${fromEnv}`);
    }
    return fromEnv;
  }
  const candidates = appConfig.puttyPsftpCandidates || [
    'C:\\Program Files\\PuTTY\\psftp.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    'ไม่พบ psftp.exe — ติดตั้ง PuTTY หรือตั้ง PSFTP_PATH ให้ชี้ไปที่ psftp.exe',
  );
}

function getExternalSftpSpawnSpec() {
  const isWin = process.platform === 'win32';
  const port = config.port || 22;
  if (isWin) {
    const exe = resolvePuttyPsftpExe();
    const args = ['-pw', config.password, '-batch'];
    if (port !== 22) args.push('-P', String(port));
    args.push(`${config.username}@${config.host}`);
    return { exe, args, listCmd: 'dir' };
  }
  const exe = process.env.SFTP_PATH || 'sftp';
  const args = ['-o', 'StrictHostKeyChecking=no'];
  if (port !== 22) args.push('-P', String(port));
  args.push(`${config.username}@${config.host}`);
  return { exe, args, listCmd: 'ls -la' };
}

function connectWithRetry() {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    function tryConnect() {
      attempt++;
      const conn = new Client();
      conn.on('ready', () => resolve(conn));
      conn.on('error', (err) => {
        conn.end();
        const retryable =
          err.code === 'ECONNRESET' ||
          err.code === 'ETIMEDOUT' ||
          err.code === 'ECONNREFUSED';
        if (retryable && attempt < MAX_RETRIES) {
          console.log(
            `Connect failed (${err.code}), retry ${attempt}/${MAX_RETRIES} in ${RETRY_DELAY_MS}ms...`,
          );
          setTimeout(tryConnect, RETRY_DELAY_MS);
        } else {
          reject(err);
        }
      });
      conn.connect(config);
    }
    tryConnect();
  });
}

function listViaSsh2(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.readdir(REMOTE_DIR, (err, list) => {
        if (err) return reject(err);
        const files = (list || [])
          .filter((item) => item.filename !== '.' && item.filename !== '..')
          .map((item) => item.filename);
        resolve(files);
      });
    });
  });
}

function listViaPsftp() {
  return new Promise((resolve, reject) => {
    const { exe, args, listCmd } = getExternalSftpSpawnSpec();
    const proc = spawn(exe, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0 && !stdout) {
        return reject(new Error(stderr || stdout || `exit ${code}`));
      }
      const lines = stdout.split(/\r?\n/);
      const files = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        if (parts.length < 8 || !/^[-d]/.test(parts[0])) continue;
        const name =
          parts.length >= 9
            ? parts.slice(8).join(' ')
            : parts.slice(7).join(' ');
        const fn = name.trim();
        if (fn && fn !== '.' && fn !== '..') files.push(fn);
      }
      resolve(files);
    });
    proc.stdin.write(`cd ${REMOTE_DIR}\n${listCmd}\nbye\n`);
    proc.stdin.end();
  });
}

function runPsftpWithCommands(commands) {
  return new Promise((resolve, reject) => {
    const { exe, args } = getExternalSftpSpawnSpec();
    const proc = spawn(exe, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `psftp exit ${code}`));
      } else {
        resolve();
      }
    });
    proc.stdin.write(commands.join('\n') + '\nbye\n');
    proc.stdin.end();
  });
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    ((date.getSeconds() / 2) | 0);
  const dosDate =
    ((date.getFullYear() - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { time, dosDate };
}

/** zip ไฟล์เดียว (deflate) — ไม่พึ่งคำสั่ง zip ของระบบ เพื่อให้รันบน Windows ได้ */
function buildSingleFileZip(entryName, data, date) {
  const nameBuf = Buffer.from(entryName, 'utf8');
  const compressed = zlib.deflateRawSync(data);
  const crc = crc32(data);
  const { time, dosDate } = dosDateTime(date);
  const flags = 0x800;

  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(flags, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  nameBuf.copy(local, 30);

  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(flags, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  nameBuf.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + compressed.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([local, compressed, central, eocd]);
}

/** CDR.csv + 15:40:12 → CDR_154012.csv.zip */
function backupZipName(filename, date) {
  const stamp = [
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ]
    .map((n) => String(n).padStart(2, '0'))
    .join('');
  const ext = path.extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  return `${stem}_${stamp}${ext}.zip`;
}

/**
 * zip ไฟล์ที่ดาวน์โหลดแล้ว เก็บที่ <script>/backup/yyyy/mm/dd/<ชื่อ>_<HHmmss>.zip
 * @returns {string} path ของ zip
 */
function backupDownloadedFile(localFilePath, date = new Date()) {
  if (!fs.existsSync(localFilePath)) {
    throw new Error(`ไม่พบไฟล์สำหรับ backup: ${localFilePath}`);
  }
  const data = fs.readFileSync(localFilePath);
  if (data.length >= 0xffffffff) {
    throw new Error(`ไฟล์ใหญ่เกิน 4GB zip ไม่ได้: ${localFilePath}`);
  }
  const y = String(date.getFullYear());
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const backupDir = path.join(__dirname, 'backup', y, m, d);
  fs.mkdirSync(backupDir, { recursive: true });
  const base = path.basename(localFilePath);
  const zipPath = path.join(backupDir, backupZipName(base, date));
  fs.writeFileSync(zipPath, buildSingleFileZip(base, data, date));
  console.log('  backup ->', zipPath);
  return zipPath;
}

function downloadViaPsftp(files, listFilePath) {
  if (files.length === 0) {
    console.log('ไม่มีไฟล์ให้ดาวน์โหลด');
    return Promise.resolve();
  }
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    console.log('สร้างโฟลเดอร์:', DOWNLOAD_DIR);
  }
  const absDir = path.resolve(DOWNLOAD_DIR);
  const lcdPath =
    process.platform === 'win32' ? absDir.replace(/\\/g, '/') : absDir;

  const downloadOne = (filename) => {
    const commands = [
      `cd ${REMOTE_DIR}`,
      `lcd "${lcdPath}"`,
      `get "${filename}"`,
    ];
    return runPsftpWithCommands(commands).then(() => {
      backupDownloadedFile(path.join(absDir, filename));
      if (listFilePath) appendToDownloadedList(filename);
    });
  };

  console.log('กำลังดาวน์โหลด', files.length, 'ไฟล์ไปที่', absDir);
  return files.reduce((p, f, i) => {
    return p.then(() => {
      console.log(`  [${i + 1}/${files.length}] ${f}`);
      return downloadOne(f);
    });
  }, Promise.resolve());
}

function moveExtractedToData(dirPath) {
  const dataDir = path.resolve(DATA_DIR);
  console.log(">>>>>",DATA_DIR);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const files = fs.readdirSync(dirPath);
  let moved = 0;
  for (const name of files) {
    if (!isCsvRemoteName(name)) continue;
    const src = path.join(dirPath, name);
    const stat = fs.statSync(src);
    if (!stat.isFile()) continue;
    const dest = path.join(dataDir, name);
    try {
      fs.renameSync(src, dest);
      console.log('  move -> data:', name);
      moved++;
    } catch (err) {
      console.error('  move error:', name, err.message);
    }
  }
  if (moved > 0) console.log('ย้าย', moved, 'ไฟล์ไปที่', DATA_DIR);
}

function printFiles(files) {
  console.log('โฟลเดอร์:', REMOTE_DIR);
  console.log('จำนวนไฟล์:', files.length);
  console.log('--- ชื่อไฟล์ ---');
  files.forEach((item, i) => {
    console.log(`${i + 1}. ${item}`);
  });
}

/**
 * @param {{ doDownload: boolean, explicitDownloadNames: string[], label?: string }} opts
 * @returns {Promise<number>} exit code 0 | 1
 */
async function runPsftpDownloadJob(opts) {
  const { doDownload, explicitDownloadNames, label } = opts;
  let exitCode = 0;
  const prefix = label ? `[${label}] ` : '';
  console.log(prefix + 'ใช้ PuTTY psftp...');
  try {
    const files = await listViaPsftp();
    printFiles(files);

    if (!doDownload || files.length === 0) {
      return exitCode;
    }

    let csvOnly = files.filter(isCsvRemoteName);
    if (explicitDownloadNames.length > 0) {
      const wantedLower = new Set(
        explicitDownloadNames.map((n) => n.toLowerCase()),
      );
      for (const n of explicitDownloadNames) {
        if (!isCsvRemoteName(n)) {
          console.warn(
            prefix + 'ข้ามชื่อ (ต้องลงท้าย .csv):',
            n,
          );
        }
      }
      const onServerLower = new Set(files.map((f) => f.toLowerCase()));
      for (const n of explicitDownloadNames) {
        if (!isCsvRemoteName(n)) continue;
        if (!onServerLower.has(n.toLowerCase())) {
          console.warn(prefix + 'ไม่พบบนเซิร์ฟเวอร์:', n);
        }
      }
      csvOnly = files.filter(
        (f) => isCsvRemoteName(f) && wantedLower.has(f.toLowerCase()),
      );
      console.log(
        prefix + 'โหมดกำหนดชื่อไฟล์:',
        explicitDownloadNames.filter(isCsvRemoteName).join(', ') ||
          '(ไม่มีชื่อ .csv ที่ใช้ได้)',
      );
    } else if (csvOnly.length < files.length) {
      console.log(
        prefix + 'ข้ามไฟล์ที่ไม่ใช่ .csv:',
        files.length - csvOnly.length,
        'ไฟล์',
      );
    }

    const downloadedSet = readDownloadedSet();
    const toDownload = csvOnly.filter((f) => !downloadedSet.has(f));
    if (toDownload.length < csvOnly.length) {
      console.log(
        prefix + 'ข้ามไฟล์ที่โหลดแล้ว:',
        csvOnly.length - toDownload.length,
        'ไฟล์',
      );
    }

    if (toDownload.length > 0) {
      const listPath = getListPathForToday();
      await downloadViaPsftp(toDownload, listPath);
      console.log(prefix + 'ดาวน์โหลดเสร็จที่', DOWNLOAD_DIR);
      moveExtractedToData(path.resolve(DOWNLOAD_DIR));
    } else if (csvOnly.length === 0) {
      console.log(prefix + 'ไม่มีไฟล์ .csv บนเซิร์ฟเวอร์สำหรับดาวน์โหลด');
    } else {
      console.log(prefix + 'ไม่มีไฟล์ .csv ใหม่ให้ดาวน์โหลด');
    }
  } catch (err) {
    console.error(prefix + 'psftp error:', err.message);
    if (process.platform === 'win32') {
      console.error(
        prefix +
          'ตรวจสอบ: ติดตั้ง PuTTY หรือตั้ง PSFTP_PATH เป็น path เต็มของ psftp.exe',
      );
    }
    exitCode = 1;
  }
  return exitCode;
}

function mergeCronJob(job, index, parent) {
  const name = job.name || `job${index + 1}`;
  return {
    name,
    schedule: job.schedule,
    timezone: job.timezone ?? parent.timezone,
    runOnStart:
      job.runOnStart !== undefined
        ? job.runOnStart
        : parent.runOnStart !== undefined
          ? parent.runOnStart
          : true,
    usePsftp:
      job.usePsftp !== undefined
        ? job.usePsftp
        : parent.usePsftp !== undefined
          ? parent.usePsftp
          : true,
    download:
      job.download !== undefined
        ? job.download
        : parent.download !== undefined
          ? parent.download
          : true,
    downloadFiles:
      job.downloadFiles !== undefined
        ? job.downloadFiles
        : parent.downloadFiles !== undefined
          ? parent.downloadFiles
          : [],
  };
}

/** รายการงาน cron: จาก jobs[] หรือจาก schedule เดี่ยวระดับบน */
function normalizeCronJobs() {
  const c = appConfig.cron || {};
  if (Array.isArray(c.jobs) && c.jobs.length > 0) {
    return c.jobs.map((job, i) => mergeCronJob(job, i, c));
  }
  if (c.schedule) {
    return [
      mergeCronJob(
        {
          name: c.name || 'default',
          schedule: c.schedule,
          timezone: c.timezone,
          runOnStart: c.runOnStart,
          usePsftp: c.usePsftp,
          download: c.download,
          downloadFiles: c.downloadFiles,
        },
        0,
        c,
      ),
    ];
  }
  return [];
}

function startScheduler() {
  const jobs = normalizeCronJobs();
  if (jobs.length === 0) {
    console.error(
      'ไม่มี cron job — ตั้ง cron.jobs หรือ cron.schedule ใน getFileName.config.js',
    );
    process.exit(1);
  }

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (!job.schedule || !cron.validate(job.schedule)) {
      console.error(
        `cron job "${job.name}" — schedule ไม่ถูกต้อง:`,
        job.schedule,
      );
      process.exit(1);
    }
    if (job.usePsftp === false) {
      console.error(
        `cron job "${job.name}" ต้องใช้ usePsftp: true (ดาวน์โหลดผ่าน psftp)`,
      );
      process.exit(1);
    }

    const explicit =
      Array.isArray(job.downloadFiles) && job.downloadFiles.length > 0
        ? job.downloadFiles
        : [];
    const doDownload = job.download !== false;

    const runJob = () => {
      const ts = new Date().toISOString();
      console.log(`\n--- cron "${job.name}" ${ts} ---`);
      runPsftpDownloadJob({
        doDownload,
        explicitDownloadNames: explicit,
        label: `cron:${job.name}`,
      }).then((code) => {
        if (code !== 0) console.error(`[cron:${job.name}] exit code`, code);
      });
    };

    if (job.runOnStart !== false) {
      runJob();
    }

    const opts = {};
    if (job.timezone) opts.timezone = job.timezone;
    cron.schedule(job.schedule, runJob, opts);

    console.log(
      `ลงทะเบียน cron "${job.name}":`,
      job.schedule,
      job.timezone ? `timezone=${job.timezone}` : '(local)',
    );
  }

  console.log('รวม', jobs.length, 'งาน cron');
}

async function runOnceFromArgv() {
  const argv = process.argv;
  const usePsftp = argv.includes('--psftp');
  const doDownload = argv.includes('--download');
  const explicitDownloadNames = parseDownloadFileArgs();

  if (usePsftp) {
    return runPsftpDownloadJob({ doDownload, explicitDownloadNames });
  }

  let conn;
  let exitCode = 0;
  try {
    conn = await connectWithRetry();
  } catch (err) {
    console.error('Connect error:', err.message);
    console.log('\nลองใช้ PuTTY แทน: node getFileName.js --once --psftp');
    return 1;
  }

  try {
    const files = await listViaSsh2(conn);
    printFiles(files);
  } catch (err) {
    console.error('List error:', err.message);
    exitCode = 1;
  } finally {
    try {
      conn.end();
    } catch (_) {}
  }
  return exitCode;
}

function hasCronConfig() {
  const c = appConfig.cron || {};
  if (Array.isArray(c.jobs) && c.jobs.length > 0) return true;
  if (c.schedule) return true;
  return false;
}

async function main() {
  const argv = process.argv;
  /** มี flag CLI ที่บอกว่าต้องการรันครั้งเดียวแล้วจบ (ไม่ค้าง cron) */
  const explicitOneShot =
    argv.includes('--once') ||
    argv.includes('--psftp') ||
    argv.includes('--download') ||
    parseDownloadFileArgs().length > 0;

  const cronReady = hasCronConfig();
  if (argv.includes('--schedule') && !cronReady) {
    console.error(
      '--schedule ต้องมี cron.jobs (อย่างน้อย 1 งาน) หรือ cron.schedule ใน getFileName.config.js',
    );
    return 1;
  }

  const useScheduler =
    (appConfig.cron?.enabled || argv.includes('--schedule')) &&
    cronReady &&
    !argv.includes('--once') &&
    !explicitOneShot;

  if (useScheduler) {
    startScheduler();
    return null;
  }

  return runOnceFromArgv();
}

if (require.main === module) {
  main()
    .then((code) => {
      if (code === null) return;
      process.exit(typeof code === 'number' ? code : 0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
