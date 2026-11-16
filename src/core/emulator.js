'use strict';
/**
 * Emulator 引擎：驱动 Google 官方 Android Emulator 作为 ApkStart 的运行时。
 *
 * 与旧版最大的不同：这里不再假设「一套参数在所有电脑上都能跑」。
 *  1. 用 doctor.chooseProfile() 按内存/CPU/磁盘/加速状态/引擎版本自动推导参数；
 *  2. 启动失败时按 planVariants() 自动降级重试（GPU 后端 → 软件模拟 → 最小内存冷启动）；
 *  3. 动态挑空闲端口、清 AVD 锁、中文路径转短路径、镜像变更后自动作废快照；
 *  4. quickboot 快照 + 小数据分区，做到「像容器一样」共享只读基础层、秒级恢复。
 *
 * probe 回调由上层（Runtime）提供，用于判断 Android 是否真正就绪。
 */
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Provisioner } = require('./provision');
const doctor = require('./doctor');

const AVD_NAME = 'apkstart';
const SNAPSHOT_NAME = 'apkstart-gles';
// 避开 Windows 快照加载时恢复 Goldfish 共享图形内存的路径，
// 保留宿主 GLES 渲染与 WHPX，解码模式也纳入快照指纹。
const GRAPHICS_FEATURES = process.platform === 'win32'
    ? '-Vulkan,-HasSharedSlotsHostMemoryAllocator,-GLDMA,-GLDMA2,-WindowsOnDemandSnapshotLoad'
    : '-Vulkan';
const EXPERIMENTAL_DECODER_VERSION = /^36\.4\.9(?:\.0)?$/;
const SNAPSHOT_PROFILE_FILE = 'apkstart-profile';
const SNAPSHOT_BOOT_TIMEOUT_MS = 30000;
const SNAPSHOT_SAVE_TIMEOUT_MS = 45000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class EmulatorEngine {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.proc = null;
    this._log = [];
    this.port = 5554;
    this.parkWindow = null;
    this.adbPort = Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044;
    this.profile = null;
    this.attempts = [];
    this.lastDiagnosis = null;
    this.snapshotReady = false;
    this.snapshotSave = null;
    this.stopping = null;
  }

  log(line) {
    this._log.push({ t: Date.now(), line });
    if (this._log.length > 600) this._log.shift();
  }

  get settings() { return store.getSettings(); }

  get serial() { return `emulator-${this.port}`; }

  /** emulator.exe 与系统镜像目录（优先用户运行时目录，回退到仓库内 engine/） */
  locate() {
    const p = this.provisioner.paths();
    const emulatorExe = this.provisioner.emulatorExecutable();
    const img = this.provisioner.systemImageInfo();
    return { emulatorExe, sysImgDir: img.dir, sysImgOk: img.ok, root: p.root };
  }

  /** 选镜像：有通用镜像（API 34 Play）就用它，不再让用户切「兼容模式」 */
  imageChoice() {
    const play = this.provisioner.playImageInfo();
    const base = this.provisioner.systemImageInfo();
    if (play.ok) {
      return { compat: true, api: play.api, tag: play.tag, dir: play.dir, abi: 'x86_64' };
    }
    return { compat: false, api: base.api, tag: base.tag, dir: base.dir, abi: base.abi || this.provisioner.paths().sysAbi };
  }

  /**
   * 作废 quickboot 快照。
   * 快照同时保存内存和磁盘镜像，装完新应用/清了数据后如果还加载旧快照，
   * 用户会看到「刚刚装好的应用重启后又不见了」。
   */
  invalidateSnapshot() {
    try {
      const snapDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots');
      fs.rmSync(snapDir, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 清掉上次异常退出留下的锁。
   * 注意 hardware-qemu.ini.lock 是**目录**不是文件，bsdtar 式的 rmSync(force) 删不掉它，
   * 于是模拟器会一直报 "Running multiple emulators with the same AVD" 起不来
   * （被强杀过一次就会这样），必须递归删。
   */
  clearLocks(avdDir) {
    try {
      for (const f of fs.readdirSync(avdDir)) {
        if (!/\.lock$/i.test(f)) continue;
        try {
          fs.rmSync(path.join(avdDir, f), { recursive: true, force: true });
        } catch (_) { /* 被占用就跳过，下次再清 */ }
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * 检查当前命名快照是否包含可恢复的元数据和内存文件。
   * @param {boolean} [checkProfile] 是否要求快照与当前运行时配置一致。
   * @returns {boolean} 当前快照是否值得尝试加载。
   */
  hasSnapshot(checkProfile = true) {
    try {
        const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME);
        const meta = fs.statSync(path.join(dir, 'snapshot.pb'), { throwIfNoEntry: false });
        const memory = ['ram.bin', 'ram.img'].some((file) => {
            const stat = fs.statSync(path.join(dir, file), { throwIfNoEntry: false });
            return stat?.isFile() && stat.size > 0;
        });
        if (!(meta?.isFile() && meta.size > 0 && memory)) return false;
        return !checkProfile || !this.currentSnapshotKey
            || fs.readFileSync(path.join(dir, SNAPSHOT_PROFILE_FILE), 'utf8') === this.currentSnapshotKey;
    } catch (_) {
        return false;
    }
  }

  /**
   * 移开恢复失败的快照，保留其文件供诊断，并让下次启动跳过它。
   * @returns {Promise<boolean>} 快照是否已移开。
   */
  async archiveFailedSnapshot() {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME);
    const archive = `${dir}.failed-${Date.now()}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            await fs.promises.rename(dir, archive);
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') return true;
            if (attempt < 2) await sleep(750);
        }
    }
    return false;
  }

  /**
   * 清掉占着 AVD 锁的孤儿模拟器。
   * emulator.exe 只是个启动器，真正的 qemu 被 spawn 成独立进程（detached），
   * 所以只 kill 自己手上的 proc 句柄经常留个孤儿在那占着 multiinstance.lock，
   * 下一次启动就会 FATAL "Running multiple emulators with the same AVD"。
   * 按「AVD 锁里的 pid」+「命令行带本 AVD 名的 qemu/emulator」两个来源清。
   */
  async killOrphanProcesses({ onLog = () => {} } = {}) {
    if (process.platform !== 'win32') return 0;
    const { execFile } = require('child_process');
    const avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const pids = new Set();
    // 1) 锁文件里 emulator 自己写的 pid（最可靠）
    try {
      const f = path.join(avdDir, 'hardware-qemu.ini.lock', 'pid');
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
        if (pid) pids.add(pid);
      }
    } catch (_) { /* ignore */ }
    // 2) 兜底：命令行里引用本 AVD 的 qemu / emulator
    try {
      const out = await new Promise((res) => execFile(
        'wmic',
        ['process', 'where', "name='qemu-system-x86_64.exe' or name='emulator.exe'", 'get', 'processid,commandline', '/format:csv'],
        { windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
        (e, o) => res(e ? '' : o || ''),
      ));
      for (const line of String(out).split('\n')) {
        if (line.includes(AVD_NAME) && /qemu|emulator/i.test(line)) {
          const m = /,(\d+)\s*$/.exec(line.trim());
          if (m) pids.add(Number(m[1]));
        }
      }
    } catch (_) { /* wmic 不可用就只靠锁文件 */ }
    pids.delete(process.pid);
    if (!pids.size) {
      this.clearLocks(avdDir);
      return 0;
    }
    onLog(`清理 ${pids.size} 个残留模拟器进程`);
    await Promise.all([...pids].map((pid) => new Promise((r) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r());
    })));
    await sleep(1200);
    this.clearLocks(avdDir);
    return pids.size;
  }

  /**
   * 准备 AVD：写 config.ini。每次启动按当前自动配置重写，保证降级重试即时生效。
   * @param {object} options 内存、核心数、图形后端、分区、加速、快照和屏幕选项。
   * @returns {object} AVD 路径和本次开机配置。
   */
  ensureAvd({
    memoryMB = 2048, cores = 2, gpu = 'software', dataMB = 4096,
    heapMB = 256, accel = 'auto', snapshot = true, wipe = false, lcd = null, hardwareDecode = false,
  } = {}) {
    const p = this.provisioner.ensureDirs();
    const home = p.avdHome;
    const avdDir = path.join(home, `${AVD_NAME}.avd`);
    fs.mkdirSync(avdDir, { recursive: true });
    this.clearLocks(avdDir);

    // 屏幕分辨率：有硬件加速时 720x1280@320 画面清晰、文字不糊；
    // 纯软件模拟时降到 540x960，帧率优先（面积只有 56%，肉眼差距远小于流畅度差距）。
    const screen = lcd || doctor.lcdFor({ accelOk: this.profile ? this.profile.accelOk : accel !== 'off' });

    const choice = this.imageChoice();
    const tag = choice.tag;
    const api = choice.api;
    const tagDisplay = choice.compat ? 'Google Play (ARM 兼容)' : 'AOSP';

    fs.writeFileSync(
      path.join(home, `${AVD_NAME}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir.replace(/\\/g, '/')}\ntarget=android-${api}\n`,
    );

    const cfgPath = path.join(avdDir, 'config.ini');
    const wantImg = choice.dir
      ? `${choice.dir.replace(/\\/g, '/')}/`
      : `system-images/android-${api}/${tag}/${choice.abi}/`;
    this.wipePending = false;
    if (fs.existsSync(cfgPath)) {
      const prev = fs.readFileSync(cfgPath, 'utf8');
      const prevTag = /tag\.id=(.+)$/m.exec(prev);
      const prevImg = /image\.sysdir\.1=(.+)$/m.exec(prev);
      if ((prevTag && prevTag[1].trim() !== tag) || (prevImg && prevImg[1].trim() !== wantImg)) {
        // 旧 userdata 与新镜像不兼容（APEX 引导循环），必须重建
        this.wipePending = true;
      }
    }

    // 配置指纹变化 → 旧 quickboot 快照必然加载失败或产生黑屏，主动作废
    const dataKey = doctor.snapshotKey({
      dataMB, emulatorVersion: this._emuVersion || '', api, tag,
    }, choice.dir);
    const key = `${dataKey}|${screen.w}x${screen.h}@${screen.dpi}`;
    const keyFile = path.join(avdDir, 'snapshot.key');
    // Emulator 版本变化只影响快照兼容性，已有 Android 数据由镜像配置判断是否兼容。
    this.currentSnapshotKey = [key, gpu, accel, memoryMB, cores, this.graphicsFeatures(hardwareDecode)].join('|');
    if (this.wipePending || wipe) {
      // 删除可能被系统/安全软件拦截（快照目录常有几个 GB）。
      // 失败就改名让 emulator 不再加载它，绝不因为清理失败而中断启动。
      const snapDir = path.join(avdDir, 'snapshots');
      try {
        fs.rmSync(snapDir, { recursive: true, force: true });
      } catch (_) {
        try { fs.renameSync(snapDir, `${snapDir}.stale-${Date.now()}`); } catch (__) { /* ignore */ }
      }
      // 用户数据不删（保留已装应用），只让模拟器按需重建；镜像切换本身由 -wipe-data 处理
    }
    fs.writeFileSync(keyFile, key, 'utf8');

    // hw.cpu.arch 必须是 ABI 本身（x86_64 不能截成 x86）
    const cpuArch = choice.abi === 'arm64-v8a' ? 'arm64'
      : choice.abi === 'armeabi-v7a' ? 'arm' : choice.abi;

    const cfg = [
      `AvdId=${AVD_NAME}`,
      'avd.ini.displayname=ApkStart',
      'avd.ini.encoding=UTF-8',
      `abi.type=${choice.abi}`,
      `hw.cpu.arch=${cpuArch}`,
      `hw.cpu.ncore=${cores}`,
      `hw.ramSize=${memoryMB}`,
      `vm.heapSize=${heapMB}`,
      `image.sysdir.1=${wantImg}`,
      `tag.id=${tag}`,
      `tag.display=${tagDisplay}`,
      // 旧版写死 16G，会在小硬盘/配额环境下生成巨型文件并拖慢首次开机
      `disk.dataPartition.size=${dataMB}M`,
      'hw.gpu.enabled=yes',
      `hw.gpu.mode=${gpu}`,
      'hw.keyboard=yes',
      'hw.lcd.width=' + screen.w,
      'hw.lcd.height=' + screen.h,
      'hw.lcd.density=' + screen.dpi,
      `hw.initialOrientation=${screen.w > screen.h ? 'landscape' : 'portrait'}`,
      'hw.mainKeys=no',
      'ShowDeviceFrame=no',
      `PlayStore.enabled=${choice.compat}`,
      // 快照完全由命令行 -snapshot apkstart 控制：用独立名字，绝不误加载
      // 旧版遗留的 default_boot（那是 API30 镜像的内存状态，加载必进引导循环）。
      'hw.sdCard=no',
      'hw.audioInput=none',
      'hw.camera.back=none',
      'hw.camera.front=none',
      'hw.gps=no',
      'hw.sensors.orientation=no',
    ].join('\n') + '\n';
    fs.writeFileSync(cfgPath, cfg);

    return {
      home, avdDir, ini: path.join(home, `${AVD_NAME}.ini`), image: choice,
      wipePending: this.wipePending, screen,
    };
  }

  /** emulator 依赖这些环境变量定位 SDK / AVD；中文路径一律转 8.3 短路径 */
  env(root, plan = {}) {
    const safeRoot = doctor.shortPath(root);
    // AVD 目录必须与 provisioner.paths().avdHome 一致：bundled 只读运行时（EXE 旁
    // resources/runtime）时 root/avd 不存在也不可写，AVD 要落到用户数据目录。
    const avdHome = doctor.shortPath(this.provisioner.paths().avdHome);
    const adbPort = String(plan.adbPort || process.env.ANDROID_ADB_SERVER_PORT || '5044');
    return {
      ...process.env,
      ANDROID_SDK_ROOT: safeRoot,
      ANDROID_HOME: safeRoot,
      ANDROID_AVD_HOME: avdHome,
      ANDROID_EMULATOR_HOME: avdHome,
      ANDROID_ADB_SERVER_PORT: adbPort,
      ANDROID_EMULATOR_USE_SYSTEM_LIBS: '',
      ...(plan.accel === 'off' ? { ANDROID_I_WANT_MY_TCG: 'yes' } : {}),
    };
  }

    /**
     * 生成与快照指纹共用的图形功能参数。
     * @param {boolean} hardwareDecode 是否启用宿主视频解码。
     * @returns {string} 模拟器的 feature 参数。
     */
    graphicsFeatures(hardwareDecode) {
        if (process.platform !== 'win32') return GRAPHICS_FEATURES;
        return `${GRAPHICS_FEATURES},${hardwareDecode ? 'HardwareDecoder' : '-HardwareDecoder'}`;
    }

  /**
   * 构造模拟器命令行。
   * @param {object} options 显示、解码和虚拟机配置。
   * @returns {string[]} 模拟器参数。
   */
  buildArgs({
    headless = true, accel = 'auto', port = 5554,
    gpu = 'software', memoryMB = 2048, cores = 2,
    snapshot = true, wipe = false, lcd = null, hardwareDecode = false,
  } = {}) {
    const args = [
      '-avd', AVD_NAME,
      '-port', String(port),
      // 音频：默认开启（让安卓应用的提示音/视频声音能放出来）。
      // 仅当用户在设置里显式关闭时才传 -no-audio 省一点 CPU。
      ...(this.settings?.engine?.audio === false ? ['-no-audio'] : []),
      '-no-boot-anim',
      '-no-metrics',
      // 关掉崩溃上报：一旦历史崩溃报告存在，emulator 会弹「同意上传」模态框，
      // 主线程被卡住、永远不开机（日志表现为 Showing crashdialog to get consent）。
      '-crash-report-mode', 'disabled',
      '-gpu', gpu,
      '-feature', this.graphicsFeatures(hardwareDecode),
      '-memory', String(memoryMB),
      '-cores', String(cores),
    ];
    // 网络：AOSP 模拟器默认走 QEMU 用户态 NAT（-netdev user），安卓侧拿到
    // 10.0.2.x 的虚拟地址，出口直接复用主机的物理网卡 NAT 出去。
    // 这种模式【不会】在 Windows 上创建任何虚拟网卡 / 虚拟交换机
    // （那必须 -netdev tap 或桥接才会发生，我们全程不启用）。
    // 所以安卓应用用的是"一台挂在主机 NAT 后面的设备"，主机网络栈完全不动，
    // 不需要装驱动、也不多一个网络适配器。
    if (lcd) args.push('-skin', `${lcd.w}x${lcd.h}`);
    if (headless) {
      args.push('-no-window');
    } else {
      // 不要模拟器自带的手机外壳；侧边浮动工具栏由窗口代理隐藏。
      args.push('-no-skin');
    }
    // 只有快照真的存在才传 -snapshot：全新 AVD（或快照刚被作废）时传了它，
    // qemu 会一直等一份不存在的内存状态，进程活着但永远不开机——
    // 上层只看到「开机超时」，接着换参数重试，反而被 AVD 锁挡成
    // "Running multiple emulators with the same AVD"。
    // 只禁用模拟器退出时默认的自动保存。冷启仍允许用控制台显式保存命名快照。
    args.push('-no-snapshot-save');
    if (snapshot && !wipe && this.hasSnapshot()) args.push('-snapshot', SNAPSHOT_NAME);
    else args.push('-no-snapshot-load');
    if (wipe) args.push('-wipe-data');
    if (accel === 'off') args.push('-accel', 'off');
    return args;
  }

  /** 拉起单个进程（不做开机等待，开机等待在 start() 的 probe 循环里） */
  spawnOnce(plan, { headless, onLog, logFile }) {
    const loc = this.locate();
    const env = this.env(loc.root, plan);
    const args = this.buildArgs({
      headless, accel: plan.accel, port: plan.port, gpu: plan.gpu,
      memoryMB: plan.memoryMB, cores: plan.cores,
      snapshot: plan.snapshot, wipe: plan.wipe, lcd: plan.lcd, hardwareDecode: plan.hardwareDecode,
    });
    fs.appendFileSync(logFile, `\n--- ${new Date().toISOString()} ${plan.label} ---\n${loc.emulatorExe} ${args.join(' ')}\n`);

    const proc = spawn(loc.emulatorExe, args, {
      cwd: path.dirname(loc.emulatorExe),
      env,
      windowsHide: true,
      // detached: 让模拟器独立于 ApkStart 进程组。
      // Electron 退出时会把自己创建的 job 对象关掉，顺带把子进程一起杀掉——
      // 表现就是"关掉 ApkStart 再打开又要冷启动 20 多秒"。独立出去之后模拟器留着，
      // 下次启动直接接管（见 Runtime.adoptExisting），点开就是秒进。
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.hardwareDecode = plan.hardwareDecode;
    this.snapshotReady = false;
    const attempt = { proc, args, snapshotFailed: false };
    try { proc.unref(); } catch (_) { /* ignore */ }

    const pipe = (stream) => {
      stream.setEncoding('utf8');
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) {
          if (!l.trim()) continue;
          if (l.includes(`Failed to load snapshot '${SNAPSHOT_NAME}'`)) attempt.snapshotFailed = true;
          this.log(l.trim());
          fs.appendFileSync(logFile, `${l.trim()}\n`);
        }
      });
    };
    pipe(proc.stdout);
    pipe(proc.stderr);
    proc.on('exit', (code) => {
      this.log(`emulator exit ${code}`);
      fs.appendFileSync(logFile, `emulator exit ${code}\n`);
      if (this.proc === proc) this.proc = null;
      onLog(`运行时已退出（code=${code}）`);
    });
    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      fs.appendFileSync(logFile, `spawn error: ${e.message}\n`);
      if (this.proc === proc) this.proc = null;
    });

    // qemu 是 detached 的独立进程，等它真正起来再把优先级降下来。
    // 不降的话 2~4 个 vCPU 线程会以 Normal 优先级和 Windows 桌面抢 CPU，
    // 用户最直观的感受就是「一打开 ApkStart，鼠标就发飘、整机变卡」。
    const perf = this.settings?.engine?.priorityMode === 'performance';
    setTimeout(() => {
      this.setPriority(perf ? 'normal' : 'below').catch(() => {});
    }, 3500).unref?.();
    return attempt;
  }

  /**
   * 调整本机 qemu/emulator 进程的优先级（只匹配命令行里带本 AVD 名的进程）。
   * level: idle（容器停放）| below（有应用在前台）| normal（性能优先）。
   */
  setPriority(level = 'below') {
    if (process.platform !== 'win32') return Promise.resolve(0);
    const script = path.join(__dirname, 'win', 'priority.ps1');
    if (!fs.existsSync(script)) return Promise.resolve(0);
    return new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Avd', AVD_NAME, '-Level', level,
      ], { windowsHide: true, timeout: 15000 }, (_err, out) => {
        const m = /CHANGED=(\d+)/.exec(String(out || ''));
        resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /** 强杀当前尝试（含 qemu 子进程树） */
  async killAttempt() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.kill(); } catch (_) { /* ignore */ }
      if (process.platform === 'win32' && proc.pid) {
        try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* ignore */ }
      }
    }
    await sleep(800);
    // proc 句柄常常已经没了（emulator.exe 启动完就退出，qemu 是 detached 的独立进程），
    // 不按进程名兜底清一遍，下一轮就会被 AVD 锁挡成 FATAL。
    await this.killOrphanProcesses().catch(() => {});
  }

  /**
   * 启动 + 自动重试。
   * @param {Function} probe 异步回调，返回 'ok' | 'pending' | 'fatal'
   */
  /**
   * 启动自带模拟器并等待 Android 就绪。
   * @param {object} options 开机选项。
   * @param {boolean} [options.headless] 是否禁用宿主窗口。
   * @param {boolean} [options.landscape] 是否使用原生横屏尺寸。
   * @param {Function} [options.onLog] 进度回调。
   * @param {Function} [options.probe] Android 就绪探测回调。
   * @param {number} [options.maxAttempts] 启动尝试上限。
   * @returns {Promise<object>} 可用的模拟器设备信息。
   */
  async start({ headless = false, landscape = false, onLog = () => {}, probe = null, maxAttempts = 4 } = {}) {
    if (this.proc && !this.proc.killed) {
      return { ok: true, reused: true, serial: this.serial, port: this.port };
    }

    const loc = this.locate();
    if (!loc.emulatorExe) throw new Error('未安装运行时引擎，请先在「运行时」页完成部署');
    const choice = this.imageChoice();
    if (choice.compat ? !this.provisioner.playImageInfo().ok : !this.provisioner.systemImageInfo().ok) {
      throw new Error('系统镜像未就绪，请先在「运行时」页下载 Android 系统镜像');
    }

    const accelInfo = await this.provisioner.emulatorAccel();
    const emuVersion = (await this.provisioner.emulatorVersion()).version || '';
    this._emuVersion = emuVersion;
    const s = this.settings;
    const diskMB = doctor.freeDiskMB(loc.root);
    const startPort = await doctor.freePortPair(5554);
    const adbPort = await doctor.freeAdbPort(Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044);
    // 让本进程里所有 adb 调用和 emulator 用同一个 server 端口
    process.env.ANDROID_ADB_SERVER_PORT = String(adbPort);
    this.adbPort = adbPort;
    // 确保专用 adb server 在 QEMU 启动前已经就绪，快照恢复时才能及时重新注册设备。
    await new Promise((resolve) => {
      try {
        const adb = this.provisioner.adbVersionPath() || 'adb';
        execFile(adb, ['-P', String(adbPort), 'start-server'], {
          timeout: 6000, windowsHide: true,
          env: { ...process.env, ANDROID_ADB_SERVER_PORT: String(adbPort) },
        }, () => resolve());
      } catch (_) { resolve(); }
    });

    // 与设置页 / 诊断报告共用同一个入口，保证「显示的」就是「实跑的」
    const profile = doctor.autoProfile({
      settings: s, accel: accelInfo, emulatorVersion: emuVersion, diskMB,
      port: startPort, adbPort,
    });
    this.profile = profile;
    const variants = doctor.planVariants(profile).slice(0, maxAttempts);

    const logFile = path.join(store.DATA_DIR, 'logs', 'emulator.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `\n\n=== ${new Date().toISOString()} START ${doctor.describeProfile(profile)} ===\n`);

    // 屏幕规格在整个启动过程中保持一致，否则每次重试都换分辨率会狂清快照
    const portrait = doctor.lcdFor({ accelOk: accelInfo.ok });
    const screen = landscape ? { ...portrait, w: portrait.h, h: portrait.w } : portrait;
    this.attempts = [];
    this.lastDiagnosis = null;
    let lastError = '';
    let skipSnapshot = landscape;
    // 只有显式启用实验选项才试用硬解。实机上 36.4.9 仍可能保存无法恢复的设备状态。
    const decoderEligible = process.env.APKSTART_EXPERIMENTAL_HW_DECODE === '1'
        && process.platform === 'win32' && !headless && EXPERIMENTAL_DECODER_VERSION.test(emuVersion);
    let decoderRejected = s.engine?.decoderRejectedVersion === emuVersion;

    // 冷启前先清孤儿：上一次运行留下的 qemu 仍占着 AVD 锁时，
    // 所有尝试都会立刻 FATAL "Running multiple emulators with the same AVD"。
    // eslint-disable-next-line no-await-in-loop
    await this.killOrphanProcesses({ onLog }).catch(() => {});

    for (let i = 0; i < variants.length; i += 1) {
      const base = variants[i];
      // 端口占用也会导致失败，每次重试重新探测一次
      // eslint-disable-next-line no-await-in-loop
      const port = i === 0 ? startPort : await doctor.freePortPair(startPort + (i * 2));
      const plan = {
          ...base, port, adbPort, lcd: screen,
          hardwareDecode: decoderEligible && !decoderRejected && base.gpu === 'host',
      };
      if (skipSnapshot) plan.snapshot = false;
      this.port = port;
      if (this.parkWindow && !headless) await this.parkWindow(port);
      onLog(`启动运行时（第 ${i + 1}/${variants.length} 次：${plan.label}）…`);

      // eslint-disable-next-line no-await-in-loop
      const avd = this.ensureAvd({
        ...plan,
        wipe: plan.wipe || !!this.wipePending,
      });
      const restoring = plan.snapshot && !plan.wipe && !avd.wipePending && this.hasSnapshot();
      // eslint-disable-next-line no-await-in-loop
      if (restoring) onLog('正在恢复安卓运行时快照…');
      const attempt = this.spawnOnce({ ...plan, wipe: plan.wipe || avd.wipePending }, { headless, onLog, logFile });

      // 参数错误 / DLL 缺失会立刻退出
      // eslint-disable-next-line no-await-in-loop
      await sleep(2500);
      if (!this.proc) {
        if (restoring) {
            skipSnapshot = true;
            onLog('快照恢复时运行时退出，正在冷启动重试…');
            await this.killAttempt();
            await this.archiveFailedSnapshot();
            if (plan.hardwareDecode) decoderRejected = this.rejectHardwareDecoder(onLog);
            i -= 1;
            continue;
        }
        const d = doctor.diagnose(this.recentLog(60));
        this.attempts.push({ plan: plan.label, diagnosis: d.code });
        this.lastDiagnosis = d;
        lastError = `${d.title}：${d.hint}`;
        onLog(`${d.title}，自动换一组参数重试…`);
        continue;
      }

      if (!probe) {
        return { ok: true, serial: this.serial, port, accel: accelInfo, logFile, profile, attempts: this.attempts };
      }

      const started = Date.now();
      const timeout = restoring ? SNAPSHOT_BOOT_TIMEOUT_MS : (plan.bootTimeoutMs || 240000);
      let ok = false;
      let fatal = false;
      let sawBooting = false;
      // eslint-disable-next-line no-await-in-loop
      while (Date.now() - started < timeout) {
        if (!this.proc || (restoring && attempt.snapshotFailed)) { fatal = true; break; }
        let state = 'pending';
        try {
          // eslint-disable-next-line no-await-in-loop
          state = await probe({ serial: this.serial, port, adbPort });
        } catch (_) { state = 'pending'; }
        if (restoring && attempt.snapshotFailed) { fatal = true; break; }
        if (state === 'ok') { ok = true; break; }
        if (state === 'fatal') { fatal = true; break; }
        // 只要 adb 能执行 shell，说明内核已经在引导，日志里的普通 Vulkan/EGL 信息不算失败
        if (state === 'booting') sawBooting = true;
        // 45 秒仍完全没连上，且日志出现明确致命错误 → 提前换方案，不干等 4 分钟
        if (!sawBooting && Date.now() - started > 45000) {
          const d = doctor.diagnose(this.recentLog(80));
          if (['GPU_INIT', 'ACCEL', 'GPU_MODE', 'IMAGE', 'DLL', 'MEMORY'].includes(d.code)) {
            this.lastDiagnosis = d;
            fatal = true;
            break;
          }
        }
        // eslint-disable-next-line no-await-in-loop
        if ((Date.now() - started) % 15000 < 3500) onLog(`正在开机… ${Math.round((Date.now() - started) / 1000)}s`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(3000);
      }

      if (ok) {
        const bootMs = Date.now() - started;
        this.snapshotReady = true;
        onLog(`${restoring ? '快照恢复后运行时就绪' : '运行时就绪'}（${Math.round(bootMs / 1000)}s，${plan.label}）`);
        return {
          ok: true, serial: this.serial, port, accel: accelInfo, logFile,
          profile, attempts: this.attempts, bootMs, quickBoot: true,
        };
      }

      if (restoring) {
          skipSnapshot = true;
          onLog('快照恢复后 Android 未就绪，正在冷启动重试…');
          await this.killAttempt();
          await this.archiveFailedSnapshot();
          if (plan.hardwareDecode) decoderRejected = this.rejectHardwareDecoder(onLog);
          i -= 1;
          continue;
      }
      const d = fatal ? (this.lastDiagnosis || doctor.diagnose(this.recentLog(80))) : doctor.diagnose(this.recentLog(80));
      this.attempts.push({ plan: plan.label, diagnosis: d.code, timeout: !fatal });
      this.lastDiagnosis = d;
      lastError = fatal ? `${d.title}：${d.hint}` : '开机超时（可能是首次引导较慢或硬件加速未生效）';
      onLog(`${lastError}，自动换一组参数重试…`);
      // eslint-disable-next-line no-await-in-loop
      await this.killAttempt();
    }

    const d = this.lastDiagnosis || doctor.diagnose(this.recentLog(120));
    const report = doctor.writeReport({
      dataDir: store.DATA_DIR, profile, logLines: this.recentLog(300),
      extra: { attempts: this.attempts, diagnosis: d, image: choice },
    });
    const err = new Error(
      `运行时多次尝试仍未能启动（${d.title}）。\n${d.hint}\n\n`
      + `已尝试：${this.attempts.map((a) => `${a.plan} → ${a.diagnosis}`).join('；')}\n`
      + `诊断报告：${report.file}`,
    );
    err.diagnosis = d;
    err.report = report.file;
    err.attempts = this.attempts;
    throw err;
  }

  running() { return !!(this.proc && !this.proc.killed); }

    /**
     * 为本机当前模拟器版本记录硬解快照失败，后续启动使用兼容解码。
     * @param {Function} onLog 启动日志回调。
     * @returns {boolean} 当前启动也应禁用硬解。
     */
    rejectHardwareDecoder(onLog) {
        try { store.saveSettings({ engine: { decoderRejectedVersion: this._emuVersion } }); }
        catch (error) { this.log(`记录视频解码兼容配置失败：${error.message}`); }
        onLog('宿主视频解码快照恢复失败，正在切换到兼容解码');
        return true;
    }

  /**
   * 供无桌面托盘的 CLI 在开机后预存快照。
   * @param {string} adbPath ADB 可执行文件。
   */
  saveSnapshotSoon(adbPath) {
    if (this.hardwareDecode || this._snapQueued || !adbPath) return;
    this._snapQueued = true;
    setTimeout(() => {
        this._snapQueued = false;
        if (!this.stopping) this.saveSnapshot(adbPath);
    }, 6000).unref?.();
  }

  /**
   * 向当前内置模拟器控制台发送命令，等待最终的 OK。
   * @param {string} adbPath ADB 可执行文件。
   * @param {string[]} args 模拟器控制台命令和参数。
   * @param {number} timeout 命令最长等待时间，单位为毫秒。
   * @returns {Promise<boolean>} 控制台是否确认命令成功。
   */
  consoleCommand(adbPath, args, timeout) {
      return new Promise((resolve) => {
          execFile(adbPath, ['-P', String(this.adbPort), '-s', this.serial, 'emu', ...args],
              { timeout, windowsHide: true }, (error, stdout) => {
                  const lines = String(stdout).trim().split(/\r?\n/);
                  resolve(!error && lines.at(-1) === 'OK' && !lines.some((line) => /^KO\b/i.test(line)));
              });
      });
  }

  /**
   * 保存已就绪的 Android，并确认控制台响应和磁盘快照均有效。
   * @param {string} adbPath ADB 可执行文件。
   * @returns {Promise<boolean>} 是否保存了可供下次加载的快照。
   */
  async saveSnapshot(adbPath) {
      if (this.snapshotSave) return this.snapshotSave;
      if (!adbPath || !this.snapshotReady || !this.running()) return false;
      this.snapshotSave = (async () => {
          const accepted = await this.consoleCommand(adbPath, ['avd', 'snapshot', 'save', SNAPSHOT_NAME], SNAPSHOT_SAVE_TIMEOUT_MS);
          if (!accepted || !this.currentSnapshotKey || !this.hasSnapshot(false)) return false;
          const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME);
          await fs.promises.writeFile(path.join(dir, SNAPSHOT_PROFILE_FILE), this.currentSnapshotKey, 'utf8');
          return true;
      })();
      try {
          return await this.snapshotSave;
      } finally {
          this.snapshotSave = null;
      }
  }

  /**
   * 先保存已就绪的内置模拟器，再关闭进程。并发停止请求共用一次保存。
   * @param {object} [options] 停止选项。
   * @param {string} [options.adbPath] ADB 可执行文件。
   * @param {boolean} [options.saveSnapshot] 是否为下次启动保存快照。
   * @param {Function} [options.onLog] 接收快照保存进度的回调。
   * @returns {Promise<boolean>} 停止完成后返回。
   */
  async stop({ adbPath, saveSnapshot = true, onLog = () => {} } = {}) {
      if (this.stopping) return this.stopping;
      if (!this.proc) return true;
      this.stopping = (async () => {
          let saved = false;
          if (saveSnapshot && this.snapshotReady) {
              const start = Date.now();
              onLog('正在保存安卓运行时快照…');
              saved = await this.saveSnapshot(adbPath).catch(() => false);
              if (saved) onLog(`安卓运行时快照已保存（${Date.now() - start}ms）`);
          }
          if (adbPath) await this.consoleCommand(adbPath, ['kill'], 8000);
          for (let i = 0; i < 20 && this.proc; i += 1) await sleep(300);
          await this.killAttempt();
          if (saveSnapshot && this.snapshotReady && !saved) {
              await this.archiveFailedSnapshot();
              onLog('快照未能完整保存，下次将冷启动');
          }
          this.snapshotReady = false;
          return true;
      })();
      try {
          return await this.stopping;
      } finally {
          this.stopping = null;
      }
  }

  recentLog(n = 40) { return this._log.slice(-n).map((x) => x.line); }
}

module.exports = { EmulatorEngine, AVD_NAME, SNAPSHOT_NAME };
